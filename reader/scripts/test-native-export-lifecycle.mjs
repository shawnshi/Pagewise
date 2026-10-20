import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '../.cache/audit-stage1/export-lifecycle')
const modules = join(homedir(), '.gradle/caches/modules-2/files-2.1')
function jars(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.jar') && !e.name.endsWith('-sources.jar'))
    .map(e => join(e.parentPath, e.name))
}
const compiler = jars(join(modules, 'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.0.21'))
const kotlin = ['org.jetbrains.kotlin/kotlin-stdlib', 'org.jetbrains.kotlin/kotlin-script-runtime',
  'org.jetbrains.kotlin/kotlin-reflect', 'org.jetbrains.intellij.deps/trove4j',
  'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm', 'org.jetbrains/annotations'].flatMap(p => jars(join(modules, p)))
const stdlib = kotlin.find(p => /kotlin-stdlib-[\d.]+\.jar$/.test(p))
function compile(args, name) {
  mkdirSync(out, { recursive: true })
  const argFile = join(out, `${name}.args`)
  writeFileSync(argFile, args.map(a => JSON.stringify(a)).join('\n'))
  const command = ['-cp', [...compiler, ...kotlin].join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '@' + argFile]
  const result = spawnSync('java', command, { encoding: 'utf8', timeout: 75000 })
  writeFileSync(join(out, `${name}.log`), JSON.stringify({ exitCode: result.status, command }) + '\n' + result.stdout + result.stderr)
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr)
}

if (process.argv.includes('--android')) {
  test('actual ExportPlugin compiles against installed Android/AndroidX and actual Tauri sources', { timeout: 90000 }, () => {
    const cache = join(homedir(), '.gradle/caches')
    const android = join(homedir(), 'AppData/Local/Android/Sdk/platforms/android-36/android.jar')
    const tauri = join(homedir(), '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.11.5/mobile/android/src/main/java')
    assert.ok(existsSync(android) && existsSync(tauri), 'installed Android/Tauri toolchain required')
    const androidx = [...jars(join(cache, '8.14.3/transforms')).filter(p => /jars[\\/]classes.jar$/.test(p)),
      ...jars(join(modules, 'androidx.lifecycle/lifecycle-common/2.5.1'))]
    const jackson = ['com.fasterxml.jackson.core/jackson-annotations', 'com.fasterxml.jackson.core/jackson-core',
      'com.fasterxml.jackson.core/jackson-databind'].flatMap(p => jars(join(modules, p)))
    mkdirSync(out, { recursive: true })
    const config = join(out, 'BuildConfig.kt')
    writeFileSync(config, 'package app.tauri\nobject BuildConfig { const val DEBUG = true }\n')
    const sources = readdirSync(tauri, { recursive: true }).filter(p => p.endsWith('.kt')).map(p => join(tauri, p))
    compile(['-no-stdlib', '-no-reflect', '-classpath', [android, ...androidx, ...kotlin, ...jackson].join(delimiter),
      '-d', join(out, 'android-classes'), config, ...sources, join(root, 'src-tauri/android/ExportPlugin.kt')], 'android-compile')
    console.log('Full production Kotlin + installed android-36/AndroidX/Tauri 2.11.5 compiled (not device verification).')
  })
} else {
  test('full production ExportPlugin executes timeout/queue/commit/cleanup/failure/shutdown host scenarios', { timeout: 90000 }, () => {
    const stubs = {
      'Activity.kt': `package android.app
open class Activity(val cacheDir: java.io.File, val dataDir: java.io.File, val contentResolver: android.content.ContentResolver)
`,
      'AppCompatActivity.kt': `package androidx.appcompat.app
class AppCompatActivity : android.app.Activity(java.io.File("."), java.io.File("."), android.content.ContentResolver())
`,
      'ContentResolver.kt': `package android.content
open class ContentResolver {
 var opener: (android.net.Uri, String) -> java.io.OutputStream? = { _, _ -> java.io.ByteArrayOutputStream() }
 fun openOutputStream(uri: android.net.Uri, mode: String): java.io.OutputStream? = opener(uri, mode)
}
`,
      'Uri.kt': `package android.net
class Uri(val value: String) { val scheme get() = value.substringBefore(':'); companion object { fun parse(value: String?) = Uri(value ?: "") } }
`,
      'Handler.kt': `package android.os
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(looper: Looper) {
 fun postDelayed(task: Runnable, delay: Long): Boolean { synchronized(pending) { pending.add(task) }; return true }
 fun removeCallbacks(task: Runnable) { synchronized(pending) { pending.remove(task) } }
 fun removeCallbacksAndMessages(token: Any?) { synchronized(pending) { pending.clear() } }
 companion object {
  private val pending = mutableListOf<Runnable>()
  fun fireFirst() { val task = synchronized(pending) { pending.firstOrNull()?.also { pending.removeAt(0) } }; task?.run() }
  fun fireAll() { val tasks = synchronized(pending) { pending.toList().also { pending.clear() } }; tasks.forEach { it.run() } }
  fun count() = synchronized(pending) { pending.size }
 }
}
`,
      'Base64.kt': `package android.util
object Base64 { const val NO_WRAP = 2; fun decode(value: String?, flags: Int): ByteArray = java.util.Base64.getDecoder().decode(value ?: "") }
`,
      'Os.kt': `package android.system
class ErrnoException(val functionName: String, val errno: Int) : Exception(functionName)
object OsConstants { const val EXDEV = 18 }
object Os {
 var calls = 0
 var before: (String, String) -> Unit = { _, _ -> }
 fun rename(source: String, target: String) { calls++; before(source, target); java.nio.file.Files.move(java.nio.file.Path.of(source), java.nio.file.Path.of(target), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE) }
}
`,
      'Annotations.kt': `package app.tauri.annotation
annotation class Command
annotation class TauriPlugin
`,
      'Plugin.kt': `package app.tauri.plugin
open class Plugin(activity: android.app.Activity) { open fun onDestroy(activity: androidx.appcompat.app.AppCompatActivity) {} }
open class JSObject {
 private val values = mutableMapOf<String, String>()
 var beforeGet: (String) -> Unit = {}
 fun put(key: String, value: String) { values[key] = value }
 fun getString(key: String): String? { beforeGet(key); return values[key] }
}
class Invoke(vararg pairs: Pair<String, String>) {
 private val args = JSObject().also { obj -> pairs.forEach { obj.put(it.first, it.second) } }
 val done = java.util.concurrent.CountDownLatch(1)
 @Volatile var code: String? = null
 @Volatile var replies = 0
 fun getArgs() = args
 @Synchronized fun reject(message: String, code: String) { this.code = code; replies++; done.countDown() }
 @Synchronized fun resolve(value: JSObject? = null) { code = "ok"; replies++; done.countDown() }
}
`,
    }
    mkdirSync(out, { recursive: true })
    const paths = Object.entries(stubs).map(([name, body]) => { const p = join(out, name); writeFileSync(p, body); return p })
    compile(['-no-stdlib', '-no-reflect', '-classpath', kotlin.join(delimiter), '-d', join(out, 'host-classes'),
      ...paths, join(root, 'src-tauri/android/ExportPlugin.kt'), join(import.meta.dirname, 'fixtures/export-lifecycle-host/ExportLifecycleHost.kt')], 'host-compile')
    const run = spawnSync('java', ['-cp', [join(out, 'host-classes'), stdlib].join(delimiter), 'io.pagewise.reader.ExportLifecycleHostKt', mkdtempSync(join(out, 'synthetic-'))], { encoding: 'utf8', timeout: 25000 })
    writeFileSync(join(out, 'host-run.log'), JSON.stringify({ exitCode: run.status }) + '\n' + run.stdout + run.stderr)
    assert.equal(run.status, 0, run.error?.message ?? run.stdout + run.stderr)
    console.log(run.stdout.trim())
  })
  test('production busy-retry policy never replays cancelled or uncertain native writes', async () => {
    const { retryWhileBusy } = await import('../src/storage/sourceFile.ts')
    for (const code of ['timeout_not_committed', 'unavailable_not_committed', 'outcome_unknown']) {
      const failure = { code }
      let attempts = 0
      await assert.rejects(retryWhileBusy(async () => { attempts++; throw failure }, [0, 0], async () => {
        assert.fail('terminal native failure must not schedule a replay')
      }), error => error === failure)
      assert.equal(attempts, 1)
    }
    let attempts = 0
    assert.equal(await retryWhileBusy(async () => {
      if (++attempts === 1) throw { code: 'busy' }
      return 'ok'
    }, [0], async () => {}), 'ok')
    assert.equal(attempts, 2)
  })
}
