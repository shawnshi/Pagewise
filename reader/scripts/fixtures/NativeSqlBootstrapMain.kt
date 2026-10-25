package io.pagewise.reader

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private class BootstrapPreferences : SharedPreferences {
    private val values = mutableMapOf<String, Any?>()

    override fun getAll(): MutableMap<String, *> = values.toMutableMap()

    override fun getString(
        k: String,
        d: String?,
    ) = values[k] as? String ?: d

    override fun getStringSet(
        k: String,
        d: MutableSet<String>?,
    ) = d

    override fun getInt(
        k: String,
        d: Int,
    ) = values[k] as? Int ?: d

    override fun getLong(
        k: String,
        d: Long,
    ) = values[k] as? Long ?: d

    override fun getFloat(
        k: String,
        d: Float,
    ) = values[k] as? Float ?: d

    override fun getBoolean(
        k: String,
        d: Boolean,
    ) = values[k] as? Boolean ?: d

    override fun contains(k: String) = values.containsKey(k)

    override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

    override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

    override fun edit(): SharedPreferences.Editor =
        object : SharedPreferences.Editor {
            override fun putString(
                k: String,
                v: String?,
            ) = apply { values[k] = v }

            override fun putStringSet(
                k: String,
                v: MutableSet<String>?,
            ) = apply { values[k] = v }

            override fun putInt(
                k: String,
                v: Int,
            ) = apply { values[k] = v }

            override fun putLong(
                k: String,
                v: Long,
            ) = apply { values[k] = v }

            override fun putFloat(
                k: String,
                v: Float,
            ) = apply { values[k] = v }

            override fun putBoolean(
                k: String,
                v: Boolean,
            ) = apply { values[k] = v }

            override fun remove(k: String) = apply { values.remove(k) }

            override fun clear() = apply { values.clear() }

            override fun commit() = true

            override fun apply() = Unit
        }
}

private class BootstrapContext(
    private val directory: File,
) : ContextWrapper(null) {
    val prefs = BootstrapPreferences()

    override fun getDataDir() = directory

    override fun getSharedPreferences(
        name: String,
        mode: Int,
    ): SharedPreferences = prefs
}

fun main(args: Array<String>) {
    val base = File(args.single()).canonicalFile
    check(base.path.startsWith("/data/local/tmp/pagewise-pw17-bootstrap-"))
    check(!base.exists()) { "Use a new isolated fixture directory" }
    check(base.mkdirs())
    val results = JSONArray()
    var failures = 0

    fun record(
        name: String,
        action: () -> Unit,
    ) {
        try {
            action()
            results.put(JSONObject().put("name", name).put("passed", true))
        } catch (e: Throwable) {
            failures++
            results.put(
                JSONObject().put("name", name).put("passed", false).put(
                    "error",
                    e.javaClass.simpleName + ":" + e.message,
                ),
            )
        }
    }

    fun context(name: String) = BootstrapContext(File(base, name).apply { mkdirs() })

    fun migrated(name: String): BootstrapContext {
        val ctx = context(name)
        NativeStateStore(ctx, "").use {
            it.command(
                "migrationBegin",
                JSONObject()
                    .put(
                        "settings",
                        "{\"sentinel\":\"preserve\"}",
                    ).put("identity", "{\"deviceId\":null,\"hashes\":[]}")
                    .put("rows", 0)
                    .put("chunks", 0),
            )
            it.command("migrationCommit", JSONObject())
            check(it.command("status", JSONObject()).getString("state") == "complete")
        }
        return ctx
    }

    fun raw(
        ctx: BootstrapContext,
        action: (SQLiteDatabase) -> Unit,
    ) = CanonicalDatabase.open(File(ctx.dataDir, "lightread.db")).use(action)

    fun tableNames(ctx: BootstrapContext): Set<String> {
        val names = mutableSetOf<String>()
        raw(ctx) { db ->
            db.rawQuery("SELECT name FROM sqlite_master WHERE type='table'", null).use {
                while (it.moveToNext()) names.add(it.getString(0))
            }
        }
        return names
    }

    fun invoke(
        ctx: BootstrapContext,
        action: String,
        payload: JSONObject = JSONObject(),
    ): JSONObject {
        val ctor = NativeSqlDatabase::class.java.declaredConstructors.firstOrNull { it.parameterTypes.size == 3 }
        val db =
            if (action == "sql.initialize" &&
                ctor != null
            ) {
                ctor.newInstance(ctx, "", true) as NativeSqlDatabase
            } else {
                NativeSqlDatabase(ctx, "")
            }
        return db.use { it.command(action, payload) }
    }
    val schema =
        JSONArray()
            .put(
                "CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,title TEXT)",
            ).put("CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY,note TEXT)")

    fun initialize(
        ctx: BootstrapContext,
        statements: JSONArray = schema,
    ) = invoke(ctx, "sql.initialize", JSONObject().put("statements", statements))

    fun rejected(
        ctx: BootstrapContext,
        statements: JSONArray = schema,
    ) {
        val before = tableNames(ctx)
        val failed = runCatching { initialize(ctx, statements) }.isFailure
        check(failed) { "Unsafe bootstrap accepted" }
        check(before == tableNames(ctx)) { "Rejected initialization modified schema" }
    }
    record("native state migration followed by SQL initialization and SELECT succeeds") {
        val ctx = migrated("fresh")
        initialize(ctx)
        val rows = invoke(ctx, "sql.select", JSONObject().put("sql", "SELECT 1 AS ready")).getJSONArray("rows")
        check(rows.getJSONObject(0).getInt("ready") == 1)
        NativeStateStore(ctx).use {
            check(JSONObject(it.command("settingsGet", JSONObject()).getString("raw")).getString("sentinel") == "preserve")
        }
    }
    record("plain SQL cannot bypass missing library schema") {
        val ctx = migrated("plain")
        check(runCatching { invoke(ctx, "sql.select", JSONObject().put("sql", "SELECT 1")) }.isFailure)
        check("books" !in tableNames(ctx))
    }
    record("initialization is idempotent and preserves existing book/annotation rows") {
        val ctx = migrated("existing")
        initialize(ctx)
        raw(ctx) {
            it.execSQL("INSERT INTO books VALUES('own-fixture','keep')")
            it.execSQL("INSERT INTO annotations VALUES('own-note','keep-note')")
        }
        initialize(ctx)
        raw(ctx) { db ->
            db.rawQuery("SELECT title FROM books", null).use { check(it.moveToFirst() && it.getString(0) == "keep") }
            db.rawQuery("SELECT note FROM annotations", null).use {
                check(it.moveToFirst() && it.getString(0) == "keep-note")
            }
        }
    }
    record("partial existing library is rejected without completing an empty replacement") {
        val ctx = migrated("partial")
        raw(ctx) { it.execSQL("CREATE TABLE books(id TEXT)") }
        rejected(ctx)
    }
    record("unknown existing tables are rejected and retained") {
        val ctx = migrated("unknown")
        raw(ctx) {
            it.execSQL("CREATE TABLE private_sentinel(value TEXT)")
            it.execSQL("INSERT INTO private_sentinel VALUES('keep')")
        }
        rejected(ctx)
    }
    record("book files prevent empty-library bootstrap") {
        val ctx = migrated("files")
        File(ctx.dataDir, "books").mkdirs()
        File(ctx.dataDir, "books/own-fixture.epub").writeText("fixture")
        rejected(ctx)
    }
    record("cover files prevent empty-library bootstrap") {
        val ctx = migrated("covers")
        File(ctx.dataDir, "covers").mkdirs()
        File(ctx.dataDir, "covers/own-fixture.png").writeText("fixture")
        rejected(ctx)
    }
    record("existing reading records prevent empty-library bootstrap") {
        val ctx = migrated("reading")
        raw(ctx) { it.execSQL("INSERT INTO native_core_reading VALUES('fixture',1,'{}')") }
        rejected(ctx)
    }
    record("existing hash mapping prevents empty-library bootstrap") {
        val ctx = migrated("hash")
        raw(ctx) { it.execSQL("INSERT INTO native_core_hashes VALUES('fixture','hash')") }
        rejected(ctx)
    }
    record("migration evidence of legacy rows prevents bootstrap") {
        val ctx = migrated("legacy")
        raw(ctx) { it.execSQL("UPDATE native_core_migration SET expected_rows=1") }
        rejected(ctx)
    }
    record("DDL failure rolls back all newly created tables") {
        val ctx = migrated("rollback")
        rejected(ctx, JSONArray().put(schema.getString(0)).put("CREATE TABLE IF NOT EXISTS broken(???"))
    }
    record("empty initialization request cannot create a ready schema") { rejected(migrated("empty"), JSONArray()) }
    record("non-DDL input is rejected without a schema change") {
        rejected(migrated("dml"), JSONArray().put("DELETE FROM native_core_settings"))
    }
    record("incomplete schema request rolls back") { rejected(migrated("incomplete"), JSONArray().put(schema.getString(0))) }
    record("initialized missing database is not recreated") {
        val ctx = migrated("missing")
        val file = File(ctx.dataDir, "lightread.db")
        check(file.delete())
        check(runCatching { initialize(ctx) }.isFailure)
        check(!file.exists())
    }
    println(
        JSONObject()
            .put("passed", failures == 0)
            .put("failures", failures)
            .put("results", results)
            .toString(),
    )
    check(failures == 0) { "$failures bootstrap assertions failed" }
}
