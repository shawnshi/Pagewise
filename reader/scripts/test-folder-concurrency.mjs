import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { toolchain } from './native-import-test-tools.mjs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

// Compile the actual plugin admission/settlement code, not a JS model of it.
// Android-facing stubs only replace bridge, clock, and handler scheduling.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '../.cache/performance-20261019/kotlin-folder')
const source = readFileSync(join(root, 'src-tauri/android/MonitoredFolderPlugin.kt'), 'utf8')
function method(name, next) {
  return source.slice(source.indexOf(`    private fun ${name}(`), source.indexOf(`    private fun ${next}(`))
}

test('real SAF scheduler isolates stalled enumeration; bounds admission, picker, timeout and shutdown', { timeout: 90000 }, () => {
  const tools = toolchain()
  const dependencies = [tools.stdlib]
  const cp = tools.compiler.join(';')
  const fields = source.slice(source.indexOf(source.includes('private class Lane') ? '    private class Lane' : '    private val executor'), source.indexOf('    private var view'))
  const admission = source.includes('private fun reserveSelection(') ? method('reserveSelection', 'work') : ''
  const work = method('work', source.includes('private fun discard(') ? 'discard' : 'check')
  const shutdown = source.slice(source.indexOf('    override fun onDestroy('), source.indexOf('    private fun tree('))
    .replace('override fun onDestroy(activity: AppCompatActivity)', 'fun onDestroy()')
  const harness = `
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean
import java.io.IOException

class CancellationSignal { @Volatile var isCanceled = false; fun cancel() { isCanceled = true } }
object SystemClock { fun elapsedRealtime() = System.nanoTime() / 1000000 }
class JSObject { fun optString(key: String) = "" }
class Invoke {
  val result = CompletableFuture<String>()
  fun resolve(value: JSObject?) { check(result.complete("ok")) }
  fun reject(message: String, code: String) { check(result.complete(code)) }
}
class Handler {
  private val executor = Executors.newSingleThreadScheduledExecutor()
  private val timers = ConcurrentHashMap<Runnable, ScheduledFuture<*>>()
  fun postDelayed(task: Runnable, delay: Long) { timers[task] = executor.schedule(task, delay, TimeUnit.MILLISECONDS) }
  fun removeCallbacks(task: Runnable) { timers.remove(task)?.cancel(false) }
  fun close() { executor.shutdownNow() }
}
class Scheduler {
  private val handler = Handler()
${fields}
  @Volatile private var destroyed = false
  @Volatile private var activeSignal: CancellationSignal? = null
  private var watching = false
  private var pendingPicker: Invoke? = null
  private var view: Any? = null
  private fun removeObserver() {}
  private class Failure(val code: String) : IOException(code)
  private fun reject(invoke: Invoke, error: Exception) = invoke.reject("io_error", "io_error")
  private fun discard(result: JSObject?) {}
${admission}
${work}
${shutdown}
  fun enumerate(invoke: Invoke, action: () -> Unit) = work(invoke, timeoutMs = 100) { _, _ -> action(); JSObject() }
  fun read(invoke: Invoke, action: () -> Unit = {}) = ${source.includes('interactiveLane') ? 'work(invoke, lane = interactiveLane, timeoutMs = 100)' : 'work(invoke, timeoutMs = 100)'} { _, _ -> action(); JSObject() }
  fun select() = ${source.includes('private fun reserveSelection(') ? 'reserveSelection() == null' : '!working.get() && selecting.compareAndSet(false, true)'}
  fun finishSelection() { selecting.set(false) }
  fun close() { onDestroy(); handler.close() }
}
fun await(invoke: Invoke) = invoke.result.get(2, TimeUnit.SECONDS)
fun main() {
  val scheduler = Scheduler()
  val release = CountDownLatch(1)
  val entered = CountDownLatch(1)
  try {
    val listing = Invoke()
    scheduler.enumerate(listing) { entered.countDown(); release.await() }
    check(entered.await(1, TimeUnit.SECONDS))
    val start = System.nanoTime()
    val opened = Invoke(); scheduler.read(opened)
    check(await(opened) == "ok") { "interactive read rejected while enumeration blocked: " + await(opened) }
    println("interactive-read-while-list-blocked-ms=" + (System.nanoTime()-start)/1e6)
    repeat(100) { val overflow = Invoke(); scheduler.enumerate(overflow) {}; check(await(overflow) == "busy") }
    check(!scheduler.select()) { "picker must not overlap active enumeration" }
    check(await(listing) == "unavailable")
    val second = Invoke(); scheduler.read(second); check(await(second) == "ok")
    val readRelease = CountDownLatch(1); val readEntered = CountDownLatch(1)
    val held = Invoke(); scheduler.read(held) { readEntered.countDown(); readRelease.await() }
    check(readEntered.await(1, TimeUnit.SECONDS))
    repeat(100) { val overflow = Invoke(); scheduler.read(overflow); check(await(overflow) == "busy") }
    scheduler.close()
    check(await(held) == "unavailable") { "shutdown must reject promptly" }
    val afterClose = Invoke(); scheduler.read(afterClose); check(await(afterClose) == "unavailable")
    readRelease.countDown()
  } finally { release.countDown(); scheduler.close() }
  val picker = Scheduler()
  try {
    check(picker.select())
    val read = Invoke(); picker.read(read); check(await(read) == "busy")
    val list = Invoke(); picker.enumerate(list) {}; check(await(list) == "busy")
    picker.finishSelection()
    val failed = Invoke(); picker.read(failed) { throw IOException("provider fault") }; check(await(failed) == "io_error")
    Thread.sleep(20)
    val next = Invoke(); picker.read(next); check(await(next) == "ok")
  } finally { picker.close() }
  println("PASS: overflow=200, independent reads, timeout, selection, dependency failure, teardown, no late success")
}
`
  mkdirSync(output, { recursive: true })
  const path = join(output, 'FolderScheduler.kt'); writeFileSync(path, harness)
  const start = performance.now()
  const compile = spawnSync('java', ['-cp', cp, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', dependencies.join(';'), '-d', join(output, 'classes'), path], { encoding: 'utf8', timeout: 45000 })
  writeFileSync(join(output, 'compile.log'), compile.stdout + compile.stderr)
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stdout + compile.stderr)
  const run = spawnSync('java', ['-cp', [join(output, 'classes'), ...dependencies].join(';'), 'FolderSchedulerKt'], { encoding: 'utf8', timeout: 10000 })
  writeFileSync(join(output, 'run.log'), run.stdout + run.stderr)
  console.log(run.stdout)
  console.log(`compile-and-run-ms=${(performance.now() - start).toFixed(1)}`)
  assert.equal(run.status, 0, run.error?.message ?? run.stdout + run.stderr)
})
