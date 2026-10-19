package io.pagewise.reader

// 导出写入通道：只接受应用自己生成的 cache/export-*.zip 和用户在系统保存对话框中选择的
// content URI。与只读的 MonitoredFolderPlugin 分开，避免给源目录读取路径增加写能力。

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

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
    private val executor = Executors.newSingleThreadExecutor()

    @Volatile private var destroyed = false

    private class Failure(
        val code: String,
    ) : Exception(code)

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
        action: () -> JSObject?,
    ) {
        if (destroyed) {
            invoke.reject("unavailable", "unavailable")
            return
        }
        val settled = AtomicBoolean(false)
        val timeout =
            Runnable {
                if (settled.compareAndSet(false, true)) invoke.reject("unavailable", "unavailable")
            }
        handler.postDelayed(timeout, timeoutMs)
        try {
            executor.execute {
                try {
                    val result = action()
                    if (settled.compareAndSet(false, true)) invoke.resolve(result)
                } catch (error: Exception) {
                    if (settled.compareAndSet(false, true)) {
                        val code = if (error is Failure) error.code else "io_error"
                        invoke.reject(code, code)
                    }
                } finally {
                    handler.removeCallbacks(timeout)
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            handler.removeCallbacks(timeout)
            invoke.reject("unavailable", "unavailable")
        }
    }

    @Command
    fun begin(invoke: Invoke) =
        run(invoke) {
            val target = file(invoke.getArgs().getString("path"))
            target.parentFile?.let { parent -> if (!parent.isDirectory && !parent.mkdirs()) throw Failure("io_error") }
            FileOutputStream(target, false).use { }
            JSObject()
        }

    @Command
    fun append(invoke: Invoke) =
        run(invoke) {
            val target = file(invoke.getArgs().getString("path"))
            if (!target.isFile) throw Failure("not_found")
            if (target.length() > MAX_EXPORT_BYTES) throw Failure("resource_limit")
            val bytes =
                try {
                    android.util.Base64.decode(invoke.getArgs().getString("data"), android.util.Base64.NO_WRAP)
                } catch (_: Exception) {
                    throw Failure("invalid_reference")
                }
            if (bytes.size > 4 * 1024 * 1024) throw Failure("resource_limit")
            FileOutputStream(target, true).use { output -> output.write(bytes) }
            JSObject()
        }

    @Command
    fun write(invoke: Invoke) =
        run(invoke, 120_000) {
            val source = file(invoke.getArgs().getString("path"))
            if (!source.isFile) throw Failure("not_found")
            val uri = Uri.parse(invoke.getArgs().getString("uri"))
            if (uri.scheme != "content") throw Failure("invalid_reference")
            val output = resolver.openOutputStream(uri, "wt") ?: resolver.openOutputStream(uri, "w") ?: throw Failure("unavailable")
            output.use { out ->
                FileInputStream(source).use { input ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        out.write(buffer, 0, count)
                    }
                }
                out.flush()
            }
            JSObject()
        }

    @Command
    fun delete(invoke: Invoke) {
        try {
            file(invoke.getArgs().getString("path")).delete()
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("invalid_reference", "invalid_reference")
        }
    }

    // ---- 大文件导入: base64 分块写入 cache, 再原生发布到 books/ ----

    @Command
    fun beginImport(invoke: Invoke) =
        run(invoke) {
            val target = importTemp(invoke.getArgs().getString("path"))
            target.parentFile?.let { parent -> if (!parent.isDirectory && !parent.mkdirs()) throw Failure("io_error") }
            FileOutputStream(target, false).use { }
            JSObject()
        }

    @Command
    fun appendImport(invoke: Invoke) =
        run(invoke) {
            val target = importTemp(invoke.getArgs().getString("path"))
            if (!target.isFile) throw Failure("not_found")
            if (target.length() > MAX_IMPORT_BYTES) throw Failure("resource_limit")
            val bytes =
                try {
                    android.util.Base64.decode(invoke.getArgs().getString("data"), android.util.Base64.NO_WRAP)
                } catch (_: Exception) {
                    throw Failure("invalid_reference")
                }
            if (bytes.size > 4 * 1024 * 1024) throw Failure("resource_limit")
            FileOutputStream(target, true).use { output -> output.write(bytes) }
            JSObject()
        }

    @Command
    fun publishImport(invoke: Invoke) =
        run(invoke, 120_000) {
            val source = importTemp(invoke.getArgs().getString("path"))
            if (!source.isFile) throw Failure("not_found")
            val target = importTarget(invoke.getArgs().getString("target"))
            target.parentFile?.let { parent -> if (!parent.isDirectory && !parent.mkdirs()) throw Failure("io_error") }
            if (target.exists() && !target.delete()) throw Failure("io_error")
            if (!source.renameTo(target)) {
                try {
                    source.inputStream().use { input -> target.outputStream().use { output -> input.copyTo(output) } }
                } catch (error: Exception) {
                    target.delete()
                    throw error
                }
                source.delete()
            }
            JSObject()
        }

    @Command
    fun deleteImport(invoke: Invoke) {
        try {
            importTemp(invoke.getArgs().getString("path")).delete()
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("invalid_reference", "invalid_reference")
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        destroyed = true
        executor.shutdownNow()
    }
}
