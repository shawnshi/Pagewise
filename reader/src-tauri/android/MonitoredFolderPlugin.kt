package io.pagewise.reader

import android.app.Activity
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.OperationCanceledException
import android.os.SystemClock
import android.provider.DocumentsContract
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Only the system tree picker can create a registry entry; no caller-supplied URI is opened. */
@TauriPlugin
class MonitoredFolderPlugin(
    private val activity: Activity,
) : Plugin(activity) {
    private val resolver get() = activity.contentResolver
    private val preferences = activity.getSharedPreferences("pagewise-monitored-folder", Activity.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val working = AtomicBoolean(false)
    private val selecting = AtomicBoolean(false)
    private var view: WebView? = null
    private var watching = false
    private var foreground = true

    @Volatile private var destroyed = false
    private var observer: ContentObserver? = null
    private var observerSignalPending = false

    @Volatile private var activeSignal: CancellationSignal? = null
    private var pendingPicker: Invoke? = null
    private val signalChange =
        Runnable {
            observerSignalPending = false
            if (!destroyed && watching && foreground) {
                // Fixed script contains no provider-controlled strings or private file names.
                view?.evaluateJavascript("window.dispatchEvent(new Event('pagewise-monitored-folder-change'))", null)
            }
        }

    private class Failure(
        val code: String,
    ) : IOException(code)

    private data class Folder(
        val id: String,
        val label: String,
        val uri: Uri,
    )

    private data class Directory(
        val id: String,
        val path: String,
        val depth: Int,
    )

    override fun load(webView: WebView) {
        view = webView
    }

    private fun signal() {
        if (!observerSignalPending && watching && foreground && !destroyed) {
            observerSignalPending = true
            handler.postDelayed(signalChange, 500)
        }
    }

    private fun removeObserver() {
        observer?.let { resolver.unregisterContentObserver(it) }
        observer = null
        handler.removeCallbacks(signalChange)
        observerSignalPending = false
    }

    private fun updateObserver() {
        removeObserver()
        if (!watching || !foreground || destroyed) return
        try {
            val folder = stored() ?: return
            if (!granted(folder)) {
                signal()
                return
            }
            val next =
                object : ContentObserver(handler) {
                    override fun onChange(selfChange: Boolean) {
                        signal()
                    }
                }
            resolver.registerContentObserver(folder.uri, true, next)
            observer = next
        } catch (_: Exception) {
            // Observation is a hint only; get/list surface errors on the next scan.
            signal()
        }
    }

    override fun onPause() {
        foreground = false
        removeObserver()
    }

    override fun onResume() {
        foreground = true
        updateObserver()
        signal()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        destroyed = true
        watching = false
        removeObserver()
        activeSignal?.cancel()
        pendingPicker?.reject("unavailable", "unavailable")
        pendingPicker = null
        executor.shutdownNow()
        view = null
    }

    private fun tree(value: String): Uri {
        val uri = Uri.parse(value)
        if (uri.scheme != "content" || uri.authority?.matches(
                Regex("[A-Za-z0-9._-]+"),
            ) != true || uri.query != null || uri.fragment != null ||
            uri.pathSegments.size != 2 ||
            uri.pathSegments[0] != "tree" ||
            !validId(DocumentsContract.getTreeDocumentId(uri))
        ) {
            throw Failure("invalid_reference")
        }
        return uri
    }

    private fun validId(value: String) = value.isNotEmpty() && value.length <= 4096 && value.none { it < ' ' }

    private fun stored(): Folder? {
        val raw = preferences.getString("selected", null) ?: return null
        val json = JSONObject(raw)
        val uri = tree(json.getString("uri"))
        val id = identity(uri)
        if (id != json.getString("id")) throw Failure("invalid_reference")
        return Folder(id, json.getString("label"), uri)
    }

    private fun identity(uri: Uri): String =
        "saf-" +
            MessageDigest.getInstance("SHA-256").digest(uri.toString().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun granted(folder: Folder) = resolver.persistedUriPermissions.any { it.uri == folder.uri && it.isReadPermission }

    private fun describe(folder: Folder) =
        JSObject().put("id", folder.id).put("label", folder.label).put("permission", if (granted(folder)) "granted" else "lost")

    // Mobile Invoke.resolve(null) becomes {}, so nullable folder results need an explicit envelope.
    private fun folderResult(folder: Folder?): JSObject = JSObject().put("folder", folder?.let { describe(it) } ?: JSONObject.NULL)

    private fun authorized(id: String): Folder {
        val folder = stored() ?: throw Failure("invalid_reference")
        if (folder.id != id) throw Failure("invalid_reference")
        if (!granted(folder)) throw Failure("permission_denied")
        return folder
    }

    private fun code(error: Exception): String =
        when (error) {
            is Failure -> error.code
            is SecurityException -> "permission_denied"
            is FileNotFoundException -> "not_found"
            is OperationCanceledException -> "unavailable"
            else -> "io_error"
        }

    private fun reject(
        invoke: Invoke,
        error: Exception,
    ) {
        val value = code(error)
        invoke.reject(value, value)
    }

    private fun work(
        invoke: Invoke,
        timeoutReject: Boolean = true,
        action: (CancellationSignal, Long) -> JSObject?,
    ) {
        if (destroyed) {
            invoke.reject("unavailable", "unavailable")
            return
        }
        if (!working.compareAndSet(false, true)) {
            invoke.reject("busy", "busy")
            return
        }
        val cancellation = CancellationSignal()
        activeSignal = cancellation
        val deadline = SystemClock.elapsedRealtime() + 15000
        val settled = AtomicBoolean(false)
        val timeout =
            Runnable {
                // A provider may ignore cancellation. Read/list callers still receive a bounded result;
                // the single worker stays busy until it unwinds rather than admitting an unbounded queue.
                if (timeoutReject && settled.compareAndSet(false, true)) invoke.reject("unavailable", "unavailable")
                cancellation.cancel()
            }
        handler.postDelayed(timeout, 15000)
        try {
            executor.execute {
                try {
                    val result = action(cancellation, deadline)
                    if (settled.compareAndSet(false, true)) invoke.resolve(result)
                } catch (error: Exception) {
                    if (settled.compareAndSet(false, true)) reject(invoke, error)
                } finally {
                    handler.removeCallbacks(timeout)
                    activeSignal = null
                    working.set(false)
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            handler.removeCallbacks(timeout)
            activeSignal = null
            working.set(false)
            invoke.reject("unavailable", "unavailable")
        }
    }

    private fun check(
        cancellation: CancellationSignal,
        deadline: Long,
    ) {
        cancellation.throwIfCanceled()
        if (destroyed || Thread.currentThread().isInterrupted || SystemClock.elapsedRealtime() >= deadline) throw Failure("unavailable")
    }

    @Command
    fun get(invoke: Invoke) {
        try {
            invoke.resolve(folderResult(stored()))
        } catch (error: Exception) {
            reject(invoke, error)
        }
    }

    @Command
    fun select(invoke: Invoke) {
        if (destroyed) {
            invoke.reject("unavailable", "unavailable")
            return
        }
        if (working.get() || !selecting.compareAndSet(false, true)) {
            invoke.reject("busy", "busy")
            return
        }
        pendingPicker = invoke
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        try {
            startActivityForResult(invoke, intent, "selected")
        } catch (
            error: Exception,
        ) {
            selecting.set(false)
            pendingPicker = null
            reject(invoke, error)
        }
    }

    @ActivityCallback
    fun selected(
        invoke: Invoke,
        result: ActivityResult,
    ) {
        pendingPicker = null
        selecting.set(false)
        if (destroyed) {
            invoke.reject("unavailable", "unavailable")
            return
        }
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(folderResult(null))
            return
        }
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.reject("unavailable", "unavailable")
            return
        }
        // Selection has a commit point: never return a synthetic timeout before its final state is known.
        work(invoke, timeoutReject = false) { cancellation, deadline ->
            val data = result.data ?: throw Failure("invalid_reference")
            val uri = tree(data.data?.toString() ?: throw Failure("invalid_reference"))
            if (data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0 ||
                data.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION == 0
            ) {
                throw Failure("permission_denied")
            }
            val previous = stored()
            val hadGrant = resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
                val label =
                    resolver
                        .query(
                            root,
                            arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE),
                            null,
                            null,
                            null,
                            cancellation,
                        )?.use { cursor ->
                            if (!cursor.moveToFirst() ||
                                cursor.getString(1) != DocumentsContract.Document.MIME_TYPE_DIR
                            ) {
                                throw Failure("invalid_reference")
                            }
                            cursor.getString(0)
                        } ?: throw Failure("unavailable")
                if (!validName(label)) throw Failure("invalid_reference")
                val folder = Folder(identity(uri), label, uri)
                check(cancellation, deadline)
                val json = JSONObject().put("id", folder.id).put("label", label).put("uri", uri.toString())
                if (!preferences.edit().putString("selected", json.toString()).commit()) throw Failure("io_error")
                // Selection commits only after grant + metadata succeed. Old descriptors remain on cancel/failure.
                if (previous != null && previous.uri != uri) {
                    try {
                        resolver.releasePersistableUriPermission(previous.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    } catch (
                        _: SecurityException,
                    ) {
                        // An already-revoked grant needs no release.
                    }
                }
                handler.post {
                    updateObserver()
                    signal()
                }
                folderResult(folder)
            } catch (error: Exception) {
                if (!hadGrant) {
                    try {
                        resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    } catch (
                        _: SecurityException,
                    ) {
                        // No new persisted grant remains.
                    }
                }
                throw error
            }
        }
    }

    private fun validName(value: String?) =
        value != null && value.isNotEmpty() && value.length <= 255 && value != "." && value != ".." &&
            value.none { it < ' ' || it == '/' || it == '\\' }

    private fun supported(name: String) = Regex("(?i).*\\.(epub|mobi|pdf|txt|md|markdown)$").matches(name)

    @Command
    fun list(invoke: Invoke) =
        work(invoke) { cancellation, deadline ->
            val folder = authorized(invoke.getArgs().getString("folderId"))
            val files = JSArray()
            val errors = JSArray()
            val errorCodes = mutableSetOf<String>()

            fun error(value: String) {
                if (errorCodes.size < 32 && errorCodes.add(value)) errors.put(JSObject().put("code", value))
            }
            val pending = ArrayDeque<Directory>()
            pending.add(Directory(DocumentsContract.getTreeDocumentId(folder.uri), "", 0))
            val seen = mutableSetOf<String>()
            var entries = 0
            val columns =
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                )
            while (pending.isNotEmpty()) {
                if (entries >= 5000) {
                    error("resource_limit")
                    break
                }
                val directory = pending.removeFirst()
                if (!seen.add(directory.id)) {
                    error("invalid_reference")
                    continue
                }
                try {
                    check(cancellation, deadline)
                    val children = DocumentsContract.buildChildDocumentsUriUsingTree(folder.uri, directory.id)
                    val cursor = resolver.query(children, columns, null, null, null, cancellation) ?: throw Failure("unavailable")
                    cursor.use {
                        while (it.moveToNext()) {
                            check(cancellation, deadline)
                            if (++entries > 5000) {
                                error("resource_limit")
                                break
                            }
                            val id = it.getString(0)
                            val name = it.getString(1)
                            if (!validId(id) || !validName(name)) {
                                error("invalid_reference")
                                continue
                            }
                            val path = if (directory.path.isEmpty()) name else "${directory.path}/$name"
                            if (it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                                if (directory.depth >= 8) {
                                    error("depth_limit")
                                } else {
                                    pending.add(Directory(id, path, directory.depth + 1))
                                }
                            } else if (supported(name)) {
                                files.put(
                                    JSObject()
                                        .put("documentId", id)
                                        .put("name", name)
                                        .put("relativePath", path)
                                        .put("size", if (it.isNull(3) || it.getLong(3) < 0) JSONObject.NULL else it.getLong(3))
                                        .put("modifiedAt", if (it.isNull(4) || it.getLong(4) <= 0) JSONObject.NULL else it.getLong(4)),
                                )
                            }
                        }
                        if (it.extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) error("provider_loading")
                    }
                } catch (failure: Exception) {
                    error(code(failure))
                }
                if (cancellation.isCanceled || SystemClock.elapsedRealtime() >= deadline) break
            }
            JSObject().put("files", files).put("complete", errorCodes.isEmpty()).put("errors", errors)
        }

    @Command
    fun read(invoke: Invoke) =
        work(invoke) { cancellation, deadline ->
            val args = invoke.getArgs()
            val folder = authorized(args.getString("folderId"))
            val id = args.getString("documentId")
            if (!validId(id) || id == DocumentsContract.getTreeDocumentId(folder.uri)) throw Failure("invalid_reference")
            val root = DocumentsContract.buildDocumentUriUsingTree(folder.uri, DocumentsContract.getTreeDocumentId(folder.uri))
            val document = DocumentsContract.buildDocumentUriUsingTree(folder.uri, id)
            // Prefix-string checks are not tree membership checks. Fail closed for providers without isChildDocument.
            if (!DocumentsContract.isChildDocument(resolver, root, document)) throw Failure("invalid_reference")
            resolver
                .query(
                    document,
                    arrayOf(
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE,
                    ),
                    null,
                    null,
                    null,
                    cancellation,
                )?.use {
                    if (!it.moveToFirst()) throw Failure("not_found")
                    if (!supported(it.getString(0)) ||
                        it.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR
                    ) {
                        throw Failure("invalid_reference")
                    }
                    if (!it.isNull(2) && it.getLong(2) > 64L * 1024 * 1024) throw Failure("resource_limit")
                } ?: throw Failure("unavailable")
            check(cancellation, deadline)
            val descriptor = resolver.openFileDescriptor(document, "r", cancellation) ?: throw Failure("unavailable")
            val closeOnTimeout =
                Runnable {
                    try {
                        descriptor.close()
                    } catch (_: IOException) {
                    }
                }
            handler.postDelayed(closeOnTimeout, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
            try {
                android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(65536)
                    while (true) {
                        check(cancellation, deadline)
                        val count = stream.read(buffer)
                        if (count < 0) break
                        if (output.size().toLong() + count > 64L * 1024 * 1024) throw Failure("resource_limit")
                        output.write(buffer, 0, count)
                    }
                    check(cancellation, deadline)
                    JSObject().put("data", android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP))
                }
            } finally {
                handler.removeCallbacks(closeOnTimeout)
                descriptor.close()
            }
        }

    @Command
    fun watch(invoke: Invoke) {
        try {
            watching = invoke.getArgs().getBoolean("enabled")
            updateObserver()
            invoke.resolve()
        } catch (error: Exception) {
            reject(invoke, error)
        }
    }
}
