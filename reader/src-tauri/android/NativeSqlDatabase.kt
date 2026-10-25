package io.pagewise.reader

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteDatabaseLockedException
import android.database.sqlite.SQLiteException
import android.database.sqlite.SQLiteProgram
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File

/** The Web storage facade shares Android's SQLite implementation with native clients. */
internal class NativeSqlDatabase(
    context: Context,
    root: String?,
    private val initializing: Boolean = false,
) : Closeable {
    private val database: SQLiteDatabase
    private val directory: File
    private val defaultRoot: Boolean
    private val newlyCreated: Boolean

    init {
        val prefs = context.getSharedPreferences("pagewise-native-state-location", Context.MODE_PRIVATE)
        val located = prefs.getString("root", null)
        val requested = root ?: located.orEmpty()
        if (located != null && requested != located) fail("library_root_conflict")
        if (requested.startsWith("content:") || (requested.isNotEmpty() && !File(requested).isAbsolute)) fail("unsupported_library_root")
        defaultRoot = requested.isEmpty()
        directory = if (defaultRoot) context.dataDir else File(requested).canonicalFile
        if (!directory.isDirectory) fail("library_root_unavailable")
        val file = File(directory, "lightread.db")
        newlyCreated = located == null && defaultRoot && !file.exists()
        database = CanonicalDatabase.open(file, create = newlyCreated)
        try {
            database.rawQuery("PRAGMA busy_timeout=5000", null).use { it.moveToFirst() }
            if (located != null && !initializing) {
                database.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('books','annotations')", null).use {
                    val tables = mutableSetOf<String>()
                    while (it.moveToNext()) tables.add(it.getString(0))
                    if (tables != setOf("books", "annotations")) fail("library_schema_mismatch")
                }
            }
        } catch (error: Throwable) {
            database.close()
            throw error
        }
    }

    private fun fail(code: String = "invalid_payload"): Nothing = throw CanonicalDatabaseFailure(code)

    private fun sql(payload: JSONObject): String {
        val value = payload.opt("sql") as? String ?: fail()
        if (value.isBlank() || value.length > 1024 * 1024) fail()
        val first =
            value
                .trimStart()
                .substringBefore(' ')
                .substringBefore('\n')
                .uppercase()
        if (first !in setOf("SELECT", "PRAGMA", "WITH", "CREATE", "ALTER", "INSERT", "UPDATE", "DELETE")) fail()
        if (first == "PRAGMA" && !Regex("(?is)^\\s*PRAGMA\\s+table_info\\s*\\(.*\\)\\s*$").matches(value)) fail()
        return value
    }

    private fun values(payload: JSONObject): JSONArray =
        if (!payload.has("values")) JSONArray() else payload.opt("values") as? JSONArray ?: fail()

    private fun bind(
        program: SQLiteProgram,
        values: JSONArray,
    ) {
        for (i in 0 until values.length()) {
            when (val value = values.get(i)) {
                JSONObject.NULL -> {
                    program.bindNull(i + 1)
                }

                is String -> {
                    program.bindString(i + 1, value)
                }

                is Boolean -> {
                    program.bindLong(i + 1, if (value) 1 else 0)
                }

                is Double -> {
                    if (!value.isFinite()) fail()
                    program.bindDouble(i + 1, value)
                }

                is Float -> {
                    if (!value.isFinite()) fail()
                    program.bindDouble(i + 1, value.toDouble())
                }

                is Number -> {
                    program.bindLong(i + 1, value.toLong())
                }

                else -> {
                    fail()
                }
            }
        }
    }

    private fun query(
        sql: String,
        values: JSONArray,
    ): JSONArray {
        val factory =
            SQLiteDatabase.CursorFactory { _, driver, table, query ->
                bind(query, values)
                SQLiteCursor(driver, table, query)
            }
        return database.rawQueryWithFactory(factory, sql, emptyArray(), "").use { cursor ->
            val result = JSONArray()
            while (cursor.moveToNext()) {
                val row = JSONObject()
                for (column in 0 until cursor.columnCount) {
                    val value: Any =
                        when (cursor.getType(column)) {
                            Cursor.FIELD_TYPE_NULL -> {
                                JSONObject.NULL
                            }

                            Cursor.FIELD_TYPE_INTEGER -> {
                                cursor.getLong(column).also {
                                    if (it !in
                                        -9007199254740991L..9007199254740991L
                                    ) {
                                        fail("library_database_unsafe_integer")
                                    }
                                }
                            }

                            Cursor.FIELD_TYPE_FLOAT -> {
                                cursor.getDouble(column).also { if (!it.isFinite()) fail("library_database_unsafe_number") }
                            }

                            Cursor.FIELD_TYPE_BLOB -> {
                                JSONArray().apply { cursor.getBlob(column).forEach { put(it.toInt() and 255) } }
                            }

                            else -> {
                                cursor.getString(column)
                            }
                        }
                    row.put(cursor.getColumnName(column), value)
                }
                result.put(row)
            }
            result
        }
    }

    private fun execute(
        sql: String,
        values: JSONArray,
    ): JSONObject {
        database.compileStatement(sql).use { statement ->
            bind(statement, values)
            statement.execute()
        }
        val change = query("SELECT changes() AS affected, last_insert_rowid() AS inserted", JSONArray()).getJSONObject(0)
        val ddl = Regex("(?is)^\\s*(CREATE|ALTER)\\b").containsMatchIn(sql)
        return JSONObject().put("rowsAffected", if (ddl) 0 else change.getLong("affected")).put("lastInsertId", change.getLong("inserted"))
    }

    private fun <T> transaction(work: () -> T): T {
        database.beginTransactionNonExclusive()
        try {
            val result = work()
            database.setTransactionSuccessful()
            return result
        } finally {
            try {
                database.endTransaction()
            } catch (error: Exception) {
                throw CanonicalDatabaseFailure("commit_outcome_unknown", error)
            }
        }
    }

    private fun initializeSchema(payload: JSONObject): JSONObject {
        val statements = payload.opt("statements") as? JSONArray ?: fail()
        if (statements.length() !in 1..128) fail()
        val ddl =
            (0 until statements.length()).map {
                val statement = statements.opt(it) as? String ?: fail()
                if (statement.length > 1024 * 1024 ||
                    !Regex("(?is)^\\s*CREATE\\s+(TABLE|(?:UNIQUE\\s+)?INDEX)\\s+IF\\s+NOT\\s+EXISTS\\b").containsMatchIn(statement)
                ) {
                    fail()
                }
                statement
            }
        return transaction {
            val names = mutableSetOf<String>()
            database.rawQuery("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'", null).use {
                while (it.moveToNext()) names.add(it.getString(0))
            }
            val library = setOf("books", "annotations")
            if (!names.containsAll(library)) {
                val core =
                    setOf(
                        "native_core_settings",
                        "native_core_reading",
                        "native_core_hashes",
                        "native_core_identity",
                        "native_core_events",
                        "native_core_migration",
                        "native_core_stage",
                        "native_core_chunks",
                    )
                val evidence =
                    listOf("books", "covers").any {
                        val folder = File(directory, it)
                        folder.exists() && (!folder.isDirectory || folder.list()?.isEmpty() != true)
                    }
                if (!defaultRoot || evidence || names.any { it in library } ||
                    !(names.isEmpty() && newlyCreated || names == core)
                ) {
                    fail("library_schema_mismatch")
                }
                if (names == core) {
                    // PW17-RELEASE-INIT-01: a settings locator does not prove that the separate book schema is ready.
                    val empty =
                        listOf("reading", "hashes", "events", "stage", "chunks").all { table ->
                            database
                                .rawQuery(
                                    "SELECT count(*) FROM native_core_$table",
                                    null,
                                ).use { it.moveToFirst() && it.getLong(0) == 0L }
                        }
                    val fresh =
                        database
                            .rawQuery(
                                "SELECT state,expected_rows,expected_chunks FROM native_core_migration WHERE id=1",
                                null,
                            ).use {
                                it.count == 1 && it.moveToFirst() && it.getString(
                                    0,
                                ) == "complete" && it.getLong(1) == 0L && it.getLong(2) == 0L
                            }
                    if (!empty || !fresh) fail("library_schema_mismatch")
                }
            }
            ddl.forEach { database.execSQL(it) }
            val ready =
                database.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('books','annotations')", null).use {
                    it.count ==
                        2
                }
            if (!ready) fail("library_schema_mismatch")
            JSONObject().put("rowsAffected", 0).put("lastInsertId", 0)
        }
    }

    private fun sameTags(
        raw: String?,
        expected: JSONArray,
    ): Boolean {
        if (raw == null) return false
        val actual = JSONArray(raw)
        if (actual.length() != expected.length()) return false
        return (0 until actual.length()).all { actual.get(it) is String && actual.getString(it) == expected.opt(it) }
    }

    private fun classify(payload: JSONObject): JSONObject =
        transaction {
            val updates = payload.opt("updates") as? JSONArray ?: fail()
            if (updates.length() > 10000) fail("resource_limit")
            val ids = mutableSetOf<String>()
            val columns =
                mapOf(
                    "title" to "title",
                    "author" to "author",
                    "publisher" to "publisher",
                    "publicationDate" to "publication_date",
                    "description" to "description",
                )
            val prepared = mutableListOf<JSONObject>()
            for (i in 0 until updates.length()) {
                val update = updates.opt(i) as? JSONObject ?: fail()
                val id = update.opt("id") as? String ?: fail()
                if (id.isEmpty() || !ids.add(id)) fail()
                val tags = update.opt("tags") as? JSONArray ?: fail()
                if ((0 until tags.length()).any { tags.opt(it) !is String }) fail()
                val classification = update.opt("classification")
                val structured = classification is JSONObject
                if (!structured && classification != JSONObject.NULL) fail()
                if (structured) {
                    val expected = update.opt("expectedRevision") as? Number ?: fail()
                    if (expected.toDouble() < 0 || expected.toDouble() != expected.toLong().toDouble() ||
                        expected.toLong() > 9007199254740990L
                    ) {
                        fail()
                    }
                    if ((classification as JSONObject).optLong("revision", -1) != expected.toLong() + 1) fail()
                } else if (update.opt("expectedTags") !is JSONArray) {
                    fail()
                }
                val rows =
                    query(
                        "SELECT classification,tags,title,author,publisher,publication_date,description FROM books WHERE id=$1",
                        JSONArray().put(id),
                    )
                if (rows.length() != 1) return@transaction JSONObject().put("rowsAffected", 0)
                val stored = rows.getJSONObject(0)
                val current = if (stored.isNull("classification")) null else JSONObject(stored.getString("classification"))
                if (structured &&
                    (current?.optLong("revision", -1) ?: 0) != update.getLong("expectedRevision")
                ) {
                    return@transaction JSONObject().put("rowsAffected", 0)
                }
                if (update.opt("expectedTags") is JSONArray &&
                    (current != null || !sameTags(stored.optString("tags"), update.getJSONArray("expectedTags")))
                ) {
                    return@transaction JSONObject().put("rowsAffected", 0)
                }
                val metadata = update.opt("expectedMetadata")
                if (metadata != null && metadata != JSONObject.NULL) {
                    if (metadata !is JSONObject) fail()
                    for ((key, column) in columns) {
                        val expected = metadata.opt(key).let { if (it == JSONObject.NULL) null else it }
                        if (expected != null && expected !is String) fail()
                        val actual = stored.opt(column).let { if (it == JSONObject.NULL) null else it }
                        if (actual != expected) return@transaction JSONObject().put("rowsAffected", 0)
                    }
                }
                prepared.add(update)
            }
            for (update in prepared) {
                val classification = update.opt("classification").let { if (it is JSONObject) it.toString() else JSONObject.NULL }
                val result =
                    execute(
                        "UPDATE books SET classification=$1,tags=$2 WHERE id=$3",
                        JSONArray().put(classification).put(update.getJSONArray("tags").toString()).put(update.getString("id")),
                    )
                if (result.getInt("rowsAffected") != 1) fail("library_database_error")
            }
            JSONObject().put("rowsAffected", prepared.size)
        }

    fun command(
        action: String,
        payload: JSONObject,
    ): JSONObject =
        try {
            if (initializing && action != "sql.initialize") fail()
            when (action) {
                "sql.initialize" -> {
                    initializeSchema(payload)
                }

                "sql.select" -> {
                    val statement = sql(payload)
                    if (!Regex("(?is)^\\s*(SELECT|PRAGMA)\\b").containsMatchIn(statement)) fail()
                    JSONObject().put("rows", query(statement, values(payload)))
                }

                "sql.execute" -> {
                    transaction { execute(sql(payload), values(payload)) }
                }

                "sql.batch" -> {
                    transaction {
                        val statements = payload.opt("statements") as? JSONArray ?: fail()
                        if (statements.length() !in 1..256) fail()
                        var result = JSONObject().put("rowsAffected", 0)
                        for (i in 0 until statements.length()) {
                            result =
                                execute(sql(JSONObject().put("sql", statements.get(i))), JSONArray())
                        }
                        result
                    }
                }

                "sql.classify" -> {
                    classify(payload)
                }

                else -> {
                    fail()
                }
            }
        } catch (error: SQLiteDatabaseCorruptException) {
            throw CanonicalDatabaseFailure("library_database_corrupt", error)
        } catch (error: SQLiteDatabaseLockedException) {
            throw CanonicalDatabaseFailure("library_database_busy", error)
        } catch (error: SQLiteException) {
            val code =
                if (error.message?.contains("duplicate column name:", ignoreCase = true) ==
                    true
                ) {
                    "library_database_duplicate_column"
                } else {
                    "library_database_error"
                }
            throw CanonicalDatabaseFailure(code, error)
        }

    override fun close() = database.close()
}
