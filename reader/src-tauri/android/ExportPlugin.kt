package io.pagewise.reader

// 导出写入通道：只接受应用自己生成的 cache/export-*.zip 和用户在系统保存对话框中选择的
// content URI。与只读的 MonitoredFolderPlugin 分开，避免给源目录读取路径增加写能力。

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

private const val MAX_EXPORT_BYTES = 256L * 1024 * 1024
private const val MAX_IMPORT_BYTES = 1024L * 1024 * 1024
private const val EXPORT_PATH = "^cache/export-[A-Za-z0-9-]{1,64}\\.zip$"
private const val IMPORT_PATH = "^cache/import-[A-Za-z0-9-]{1,64}\\.bin$"
private const val IMPORT_TARGET = "^books/[A-Za-z0-9-]{1,64}\\.[A-Za-z0-9]{1,10}$"

@TauriPlugin
class ExportPlugin(
    private val activity: Activity,
) : Plugin(activity) {
    private val resolver get() = activity.contentResolver
    private val handler = Handler(Looper.getMainLooper())

    // A stuck provider must not retain an unbounded number of cancelled IPC requests.
    private val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(32))

    @Volatile private var destroyed = false
    private val operations = mutableSetOf<Operation>()

    private class Failure(
        val code: String,
    ) : Exception(code)

    private enum class State { QUEUED, RUNNING, COMMITTING, COMMITTED, CANCELLED, UNCERTAIN, FINISHED }

    private class Operation(
        private val invoke: Invoke,
    ) {
        private var state = State.QUEUED

        @Synchronized fun start(): Boolean {
            if (state != State.QUEUED) return false
            state = State.RUNNING
            return true
        }

        @Synchronized fun check() {
            if (state != State.RUNNING && state != State.COMMITTING) throw Failure("cancelled")
        }

        @Synchronized private fun enterCommit() {
            check()
            state = State.COMMITTING
        }

        // The commit transition, not the IPC reply, arbitrates with timeout. Never hold the
        // monitor during I/O: a stuck provider/rename must not block the Android main thread.
        fun commit(
            external: Boolean = false,
            action: () -> Unit,
        ) {
            enterCommit()
            try {
                action()
                synchronized(this) { if (state == State.COMMITTING) state = State.COMMITTED }
            } catch (error: Exception) {
                // Opening a provider can truncate before throwing; retain COMMITTING until
                // settlement so a racing timeout cannot claim that nothing was committed.
                if (external) throw Failure("outcome_unknown")
                synchronized(this) { if (state == State.COMMITTING) state = State.RUNNING }
                throw error
            }
        }

        @Synchronized fun cancel(code: String) {
            when (state) {
                State.QUEUED, State.RUNNING -> {
                    state = State.CANCELLED
                    invoke.reject(code, code)
                }

                State.COMMITTING -> {
                    state = State.UNCERTAIN
                    invoke.reject("outcome_unknown", "outcome_unknown")
                }

                else -> {
                    Unit
                }
            }
        }

        @Synchronized fun finish(
            result: JSObject?,
            error: Exception? = null,
        ) {
            if (state == State.CANCELLED || state == State.UNCERTAIN || state == State.FINISHED) return
            state = State.FINISHED
            if (error == null) {
                invoke.resolve(result)
            } else {
                val code = if (error is Failure) error.code else "io_error"
                invoke.reject(code, code)
            }
        }
    }

    private fun copy(
        input: InputStream,
        output: OutputStream,
        operation: Operation,
    ) {
        val buffer = ByteArray(65536)
        while (true) {
            operation.check()
            val count = input.read(buffer)
            if (count < 0) break
            operation.check()
            output.write(buffer, 0, count)
        }
        operation.check()
    }

    private fun file(path: String?): File {
        if (path == null || !Regex(EXPORT_PATH).matches(path)) throw Failure("invalid_reference")
        return File(activity.cacheDir, path.removePrefix("cache/"))
    }

    private fun importTemp(path: String?): File {
        if (path == null || !Regex(IMPORT_PATH).matches(path)) throw Failure("invalid_reference")
        return File(activity.cacheDir, path.removePrefix("cache/"))
    }

    private fun importTarget(path: String?): File {
        if (path == null || !Regex(IMPORT_TARGET).matches(path)) throw Failure("invalid_reference")
        // Storage 的 AppData 根是 activity.dataDir (books/ 直接位于其下), 不是 filesDir。
        return File(activity.dataDir, path)
    }

    private fun run(
        invoke: Invoke,
        timeoutMs: Long = 30_000,
        action: (Operation) -> JSObject?,
    ) {
        val operation = Operation(invoke)
        val timeout = Runnable { operation.cancel("timeout_not_committed") }
        synchronized(operations) {
            if (destroyed) {
                invoke.reject("unavailable", "unavailable")
                return
            }
            operations.add(operation)
            handler.postDelayed(timeout, timeoutMs)
        }
        try {
            executor.execute {
                try {
                    if (operation.start()) operation.finish(action(operation))
                } catch (error: Exception) {
                    operation.finish(null, error)
                } finally {
                    handler.removeCallbacks(timeout)
                    synchronized(operations) { operations.remove(operation) }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            handler.removeCallbacks(timeout)
            synchronized(operations) { operations.remove(operation) }
            operation.cancel("unavailable_not_committed")
        }
    }

    @Command
    fun begin(invoke: Invoke) =
        run(invoke) { operation ->
            val target = file(invoke.getArgs().getString("path"))
            target.parentFile?.let { parent -> if (!parent.isDirectory && !parent.mkdirs()) throw Failure("io_error") }
            operation.commit { FileOutputStream(target, false).use { } }
            JSObject()
        }

    @Command
    fun append(invoke: Invoke) =
        run(invoke) { operation ->
            val target = file(invoke.getArgs().getString("path"))
            if (!target.isFile) throw Failure("not_found")
            if (target.length() > MAX_EXPORT_BYTES) throw Failure("resource_limit")
            val bytes =
                try {
                    android.util.Base64.decode(invoke.getArgs().getString("data"), android.util.Base64.NO_WRAP)
                } catch (_: Exception) {
                    throw Failure("invalid_reference")
                }
            if (bytes.size > 4 * 1024 * 1024 || target.length() > MAX_EXPORT_BYTES - bytes.size) throw Failure("resource_limit")
            operation.commit { FileOutputStream(target, true).use { output -> output.write(bytes) } }
            JSObject()
        }

    @Command
    fun write(invoke: Invoke) =
        run(invoke, 120_000) { operation ->
            val source = file(invoke.getArgs().getString("path"))
            if (!source.isFile) throw Failure("not_found")
            val uri = Uri.parse(invoke.getArgs().getString("uri"))
            if (uri.scheme != "content") throw Failure("invalid_reference")
            operation.commit(external = true) {
                val output =
                    resolver.openOutputStream(uri, "wt") ?: run {
                        operation.check()
                        resolver.openOutputStream(uri, "w") ?: throw Failure("unavailable")
                    }
                output.use { out ->
                    operation.check()
                    FileInputStream(source).use { input -> copy(input, out, operation) }
                    operation.check()
                    out.flush()
                }
            }
            JSObject()
        }

    @Command
    fun delete(invoke: Invoke) =
        run(invoke) { operation ->
            val target = file(invoke.getArgs().getString("path"))
            operation.commit { if (target.exists() && !target.delete()) throw Failure("io_error") }
            JSObject()
        }

    // ---- 大文件导入: base64 分块写入 cache, 再原生发布到 books/ ----

    @Command
    fun beginImport(invoke: Invoke) =
        run(invoke) { operation ->
            val target = importTemp(invoke.getArgs().getString("path"))
            target.parentFile?.let { parent -> if (!parent.isDirectory && !parent.mkdirs()) throw Failure("io_error") }
            operation.commit { FileOutputStream(target, false).use { } }
            JSObject()
        }

    @Command
    fun appendImport(invoke: Invoke) =
        run(invoke) { operation ->
            val target = importTemp(invoke.getArgs().getString("path"))
            if (!target.isFile) throw Failure("not_found")
            if (target.length() > MAX_IMPORT_BYTES) throw Failure("resource_limit")
            val bytes =
                try {
                    android.util.Base64.decode(invoke.getArgs().getString("data"), android.util.Base64.NO_WRAP)
                } catch (_: Exception) {
                    throw Failure("invalid_reference")
                }
            if (bytes.size > 4 * 1024 * 1024 || target.length() > MAX_IMPORT_BYTES - bytes.size) throw Failure("resource_limit")
            operation.commit { FileOutputStream(target, true).use { output -> output.write(bytes) } }
            JSObject()
        }

    @Command
    fun publishImport(invoke: Invoke) =
        run(invoke, 120_000) { operation ->
            val source = importTemp(invoke.getArgs().getString("path"))
            if (!source.isFile) throw Failure("not_found")
            val target = importTarget(invoke.getArgs().getString("target"))
            val parent = target.parentFile ?: throw Failure("io_error")
            if (!parent.isDirectory && !parent.mkdirs()) throw Failure("io_error")
            try {
                // rename(2) replaces atomically without first removing the existing book (Android API 21+).
                operation.commit { Os.rename(source.absolutePath, target.absolutePath) }
            } catch (error: ErrnoException) {
                if (error.errno != OsConstants.EXDEV) throw error
                // Cross-filesystem copies must finish beside the target before committing the replacement.
                operation.check()
                val staged = File.createTempFile(".pagewise-import-", ".tmp", parent)
                try {
                    FileInputStream(source).use { input ->
                        FileOutputStream(staged).use { output ->
                            copy(input, output, operation)
                            operation.check()
                            output.fd.sync()
                        }
                    }
                    operation.commit { Os.rename(staged.absolutePath, target.absolutePath) }
                    source.delete()
                } finally {
                    staged.delete()
                }
            }
            JSObject()
        }

    @Command
    fun deleteImport(invoke: Invoke) =
        run(invoke) { operation ->
            val target = importTemp(invoke.getArgs().getString("path"))
            operation.commit { if (target.exists() && !target.delete()) throw Failure("io_error") }
            JSObject()
        }

    override fun onDestroy(activity: AppCompatActivity) {
        synchronized(operations) {
            destroyed = true
            operations.forEach { it.cancel("unavailable_not_committed") }
            operations.clear()
        }
        handler.removeCallbacksAndMessages(null)
        executor.shutdownNow()
    }
}
