package io.pagewise.reader

import android.content.Context
import android.os.CancellationSignal
import android.system.Os
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

internal interface NativeImportControl {
    fun checkpoint()

    /** Cancellation/timeout cannot publish a false terminal state across this commit boundary. */
    fun commit(action: () -> Unit)

    fun progress(result: JSONObject)
}

/** One native owner performs extraction, optional cover conversion and transactional batch indexing. */
internal class NativeBookImporter(
    private val context: Context,
) {
    private val io = MonitoredFolderIo(context.applicationContext)
    private val uuid = Regex("[a-f0-9-]{36}")

    companion object {
        private val checks = linkedMapOf<String, Long>()
        const val MAX_ITEMS = 128
        const val MAX_BATCH_BYTES = 1024L * 1024 * 1024

        private fun canonical(value: Any?): String =
            when (value) {
                is JSONObject -> {
                    value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}", separator = ",") { key ->
                        canonical(key) +
                            ":" +
                            canonical(value.get(key))
                    }
                }

                is JSONArray -> {
                    (0 until value.length()).joinToString(prefix = "[", postfix = "]", separator = ",") { canonical(value.get(it)) }
                }

                else -> {
                    JSONArray().put(value).toString().removeSurrounding("[", "]")
                }
            }

        fun requestFingerprint(
            kind: String,
            folderId: String,
            request: JSONObject,
        ): String =
            MessageDigest
                .getInstance("SHA-256")
                .digest((kind + ":" + folderId + ":" + canonical(request)).toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }

        fun code(error: Exception): String =
            when (error) {
                is NativeImportFailure -> error.code
                is MonitoredFolderIo.Failure -> error.code
                is SecurityException -> "permission_denied"
                is java.io.FileNotFoundException -> "not_found"
                is android.os.OperationCanceledException -> "cancelled"
                is android.database.sqlite.SQLiteException -> "database_error"
                else -> "parse_error"
            }
    }

    private fun summary(operation: String) =
        JSONObject()
            .put("operation", operation)
            .put("total", 0)
            .put("done", 0)
            .put("imported", 0)
            .put("updated", 0)
            .put("skipped", 0)
            .put("failed", 0)
            .put("complete", false)
            .put("results", JSONArray())
            .put("errors", JSONArray())

    private fun count(
        result: JSONObject,
        key: String,
        amount: Int = 1,
    ) {
        result.put(key, result.getInt(key) + amount)
    }

    private fun error(
        result: JSONObject,
        file: String,
        code: String,
    ) {
        val errors = result.getJSONArray("errors")
        if (errors.length() < 32) errors.put(JSONObject().put("fileName", file.take(255)).put("code", code))
    }

    private fun validName(name: String): Boolean =
        name.isNotBlank() && name.length <= 255 && name != "." && name != ".." && name.none { it < ' ' || it == '/' || it == '\\' }

    private fun temp(path: String): File {
        if (!Regex("cache/import-[a-f0-9-]{36}\\.bin").matches(path)) throw NativeImportFailure("invalid_reference")
        return File(context.cacheDir, path.removePrefix("cache/"))
    }

    private fun active(
        folderId: String,
        control: NativeImportControl,
    ) {
        control.checkpoint()
        io.authorized(folderId)
    }

    private fun parse(
        file: File,
        name: String,
        cover: Boolean,
        control: NativeImportControl,
    ): NativeBibliography {
        val metadata =
            if (NativeBookMetadata.format(name) ==
                "pdf"
            ) {
                NativePdfMetadata.parse(context, file, name, cover, control::checkpoint)
            } else {
                NativeBookMetadata.parse(file, name, cover, control::checkpoint)
            }
        if (metadata.title.length > 65536 || metadata.author.length > 65536) throw NativeImportFailure("resource_limit")
        if (!cover || metadata.cover == null || NativeBookMetadata.format(name) == "pdf") return metadata
        val image =
            try {
                NativePdfMetadata.normalizeCover(metadata.cover, control::checkpoint)
            } catch (
                failure: Exception,
            ) {
                control.checkpoint()
                null
            }
        return metadata.copy(cover = image)
    }

    private fun stage(
        bytes: ByteArray?,
        id: String,
        jobId: String,
    ): File? {
        if (bytes == null) return null
        val directory = File(context.dataDir, "covers")
        if (!directory.isDirectory && !directory.mkdirs()) throw NativeImportFailure("io_error")
        return File(directory, ".native-$jobId-$id.tmp").also { target ->
            FileOutputStream(target).use { stream ->
                stream.write(bytes)
                stream.fd.sync()
            }
        }
    }

    private fun publish(
        staged: File?,
        id: String,
    ) {
        if (staged != null) Os.rename(staged.path, File(context.dataDir, "covers/$id.jpg").path)
    }

    fun inspect(
        folderId: String,
        documentId: String,
        fileName: String,
        cancellation: CancellationSignal,
        deadline: Long,
        control: NativeImportControl,
    ): JSObject {
        if (!validName(fileName)) throw NativeImportFailure("invalid_reference")
        active(folderId, control)
        val result = io.read(folderId, documentId, cancellation, deadline)
        val file = File(context.dataDir, result.getString("path"))
        try {
            parse(file, fileName, false, control)
            active(folderId, control)
            return JSObject().put("format", NativeBookMetadata.format(fileName))
        } finally {
            file.delete()
        }
    }

    fun index(
        jobId: String,
        folderId: String,
        request: JSONObject,
        cancellation: CancellationSignal,
        deadline: Long,
        control: NativeImportControl,
    ): JSObject {
        if (!uuid.matches(jobId)) throw NativeImportFailure("invalid_reference")
        val folder = io.stored() ?: throw NativeImportFailure("invalid_reference")
        if (folder.id != folderId) throw NativeImportFailure("invalid_reference")
        val force = request.optBoolean("force")
        val fingerprint = requestFingerprint("index", folderId, request)
        NativeImportDatabase(context).use { db ->
            var result = summary("index")
            control.commit { result = db.transaction { db.batch(jobId, fingerprint, result) } }
            if (result.optBoolean("finished")) return JSObject(result.toString())
            if (result.getInt("done") > 0) throw NativeImportFailure("interrupted")
            val known = db.linked(folderId)
            if (!io.granted(folder)) {
                control.commit {
                    if (io.stored()?.id != folderId) throw NativeImportFailure("source_changed")
                    db.transaction {
                        for (book in known) db.availability(book, "permission-denied")
                        error(result, "", "permission_denied")
                        result.put("complete", false).put("finished", true)
                        db.record(jobId, result)
                    }
                    control.progress(result)
                }
                return JSObject(result.toString())
            }
            val listing = io.list(folderId, cancellation, deadline)
            val files = listing.getJSONArray("files")
            val byDocument = known.groupBy { JSONObject(it["source_ref"]!!).getString("documentId") }
            val seen = mutableSetOf<String>()
            result.put("total", files.length())
            val listingErrors = listing.getJSONArray("errors")
            for (i in 0 until listingErrors.length()) error(result, "", listingErrors.getJSONObject(i).getString("code"))
            for (i in 0 until files.length()) {
                active(folderId, control)
                val entry = files.getJSONObject(i)
                val documentId = entry.getString("documentId")
                val name = entry.getString("name")
                if (!seen.add(documentId)) throw NativeImportFailure("invalid_reference")
                val linked = byDocument[documentId].orEmpty()
                var spool: File? = null
                var staged: File? = null
                try {
                    if (!validName(name)) throw NativeImportFailure("invalid_reference")
                    val format = NativeBookMetadata.format(name)
                    val size = if (entry.isNull("size")) null else entry.getLong("size")
                    val modified = if (entry.isNull("modifiedAt")) null else entry.getLong("modifiedAt")
                    if (size != null && (size <= 0 || size > 64L * 1024 * 1024)) throw NativeImportFailure("resource_limit")
                    val version = JSONArray().put(size ?: JSONObject.NULL).put(modified ?: JSONObject.NULL).toString()
                    val reference =
                        JSONObject()
                            .put(
                                "folderId",
                                folderId,
                            ).put("documentId", documentId)
                            .put("relativePath", entry.getString("relativePath"))
                            .put("version", version)
                    val signature = "$folderId|$documentId|$version|$name|${entry.getString("relativePath")}"
                    val checkedAt = checks[signature]
                    val unknownDue =
                        (size == null || modified == null) &&
                            (force || checkedAt == null || System.currentTimeMillis() - checkedAt !in 0..299999)
                    val mustParse =
                        linked.isEmpty() || unknownDue ||
                            linked.any {
                                JSONObject(it["source_ref"]!!).optString("version") != version ||
                                    it["file_availability"] != "available"
                            }
                    var metadata: NativeBibliography? = null
                    val id = UUID.nameUUIDFromBytes("pagewise-folder:$folderId:$documentId".toByteArray()).toString()
                    if (mustParse) {
                        val read = io.read(folderId, documentId, cancellation, deadline)
                        spool = File(context.dataDir, read.getString("path"))
                        metadata = parse(spool!!, name, linked.isEmpty(), control)
                        staged = stage(metadata.cover, id, jobId)
                    }
                    active(folderId, control)
                    control.commit {
                        io.authorized(folderId)
                        var newCover = false
                        try {
                            db.transaction {
                                if (linked.isEmpty() && metadata != null && db.copied(id) == null) {
                                    publish(staged, id)
                                    newCover = staged != null
                                    db.insert(id, metadata!!, name, format, folder.label, "book", reference, newCover)
                                    count(result, "imported")
                                } else if (linked.isNotEmpty()) {
                                    for (book in linked) db.updateReference(book, reference, name, format, "available")
                                    if (mustParse ||
                                        linked.any { it["file_name"] != name || it["source_ref"] != reference.toString() }
                                    ) {
                                        count(result, "updated")
                                    } else {
                                        count(result, "skipped")
                                    }
                                } else {
                                    count(result, "skipped")
                                }
                                count(result, "done")
                                db.record(jobId, result)
                            }
                        } catch (failure: Exception) {
                            if (newCover && db.copied(id) == null) File(context.dataDir, "covers/$id.jpg").delete()
                            throw failure
                        }
                        control.progress(result)
                    }
                    if (mustParse && (size == null || modified == null)) {
                        if (checks.size >= 5000) checks.remove(checks.keys.first())
                        checks[signature] = System.currentTimeMillis()
                    }
                } catch (failure: Exception) {
                    control.checkpoint()
                    val code = code(failure)
                    if (code in
                        setOf("permission_denied", "source_changed", "database_error", "receipt_error", "commit_outcome_unknown")
                    ) {
                        throw failure
                    }
                    control.commit {
                        io.authorized(folderId)
                        db.transaction {
                            if (code == "not_found") for (book in linked) db.availability(book, "missing")
                            count(result, "failed")
                            count(result, "done")
                            error(result, name, code)
                            db.record(jobId, result)
                        }
                        control.progress(result)
                    }
                } finally {
                    spool?.delete()
                    staged?.delete()
                }
            }
            active(folderId, control)
            control.commit {
                io.authorized(folderId)
                db.transaction {
                    if (listing.getBoolean("complete") && result.getInt("failed") == 0 && result.getJSONArray("errors").length() == 0) {
                        for (book in known) {
                            if (JSONObject(book["source_ref"]!!).getString("documentId") !in
                                seen
                            ) {
                                db.availability(book, "missing")
                            }
                        }
                    }
                    result
                        .put(
                            "complete",
                            listing.getBoolean("complete") && result.getInt("failed") == 0 && result.getJSONArray("errors").length() == 0,
                        ).put("finished", true)
                    db.record(jobId, result)
                }
                control.progress(result)
            }
            return JSObject(result.toString())
        }
    }

    fun import(
        jobId: String,
        request: JSONObject,
        control: NativeImportControl,
    ): JSObject {
        val items = request.getJSONArray("items")
        if (items.length() !in 1..MAX_ITEMS) throw NativeImportFailure("resource_limit")
        val source = request.optString("source", "本地导入")
        if (source.length > 1024) throw NativeImportFailure("resource_limit")
        val seen = mutableSetOf<String>()
        var bytes = 0L
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            if (!validName(item.getString("fileName")) || !seen.add(item.getString("path"))) throw NativeImportFailure("invalid_reference")
            bytes += temp(item.getString("path")).length()
        }
        if (bytes > MAX_BATCH_BYTES) throw NativeImportFailure("resource_limit")
        NativeImportDatabase(context).use { db ->
            var result = summary("import").put("total", items.length())
            control.commit { result = db.transaction { db.batch(jobId, requestFingerprint("import", "app-import", request), result) } }
            val start = result.getInt("done")
            for (i in start until items.length()) {
                control.checkpoint()
                val item = items.getJSONObject(i)
                val name = item.getString("fileName")
                val input = temp(item.getString("path"))
                val id = UUID.nameUUIDFromBytes("pagewise-copy:${input.name}".toByteArray()).toString()
                var cover: File? = null
                var stagedBook: File? = null
                try {
                    val format = NativeBookMetadata.format(name)
                    val existing = db.copied(id)
                    if (existing != null &&
                        (existing["source_ref"] != null || existing["file_name"] != name)
                    ) {
                        throw NativeImportFailure("conflict")
                    }
                    if (existing == null) {
                        if (!input.isFile) throw NativeImportFailure("not_found")
                        val parsed = parse(input, name, true, control)
                        val overrides = item.optJSONObject("overrides") ?: JSONObject()

                        fun override(
                            key: String,
                            original: String,
                        ): String =
                            overrides.optString(key).ifEmpty { original }.also {
                                if (it.length >
                                    65536
                                ) {
                                    throw NativeImportFailure("resource_limit")
                                }
                            }
                        val meta =
                            parsed.copy(
                                title = override("title", parsed.title),
                                author = override("author", parsed.author),
                                description =
                                    override(
                                        "description",
                                        parsed.description ?: "",
                                    ).ifEmpty { null },
                            )
                        val kind = overrides.optString("kind", "book")
                        if (kind !in setOf("book", "paper")) throw NativeImportFailure("invalid_reference")
                        cover = stage(meta.cover, id, jobId)
                        val books =
                            File(context.dataDir, "books").apply {
                                if (!isDirectory &&
                                    !mkdirs()
                                ) {
                                    throw NativeImportFailure("io_error")
                                }
                            }
                        stagedBook = File(books, ".native-$jobId-$id.tmp")
                        input.inputStream().use { from ->
                            FileOutputStream(stagedBook!!).use { to ->
                                val buffer = ByteArray(65536)
                                var written = 0L
                                while (true) {
                                    control.checkpoint()
                                    val n = from.read(buffer)
                                    if (n <
                                        0
                                    ) {
                                        break
                                    }
                                    written += n
                                    if (written >
                                        1024L * 1024 * 1024
                                    ) {
                                        throw NativeImportFailure("resource_limit")
                                    }
                                    to.write(buffer, 0, n)
                                }
                                to.fd.sync()
                            }
                        }
                        control.commit {
                            var published = false
                            try {
                                db.transaction {
                                    Os.rename(stagedBook!!.path, File(books, "$id.${name.substringAfterLast('.')}").path)
                                    published = true
                                    publish(cover, id)
                                    db.insert(id, meta, name, format, source, kind, null, cover != null)
                                    count(result, "imported")
                                    count(result, "done")
                                    result.getJSONArray("results").put(JSONObject().put("ok", true).put("fileName", name).put("bookId", id))
                                    db.record(jobId, result)
                                }
                            } catch (failure: Exception) {
                                if (published &&
                                    db.copied(id) == null
                                ) {
                                    File(books, "$id.${name.substringAfterLast('.')}").delete()
                                    File(context.dataDir, "covers/$id.jpg").delete()
                                }
                                throw failure
                            }
                            control.progress(result)
                        }
                    } else {
                        control.commit {
                            db.transaction {
                                count(result, "skipped")
                                count(result, "done")
                                result.getJSONArray("results").put(JSONObject().put("ok", true).put("fileName", name).put("bookId", id))
                                db.record(jobId, result)
                            }
                            control.progress(result)
                        }
                    }
                    input.delete()
                } catch (failure: Exception) {
                    control.checkpoint()
                    val code = code(failure)
                    if (code in setOf("database_error", "receipt_error", "commit_outcome_unknown")) throw failure
                    control.commit {
                        db.transaction {
                            count(result, "failed")
                            count(result, "done")
                            error(result, name, code)
                            result.getJSONArray("results").put(JSONObject().put("ok", false).put("fileName", name).put("error", code))
                            db.record(jobId, result)
                        }
                        control.progress(result)
                    }
                    input.delete()
                } finally {
                    cover?.delete()
                    stagedBook?.delete()
                }
            }
            control.commit {
                db.transaction {
                    result.put("complete", result.getInt("failed") == 0)
                    db.record(jobId, result)
                }
                control.progress(result)
            }
            return JSObject(result.toString())
        }
    }
}
