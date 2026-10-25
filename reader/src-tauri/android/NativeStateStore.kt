package io.pagewise.reader

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID

internal class NativeStateFailure(
    val code: String,
    cause: Throwable? = null,
) : java.io.IOException(code, cause)

/** One SQLite authority for settings/statistics. Existing books/annotations are never recreated here. */
internal class NativeStateStore(
    private val context: Context,
    requestedRoot: String? = null,
) : java.io.Closeable {
    companion object {
        private val lock = Any()
        private const val MAX_JSON = 8 * 1024 * 1024
        private const val PAGE = 256
        private const val RETENTION = 7L * 24 * 60 * 60 * 1000
        private val UUID_RE = Regex("[a-f0-9-]{36}")
        private val DAY = Regex("\\d{4}-\\d{2}-\\d{2}")

        private fun hash(value: String) =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") {
                "%02x".format(it)
            }

        private fun invalid(): Nothing = throw NativeStateFailure("invalid_payload")

        private fun canonical(value: Any?): String =
            when (value) {
                null, JSONObject.NULL -> {
                    "null"
                }

                is JSONObject -> {
                    value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
                        canonical(it) + ":" +
                            canonical(value.get(it))
                    }
                }

                is JSONArray -> {
                    (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
                }

                else -> {
                    JSONArray().put(value).toString().let { it.substring(1, it.length - 1) }
                }
            }

        private fun string(
            value: JSONObject,
            key: String,
            max: Int = 4096,
        ): String {
            val text = value.get(key) as? String ?: invalid()
            if (text.length > max) invalid()
            return text
        }

        private fun finite(
            value: JSONObject,
            key: String,
        ): Double {
            val number = (value.get(key) as? Number)?.toDouble() ?: invalid()
            if (!number.isFinite()) invalid()
            return number
        }

        private fun integer(
            value: JSONObject,
            key: String,
            max: Int,
        ): Int {
            val n = finite(value, key)
            if (n < 0 || n > max || n != n.toInt().toDouble()) invalid()
            return n.toInt()
        }

        private fun row(value: JSONObject): JSONObject {
            val key = string(value, "key")
            val i = key.indexOf('|')
            val j = key.indexOf('|', i + 1)
            if (i <= 0 || j <= i || !DAY.matches(key.substring(i + 1, j))) invalid()
            val ref = key.substring(j + 1)
            val seconds = finite(value, "seconds")
            if (seconds <= 0) invalid()
            val result =
                JSONObject()
                    .put("key", key)
                    .put("device", key.substring(0, i))
                    .put("day", key.substring(i + 1, j))
                    .put("title", if (value.has("title") && value.get("title") is String) string(value, "title", 65536) else "")
                    .put("kind", if (value.optString("kind") == "paper") "paper" else "book")
                    .put("seconds", seconds)
                    .put("updatedAt", if (value.has("updatedAt") && !value.isNull("updatedAt")) finite(value, "updatedAt") else 0)
            when {
                ref.startsWith("id:") && ref.length > 3 -> result.put("bookId", ref.substring(3))
                ref.startsWith("h:") && ref.length > 2 -> result.put("hash", ref.substring(2))
                else -> invalid()
            }
            return result
        }
    }

    private val locator = context.getSharedPreferences("pagewise-native-state-location", Context.MODE_PRIVATE)
    private val root: String
    private val database: SQLiteDatabase

    init {
        val located = locator.getString("root", null)
        if (located == null && requestedRoot == null) throw NativeStateFailure("migration_not_initialized")
        if (located != null && requestedRoot != null && located != requestedRoot) throw NativeStateFailure("library_root_conflict")
        root = located ?: requestedRoot.orEmpty()
        if (root.startsWith("content:") ||
            (root.isNotEmpty() && !File(root).isAbsolute)
        ) {
            throw NativeStateFailure("unsupported_library_root")
        }
        val directory = if (root.isEmpty()) context.dataDir else File(root).canonicalFile
        if (!directory.isDirectory) throw NativeStateFailure("library_root_unavailable")
        val file = File(directory, "lightread.db")
        if ((located != null || root.isNotEmpty()) && !file.isFile) throw NativeStateFailure("library_database_missing")
        database = CanonicalDatabase.open(file, create = located == null && root.isEmpty() && !file.exists())
        try {
            rows("PRAGMA busy_timeout = 5000")
            val ddls =
                listOf(
                    "CREATE TABLE IF NOT EXISTS native_core_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_reading(key TEXT PRIMARY KEY, seconds REAL NOT NULL, json TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_hashes(book_id TEXT PRIMARY KEY, hash TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_identity(id INTEGER PRIMARY KEY CHECK(id=1), device TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_events(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_migration(id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, settings TEXT NOT NULL, identity TEXT NOT NULL, expected_rows INTEGER NOT NULL, expected_chunks INTEGER NOT NULL, state TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_stage(key TEXT PRIMARY KEY, seconds REAL NOT NULL, json TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS native_core_chunks(ordinal INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, rows INTEGER NOT NULL)",
                )
            for (ddl in ddls) database.execSQL(ddl)
            if (located != null && migration()?.get("state") != "complete") throw NativeStateFailure("canonical_state_missing")
            // Existing collisions/corruption must fail, not silently create a substitute store.
            for ((table, required) in mapOf(
                "native_core_settings" to setOf("id", "revision", "json"),
                "native_core_reading" to setOf("key", "seconds", "json"),
                "native_core_migration" to setOf("id", "fingerprint", "settings", "identity", "expected_rows", "expected_chunks", "state"),
            )) {
                if (!rows(
                        "PRAGMA table_info($table)",
                    ).map { it["name"] }.containsAll(required)
                ) {
                    throw NativeStateFailure("native_state_schema_mismatch")
                }
            }
        } catch (error: Exception) {
            database.close()
            throw error
        }
    }

    override fun close() = database.close()

    private fun execute(
        sql: String,
        args: List<Any?> = emptyList(),
    ) = database.execSQL(sql, args.toTypedArray())

    private fun rows(
        sql: String,
        args: List<String> = emptyList(),
    ): List<Map<String, String?>> =
        database.rawQuery(sql, args.toTypedArray()).use { cursor ->
            val result = ArrayList<Map<String, String?>>()
            while (cursor.moveToNext()) {
                result.add(
                    cursor.columnNames.withIndex().associate {
                        it.value to
                            if (cursor.isNull(it.index)) null else cursor.getString(it.index)
                    },
                )
            }
            result
        }

    private fun scalar(sql: String) =
        rows(sql)
            .single()
            .values
            .first()!!
            .toInt()

    private fun <T> transaction(action: () -> T): T {
        database.beginTransaction()
        var primary: Exception? = null
        try {
            val result = action()
            database.setTransactionSuccessful()
            return result
        } catch (
            error: Exception,
        ) {
            primary = error
            throw error
        } finally {
            try {
                database.endTransaction()
            } catch (error: Exception) {
                val unknown = NativeStateFailure("commit_outcome_unknown", error)
                primary?.let { unknown.addSuppressed(it) }
                throw unknown
            }
        }
    }

    private fun migration() = rows("SELECT * FROM native_core_migration WHERE id=1").firstOrNull()

    private fun requireReady() {
        if (migration()?.get("state") != "complete") throw NativeStateFailure("native_state_not_ready")
    }

    private fun settings(): JSONObject {
        requireReady()
        val current =
            rows("SELECT revision,json FROM native_core_settings WHERE id=1").singleOrNull()
                ?: throw NativeStateFailure("native_state_schema_mismatch")
        return JSONObject().put("revision", current["revision"]!!.toLong()).put("raw", current["json"]!!)
    }

    private fun readyStatus(): JSONObject {
        val migration = migration() ?: return JSONObject().put("state", "empty")
        if (migration["state"] != "complete") {
            return JSONObject()
                .put("state", "staging")
                .put(
                    "nextChunk",
                    scalar("SELECT count(*) FROM native_core_chunks"),
                ).put("stagedRows", scalar("SELECT count(*) FROM native_core_stage"))
        }
        val current = settings()
        // Re-establish a missing locator after a lost filesystem preference ACK; it contains no credentials.
        if (!locator.edit().putString("root", root).commit()) throw NativeStateFailure("location_receipt_error")
        return JSONObject()
            .put(
                "state",
                "complete",
            ).put("settings", current)
            .put("rows", scalar("SELECT count(*) FROM native_core_reading"))
    }

    fun command(
        action: String,
        payload: JSONObject,
    ): JSONObject =
        synchronized(lock) {
            try {
                if (payload.toString().toByteArray(Charsets.UTF_8).size > MAX_JSON) throw NativeStateFailure("resource_limit")
                when (action) {
                    "status" -> {
                        readyStatus()
                    }

                    "migrationBegin" -> {
                        beginMigration(payload)
                    }

                    "migrationChunk" -> {
                        migrationChunk(payload)
                    }

                    "migrationCommit" -> {
                        commitMigration()
                    }

                    "settingsGet" -> {
                        settings()
                    }

                    "settingsPatch" -> {
                        mutation(action, payload) { patchSettings(payload) }
                    }

                    "readingPage" -> {
                        readingPage(payload)
                    }

                    "readingAdd" -> {
                        mutation(action, payload) {
                            addReading(payload)
                            JSONObject().put("ok", true)
                        }
                    }

                    "readingPutMax" -> {
                        mutation(action, payload) { putReading(payload) }
                    }

                    "identityGet" -> {
                        requireReady()
                        JSONObject().put("deviceId", rows("SELECT device FROM native_core_identity WHERE id=1").single()["device"])
                    }

                    "hashesPage" -> {
                        hashesPage(payload)
                    }

                    "receipt" -> {
                        receipt(payload)
                    }

                    else -> {
                        throw NativeStateFailure("unsupported_action")
                    }
                }
            } catch (
                error: NativeStateFailure,
            ) {
                throw error
            } catch (
                error: JSONException,
            ) {
                throw NativeStateFailure("invalid_payload", error)
            } catch (
                error: SQLiteException,
            ) {
                throw NativeStateFailure("database_error", error)
            }
        }

    private fun beginMigration(payload: JSONObject): JSONObject {
        if (migration()?.get("state") == "complete") return readyStatus()
        val raw = string(payload, "settings", MAX_JSON)
        JSONObject(raw)
        val identity = string(payload, "identity", MAX_JSON)
        val id = JSONObject(identity)
        if (!id.isNull("deviceId") && string(id, "deviceId").isEmpty()) invalid()
        val hashes = id.getJSONArray("hashes")
        if (hashes.length() > 100000) throw NativeStateFailure("resource_limit")
        val seen = mutableSetOf<String>()
        for (i in 0 until hashes.length()) {
            val pair = hashes.getJSONArray(i)
            if (pair.length() != 2 || pair.getString(0).isEmpty() || pair.getString(1).isEmpty() || !seen.add(pair.getString(0))) invalid()
        }
        val count = integer(payload, "rows", 2_000_000)
        val chunks = integer(payload, "chunks", 100000)
        if (chunks != (count + PAGE - 1) / PAGE) invalid()
        val fingerprint = hash(raw + "\u0000" + identity + "\u0000" + count + ":" + chunks)
        transaction {
            val existing = migration()
            if (existing != null) {
                if (existing["fingerprint"] != fingerprint) throw NativeStateFailure("migration_source_changed")
            } else {
                execute(
                    "INSERT INTO native_core_migration VALUES(1,?,?,?,?,?,'staging')",
                    listOf(fingerprint, raw, identity, count, chunks),
                )
            }
        }
        return readyStatus()
    }

    private fun migrationChunk(payload: JSONObject): JSONObject =
        transaction {
            val migration = migration() ?: throw NativeStateFailure("migration_not_started")
            if (migration["state"] == "complete") return@transaction readyStatus()
            val ordinal = integer(payload, "ordinal", 100000)
            val raw = string(payload, "rows", 2 * 1024 * 1024)
            val list = JSONArray(raw)
            if (list.length() !in 1..PAGE || ordinal >= migration["expected_chunks"]!!.toInt()) invalid()
            val fingerprint = hash(raw)
            val prior = rows("SELECT fingerprint FROM native_core_chunks WHERE ordinal=?", listOf(ordinal.toString())).firstOrNull()
            if (prior != null) {
                if (prior["fingerprint"] != fingerprint) throw NativeStateFailure("migration_source_changed")
                return@transaction JSONObject().put("ordinal", ordinal).put("replayed", true)
            }
            if (ordinal != scalar("SELECT count(*) FROM native_core_chunks")) throw NativeStateFailure("migration_out_of_order")
            for (i in 0 until list.length()) {
                val item = row(list.getJSONObject(i))
                val key = item.getString("key")
                if (rows(
                        "SELECT key FROM native_core_stage WHERE key=?",
                        listOf(key),
                    ).isNotEmpty()
                ) {
                    throw NativeStateFailure("duplicate_migration_row")
                }
                execute(
                    "INSERT INTO native_core_stage(key,seconds,json) VALUES(?,?,?)",
                    listOf(key, finite(item, "seconds"), item.toString()),
                )
            }
            execute("INSERT INTO native_core_chunks VALUES(?,?,?)", listOf(ordinal, fingerprint, list.length()))
            JSONObject().put("ordinal", ordinal).put("replayed", false)
        }

    private fun commitMigration(): JSONObject {
        if (migration()?.get("state") == "complete") return readyStatus()
        transaction {
            val migration = migration() ?: throw NativeStateFailure("migration_not_started")
            if (scalar("SELECT count(*) FROM native_core_stage") != migration["expected_rows"]!!.toInt() ||
                scalar("SELECT count(*) FROM native_core_chunks") != migration["expected_chunks"]!!.toInt()
            ) {
                throw NativeStateFailure("migration_incomplete")
            }
            val identity = JSONObject(migration["identity"]!!)
            val device = if (identity.isNull("deviceId")) UUID.randomUUID().toString() else identity.getString("deviceId")
            execute("INSERT INTO native_core_identity VALUES(1,?)", listOf(device))
            execute("INSERT INTO native_core_settings VALUES(1,1,?)", listOf(migration["settings"]))
            val hashes = identity.getJSONArray("hashes")
            for (i in 0 until hashes.length()) {
                val pair = hashes.getJSONArray(i)
                execute("INSERT INTO native_core_hashes VALUES(?,?)", listOf(pair.getString(0), pair.getString(1)))
            }
            execute(
                "INSERT OR REPLACE INTO native_core_reading(key,seconds,json) SELECT s.key,s.seconds,s.json FROM native_core_stage s LEFT JOIN native_core_reading r ON r.key=s.key WHERE r.key IS NULL OR s.seconds > r.seconds",
            )
            execute("UPDATE native_core_migration SET state='complete',settings='',identity='' WHERE id=1")
            execute("DELETE FROM native_core_stage")
            execute("DELETE FROM native_core_chunks")
        }
        return readyStatus()
    }

    private fun receipt(payload: JSONObject): JSONObject {
        val id = string(payload, "requestId", 36)
        if (!UUID_RE.matches(id)) invalid()
        val event = rows("SELECT result,fingerprint FROM native_core_events WHERE id=?", listOf(id)).firstOrNull()
        return JSONObject().put("found", event != null).apply {
            if (event != null) {
                val cached = JSONObject(event["result"]!!)
                put("result", if (cached.has("settingsRevision")) settings() else cached).put("fingerprint", event["fingerprint"])
            }
        }
    }

    private fun mutation(
        action: String,
        payload: JSONObject,
        work: () -> JSONObject,
    ): JSONObject {
        requireReady()
        val id = string(payload, "requestId", 36)
        val created = finite(payload, "createdAt").toLong()
        val now = System.currentTimeMillis()
        if (!UUID_RE.matches(id)) invalid()
        val fingerprint = hash(action + "\u0000" + canonical(payload))
        return transaction {
            val prior = rows("SELECT fingerprint,result FROM native_core_events WHERE id=?", listOf(id)).firstOrNull()
            if (prior != null) {
                if (prior["fingerprint"] != fingerprint) throw NativeStateFailure("request_conflict")
                return@transaction if (action == "settingsPatch") settings() else JSONObject(prior["result"]!!)
            }
            if (created < now - RETENTION || created > now + 600000) throw NativeStateFailure("stale_request")
            execute("DELETE FROM native_core_events WHERE created < ?", listOf(now - RETENTION))
            if (scalar("SELECT count(*) FROM native_core_events") >= 65536) throw NativeStateFailure("resource_limit")
            val result = work()
            val cached = if (action == "settingsPatch") JSONObject().put("settingsRevision", result.getLong("revision")) else result
            execute("INSERT INTO native_core_events VALUES(?,?,?,?)", listOf(id, fingerprint, cached.toString(), created))
            result
        }
    }

    private fun path(value: JSONArray): List<String> {
        if (value.length() !in 1..8) invalid()
        return (0 until value.length()).map {
            value.getString(it).also { key ->
                if (key.isEmpty() || key.length > 256 || key in setOf("__proto__", "constructor", "prototype")) invalid()
            }
        }
    }

    private fun at(
        root: JSONObject,
        path: List<String>,
    ): Pair<Boolean, Any?> {
        var node = root
        for (key in path.dropLast(1)) {
            if (!node.has(key) || node.get(key) !is JSONObject) return false to null
            node = node.getJSONObject(key)
        }
        return node.has(path.last()) to if (node.has(path.last())) node.get(path.last()) else null
    }

    private fun matches(
        actual: Pair<Boolean, Any?>,
        expected: JSONObject,
    ): Boolean =
        actual.first == expected.getBoolean("present") && (!actual.first || canonical(actual.second) == canonical(expected.get("value")))

    private fun patchSettings(payload: JSONObject): JSONObject {
        val patches = payload.getJSONArray("patches")
        if (patches.length() !in 1..512) invalid()
        val current = settings()
        val root = JSONObject(current.getString("raw"))
        val parsed =
            (0 until patches.length()).map { i ->
                val patch = patches.getJSONObject(i)
                path(patch.getJSONArray("path")) to patch
            }
        for ((i, entry) in parsed.withIndex()) {
            if (entry.first.first() == "libraryRoot") throw NativeStateFailure("library_move_required")
            if (parsed.take(i).any { (other, _) ->
                    other.take(entry.first.size) == entry.first || entry.first.take(other.size) == other
                }
            ) {
                invalid()
            }
            if (!matches(at(root, entry.first), entry.second.getJSONObject("before"))) throw NativeStateFailure("settings_conflict")
        }
        for ((path, patch) in parsed) {
            var parent = root
            for (key in path.dropLast(1)) {
                if (!parent.has(key)) parent.put(key, JSONObject())
                if (parent.get(key) !is JSONObject) invalid()
                parent = parent.getJSONObject(key)
            }
            val next = patch.getJSONObject("after")
            if (next.getBoolean("present")) parent.put(path.last(), next.get("value")) else parent.remove(path.last())
        }
        val raw = root.toString()
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_JSON) throw NativeStateFailure("resource_limit")
        execute("UPDATE native_core_settings SET revision=revision+1,json=? WHERE id=1", listOf(raw))
        return JSONObject().put("revision", current.getLong("revision") + 1).put("raw", raw)
    }

    private fun readingPage(payload: JSONObject): JSONObject {
        requireReady()
        val after = string(payload, "after")
        val limit = integer(payload, "limit", PAGE)
        if (limit < 1) invalid()
        val list = rows("SELECT key,json FROM native_core_reading WHERE key>? ORDER BY key LIMIT ?", listOf(after, limit.toString()))
        return JSONObject()
            .put(
                "rows",
                JSONArray(list.map { JSONObject(it["json"]!!) }),
            ).put("next", list.lastOrNull()?.get("key") ?: after)
    }

    private fun hashesPage(payload: JSONObject): JSONObject {
        requireReady()
        val after = string(payload, "after")
        val list = rows("SELECT book_id,hash FROM native_core_hashes WHERE book_id>? ORDER BY book_id LIMIT 256", listOf(after))
        return JSONObject().put("rows", JSONArray(list.map { JSONArray().put(it["book_id"]).put(it["hash"]) })).put(
            "next",
            list.lastOrNull()?.get("book_id") ?: after,
        )
    }

    private fun upsertMax(item: JSONObject): Boolean {
        val key = item.getString("key")
        val previous = rows("SELECT seconds FROM native_core_reading WHERE key=?", listOf(key)).firstOrNull()
        if (previous != null && previous["seconds"]!!.toDouble() >= finite(item, "seconds")) return false
        execute("INSERT OR REPLACE INTO native_core_reading VALUES(?,?,?)", listOf(key, finite(item, "seconds"), item.toString()))
        return true
    }

    private fun putReading(payload: JSONObject): JSONObject {
        val list = payload.getJSONArray("rows")
        if (list.length() > PAGE) invalid()
        var changed = 0
        for (i in 0 until list.length()) if (upsertMax(row(list.getJSONObject(i)))) changed++
        return JSONObject().put("changed", changed)
    }

    private fun addReading(payload: JSONObject) {
        val list = payload.getJSONArray("deltas")
        val now = finite(payload, "now")
        if (list.length() > PAGE) invalid()
        for (i in 0 until list.length()) {
            val delta = list.getJSONObject(i)
            val device = string(delta, "device")
            val day = string(delta, "day")
            val ref = string(delta, "ref")
            val seconds = finite(delta, "seconds")
            if (device.isEmpty() || device.contains('|') || !DAY.matches(day) || seconds <= 0 || seconds > 86400) invalid()
            val key = "$device|$day|$ref"
            val old = rows("SELECT json FROM native_core_reading WHERE key=?", listOf(key)).firstOrNull()?.let { JSONObject(it["json"]!!) }
            val item =
                JSONObject(delta.toString())
                    .put("key", key)
                    .put(
                        "seconds",
                        (
                            old?.let {
                                finite(it, "seconds")
                            } ?: 0.0
                        ) + seconds,
                    ).put("updatedAt", now)
            if (item.optString("title").isEmpty() && old != null) item.put("title", old.optString("title"))
            val normalized = row(item)
            execute(
                "INSERT OR REPLACE INTO native_core_reading VALUES(?,?,?)",
                listOf(key, finite(normalized, "seconds"), normalized.toString()),
            )
        }
    }
}
