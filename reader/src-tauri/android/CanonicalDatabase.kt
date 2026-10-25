package io.pagewise.reader

import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteDatabaseLockedException
import android.database.sqlite.SQLiteException
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

internal class CanonicalDatabaseFailure(
    val code: String,
    cause: Throwable? = null,
) : IOException(code, cause)

internal object CanonicalDatabase {
    private val quarantined = ConcurrentHashMap.newKeySet<String>()
    private val header = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)

    fun failure(
        file: File,
        error: Throwable,
    ): Throwable {
        val corrupt =
            generateSequence(error) { it.cause }.take(16).any {
                it is SQLiteDatabaseCorruptException || (it is CanonicalDatabaseFailure && it.code == "library_database_corrupt")
            }
        if (!corrupt) return error
        quarantined.add(file.canonicalPath)
        if (error.message in setOf("commit_outcome_unknown", "native_state_unknown", "activity_changed_outcome_unknown")) return error
        return if (error is CanonicalDatabaseFailure) error else CanonicalDatabaseFailure("library_database_corrupt", error)
    }

    fun <T> protect(
        file: File,
        work: () -> T,
    ): T =
        try {
            work()
        } catch (error: Throwable) {
            throw failure(file, error)
        }

    fun open(
        file: File,
        create: Boolean = false,
        readOnly: Boolean = false,
    ): SQLiteDatabase {
        val key = file.canonicalPath
        if (key in quarantined) throw CanonicalDatabaseFailure("library_database_corrupt")
        if (!file.isFile) {
            val evidence =
                listOf("books", "covers").any { File(file.parentFile, it).list()?.isNotEmpty() == true } ||
                    listOf("-wal", "-shm", "-journal").any { File(file.path + it).exists() }
            if (!create || readOnly || evidence || file.exists()) throw CanonicalDatabaseFailure("library_database_missing")
        } else {
            val found = ByteArray(header.size)
            val size = file.inputStream().use { it.read(found) }
            if (size != header.size || !found.contentEquals(header)) {
                quarantined.add(key)
                throw CanonicalDatabaseFailure("library_database_corrupt")
            }
        }
        val handler =
            DatabaseErrorHandler {
                // The framework default handler deletes the canonical DB and sidecars before retrying open.
                quarantined.add(key)
                throw CanonicalDatabaseFailure("library_database_corrupt")
            }
        var flags = SQLiteDatabase.NO_LOCALIZED_COLLATORS
        flags =
            flags or
            if (readOnly) SQLiteDatabase.OPEN_READONLY else SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING
        if (create) flags = flags or SQLiteDatabase.CREATE_IF_NECESSARY
        return try {
            SQLiteDatabase.openDatabase(file.path, null, flags, handler)
        } catch (error: SQLiteDatabaseCorruptException) {
            quarantined.add(key)
            throw CanonicalDatabaseFailure("library_database_corrupt", error)
        } catch (error: SQLiteDatabaseLockedException) {
            throw CanonicalDatabaseFailure("library_database_busy", error)
        } catch (error: SQLiteException) {
            throw CanonicalDatabaseFailure("library_database_error", error)
        }
    }
}
