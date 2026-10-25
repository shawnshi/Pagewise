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
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private typealias Folder = MonitoredFolderIo.Folder

/** Only the system tree picker can create a registry entry; no caller-supplied URI is opened. */
@TauriPlugin
class MonitoredFolderPlugin(
    private val activity: Activity,
) : Plugin(activity) {
    private val io = MonitoredFolderIo(activity.applicationContext)
    private val resolver get() = activity.contentResolver
    private val preferences = activity.getSharedPreferences("pagewise-monitored-folder", Activity.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())

    private class Lane {
        val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1))
        var working = false
        var stop: (() -> Unit)? = null
    }

    private val admission = Any()
    private val enumerationLane = Lane()
    private val interactiveLane = Lane()
    private val selecting = AtomicBoolean(false)
    private var view: WebView? = null
    private var watching = false
    private var foreground = true

    @Volatile private var destroyed = false
    private var observer: ContentObserver? = null
    private var observerSignalPending = false

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
        val stops =
            synchronized(admission) {
                destroyed = true
                listOfNotNull(enumerationLane.stop, interactiveLane.stop)
            }
        watching = false
        removeObserver()
        stops.forEach { it() }
        pendingPicker?.reject("unavailable", "unavailable")
        pendingPicker = null
        enumerationLane.executor.shutdownNow()
        interactiveLane.executor.shutdownNow()
        view = null
    }

    private fun tree(value: String) = io.tree(value)

    private fun validId(value: String) = io.validId(value)

    private fun validName(value: String?) = io.validName(value)

    private fun stored() = io.stored()

    private fun identity(uri: Uri) = io.identity(uri)

    private fun granted(folder: Folder) = io.granted(folder)

    private fun describe(folder: Folder) = io.describe(folder)

    private fun folderResult(folder: Folder?): JSObject = JSObject().put("folder", folder?.let { describe(it) } ?: JSONObject.NULL)

    private fun code(error: Exception): String =
        when (error) {
            is Failure -> error.code
            is MonitoredFolderIo.Failure -> error.code
            is NativeImportFailure -> error.code
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

    private fun reserveSelection(invoke: Invoke? = null): String? =
        synchronized(admission) {
            when {
                destroyed -> {
                    "unavailable"
                }

                enumerationLane.working || interactiveLane.working || selecting.get() -> {
                    "busy"
                }

                else -> {
                    selecting.set(true)
                    pendingPicker = invoke
                    null
                }
            }
        }

    private fun work(
        invoke: Invoke,
        lane: Lane = enumerationLane,
        selection: Boolean = false,
        timeoutReject: Boolean = true,
        timeoutMs: Long = 15000,
        action: (CancellationSignal, Long) -> JSObject?,
    ) = synchronized(admission) {
        if (destroyed) {
            if (selection) selecting.set(false)
            invoke.reject("unavailable", "unavailable")
            return@synchronized
        }
        if (lane.working || (selecting.get() && !selection)) {
            invoke.reject("busy", "busy")
            return@synchronized
        }
        lane.working = true
        val cancellation = CancellationSignal()
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        val settled = AtomicBoolean(false)
        val stop = {
            if (timeoutReject && settled.compareAndSet(false, true)) invoke.reject("unavailable", "unavailable")
            cancellation.cancel()
        }
        lane.stop = stop
        val timeout = Runnable { stop() }
        handler.postDelayed(timeout, timeoutMs)
        try {
            lane.executor.execute {
                try {
                    val result = action(cancellation, deadline)
                    // A canceled provider keeps only its own lane occupied, never the other lane.
                    synchronized(admission) {
                        if (destroyed && timeoutReject) {
                            if (settled.compareAndSet(false, true)) invoke.reject("unavailable", "unavailable")
                            discard(result)
                        } else if (settled.compareAndSet(false, true)) {
                            invoke.resolve(result)
                        } else {
                            discard(result)
                        }
                    }
                } catch (error: Exception) {
                    if (settled.compareAndSet(false, true)) reject(invoke, error)
                } finally {
                    handler.removeCallbacks(timeout)
                    synchronized(admission) {
                        lane.stop = null
                        lane.working = false
                        if (selection) selecting.set(false)
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            handler.removeCallbacks(timeout)
            lane.stop = null
            lane.working = false
            if (selection) selecting.set(false)
            if (settled.compareAndSet(false, true)) invoke.reject("unavailable", "unavailable")
        }
    }

    private fun discard(result: JSObject?) {
        val path = result?.optString("path") ?: return
        if (Regex("cache/pagewise-read/[a-f0-9-]{36}\\.bin").matches(path)) {
            File(activity.cacheDir, "pagewise-read/${path.substringAfterLast('/')}").delete()
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

    private fun releaseSelection(invoke: Invoke) = synchronized(admission) {
        if (pendingPicker === invoke) {
            pendingPicker = null
            selecting.set(false)
        }
    }

    @Command
    fun select(invoke: Invoke) {
        val error = reserveSelection(invoke)
        if (error != null) {
            invoke.reject(error, error)
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        try {
            synchronized(admission) {
                if (destroyed) return
                startActivityForResult(invoke, intent, "selected") { releaseSelection(invoke) }
            }
        } catch (
            error: Exception,
        ) {
            releaseSelection(invoke)
            reject(invoke, error)
        }
    }

    @ActivityCallback
    fun selected(
        invoke: Invoke,
        result: ActivityResult,
    ) {
        if (pendingPicker !== invoke) return
        pendingPicker = null
        if (destroyed) {
            selecting.set(false)
            invoke.reject("unavailable", "unavailable")
            return
        }
        if (result.resultCode == Activity.RESULT_CANCELED) {
            selecting.set(false)
            invoke.resolve(folderResult(null))
            return
        }
        if (result.resultCode != Activity.RESULT_OK) {
            selecting.set(false)
            invoke.reject("unavailable", "unavailable")
            return
        }
        // Selection has a commit point: never return a synthetic timeout before its final state is known.
        work(invoke, selection = true, timeoutReject = false) { cancellation, deadline ->
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

    // Legacy commands keep their response shape; new callers use durable service jobs.
    @Command
    fun list(invoke: Invoke) =
        work(invoke) { cancellation, deadline ->
            io.list(invoke.getArgs().getString("folderId"), cancellation, deadline)
        }

    @Command
    fun read(invoke: Invoke) =
        work(invoke, lane = interactiveLane) { cancellation, deadline ->
            val args = invoke.getArgs()
            io.read(args.getString("folderId"), args.getString("documentId"), cancellation, deadline)
        }

    @Command
    fun job(invoke: Invoke) =
        work(invoke, lane = interactiveLane) { _, _ ->
            NativeFileJobs.command(activity.applicationContext, invoke.getArgs())
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
