package io.pagewise.reader

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.io.Closeable
import java.io.File

/** Opens only the existing default Tauri library. It never creates a replacement books database. */
internal class NativeImportDatabase(
    context: Context,
) : Closeable {
    private val database: SQLiteDatabase

    init {
        val path = File(context.dataDir, "lightread.db")
        if (!path.isFile) throw NativeImportFailure("library_not_initialized")
        database =
            SQLiteDatabase.openDatabase(
                path.path,
                null,
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.NO_LOCALIZED_COLLATORS or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
            )
        try {
            database.execSQL("PRAGMA busy_timeout=5000")
            val required =
                setOf(
                    "id",
                    "title",
                    "author",
                    "format",
                    "file_name",
                    "description",
                    "language",
                    "tags",
                    "added_at",
                    "source",
                    "has_cover",
                    "kind",
                    "publisher",
                    "publication_date",
                    "source_ref",
                    "file_availability",
                )
            val columns = rows("PRAGMA table_info(books)").mapNotNull { it["name"] }.toSet()
            if (!columns.containsAll(required)) throw NativeImportFailure("library_schema_mismatch")
            database.execSQL(
                """CREATE TABLE IF NOT EXISTS native_import_batches (
                job_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL, updated_at INTEGER NOT NULL
            )""",
            )
        } catch (error: Exception) {
            database.close()
            throw error
        }
    }

    fun rows(
        sql: String,
        args: List<String> = emptyList(),
    ): List<Map<String, String?>> =
        database.rawQuery(sql, args.toTypedArray()).use { cursor ->
            val names = cursor.columnNames
            val result = ArrayList<Map<String, String?>>()
            while (cursor.moveToNext()) {
                result.add(
                    names.withIndex().associate {
                        it.value to
                            if (cursor.isNull(it.index)) null else cursor.getString(it.index)
                    },
                )
            }
            result
        }

    fun execute(
        sql: String,
        args: List<Any?> = emptyList(),
    ) {
        database.execSQL(sql, args.toTypedArray())
    }

    fun <T> transaction(action: () -> T): T {
        database.beginTransactionNonExclusive()
        var failure: Throwable? = null
        try {
            val result = action()
            database.setTransactionSuccessful()
            return result
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            try {
                database.endTransaction()
            } catch (error: Exception) {
                val uncertain = NativeImportFailure("commit_outcome_unknown").apply { initCause(error) }
                failure?.let { uncertain.addSuppressed(it) }
                throw uncertain
            }
        }
    }

    fun batch(
        jobId: String,
        hash: String,
        initial: JSONObject,
    ): JSONObject {
        val previous = rows("SELECT request_hash, result FROM native_import_batches WHERE job_id = ?", listOf(jobId)).firstOrNull()
        if (previous != null) {
            if (previous["request_hash"] != hash) throw NativeImportFailure("invalid_reference")
            return JSONObject(previous["result"] ?: throw NativeImportFailure("library_schema_mismatch"))
        }
        execute(
            "DELETE FROM native_import_batches WHERE job_id != ? AND (updated_at < ? OR job_id IN (SELECT job_id FROM native_import_batches ORDER BY updated_at DESC,job_id LIMIT -1 OFFSET 255))",
            listOf(
                jobId,
                System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000,
            ),
        )
        execute(
            "INSERT INTO native_import_batches(job_id,request_hash,result,updated_at) VALUES(?,?,?,?)",
            listOf(jobId, hash, initial.toString(), System.currentTimeMillis()),
        )
        return initial
    }

    fun record(
        jobId: String,
        result: JSONObject,
    ) {
        if (result.optString("operation") == "import" && result.getInt("total") > 0 && result.getInt("done") == result.getInt("total")) {
            result.put("finished", true).put("complete", result.getInt("failed") == 0 && result.getJSONArray("errors").length() == 0)
        }
        if (result.toString().toByteArray().size > 2 * 1024 * 1024) throw NativeImportFailure("resource_limit")
        execute(
            "UPDATE native_import_batches SET result = ?, updated_at = ? WHERE job_id = ?",
            listOf(result.toString(), System.currentTimeMillis(), jobId),
        )
    }

    fun linked(
        folderId: String,
        documentId: String? = null,
    ): List<Map<String, String?>> =
        rows("SELECT id, source_ref, file_name, format, file_availability FROM books WHERE source_ref IS NOT NULL").filter { row ->
            val ref = JSONObject(row["source_ref"] ?: throw NativeImportFailure("library_schema_mismatch"))
            ref.getString("folderId") == folderId && (documentId == null || ref.getString("documentId") == documentId)
        }

    fun updateReference(
        row: Map<String, String?>,
        reference: JSONObject,
        fileName: String,
        format: String,
        availability: String,
    ) {
        execute(
            "UPDATE books SET source_ref=?,file_name=?,format=?,file_availability=? WHERE id=? AND source_ref=?",
            listOf(reference.toString(), fileName, format, availability, row["id"], row["source_ref"]),
        )
        if (rows("SELECT changes() AS changed").firstOrNull()?.get("changed") != "1") throw NativeImportFailure("source_changed")
    }

    fun availability(
        row: Map<String, String?>,
        availability: String,
    ) {
        execute("UPDATE books SET file_availability=? WHERE id=? AND source_ref=?", listOf(availability, row["id"], row["source_ref"]))
    }

    fun insert(
        id: String,
        meta: NativeBibliography,
        fileName: String,
        format: String,
        source: String,
        kind: String,
        reference: JSONObject?,
        hasCover: Boolean,
    ) {
        execute(
            """INSERT INTO books(id,title,author,format,file_name,description,language,tags,added_at,source,has_cover,kind,publisher,publication_date,source_ref,file_availability)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            listOf(
                id,
                meta.title,
                meta.author,
                format,
                fileName,
                meta.description,
                meta.language,
                org.json.JSONArray(meta.tags).toString(),
                System.currentTimeMillis(),
                source,
                if (hasCover) 1 else 0,
                kind,
                meta.publisher,
                meta.publicationDate,
                reference?.toString(),
                if (reference ==
                    null
                ) {
                    null
                } else {
                    "available"
                },
            ),
        )
    }

    fun copied(id: String) = rows("SELECT id, file_name, source_ref FROM books WHERE id = ?", listOf(id)).firstOrNull()

    override fun close() = database.close()

    companion object {
        /** Read-only reconciliation also works after the owning service/process stopped. */
        fun progress(
            context: Context,
            jobId: String,
            expectedHash: String? = null,
        ): JSONObject? {
            val file = File(context.dataDir, "lightread.db")
            if (!file.isFile) return null
            SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS).use { db ->
                val exists =
                    db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='native_import_batches'", null).use {
                        it.moveToFirst()
                    }
                if (!exists) return null
                db.rawQuery("SELECT request_hash,result FROM native_import_batches WHERE job_id = ?", arrayOf(jobId)).use { cursor ->
                    if (!cursor.moveToFirst()) return null
                    if (expectedHash != null && cursor.getString(0) != expectedHash) throw NativeImportFailure("invalid_reference")
                    return JSONObject(cursor.getString(1))
                }
            }
        }
    }
}
