package io.pagewise.reader

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.text.Collator
import java.text.Normalizer
import java.util.Locale

/** Management-only seam. Reader/import/TTS owners and physical document files are untouched. */
internal class NativeLibraryRepository(
    context: Context,
) : Closeable {
    private val database: SQLiteDatabase
    private val directory: File
    private var closed = false

    init {
        var opened: SQLiteDatabase? = null
        try {
            val root =
                context
                    .getSharedPreferences("pagewise-native-state-location", Context.MODE_PRIVATE)
                    .getString("root", null) ?: fail("migration_not_initialized")
            if (root.startsWith("content:") || (root.isNotEmpty() && !File(root).isAbsolute)) fail("unsupported_library_root")
            directory = (if (root.isEmpty()) context.dataDir else File(root)).canonicalFile
            if (!directory.isDirectory) fail("library_root_unavailable")
            val file = File(directory, "lightread.db")
            if (!file.isFile) fail("library_database_missing")
            opened = CanonicalDatabase.open(file)
            database = opened
            rows("PRAGMA busy_timeout=5000")
            for ((table, fields) in SCHEMA) {
                val info = rows("PRAGMA table_info($table)")
                if (!info.map { it["name"] }.containsAll(fields)) fail("library_schema_mismatch")
                val primary = info.filter { it["pk"] != "0" }.map { it["name"] }.toSet()
                val expectedPrimary =
                    when (table) {
                        "booklist_items" -> setOf("booklist_id", "book_id")
                        "native_core_reading" -> setOf("key")
                        "native_core_hashes" -> setOf("book_id")
                        else -> setOf("id")
                    }
                if (primary != expectedPrimary) fail("library_schema_mismatch")
            }
            requireReady()
            val settings =
                JSONObject(
                    rows("SELECT json FROM native_core_settings WHERE id=1").singleOrNull()?.get("json") ?: fail("canonical_state_missing"),
                )
            val configured = if (settings.has("libraryRoot")) text(settings, "libraryRoot", 4096) else ""
            if (configured.startsWith("content:") ||
                (configured.isNotEmpty() && !File(configured).isAbsolute)
            ) {
                fail("unsupported_library_root")
            }
            val expected = (if (configured.isEmpty()) context.dataDir else File(configured)).canonicalFile
            if (expected != directory) fail("library_root_conflict")
        } catch (error: CanonicalDatabaseFailure) {
            opened?.close()
            throw error
        } catch (error: NativeStateFailure) {
            opened?.close()
            throw error
        } catch (error: SQLiteException) {
            opened?.close()
            throw NativeStateFailure("database_error")
        } catch (error: JSONException) {
            opened?.close()
            throw NativeStateFailure("library_schema_mismatch")
        } catch (error: IOException) {
            opened?.close()
            throw NativeStateFailure("library_root_unavailable")
        } catch (error: SecurityException) {
            opened?.close()
            throw NativeStateFailure("permission_denied")
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        try {
            database.close()
            closed = true
        } catch (error: SQLiteException) {
            fail("database_error")
        }
    }

    @Synchronized
    fun command(
        action: String,
        payload: JSONObject,
    ): JSONObject {
        try {
            if (closed) fail("repository_closed")
            if (payload.toString().toByteArray(Charsets.UTF_8).size > 2 * 1024 * 1024) fail("resource_limit")
            requireReady()
            return when (action) {
                "books" -> {
                    books(payload)
                }

                "book" -> {
                    JSONObject().put("book", book(id(payload)))
                }

                "annotations" -> {
                    annotations(payload)
                }

                "annotation" -> {
                    JSONObject().put("annotation", annotation(id(payload)))
                }

                "bookPatch" -> {
                    transaction { patchBook(payload) }
                }

                "annotationPatch" -> {
                    transaction { patchAnnotation(payload) }
                }

                "bookRemove" -> {
                    transaction { removeBook(payload) }
                }

                "annotationRemove" -> {
                    transaction { removeAnnotation(payload) }
                }

                "statistics" -> {
                    transaction { statistics() }
                }

                "booklists" -> {
                    JSONObject().put(
                        "items",
                        JSONArray(
                            rows("SELECT * FROM booklists ORDER BY created_at DESC,id").map {
                                JSONObject()
                                    .put("id", it["id"])
                                    .put("name", it["name"])
                                    .put("createdAt", number(it["created_at"]))
                                    .put("updatedAt", number(it["updated_at"]))
                            },
                        ),
                    )
                }

                else -> {
                    fail("unsupported_action")
                }
            }
        } catch (error: JSONException) {
            throw NativeStateFailure("invalid_payload")
        } catch (error: SQLiteException) {
            throw NativeStateFailure("database_error")
        }
    }

    private fun requireReady() {
        if (rows("SELECT state FROM native_core_migration WHERE id=1").singleOrNull()?.get("state") !=
            "complete"
        ) {
            fail("native_state_not_ready")
        }
    }

    private fun rows(
        sql: String,
        args: List<String> = emptyList(),
    ): List<Map<String, String?>> =
        database.rawQuery(sql, args.toTypedArray()).use { cursor ->
            val result = ArrayList<Map<String, String?>>()
            while (cursor.moveToNext()) result.add(row(cursor))
            result
        }

    private fun row(cursor: Cursor) =
        cursor.columnNames.withIndex().associate { (i, name) ->
            name to if (cursor.isNull(i)) null else cursor.getString(i)
        }

    private fun execute(
        sql: String,
        args: List<Any?> = emptyList(),
    ) = database.execSQL(sql, args.toTypedArray())

    private fun <T> transaction(body: () -> T): T {
        database.beginTransactionNonExclusive()
        try {
            val result = body()
            database.setTransactionSuccessful()
            return result
        } finally {
            try {
                database.endTransaction()
            } catch (error: SQLiteException) {
                // A lost COMMIT acknowledgement is not permission to repeat a destructive mutation.
                fail("commit_outcome_unknown")
            }
        }
    }

    private fun book(id: String) = bookDto(rows("SELECT * FROM books WHERE id=?", listOf(id)).singleOrNull() ?: fail("book_not_found"))

    private fun bookDto(row: Map<String, String?>): JSONObject {
        val result = JSONObject()
        for ((key, column) in BOOK_COLUMNS) {
            val raw = row[column]
            result.put(
                key,
                when {
                    raw == null -> JSONObject.NULL
                    key in JSON_FIELDS -> parseStored(raw, key == "tags")
                    key in NUMBERS -> number(raw)
                    else -> raw
                },
            )
        }
        result.put("hasCover", row["has_cover"] == "1")
        // IDs need not be UUIDs in legacy libraries. Never turn an identifier into a path escape.
        val id = row["id"] ?: fail("library_schema_mismatch")
        val safeId = id.isNotEmpty() && id != "." && id != ".." && !id.contains('/') && !id.contains('\\') && !id.contains('\u0000')
        result.put("coverPath", if (row["has_cover"] == "1" && safeId) File(directory, "covers/$id.jpg").path else JSONObject.NULL)
        return result
    }

    private fun parseStored(
        raw: String,
        array: Boolean,
    ): Any =
        try {
            if (array) JSONArray(raw) else JSONObject(raw)
        } catch (error: JSONException) {
            fail("library_schema_mismatch")
        }

    private fun annotationDto(row: Map<String, String?>): JSONObject {
        val result = JSONObject()
        for ((key, column) in ANNOTATION_COLUMNS) {
            result.put(
                key,
                if (key ==
                    "createdAt"
                ) {
                    number(row[column])
                } else {
                    row[column] ?: JSONObject.NULL
                },
            )
        }
        return result
            .put("bookTitle", row["book_title"] ?: JSONObject.NULL)
            .put("bookAuthor", row["book_author"] ?: JSONObject.NULL)
            .put("sourceMissing", row["book_title"] == null)
    }

    private fun annotation(id: String) =
        annotationDto(rows(ANNOTATION_SELECT + " WHERE a.id=?", listOf(id)).singleOrNull() ?: fail("annotation_not_found"))

    private fun page(
        payload: JSONObject,
        sql: String,
        args: List<String>,
        transform: (Map<String, String?>) -> JSONObject,
        comparator: Comparator<JSONObject>? = null,
        accept: (JSONObject) -> Boolean,
    ): JSONObject {
        val offset = integer(payload, "offset", 0, Int.MAX_VALUE)
        val limit = integer(payload, "limit", 50, 256)
        if (limit == 0) fail("invalid_payload")
        val items = JSONArray()
        val candidates = if (comparator == null) null else ArrayList<JSONObject>()
        var total = 0L
        database.rawQuery(sql, args.toTypedArray()).use { cursor ->
            while (cursor.moveToNext()) {
                val dto = transform(row(cursor))
                if (!accept(dto)) continue
                if (candidates != null) {
                    candidates.add(dto)
                } else if (total >= offset && items.length() < limit) {
                    items.put(dto)
                }
                total++
            }
        }
        if (candidates != null && comparator != null) {
            candidates.sortWith(comparator)
            candidates
                .asSequence()
                .drop(offset)
                .take(limit)
                .forEach { items.put(it) }
        }
        return JSONObject().put("items", items).put("total", total)
    }

    private fun books(payload: JSONObject): JSONObject {
        filters(payload, setOf("query", "readingOnly", "offset", "limit", "sort", "kind", "readingStatus"))
        val query = if (payload.has("query")) normalize(text(payload, "query", 4096)) else ""
        val words = query.split(' ').filter { it.isNotEmpty() }
        val reading = if (payload.has("readingOnly")) payload.get("readingOnly") as? Boolean ?: fail("invalid_payload") else false
        val kind =
            if (payload.has("kind")) {
                text(payload, "kind", 32).also {
                    if (it !in
                        setOf("book", "paper")
                    ) {
                        fail("unsupported_filter")
                    }
                }
            } else {
                null
            }
        val status =
            if (payload.has("readingStatus")) {
                text(payload, "readingStatus", 32)
                    .let { if (it == "unread") "unmarked" else it }
                    .also { if (it !in STATUSES) fail("unsupported_filter") }
            } else {
                null
            }
        val sort =
            if (payload.has("sort")) {
                text(payload, "sort", 32).also {
                    if (it !in
                        setOf("recent", "title", "author", "added", "pinned")
                    ) {
                        fail("unsupported_filter")
                    }
                }
            } else {
                null
            }
        val pins = "CASE WHEN pinned_at>0 THEN pinned_at ELSE 0 END DESC,"
        val recent = "CASE WHEN last_read_at>0 THEN last_read_at ELSE 0 END DESC,"
        val order =
            when (sort) {
                "title", "author" -> "id"
                "added" -> pins + "added_at DESC,id"
                "recent", "pinned" -> pins + recent + "id"
                else -> if (reading) "coalesce(last_read_at,added_at) DESC,added_at DESC,id" else pins + recent + "added_at DESC,id"
            }
        val collator = Collator.getInstance(Locale.CHINESE)
        val comparator =
            if (sort == "title" || sort == "author") {
                Comparator<JSONObject> { a, b ->
                    val pinOrder =
                        ((b.get("pinnedAt") as? Number)?.toDouble() ?: 0.0).compareTo((a.get("pinnedAt") as? Number)?.toDouble() ?: 0.0)
                    if (pinOrder != 0) {
                        pinOrder
                    } else {
                        val textOrder = collator.compare(normalize(a.getString(sort)), normalize(b.getString(sort)))
                        if (textOrder != 0) textOrder else a.getString("id").compareTo(b.getString("id"))
                    }
                }
            } else {
                null
            }
        return page(payload, "SELECT * FROM books ORDER BY $order", emptyList(), ::bookDto, comparator) { dto ->
            val effective = effectiveStatus(dto)
            val tags = dto.getJSONArray("tags")
            val tokens =
                listOf(dto.getString("title"), dto.getString("author")) +
                    (0 until tags.length()).map { tags.get(it) as? String ?: fail("library_schema_mismatch") }
            (!reading || effective == "reading") && (status == null || effective == status) &&
                (kind == null || (if (dto.optString("kind") == "paper") "paper" else "book") == kind) &&
                words.all { word -> tokens.any { normalize(it).contains(word) } }
        }
    }

    private fun effectiveStatus(dto: JSONObject): String {
        val explicit = dto.optString("readingStatus").let { if (it == "unread") "unmarked" else it }
        if (explicit in STATUSES) return explicit
        return if (((dto.get("lastReadAt") as? Number)?.toDouble() ?: 0.0) > 0) "reading" else "unmarked"
    }

    private fun filters(
        payload: JSONObject,
        allowed: Set<String>,
    ) {
        if (payload.keys().asSequence().any { it !in allowed }) fail("unsupported_filter")
    }

    private fun annotations(payload: JSONObject): JSONObject {
        filters(payload, setOf("query", "bookId", "offset", "limit", "filter"))
        val filter = if (payload.has("filter")) text(payload, "filter", 32) else "all"
        if (filter !in setOf("all", "thoughts", "highlights", "bookmarks")) fail("unsupported_filter")
        val query = if (payload.has("query")) text(payload, "query", 4096).trim().lowercase(Locale.ROOT) else ""
        val args = if (payload.has("bookId")) listOf(text(payload, "bookId", 4096)) else emptyList()
        return page(
            payload,
            ANNOTATION_SELECT + (if (args.isEmpty()) "" else " WHERE a.book_id=?") + " ORDER BY a.created_at DESC,a.id",
            args,
            ::annotationDto,
        ) { dto ->
            val matchesQuery =
                query.isEmpty() ||
                    listOf("text", "note", "bookTitle", "bookAuthor").any { dto.optString(it).lowercase(Locale.ROOT).contains(query) }
            val kind = if (dto.isNull("kind")) "highlight" else dto.optString("kind")
            matchesQuery &&
                when (filter) {
                    "thoughts" -> !dto.isNull("note") && dto.optString("note").trim().isNotEmpty()
                    "highlights" -> kind == "highlight"
                    "bookmarks" -> kind == "bookmark"
                    else -> true
                }
        }
    }

    private fun patchBook(payload: JSONObject): JSONObject {
        val id = id(payload)
        val current = book(id)
        val before = payload.getJSONObject("before")
        identity(before, current, listOf("id"))
        val patch = payload.getJSONObject("patch")
        val changes = linkedMapOf<String, Any?>()
        for (key in patch.keys()) {
            if (key !in EDITABLE_BOOK) fail("unsupported_field")
            if (!before.has(key)) fail("invalid_payload")
            val next = patch.get(key)
            if (equal(next, before.get(key))) continue
            if (!equal(current.get(key), before.get(key))) fail("book_conflict")
            validateBookField(key, next)
            changes[key] = if (next == JSONObject.NULL) null else next
        }
        if (changes.containsKey("tags") &&
            (!current.isNull("classification") || changes.containsKey("classification"))
        ) {
            fail("classification_required")
        }
        if (changes.containsKey("classification")) {
            identity(before, current, listOf("classification", "tags", "title", "author", "publisher", "publicationDate", "description"))
            val next = changes["classification"] as? JSONObject ?: fail("invalid_classification")
            validateClassification(next)
            val old = if (current.isNull("classification")) null else current.getJSONObject("classification")
            val revision = if (old == null) 0.0 else (old.get("revision") as? Number)?.toDouble() ?: fail("invalid_classification")
            if ((next.get("revision") as Number).toDouble() != revision + 1) fail("classification_conflict")
            requireManualEdits(old, next)
            changes["tags"] = classificationTags(next)
        }
        if (changes.isNotEmpty()) update("books", id, changes, BOOK_COLUMNS)
        return JSONObject().put("book", book(id))
    }

    private fun validateBookField(
        key: String,
        value: Any?,
    ) {
        if (key == "classification") {
            if (value !is JSONObject) fail("invalid_classification")
            return
        }
        if (key == "tags") {
            legacyTags(value)
            return
        }
        if (value == JSONObject.NULL || value == null) {
            if (key in setOf("title", "author", "kind")) fail("invalid_payload")
            return
        }
        when (key) {
            "pinnedAt" -> {
                if (value !is Number || !value.toDouble().isFinite() || value.toDouble() < 0 ||
                    value.toDouble() > 9007199254740991.0 ||
                    value.toDouble() % 1 != 0.0
                ) {
                    fail("invalid_payload")
                }
            }

            "readingStatus" -> {
                if (value !is String || value !in STATUSES) fail("invalid_payload")
            }

            "kind" -> {
                if (value != "book" && value != "paper") fail("invalid_payload")
            }

            else -> {
                if (value !is String || value.length > 65536 || value.contains('\u0000') ||
                    (key == "title" && value.trim().isEmpty())
                ) {
                    fail("invalid_payload")
                }
            }
        }
    }

    private fun patchAnnotation(payload: JSONObject): JSONObject {
        val id = id(payload)
        val current = annotation(id)
        val before = payload.getJSONObject("before")
        identity(before, current, listOf("id", "bookId", "cfi", "text", "kind", "createdAt"))
        val patch = payload.getJSONObject("patch")
        val changes = linkedMapOf<String, Any?>()
        for (key in patch.keys()) {
            if (key != "note" && key != "color") fail("unsupported_field")
            if (!before.has(key)) fail("invalid_payload")
            val next = patch.get(key)
            if (equal(next, before.get(key))) continue
            if (!equal(current.get(key), before.get(key))) fail("annotation_conflict")
            if (key == "note" && (next == null || next == JSONObject.NULL)) {
                changes[key] = null
            } else {
                if (next !is String || next.length > 1048576 || next.contains('\u0000')) fail("invalid_payload")
                if (key == "color" && next !in COLORS) fail("invalid_payload")
                changes[key] = next
            }
        }
        if (changes.isNotEmpty()) update("annotations", id, changes, ANNOTATION_COLUMNS)
        return JSONObject().put("annotation", annotation(id))
    }

    private fun update(
        table: String,
        id: String,
        changes: Map<String, Any?>,
        columns: Map<String, String>,
    ) {
        execute(
            "UPDATE $table SET " + changes.keys.joinToString(",") { "${columns.getValue(it)}=?" } + " WHERE id=?",
            changes.values.map { if (it is JSONObject || it is JSONArray) it.toString() else it } + id,
        )
        if (rows("SELECT changes() AS n").single()["n"] != "1") fail("write_conflict")
    }

    private fun removeBook(payload: JSONObject): JSONObject {
        val id = id(payload)
        val current = book(id)
        identity(payload.getJSONObject("before"), current, BOOK_COLUMNS.keys.toList() + "hasCover")
        if (!current.isNull("sourceRef")) fail("source_linked_book")
        execute("DELETE FROM annotations WHERE book_id=?", listOf(id))
        execute("DELETE FROM booklist_items WHERE book_id=?", listOf(id))
        execute("DELETE FROM books WHERE id=?", listOf(id))
        return JSONObject().put("removed", true).put("filesRetained", true)
    }

    private fun removeAnnotation(payload: JSONObject): JSONObject {
        val id = id(payload)
        identity(payload.getJSONObject("before"), annotation(id), ANNOTATION_COLUMNS.keys.toList())
        execute("DELETE FROM annotations WHERE id=?", listOf(id))
        return JSONObject().put("removed", true)
    }

    /** Mirrors readingLog.loadDaily: h: rows are landed DIFFERENCES, not duplicate full counters. */
    private fun statistics(): JSONObject {
        val live = rows("SELECT id,title,kind,added_at FROM books ORDER BY added_at,id")
        val byId = live.associateBy { it["id"]!! }
        val hashes = rows("SELECT book_id,hash FROM native_core_hashes").associate { it["book_id"]!! to it["hash"]!! }
        val byHash = linkedMapOf<String, Map<String, String?>>()
        for (b in live) hashes[b["id"]]?.let { byHash.putIfAbsent(it, b) }
        val daily = sortedMapOf<String, LinkedHashMap<String, JSONObject>>()
        for (stored in rows("SELECT key,seconds,json FROM native_core_reading ORDER BY key")) {
            val r =
                try {
                    JSONObject(stored["json"] ?: fail("library_schema_mismatch"))
                } catch (
                    e: JSONException,
                ) {
                    fail("library_schema_mismatch")
                }
            val key = stored["key"] ?: fail("library_schema_mismatch")
            val parts = key.split('|', limit = 3)
            val seconds = number(stored["seconds"]) ?: fail("library_schema_mismatch")
            if (parts.size != 3 || parts[0].isEmpty() || !Regex("\\d{4}-\\d{2}-\\d{2}").matches(parts[1]) || seconds.toDouble() <= 0 ||
                r.optString("key") != key ||
                !equal(r.get("seconds"), seconds)
            ) {
                fail("library_schema_mismatch")
            }
            val ref = parts[2]
            val bookId = if (ref.startsWith("id:") && ref.length > 3) ref.substring(3) else null
            val hash =
                if (bookId !=
                    null
                ) {
                    hashes[bookId]
                } else if (ref.startsWith("h:") && ref.length > 2) {
                    ref.substring(2)
                } else {
                    fail("library_schema_mismatch")
                }
            val canonical = hash?.let { byHash[it] }
            val book = canonical ?: bookId?.let { byId[it] }
            val aggregationKey =
                if (book != null) {
                    "id:${book["id"]}"
                } else if (hash != null) {
                    "h:$hash"
                } else {
                    "t:${r.optString("title")}"
                }
            val day = daily.getOrPut(parts[1]) { linkedMapOf() }
            val previous = day[aggregationKey]
            val title = book?.get("title")?.takeIf { it.isNotEmpty() } ?: r.optString("title")
            val kind = if ((if (book != null) book["kind"] else r.optString("kind")) == "paper") "paper" else "book"
            val item =
                previous ?: JSONObject()
                    .put("key", aggregationKey)
                    .put("title", title)
                    .put("kind", kind)
                    .put("seconds", 0)
            if (book != null) item.put("bookId", book["id"])
            if (previous != null && item.optString("title").isEmpty() &&
                r.optString("title").isNotEmpty()
            ) {
                item.put("title", r.optString("title"))
            }
            item.put("seconds", (item.get("seconds") as Number).toDouble() + seconds.toDouble())
            day[aggregationKey] = item
        }
        val collator = Collator.getInstance()
        val order =
            compareByDescending<JSONObject> { (it.get("seconds") as Number).toDouble() }
                .thenComparator { a, b -> collator.compare(a.getString("title"), b.getString("title")) }
                .thenComparator { a, b -> collator.compare(a.getString("key"), b.getString("key")) }
        val dailyDto = JSONObject()
        val totals = linkedMapOf<String, JSONObject>()
        var total = 0.0
        var activeDays = 0
        for ((day, items) in daily) {
            val sorted = items.values.sortedWith(order)
            val seconds = sorted.sumOf { (it.get("seconds") as Number).toDouble() }
            if (seconds >= 60) activeDays++
            total += seconds
            dailyDto.put(day, JSONObject().put("seconds", seconds).put("books", JSONArray(sorted)))
            for (item in sorted) {
                val key = item.getString("key")
                val aggregate = totals[key] ?: JSONObject(item.toString()).put("seconds", 0)
                aggregate.put("seconds", (aggregate.get("seconds") as Number).toDouble() + (item.get("seconds") as Number).toDouble())
                if (aggregate.optString("title").isEmpty()) aggregate.put("title", item.getString("title"))
                if (aggregate.isNull("bookId") && !item.isNull("bookId")) aggregate.put("bookId", item.get("bookId"))
                totals[key] = aggregate
            }
        }
        return JSONObject()
            .put("daily", dailyDto)
            .put(
                "books",
                JSONArray(totals.values.sortedWith(order)),
            ).put("totalSeconds", total)
            .put("activeDays", activeDays)
            .put("activeDaySeconds", 60)
    }

    private fun identity(
        before: JSONObject,
        current: JSONObject,
        keys: List<String>,
    ) {
        for (key in keys) {
            if (!before.has(key)) fail("invalid_payload")
            if (!equal(before.get(key), current.get(key))) fail("write_conflict")
        }
    }

    private fun legacyTags(value: Any?): JSONArray {
        if (value !is JSONArray || value.length() > 1024) fail("invalid_classification")
        for (i in 0 until value.length()) {
            val s = value.get(i) as? String ?: fail("invalid_classification")
            if (s.trim().isEmpty() || s.length > 500 || CONTROL.containsMatchIn(s)) fail("invalid_classification")
        }
        return value
    }

    private fun fields(
        obj: JSONObject,
        allowed: Set<String>,
        required: Set<String> = allowed,
    ) {
        val keys = obj.keys().asSequence().toSet()
        if (!allowed.containsAll(keys) || !keys.containsAll(required)) fail("invalid_classification")
    }

    private fun classText(value: Any?): String {
        val s = value as? String ?: fail("invalid_classification")
        // Reject rather than silently canonicalize: manual/locked values must not be rewritten as a side effect.
        if (s.isEmpty() || s.length > 80 || CONTROL.containsMatchIn(s) || s != normalizeSpaces(s) ||
            s in ALIASES
        ) {
            fail("invalid_classification")
        }
        return s
    }

    private fun classTag(
        value: Any?,
        category: Boolean = false,
    ): JSONObject {
        val tag = value as? JSONObject ?: fail("invalid_classification")
        fields(tag, setOf("value", "locked", "source"))
        val s = classText(tag.get("value"))
        if (tag.get("locked") !is Boolean || tag.get("source") !in listOf("manual", "ai")) fail("invalid_classification")
        if (category) {
            if (!CATEGORIES.containsKey(s)) fail("invalid_classification")
        } else if (EXCLUDED.matches(s)) {
            fail("invalid_classification")
        }
        return tag
    }

    private fun validateClassification(c: JSONObject) {
        fields(c, setOf("version", "revision", "category", "topics", "feature", "facets", "legacyTags"))
        if (!equal(c.get("version"), 1)) fail("invalid_classification")
        val revision = c.get("revision") as? Number ?: fail("invalid_classification")
        if (!revision.toDouble().isFinite() || revision.toDouble() < 0 || revision.toDouble() > 9007199254740991.0 ||
            revision.toDouble() % 1 != 0.0
        ) {
            fail("invalid_classification")
        }
        val topics = c.get("topics") as? JSONArray ?: fail("invalid_classification")
        if (topics.length() > 3) fail("invalid_classification")
        val values = (0 until topics.length()).map { classTag(topics.get(it)).getString("value") }
        for (i in values.indices) {
            for (j in 0 until i) {
                val a = values[i]
                val b = values[j]
                if (a == b || a.startsWith("$b/") || b.startsWith("$a/") ||
                    TOPIC_PATHS.any { a in it && b in it }
                ) {
                    fail("invalid_classification")
                }
            }
        }
        val category = if (c.isNull("category")) null else classTag(c.get("category"), true).getString("value")
        val feature = if (c.isNull("feature")) null else classTag(c.get("feature")).getString("value")
        if (feature != null && feature in values) fail("invalid_classification")
        if (category != null &&
            (values + listOfNotNull(feature)).any {
                it.lowercase(Locale.ROOT) in
                    listOf(category.lowercase(Locale.ROOT), CATEGORIES.getValue(category).lowercase(Locale.ROOT))
            }
        ) {
            fail("invalid_classification")
        }
        val facets = c.get("facets") as? JSONObject ?: fail("invalid_classification")
        fields(facets, setOf("audience", "textbook", "ancientText", "workCountry", "workPeriod"), emptySet())
        for (key in facets.keys()) {
            val v = facets.get(key)
            if (key == "textbook" || key == "ancientText") {
                if (v !is Boolean) fail("invalid_classification")
            } else if (classText(v).lowercase(Locale.ROOT) in listOf("未知", "不详", "不明", "unknown", "n/a")) {
                fail("invalid_classification")
            }
        }
        legacyTags(c.get("legacyTags"))
    }

    private fun requireManualEdits(
        old: JSONObject?,
        next: JSONObject,
    ) {
        for (key in listOf("category", "feature")) {
            val tag = if (next.isNull(key)) null else next.getJSONObject(key)
            if (tag != null && !equal(tag, old?.get(key))) manual(tag)
        }
        val previous = old?.getJSONArray("topics")
        val topics = next.getJSONArray("topics")
        for (i in 0 until topics.length()) {
            val tag = topics.getJSONObject(i)
            if (previous == null || (0 until previous.length()).none { equal(previous.get(it), tag) }) manual(tag)
        }
    }

    private fun manual(tag: JSONObject) {
        if (tag.getString("source") != "manual" || !tag.getBoolean("locked")) fail("manual_classification_required")
    }

    private fun classificationTags(c: JSONObject): JSONArray {
        val result = JSONArray()
        if (!c.isNull("category")) result.put(CATEGORIES.getValue(c.getJSONObject("category").getString("value")))
        val topics = c.getJSONArray("topics")
        for (i in 0 until topics.length()) result.put(topics.getJSONObject(i).getString("value"))
        if (!c.isNull("feature")) result.put(c.getJSONObject("feature").getString("value"))
        return result
    }

    companion object {
        private fun fail(code: String): Nothing = throw NativeStateFailure(code)

        private fun id(p: JSONObject) = text(p, "id", 4096).also { if (it.isEmpty()) fail("invalid_payload") }

        private fun text(
            p: JSONObject,
            key: String,
            max: Int,
        ): String =
            (p.get(key) as? String ?: fail("invalid_payload")).also {
                if (it.length >
                    max ||
                    it.contains('\u0000')
                ) {
                    fail("invalid_payload")
                }
            }

        private fun integer(
            p: JSONObject,
            key: String,
            default: Int,
            max: Int,
        ): Int {
            if (!p.has(key)) return default
            val n = (p.get(key) as? Number)?.toDouble() ?: fail("invalid_payload")
            if (!n.isFinite() || n < 0 || n > max || n % 1 != 0.0) fail("invalid_payload")
            return n.toInt()
        }

        private fun number(raw: String?): Number? {
            if (raw == null) return null
            return raw.toLongOrNull() ?: raw.toDoubleOrNull()?.takeIf { it.isFinite() } ?: fail("library_schema_mismatch")
        }

        private fun equal(
            a: Any?,
            b: Any?,
        ): Boolean {
            if (a == null || a == JSONObject.NULL) return b == null || b == JSONObject.NULL
            if (a is Number && b is Number) return a.toDouble() == b.toDouble()
            if (a is JSONObject && b is JSONObject) {
                val keys = a.keys().asSequence().toSet()
                return keys == b.keys().asSequence().toSet() && keys.all { equal(a.get(it), b.get(it)) }
            }
            if (a is JSONArray &&
                b is JSONArray
            ) {
                return a.length() == b.length() && (0 until a.length()).all { equal(a.get(it), b.get(it)) }
            }
            return a == b
        }

        private fun normalizeSpaces(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKC).replace(Regex("[\\s\\p{Z}]+"), " ").trim()

        private fun normalize(s: String) = normalizeSpaces(s).lowercase(Locale.ROOT)

        private val STATUSES = setOf("unmarked", "wanted", "reading", "paused", "finished", "abandoned")
        private val COLORS = setOf("yellow", "green", "blue", "red")
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
        private val JSON_FIELDS = setOf("tags", "classification", "sourceRef")
        private val NUMBERS = setOf("addedAt", "lastReadAt", "progress", "readingSeconds", "pinnedAt")
        private val EDITABLE_BOOK =
            setOf(
                "title",
                "author",
                "description",
                "language",
                "publisher",
                "publicationDate",
                "kind",
                "readingStatus",
                "pinnedAt",
                "tags",
                "classification",
            )
        private val BOOK_COLUMNS =
            linkedMapOf(
                "id" to "id",
                "title" to "title",
                "author" to "author",
                "format" to "format",
                "fileName" to "file_name",
                "description" to "description",
                "language" to "language",
                "publisher" to "publisher",
                "publicationDate" to "publication_date",
                "sourceRef" to "source_ref",
                "fileAvailability" to "file_availability",
                "tags" to "tags",
                "classification" to "classification",
                "addedAt" to "added_at",
                "lastReadAt" to "last_read_at",
                "location" to "location",
                "progress" to "progress",
                "source" to "source",
                "readingStatus" to "reading_status",
                "readingSeconds" to "reading_seconds",
                "pinnedAt" to "pinned_at",
                "kind" to "kind",
            )
        private val ANNOTATION_COLUMNS =
            linkedMapOf(
                "id" to "id",
                "bookId" to "book_id",
                "kind" to "kind",
                "cfi" to "cfi",
                "text" to "text",
                "note" to "note",
                "color" to "color",
                "createdAt" to "created_at",
            )
        private const val ANNOTATION_SELECT = "SELECT a.*,b.title AS book_title,b.author AS book_author FROM annotations a LEFT JOIN books b ON b.id=a.book_id"
        private val SCHEMA =
            mapOf(
                "books" to BOOK_COLUMNS.values.toSet() + "has_cover",
                "annotations" to ANNOTATION_COLUMNS.values.toSet(),
                "booklists" to setOf("id", "name", "created_at", "updated_at"),
                "booklist_items" to setOf("booklist_id", "book_id", "added_at"),
                "native_core_settings" to setOf("id", "revision", "json"),
                "native_core_migration" to setOf("id", "state"),
                "native_core_reading" to setOf("key", "seconds", "json"),
                "native_core_hashes" to setOf("book_id", "hash"),
            )
        private val CATEGORIES =
            linkedMapOf(
                "literature-language" to "文学与语言",
                "history-archaeology" to "历史与考古",
                "biography-memoir" to "传记与回忆",
                "philosophy-religion" to "哲学与宗教",
                "society-politics-law" to "社会政治与法律",
                "economics-finance" to "经济与金融",
                "business-management" to "商业与管理",
                "psychology-cognition" to "心理与认知",
                "education-learning" to "教育与学习",
                "computing-ai" to "计算机与AI",
                "science-mathematics" to "自然科学与数学",
                "engineering-industry" to "工程与产业技术",
                "medicine-health" to "医学与健康",
                "arts-design" to "艺术与设计",
                "life-leisure" to "生活与休闲",
                "general-reference" to "综合参考",
            )
        private val ALIASES = setOf("AI", "ai", "Artificial Intelligence", "科幻小说", "科学幻想", "心理学", "天文", "数学教材", "中医学", "Machine Learning")
        private val EXCLUDED =
            Regex(
                "(?:中文|英文|英语|汉语|简体|繁体|电子书|纸质书|EPUB|PDF|TXT|MOBI|精装|平装|未读|在读|已读|读完|暂停|畅销|畅销书|经典|必读|推荐|豆瓣高分|作者|教材|教科书|儿童|古籍)",
                RegexOption.IGNORE_CASE,
            )
        private val TOPIC_PATHS = listOf(setOf("人工智能", "机器学习", "深度学习"), setOf("天文学", "宇宙学"), setOf("中医", "中医基础理论"))
    }
}
