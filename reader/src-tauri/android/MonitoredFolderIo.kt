package io.pagewise.reader

import android.content.Context
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.OperationCanceledException
import android.os.SystemClock
import android.provider.DocumentsContract
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID

private const val MAX_READ_BYTES = 64L * 1024 * 1024

/** Shared SAF authority and bounded IO; owns application context, never an Activity or WebView. */
internal class MonitoredFolderIo(
    private val context: Context,
) {
    private val resolver get() = context.contentResolver
    private val preferences = context.getSharedPreferences("pagewise-monitored-folder", Context.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())

    class Failure(
        val code: String,
    ) : IOException(code)

    data class Folder(
        val id: String,
        val label: String,
        val uri: Uri,
    )

    private data class Directory(
        val id: String,
        val path: String,
        val depth: Int,
    )

    fun tree(value: String): Uri {
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

    fun validId(value: String) = value.isNotEmpty() && value.length <= 4096 && value.none { it < ' ' }

    fun stored(): Folder? {
        val raw = preferences.getString("selected", null) ?: return null
        val json = JSONObject(raw)
        val uri = tree(json.getString("uri"))
        val id = identity(uri)
        if (id != json.getString("id")) throw Failure("invalid_reference")
        return Folder(id, json.getString("label"), uri)
    }

    fun identity(uri: Uri): String =
        "saf-" +
            MessageDigest.getInstance("SHA-256").digest(uri.toString().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun granted(folder: Folder) = resolver.persistedUriPermissions.any { it.uri == folder.uri && it.isReadPermission }

    fun describe(folder: Folder) =
        JSObject().put("id", folder.id).put("label", folder.label).put("permission", if (granted(folder)) "granted" else "lost")

    // Mobile Invoke.resolve(null) becomes {}, so nullable folder results need an explicit envelope.
    fun folderResult(folder: Folder?): JSObject = JSObject().put("folder", folder?.let { describe(it) } ?: JSONObject.NULL)

    fun authorized(id: String): Folder {
        val folder = stored() ?: throw Failure("invalid_reference")
        if (folder.id != id) throw Failure("invalid_reference")
        if (!granted(folder)) throw Failure("permission_denied")
        return folder
    }

    fun code(error: Exception): String =
        when (error) {
            is Failure -> error.code
            is SecurityException -> "permission_denied"
            is FileNotFoundException -> "not_found"
            is OperationCanceledException -> "unavailable"
            else -> "io_error"
        }

    fun discard(result: JSObject?) {
        val path = result?.optString("path") ?: return
        if (Regex("cache/pagewise-read/[a-f0-9-]{36}\\.bin").matches(path)) {
            File(context.cacheDir, "pagewise-read/${path.substringAfterLast('/')}").delete()
        }
    }

    private fun check(
        cancellation: CancellationSignal,
        deadline: Long,
    ) {
        cancellation.throwIfCanceled()
        if (Thread.currentThread().isInterrupted || SystemClock.elapsedRealtime() >= deadline) throw Failure("unavailable")
    }

    fun validName(value: String?) =
        value != null && value.isNotEmpty() && value.length <= 255 && value != "." && value != ".." &&
            value.none { it < ' ' || it == '/' || it == '\\' }

    private fun supported(name: String) = Regex("(?i).*\\.(epub|mobi|pdf|txt|md|markdown)$").matches(name)

    fun list(
        folderId: String,
        cancellation: CancellationSignal,
        deadline: Long,
    ): JSObject {
        val folder = authorized(folderId)
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
        authorized(folder.id)
        return JSObject().put("files", files).put("complete", errorCodes.isEmpty()).put("errors", errors)
    }

    fun read(
        folderId: String,
        documentId: String,
        cancellation: CancellationSignal,
        deadline: Long,
    ): JSObject {
        val folder = authorized(folderId)
        val id = documentId
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
                val sourceSize = if (it.isNull(2)) null else it.getLong(2)
                if ((sourceSize ?: 0L) > MAX_READ_BYTES) throw Failure("resource_limit")
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
            // Provider sizes are untrusted (including files that grow during reading). Always spool
            // with the actual-byte limit; otherwise an understated size can create a huge UTF-16 Base64 string.
            val result = JSObject().put("path", writeTempDocument(descriptor, cancellation, deadline))
            try {
                check(cancellation, deadline)
                authorized(folder.id)
                return result
            } catch (error: Exception) {
                discard(result)
                throw error
            }
        } finally {
            handler.removeCallbacks(closeOnTimeout)
            descriptor.close()
        }
    }

    /** 流式写 cache/pagewise-read/<uuid>.bin; 过期临时文件一小时清理。 */
    private fun writeTempDocument(
        descriptor: android.os.ParcelFileDescriptor,
        cancellation: CancellationSignal,
        deadline: Long,
    ): String {
        val dir = File(context.cacheDir, "pagewise-read")
        if (!dir.isDirectory && !dir.mkdirs()) throw Failure("io_error")
        val cutoff = System.currentTimeMillis() - 60L * 60L * 1000L
        dir.listFiles()?.forEach { file ->
            if (file.isFile && file.lastModified() < cutoff) file.delete()
        }
        val target = File(dir, "${UUID.randomUUID()}.bin")
        try {
            FileOutputStream(target).use { output ->
                android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
                    val buffer = ByteArray(65536)
                    var written = 0L
                    while (true) {
                        check(cancellation, deadline)
                        val count = stream.read(buffer)
                        if (count < 0) break
                        written += count
                        if (written > MAX_READ_BYTES) throw Failure("resource_limit")
                        output.write(buffer, 0, count)
                    }
                    check(cancellation, deadline)
                }
            }
        } catch (error: Exception) {
            target.delete()
            throw error
        }
        return "cache/pagewise-read/${target.name}"
    }
}
