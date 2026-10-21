// Uses installed toolchains only. Host tests exercise production Kotlin policy and copy code;
// the separate Android compile checks the actual Activity/plugin types, not stubbed APIs.
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const out = join(root, '.cache/android-native-20261019/kotlin')
mkdirSync(out, { recursive: true })
const home = homedir()
const modules = join(home, '.gradle/caches/modules-2/files-2.1')
function files(dir, suffix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name)
    return e.isDirectory() ? files(path, suffix) : path.endsWith(suffix) ? [path] : []
  })
}
function jar(group, name, version) {
  const found = files(join(modules, group, name, version), '.jar')
  if (found.length !== 1) throw Error(`Expected one installed ${name}:${version}; found ${found.length}`)
  return found[0]
}
const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.25')
const compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '1.9.25'), stdlib,
  jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '1.9.25'), jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
  jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'), ...files(join(modules, 'org.jetbrains', 'annotations'), '.jar')]
function run(label, args) {
  const started = performance.now()
  const result = spawnSync('java', args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const receipt = { exitCode: result.status, signal: result.signal, error: result.error?.message, elapsedMs: performance.now() - started }
  writeFileSync(join(out, `${label}.log`), `${JSON.stringify(receipt)}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  console.log(`${label}: ${JSON.stringify(receipt)}\n${result.stdout ?? ''}`)
  if (result.status !== 0) throw Error(`${label}: ${result.stderr || result.error || result.status}`)
}
function compile(label, inputs, classpath) {
  const args = ['-no-stdlib', '-no-reflect', '-jvm-target', '1.8', '-classpath', classpath.join(delimiter), '-d', join(out, label), ...inputs]
  const argFile = join(out, `${label}.args`)
  writeFileSync(argFile, args.map(arg => JSON.stringify(arg)).join('\n'))
  run(label, ['-cp', compiler.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '@' + argFile])
}
const mode = process.argv[2] ?? 'host'
if (mode === 'android') {
  const project = join(root, 'reader/src-tauri/gen/android')
  const classpath = [join(home, 'AppData/Local/Android/Sdk/platforms/android-36/android.jar'), stdlib,
    join(home, '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.11.5/mobile/android/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar'),
    join(project, 'app/build/tmp/kotlin-classes/universalDebug'),
    ...files(join(home, '.gradle/caches/8.14.3/transforms'), 'classes.jar'),
    jar('androidx.lifecycle', 'lifecycle-common', '2.5.1')]
  for (const input of classpath) if (!existsSync(input)) throw Error(`Missing installed Android compile input: ${input}`)
  writeFileSync(join(out, 'android-inputs.json'), JSON.stringify(classpath, null, 2))
  compile('android', ['MainActivity.kt', 'ReaderWindowState.kt', 'OnyxSdkBridge.kt', 'MonitoredFolderPlugin.kt', 'MonitoredFolderIo.kt', 'NativeFileJobs.kt', 'ExportPlugin.kt'].map(p => join(root, 'reader/src-tauri/android', p)), classpath)
} else if (mode === 'host') {
  const folder = readFileSync(join(root, 'reader/src-tauri/android/MonitoredFolderIo.kt'), 'utf8')
  const start = folder.indexOf('    private fun writeTempDocument(')
  const end = folder.lastIndexOf('\n}')
  if (start < 0 || end < start) throw Error('Production copy method could not be located; host extraction must be reviewed')
  const method = folder.slice(start, end).replace('private fun writeTempDocument', 'fun writeTempDocument')
  const limit = folder.match(/private const val MAX_READ_BYTES = ([^\r\n]+)/)?.[1]
  if (!limit) throw Error('Missing production byte limit')
  const descriptor = join(out, 'ParcelFileDescriptor.kt')
  writeFileSync(descriptor, `package android.os
import java.io.InputStream
class ParcelFileDescriptor(val source: InputStream) {
    class AutoCloseInputStream(descriptor: ParcelFileDescriptor) : java.io.FilterInputStream(descriptor.source)
}
`)
  const host = join(out, 'ReaderEnvironmentHost.kt')
  writeFileSync(host, `package io.pagewise.reader
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import android.os.ParcelFileDescriptor
private const val MAX_READ_BYTES = ${limit}
class CancellationSignal(var remainingChecks: Int = Int.MAX_VALUE)
class HostActivity(val cacheDir: File)
class SpoolHost(val context: HostActivity) {
    class Failure(val code: String) : Exception(code)
    private fun check(cancellation: CancellationSignal, deadline: Long) {
        if (--cancellation.remainingChecks <= 0) throw Failure("cancelled")
        if (deadline < 100L) throw Failure("timeout")
    }
${method}
}
class SyntheticInput(private val length: Long, private val failAfter: Long = Long.MAX_VALUE) : java.io.InputStream() {
    var position = 0L
    var closed = false
    var maxBuffer = 0
    override fun read(): Int = error("Copy must use its bounded byte buffer")
    override fun read(buffer: ByteArray, offset: Int, count: Int): Int {
        if (position >= failAfter) throw IOException("injected provider failure")
        if (position >= length) return -1
        maxBuffer = maxOf(maxBuffer, count)
        val n = minOf(count.toLong(), length - position).toInt()
        java.util.Arrays.fill(buffer, offset, offset + n, 0x35.toByte())
        position += n
        return n
    }
    override fun close() { closed = true }
}
fun main(args: Array<String>) {
    var assertions = 0
    fun verify(value: Boolean, message: String) { assertions++; check(value) { message } }
    val state = ReaderWindowState()
    state.requestImmersive(true); state.requestKeepScreenOn(true)
    verify(!state.immersive && !state.keepScreenOn, "created window is not resumed")
    state.resume(); verify(state.immersive && state.keepScreenOn, "resume restores intent")
    state.pause(); verify(!state.immersive && !state.keepScreenOn, "pause releases window effects")
    state.requestImmersive(false); state.requestKeepScreenOn(false); state.resume()
    verify(!state.immersive && !state.keepScreenOn, "reader exit while paused must win")
    repeat(8) { state.pause(); state.resume() }
    verify(!state.keepScreenOn, "lifecycle alone must not request wake")
    state.requestImmersive(true); state.requestKeepScreenOn(true); state.destroy()
    state.requestImmersive(true); state.requestKeepScreenOn(true); state.resume()
    verify(!state.resumed && !state.immersive && !state.keepScreenOn, "late bridge cannot revive destroyed Activity")
    val onyxWindow = ReaderWindowState()
    onyxWindow.resume()
    onyxWindow.epdState.configureGcInterval(3)
    verify(onyxWindow.epdState.recordPageTurn() == OnyxWaveformMode.REGAL, "turn 1 stays REGAL")
    verify(onyxWindow.epdState.recordPageTurn() == OnyxWaveformMode.REGAL, "turn 2 stays REGAL")
    verify(onyxWindow.epdState.recordPageTurn() == OnyxWaveformMode.GC, "turn 3 triggers GC full refresh")
    verify(onyxWindow.epdState.enterFastMode("scroll", OnyxWaveformMode.A2), "enter A2 fast mode")
    verify(onyxWindow.epdState.fastModeActive && onyxWindow.epdState.currentMode == OnyxWaveformMode.A2, "fast mode state active")
    verify(onyxWindow.epdState.onLifecyclePause(), "pause exits fast mode")
    verify(!onyxWindow.epdState.fastModeActive && onyxWindow.epdState.currentMode == OnyxWaveformMode.REGAL, "fast mode restored to REGAL")
    verify(OnyxFrontLightSnapshot.percentToRaw(50, 0, 32) == 16, "frontlight 50% maps to raw 16")
    verify(OnyxFrontLightSnapshot.rawToPercent(16, 0, 32) == 50, "frontlight raw 16 maps to 50%")
    onyxWindow.scribbleState.configure(true, OnyxScribbleState.STROKE_STYLE_FOUNTAIN, 3.5f, OnyxRectCss(0f, 40f, 800f, 1100f), listOf(OnyxRectCss(0f, 0f, 800f, 40f)))
    verify(onyxWindow.canEnableRawDrawing(), "scribble active when window resumed and limit rect valid")
    onyxWindow.scribbleState.setModalSuspended(true)
    verify(!onyxWindow.canEnableRawDrawing(), "modal open suspends raw drawing immediately")
    onyxWindow.scribbleState.setModalSuspended(false)
    onyxWindow.pause()
    verify(!onyxWindow.canEnableRawDrawing(), "window pause suspends raw drawing")
    onyxWindow.resume()
    onyxWindow.hardwareKeyState.configure(true, true)
    val downVolDown = onyxWindow.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_VOLUME_DOWN, OnyxHardwareKeyState.ACTION_DOWN, 0)
    verify(downVolDown.intercept && downVolDown.direction == "next", "VOLUME_DOWN triggers next page turn")
    val repeatVolDown = onyxWindow.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_VOLUME_DOWN, OnyxHardwareKeyState.ACTION_DOWN, 3)
    verify(repeatVolDown.intercept && repeatVolDown.direction == null, "VOLUME_DOWN repeat is intercepted without queuing duplicate page turns")
    val upVolDown = onyxWindow.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_VOLUME_DOWN, OnyxHardwareKeyState.ACTION_UP, 0)
    verify(upVolDown.intercept && upVolDown.direction == null, "VOLUME_DOWN key-up is intercepted to suppress system volume bar")
    onyxWindow.hardwareKeyState.configure(false, true)
    val libraryVol = onyxWindow.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_VOLUME_DOWN, OnyxHardwareKeyState.ACTION_DOWN, 0)
    verify(!libraryVol.intercept && libraryVol.direction == null, "non-reader route releases volume keys to Android")
    verify(onyxWindow.checkpointState.stage("book-1", "epubcfi(/6/4!/4/2)", 0.42, 120, 1700000000000L), "stage reading checkpoint")
    val peeked = onyxWindow.checkpointState.peekDirtyForFlush()
    verify(peeked != null && peeked.bookId == "book-1" && peeked.readingDeltaSeconds == 120, "peekDirtyForFlush returns staged checkpoint without clearing dirty")
    verify(onyxWindow.checkpointState.peekDirtyForFlush() != null, "failed write retains dirty checkpoint for next flush")
    verify(onyxWindow.checkpointState.markFlushed(peeked!!), "markFlushed clears dirty after confirmed disk sync")
    verify(onyxWindow.checkpointState.peekDirtyForFlush() == null, "subsequent flush is clean until next stage")
    val plain = OnyxEpubTextMatcher.stripXmlToPlainText("<html><head><title>Ignore</title></head><body><p>文石 <b>Note X3 Pro</b> 墨水屏阅读器</p></body></html>")
    verify(plain == "文石 Note X3 Pro 墨水屏阅读器", "stripXmlToPlainText removes head and tags")
    val excerpts = OnyxEpubTextMatcher.findExcerpts(plain, "Note X3", 5)
    verify(excerpts.size == 1 && excerpts[0].contains("Note X3 Pro"), "findExcerpts extracts matched context")
    val dir = File(args.single()).apply { mkdirs() }
    val spool = SpoolHost(HostActivity(dir))
    for (size in listOf(0L, 17L, 16L * 1024 * 1024, MAX_READ_BYTES)) {
        val input = SyntheticInput(size)
        val path = spool.writeTempDocument(ParcelFileDescriptor(input), CancellationSignal(), Long.MAX_VALUE)
        val file = File(dir, path.removePrefix("cache/"))
        verify(file.length() == size, "actual copied byte count")
        verify(input.maxBuffer <= 65536 && input.closed, "bounded buffer and descriptor close")
        file.inputStream().use { stream -> if (size > 0) verify(stream.read() == 0x35, "source bytes preserved") }
        verify(file.delete(), "test file cleanup")
    }
    val cases = listOf(
        Triple(SyntheticInput(MAX_READ_BYTES + 1), CancellationSignal(), Long.MAX_VALUE),
        Triple(SyntheticInput(131072, 65536), CancellationSignal(), Long.MAX_VALUE),
        Triple(SyntheticInput(131072), CancellationSignal(2), Long.MAX_VALUE),
        Triple(SyntheticInput(131072), CancellationSignal(), 0L)
    )
    for ((index, case) in cases.withIndex()) {
        val (input, cancellation, deadline) = case
        val thrown = try { spool.writeTempDocument(ParcelFileDescriptor(input), cancellation, deadline); null } catch (e: Exception) { e }
        verify(thrown != null, "negative copy must fail")
        if (index == 0) verify((thrown as SpoolHost.Failure).code == "resource_limit", "limit error remains explicit")
        if (index == 1) verify(thrown is IOException, "provider error is not empty data")
        verify(input.closed, "failed stream closed")
        verify(File(dir, "pagewise-read").listFiles()!!.isEmpty(), "failed copy leaves no partial file")
    }
    println("PASS: $assertions host assertions; production window policy and bounded SAF copy; no Android-provider/device claim")
}
`)
  compile('host', [descriptor, host, join(root, 'reader/src-tauri/android/ReaderWindowState.kt')], [stdlib])
  run('host-run', ['-cp', [join(out, 'host'), stdlib].join(delimiter), 'io.pagewise.reader.ReaderEnvironmentHostKt', join(out, 'synthetic')])
} else throw Error(`Unknown mode: ${mode}`)
