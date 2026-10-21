package io.pagewise.reader

import android.app.Activity
import android.content.ContentResolver
import android.os.Handler
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import androidx.appcompat.app.AppCompatActivity
import app.tauri.plugin.Invoke
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private fun CountDownLatch.waitFor() {
    check(await(3, TimeUnit.SECONDS)) { "latch deadline" }
}

private fun Invoke.expect(expected: String) {
    done.waitFor()
    check(code == expected) { "expected $expected, received $code" }
    check(replies == 1)
}

private class Gate {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)

    fun block() {
        entered.countDown()
        release.waitFor()
    }
}

private class Fixture(
    root: File,
    name: String,
) {
    val dir = File(root, name).also { it.mkdirs() }
    val cache = File(dir, "cache").also { it.mkdirs() }
    val data = File(dir, "data").also { it.mkdirs() }
    val resolver = ContentResolver()
    val plugin = ExportPlugin(Activity(cache, data, resolver))
    val releases = mutableListOf<CountDownLatch>()

    fun gate() = Gate().also { releases.add(it.release) }

    fun temp(
        name: String = "import-a.bin",
        bytes: String = "new",
    ) = File(cache, name).also { it.writeText(bytes) }

    fun target() =
        File(data, "books/a.epub").also {
            it.parentFile.mkdirs()
            it.writeText("old")
        }

    fun drain() {
        val fence = Invoke("path" to "cache/export-fence.zip")
        plugin.begin(fence)
        fence.expect("ok")
    }

    fun close() {
        releases.forEach { it.countDown() }
        plugin.onDestroy(AppCompatActivity())
        val executor =
            ExportPlugin::class.java
                .getDeclaredField("executor")
                .also { it.isAccessible = true }
                .get(plugin) as java.util.concurrent.ExecutorService
        check(executor.awaitTermination(3, TimeUnit.SECONDS)) { "worker did not terminate" }
    }
}

fun main(args: Array<String>) {
    val root = File(args[0]).also { it.mkdirs() }
    var failures = 0
    var scenarios = 0

    fun scenario(
        name: String,
        action: (Fixture) -> Unit,
    ) {
        scenarios++
        val f = Fixture(root, "$scenarios-$name")
        Os.calls = 0
        Os.before = { _, _ -> }
        try {
            action(f)
            println("PASS $name")
        } catch (
            error: Throwable,
        ) {
            failures++
            println("FAIL $name: ${error.message}")
        } finally {
            f.close()
            Handler.fireAll()
        }
    }
    scenario("queued-timeout-never-starts") { f ->
        f.temp("export-a.zip")
        val gate = f.gate()
        f.resolver.opener = { _, _ ->
            gate.block()
            ByteArrayOutputStream()
        }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        gate.entered.waitFor()
        val queued = Invoke("path" to "cache/import-late.bin")
        f.plugin.beginImport(queued)
        val source = f.temp()
        val target = f.target()
        val append = Invoke("path" to "cache/import-a.bin", "data" to "YQ==")
        f.plugin.appendImport(append)
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        Handler.fireAll()
        queued.expect("timeout_not_committed")
        writing.expect("outcome_unknown")
        append.expect("timeout_not_committed")
        publish.expect("timeout_not_committed")
        gate.release.countDown()
        f.drain()
        check(!File(f.cache, "import-late.bin").exists()) { "timed out queued command created a file" }
        check(source.readText() == "new" && target.readText() == "old" && Os.calls == 0)
        check(queued.replies == 1 && writing.replies == 1 && append.replies == 1 && publish.replies == 1)
    }
    scenario("cancel-before-local-commit") { f ->
        val source = f.temp()
        val target = f.target()
        val gate = f.gate()
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        publish.getArgs().beforeGet = { key -> if (key == "target") gate.block() }
        f.plugin.publishImport(publish)
        gate.entered.waitFor()
        Handler.fireAll()
        publish.expect("timeout_not_committed")
        gate.release.countDown()
        f.drain()
        check(target.readText() == "old" && source.readText() == "new" && Os.calls == 0)
    }
    scenario("rename-wins-timeout-is-not-definitive") { f ->
        val source = f.temp()
        val target = f.target()
        val gate = f.gate()
        Os.before = { _, _ -> gate.block() }
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        gate.entered.waitFor()
        Handler.fireAll()
        publish.expect("outcome_unknown")
        gate.release.countDown()
        f.drain()
        check(target.readText() == "new" && !source.exists() && publish.replies == 1)
    }
    scenario("EXDEV-timeout-cannot-late-publish") { f ->
        val source = f.temp()
        val target = f.target()
        val gate = f.gate()
        Os.before = { _, _ ->
            gate.block()
            throw ErrnoException("rename", OsConstants.EXDEV)
        }
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        gate.entered.waitFor()
        Handler.fireAll()
        publish.expect("outcome_unknown")
        gate.release.countDown()
        f.drain()
        check(target.readText() == "old" && source.readText() == "new" && Os.calls == 1)
        check(target.parentFile.listFiles()!!.none { it.name.startsWith(".pagewise-import-") })
    }
    scenario("provider-timeout-stops-next-chunk-and-serializes-delete") { f ->
        val source = f.temp("export-a.zip", "x".repeat(65536 * 3))
        val gate = f.gate()
        val bytes = ByteArrayOutputStream()
        f.resolver.opener = { _, _ ->
            object : java.io.OutputStream() {
                override fun write(b: Int) {
                    error("unexpected single byte")
                }

                override fun write(
                    b: ByteArray,
                    offset: Int,
                    count: Int,
                ) {
                    bytes.write(b, offset, count)
                    gate.block()
                }
            }
        }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        gate.entered.waitFor()
        val deleting = Invoke("path" to "cache/export-a.zip")
        f.plugin.delete(deleting)
        check(source.exists() && deleting.replies == 0) { "delete bypassed in-flight write" }
        Handler.fireFirst()
        writing.expect("outcome_unknown")
        check(source.exists())
        gate.release.countDown()
        deleting.expect("ok")
        f.drain()
        check(bytes.size() == 65536 && !source.exists() && writing.replies == 1)
    }
    scenario("import-delete-waits-for-commit") { f ->
        val source = f.temp()
        val target = f.target()
        val gate = f.gate()
        Os.before = { _, _ -> gate.block() }
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        gate.entered.waitFor()
        val deleting = Invoke("path" to "cache/import-a.bin")
        f.plugin.deleteImport(deleting)
        check(source.exists() && deleting.replies == 0)
        gate.release.countDown()
        publish.expect("ok")
        deleting.expect("ok")
        check(target.readText() == "new")
    }
    scenario("provider-failure-is-uncertain-not-retryable") { f ->
        f.temp("export-a.zip")
        f.resolver.opener = { _, _ -> throw java.io.IOException("provider may already truncate") }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        writing.expect("outcome_unknown")
    }
    scenario("provider-flush-failure-is-uncertain") { f ->
        f.temp("export-a.zip")
        f.resolver.opener = { _, _ ->
            object : ByteArrayOutputStream() {
                override fun flush(): Unit = throw java.io.IOException("flush")
            }
        }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        writing.expect("outcome_unknown")
    }
    scenario("provider-fallback-does-not-open-after-cancel") { f ->
        f.temp("export-a.zip")
        val gate = f.gate()
        var opens = 0
        f.resolver.opener = { _, _ ->
            opens++
            gate.block()
            null
        }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        gate.entered.waitFor()
        Handler.fireFirst()
        writing.expect("outcome_unknown")
        gate.release.countDown()
        f.drain()
        check(opens == 1)
    }
    scenario("precommit-copy-cancellation-after-blocked-read") { f ->
        // Exercise the exact copy routine used by EXDEV staging, without a filesystem-speed race.
        val invoke = Invoke()
        val type = Class.forName("io.pagewise.reader.ExportPlugin\$Operation")
        val operation =
            type
                .getDeclaredConstructor(Invoke::class.java, kotlin.jvm.functions.Function0::class.java)
                .also {
                    it.isAccessible =
                        true
                }.newInstance(invoke, { Unit })
        type.getDeclaredMethod("start").also { it.isAccessible = true }.invoke(operation)
        val gate = f.gate()
        val bytes = ByteArrayOutputStream()
        val input =
            object : java.io.InputStream() {
                override fun read(): Int = error("unexpected single byte")

                override fun read(buffer: ByteArray): Int {
                    gate.block()
                    buffer[0] = 7
                    return 1
                }
            }
        val copy =
            ExportPlugin::class.java
                .getDeclaredMethod(
                    "copy",
                    java.io.InputStream::class.java,
                    java.io.OutputStream::class.java,
                    type,
                ).also {
                    it.isAccessible =
                        true
                }
        val failure =
            java.util.concurrent.atomic
                .AtomicReference<Throwable>()
        val worker =
            Thread {
                try {
                    copy.invoke(f.plugin, input, bytes, operation)
                } catch (
                    error: java.lang.reflect.InvocationTargetException,
                ) {
                    failure.set(error.targetException)
                }
            }
        worker.start()
        gate.entered.waitFor()
        type.getDeclaredMethod("cancel", String::class.java).also { it.isAccessible = true }.invoke(operation, "timeout_not_committed")
        invoke.expect("timeout_not_committed")
        gate.release.countDown()
        worker.join(3000)
        check(!worker.isAlive && failure.get()?.message == "cancelled" && bytes.size() == 0)
    }
    scenario("repeated-timeout-commit-races") { f ->
        repeat(80) {
            val source = f.temp()
            val target = f.target()
            val gate = f.gate()
            val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
            publish.getArgs().beforeGet = { key -> if (key == "target") gate.block() }
            f.plugin.publishImport(publish)
            gate.entered.waitFor()
            val start = CountDownLatch(1)
            val timer =
                Thread {
                    start.waitFor()
                    Handler.fireAll()
                }
            val resume =
                Thread {
                    start.waitFor()
                    gate.release.countDown()
                }
            timer.start()
            resume.start()
            start.countDown()
            timer.join(3000)
            resume.join(3000)
            check(!timer.isAlive && !resume.isAlive)
            publish.done.waitFor()
            f.drain()
            check(publish.replies == 1)
            when (publish.code) {
                "timeout_not_committed" -> check(target.readText() == "old" && source.exists())
                "ok" -> check(target.readText() == "new" && !source.exists())
                "outcome_unknown" -> check(target.readText() == "new" && !source.exists())
                else -> error("unexpected race result ${publish.code}")
            }
        }
    }
    scenario("local-rename-failure-keeps-original") { f ->
        val source = f.temp()
        val target = f.target()
        Os.before = { _, _ -> throw ErrnoException("rename", 13) }
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        publish.expect("io_error")
        check(target.readText() == "old" && source.exists())
    }
    scenario("EXDEV-stages-and-atomically-replaces") { f ->
        val source = f.temp()
        val target = f.target()
        Os.before = { _, _ -> if (Os.calls == 1) throw ErrnoException("rename", OsConstants.EXDEV) }
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        publish.expect("ok")
        check(target.readText() == "new" && !source.exists() && Os.calls == 2)
        check(target.parentFile.listFiles()!!.none { it.name.startsWith(".pagewise-import-") })
    }
    scenario("successful-commit-settles-once") { f ->
        f.temp()
        val target = f.target()
        val publish = Invoke("path" to "cache/import-a.bin", "target" to "books/a.epub")
        f.plugin.publishImport(publish)
        publish.expect("ok")
        Handler.fireAll()
        check(target.readText() == "new" && publish.replies == 1)
    }
    scenario("invalid-input-has-no-provider-side-effect") { f ->
        var opens = 0
        f.resolver.opener = { _, _ ->
            opens++
            ByteArrayOutputStream()
        }
        f.temp("export-a.zip")
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "file:///synthetic")
        f.plugin.write(writing)
        writing.expect("invalid_reference")
        check(opens == 0)
        val begin = Invoke("path" to "../escape")
        f.plugin.begin(begin)
        begin.expect("invalid_reference")
    }
    scenario("stuck-provider-queue-is-bounded") { f ->
        f.temp("export-a.zip")
        val gate = f.gate()
        f.resolver.opener = { _, _ ->
            gate.block()
            ByteArrayOutputStream()
        }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        gate.entered.waitFor()
        val queued = (1..32).map { index -> Invoke("path" to "cache/import-queued$index.bin").also { f.plugin.beginImport(it) } }
        val rejected = Invoke("path" to "cache/import-overflow.bin")
        f.plugin.beginImport(rejected)
        rejected.expect("unavailable_not_committed")
        Handler.fireAll()
        writing.expect("outcome_unknown")
        queued.forEach { it.expect("timeout_not_committed") }
        gate.release.countDown()
        check(!File(f.cache, "import-overflow.bin").exists())
    }
    scenario("shutdown-cancels-active-and-queued") { f ->
        f.temp("export-a.zip")
        val gate = f.gate()
        f.resolver.opener = { _, _ ->
            gate.block()
            ByteArrayOutputStream()
        }
        val writing = Invoke("path" to "cache/export-a.zip", "uri" to "content://synthetic")
        f.plugin.write(writing)
        gate.entered.waitFor()
        val queued = Invoke("path" to "cache/import-shutdown.bin")
        f.plugin.beginImport(queued)
        f.plugin.onDestroy(AppCompatActivity())
        writing.expect("outcome_unknown")
        queued.expect("unavailable_not_committed")
        gate.release.countDown()
        val after = Invoke("path" to "cache/export-after.zip")
        f.plugin.begin(after)
        after.expect("unavailable")
        check(!File(f.cache, "import-shutdown.bin").exists())
    }
    scenario("reloaded-preparing-cleanup-waits-for-physical-upload-and-seals-late-IPC") { f ->
        val name = "import-12345678-1234-4234-8234-123456789abc.bin"
        val path = "cache/" + name
        val source = f.temp(name, "old")
        val entered = CountDownLatch(1)
        val release = f.gate().release
        HostFileOutputStream.before = { file ->
            if (file.name == name) {
                entered.countDown()
                while (release.count > 0) {
                    try {
                        release.await(3, TimeUnit.SECONDS)
                    } catch (_: InterruptedException) {
                        // provider ignores interrupt
                    }
                }
            }
        }
        try {
            val append = Invoke("path" to path, "data" to "YQ==")
            f.plugin.appendImport(append)
            entered.waitFor()
            f.plugin.onDestroy(AppCompatActivity())
            append.expect("outcome_unknown")
            check(!NativeImportUploads.seal(listOf(path))) { "cleanup released before physical upload finished" }
            check(source.readText() == "old")
            release.countDown()
            f.close()
            check(NativeImportUploads.seal(listOf(path)))
            check(source.readText() == "olda" && source.delete())
            val rebuilt = ExportPlugin(Activity(f.cache, f.data, f.resolver))
            try {
                val late = Invoke("path" to path)
                rebuilt.beginImport(late)
                late.expect("invalid_reference")
                check(!source.exists()) { "late IPC recreated a released path" }
            } finally {
                rebuilt.onDestroy(AppCompatActivity())
            }
        } finally {
            release.countDown()
            HostFileOutputStream.before = {}
        }
    }
    println(
        "$scenarios scenarios, $failures failures; full production plugin on JVM with controlled platform boundaries, not Android/device verification",
    )
    check(failures == 0)
}
