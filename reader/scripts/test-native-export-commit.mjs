import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

// Real production command bodies, scaled byte ceilings and controlled Android/filesystem faults.
// No user files, Android providers or production timeout/executor claims.
test('native append limits and atomic book publication preserve the previous file on failure', { timeout: 120000 }, () => {
  const root = resolve(import.meta.dirname, '../..')
  const baseline = process.env.PAGEWISE_EXPORT_BASELINE === '1'
  const sourcePath = baseline ? '.cache/android-native-20261019/baseline/reader/src-tauri/android/ExportPlugin.kt' : 'reader/src-tauri/android/ExportPlugin.kt'
  const source = readFileSync(join(root, sourcePath), 'utf8').replaceAll('\r\n', '\n')
  assert.match(source, /MAX_EXPORT_BYTES = 256L \* 1024 \* 1024/)
  assert.match(source, /MAX_IMPORT_BYTES = 1024L \* 1024 \* 1024/)
  const out = join(root, '.cache/audit-stage1/export-commit', baseline ? 'baseline' : 'current')
  mkdirSync(out, { recursive: true })
  function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
    assert.ok(a >= 0 && b > a, `Production section ${start} must be reviewed if its shape changes`)
    return source.slice(a, b)
  }
  const lifecycle = baseline ? '' : section('    private enum class State', '    private fun file(')
  const helpers = section('    private fun file(', '    private fun run(')
  const commands = [['append', 'write'], ['appendImport', 'publishImport'], ['publishImport', 'deleteImport']]
    .map(([a, b]) => section(`    @Command\n    fun ${a}(`, `    @Command\n    fun ${b}(`)).join('\n')
  const constants = source.slice(source.indexOf('private const val EXPORT_PATH'), source.indexOf('@TauriPlugin'))
  const file = (name, content) => { const p = join(out, name); writeFileSync(p, content); return p }
  const base64 = file('Base64.kt', `package android.util
object Base64 { const val NO_WRAP = 2; fun decode(value: String, flags: Int): ByteArray = java.util.Base64.getDecoder().decode(value) }
`)
  const os = file('Os.kt', `package android.system
class ErrnoException(name: String, val errno: Int) : Exception(name)
object OsConstants { const val EXDEV = 18; const val EIO = 5 }
object Os {
    var calls = 0
    var failures = emptySet<Int>()
    var firstErrno = OsConstants.EXDEV
    fun rename(from: String, to: String) {
        io.pagewise.reader.host.Events.log.add(if(java.io.File(from).name.startsWith(".pagewise-import-")) "commit-rename" else "source-rename")
        calls++
        if (calls in failures) throw ErrnoException("injected rename", if (calls == 1) firstErrno else OsConstants.EIO)
        java.nio.file.Files.move(java.nio.file.Path.of(from), java.nio.file.Path.of(to), java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }
}
`)
  const io = file('FaultyInput.kt', `package io.pagewise.reader.host
object Events { val log = mutableListOf<String>() }
class FaultyOutputStream(file: java.io.File, append: Boolean = false) : java.io.OutputStream() {
    companion object { var failSync = false }
    private val delegate = java.io.FileOutputStream(file, append)
    val fd get() = SyncPoint(delegate.fd)
    class SyncPoint(private val descriptor: java.io.FileDescriptor) {
        fun sync() {
            Events.log.add("sync-start")
            if(failSync) throw java.io.IOException("injected sync failure")
            descriptor.sync()
            Events.log.add("sync-done")
        }
    }
    override fun write(value: Int) { delegate.write(value) }
    override fun write(bytes: ByteArray, off: Int, length: Int) { delegate.write(bytes, off, length) }
    override fun flush() { delegate.flush() }
    override fun close() { delegate.close() }
}
class FaultyInputStream(file: java.io.File) : java.io.FileInputStream(file) {
    companion object { var failAfter = Int.MAX_VALUE }
    private var consumed = 0
    override fun read(bytes: ByteArray): Int = read(bytes, 0, bytes.size)
    override fun read(bytes: ByteArray, off: Int, length: Int): Int {
        if (consumed >= failAfter) throw java.io.IOException("injected copy failure")
        val n = super.read(bytes, off, minOf(length, failAfter - consumed))
        if (n > 0) consumed += n
        return n
    }
}
`)
  const host = file('ExportCommitHost.kt', `package io.pagewise.reader
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import io.pagewise.reader.host.FaultyOutputStream as FileOutputStream
import io.pagewise.reader.host.FaultyInputStream as FileInputStream
import io.pagewise.reader.host.Events
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
private const val MAX_EXPORT_BYTES = 256L
private const val MAX_IMPORT_BYTES = 1024L
${constants}
annotation class Command
class JSObject
class Args(private val values: Map<String, String>) { fun getString(key: String): String = values.getValue(key) }
class Invoke(val values: Map<String, String>) {
    var status = "pending"
    fun getArgs() = Args(values)
    fun resolve(result: JSObject?) { status = "ok" }
    fun reject(code: String, errorCode: String = code) { status = errorCode }
}
class HostActivity(val cacheDir: File, val dataDir: File)
class ExportHost(private val activity: HostActivity) {
    private class Failure(val code: String) : Exception(code)
${lifecycle}
${helpers}
${baseline ? `    private fun run(invoke: Invoke, timeoutMs: Long = 30000, action: () -> JSObject?) {
        try { invoke.resolve(action()) } catch(e: Exception) { invoke.reject(if(e is Failure) e.code else "io_error") }
    }` : `    private fun run(invoke: Invoke, timeoutMs: Long = 30000, action: (Operation) -> JSObject?) {
        val operation = Operation(invoke)
        try { if (operation.start()) operation.finish(action(operation)) } catch(e: Exception) { operation.finish(null, e) }
    }`}
${commands}
}
fun main(args: Array<String>) {
    val dir = File(args.single()).apply { mkdirs() }
    val cache = File(dir, "cache").apply { mkdirs() }
    val data = File(dir, "data").apply { mkdirs() }
    val host = ExportHost(HostActivity(cache, data))
    var assertions = 0
    fun verify(value: Boolean, message: String) { assertions++; check(value) { message } }
    fun request(path: String, bytes: ByteArray): Invoke = Invoke(mapOf("path" to path, "data" to java.util.Base64.getEncoder().encodeToString(bytes)))
    for ((path, limit) in listOf("cache/export-boundary.zip" to 256, "cache/import-boundary.bin" to 1024)) {
        val target = File(dir, path); target.writeBytes(ByteArray(limit - 1) { 0x31 })
        val rejected = request(path, byteArrayOf(0x32, 0x33))
        if (limit == 256) host.append(rejected) else host.appendImport(rejected)
        verify(rejected.status == "resource_limit", "crossing byte ceiling must reject before append; got " + rejected.status)
        verify(target.length() == (limit - 1).toLong(), "rejected append did not change length")
        verify(target.readBytes().all { it == 0x31.toByte() }, "rejected append did not change bytes")
        val accepted = request(path, byteArrayOf(0x32))
        if (limit == 256) host.append(accepted) else host.appendImport(accepted)
        verify(accepted.status == "ok" && target.length() == limit.toLong(), "exact ceiling remains allowed")
        val full = request(path, byteArrayOf(0x33))
        if (limit == 256) host.append(full) else host.appendImport(full)
        verify(full.status == "resource_limit" && target.length() == limit.toLong(), "full target cannot grow")
    }
    for (mode in listOf("replace", "new-target", "cross-device", "copy-failure", "sync-failure", "rename-failure", "direct-rename-failure")) {
        Os.calls = 0; Os.failures = if(mode == "replace" || mode == "new-target") emptySet() else if(mode == "rename-failure") setOf(1, 2) else setOf(1)
        Os.firstErrno = if(mode == "direct-rename-failure") OsConstants.EIO else OsConstants.EXDEV
        FileInputStream.failAfter = if(mode == "copy-failure") 8192 else Int.MAX_VALUE
        FileOutputStream.failSync = mode == "sync-failure"
        Events.log.clear()
        val source = File(cache, "import-test.bin"); source.writeBytes(ByteArray(24576) { 0x35 })
        val target = File(data, "books/test.epub").apply { parentFile.mkdirs(); if(mode == "new-target") delete() else writeText("old book") }
        val invoke = Invoke(mapOf("path" to "cache/import-test.bin", "target" to "books/test.epub"))
        host.publishImport(invoke)
        if(mode == "copy-failure" || mode == "sync-failure" || mode == "rename-failure" || mode == "direct-rename-failure") {
            verify(invoke.status == "io_error", "failed publication stays an error")
            verify(target.readText() == "old book", "failed publication preserved previous book")
            verify(source.isFile && source.length() == 24576L, "failed publication kept retryable source")
        } else {
            verify(invoke.status == "ok", "publication succeeded")
            verify(target.length() == 24576L && target.readBytes().all { it == 0x35.toByte() }, "published bytes exact")
            verify(!source.exists(), "source removed only after successful publication")
        }
        verify(target.parentFile.listFiles()!!.map { it.name } == listOf("test.epub"), "no partial sibling remains")
        if(mode == "cross-device" || mode == "rename-failure") verify(Events.log == listOf("source-rename", "sync-start", "sync-done", "commit-rename"), "sync completes before commit rename")
        if(mode == "sync-failure") verify(Events.log == listOf("source-rename", "sync-start"), "sync failure never reaches commit rename")
        if(mode == "direct-rename-failure") verify(Events.log == listOf("source-rename"), "non-EXDEV failure never starts a fallback copy")
    }
    println("PASS: $assertions native export commit assertions; host filesystem faults, scaled limits; no timeout/provider claim")
}
`)
  const modules = join(homedir(), '.gradle/caches/modules-2/files-2.1')
  const jars = (path) => existsSync(path) ? readdirSync(path, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.jar')).map(e => join(e.parentPath, e.name)) : []
  const jar = (g, a, v) => { const found = jars(join(modules, g, a, v)); assert.equal(found.length, 1, `${a}:${v}`); return found[0] }
  const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.25')
  const compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '1.9.25'), stdlib,
    jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '1.9.25'), jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
    jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'), ...jars(join(modules, 'org.jetbrains', 'annotations'))]
  const compile = spawnSync('java', ['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', stdlib, '-d', join(out, 'classes'), base64, os, io, host], { encoding: 'utf8', timeout: 90000 })
  writeFileSync(join(out, 'compile.log'), JSON.stringify({ exitCode: compile.status }) + '\n' + compile.stdout + compile.stderr)
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stdout + compile.stderr)
  const run = spawnSync('java', ['-cp', [join(out, 'classes'), stdlib].join(delimiter), 'io.pagewise.reader.ExportCommitHostKt', join(out, 'synthetic')], { encoding: 'utf8', timeout: 15000 })
  writeFileSync(join(out, 'run.log'), JSON.stringify({ exitCode: run.status }) + '\n' + run.stdout + run.stderr)
  assert.equal(run.status, 0, run.error?.message ?? run.stdout + run.stderr)
  console.log(run.stdout.trim())
})
