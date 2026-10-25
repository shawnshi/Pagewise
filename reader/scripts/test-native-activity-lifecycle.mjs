import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { root, compile, emit, runJvm } from './native-import-test-tools.mjs'
import { tauriLifecycleEntries } from './prepare-tauri-lifecycle.mjs'

const source = join(root, 'src-tauri/android-sdk/tauri-2.11.5')
const parse = text => {
  try { return JSON.parse(text) }
  catch (error) { throw new Error('Invalid lifecycle test metadata', { cause: error }) }
}
const pin = parse(readFileSync(join(source, 'upstream.json'), 'utf8'))
const settings = readFileSync(join(root, 'src-tauri/gen/android/tauri.settings.gradle'), 'utf8')
const sdkLine = settings.split('\n').find(line => line.includes("project(':tauri-android').projectDir"))
assert.ok(sdkLine, 'Use the installed, locked SDK; tests never install dependencies')
const upstream = parse(sdkLine.slice(sdkLine.indexOf('new File(') + 9, sdkLine.lastIndexOf(')')))
const cache = join(root, '.cache')
mkdirSync(cache, { recursive: true })

function fixture() {
  const dir = mkdtempSync(join(cache, 'native-lifecycle-'))
  const base = join(dir, 'reader'), sdk = join(dir, 'sdk'), project = join(base, 'src-tauri/gen/android')
  mkdirSync(project, { recursive: true })
  cpSync(source, join(base, 'src-tauri/android-sdk/tauri-2.11.5'), { recursive: true })
  writeFileSync(join(base, 'src-tauri/Cargo.lock'), readFileSync(join(root, 'src-tauri/Cargo.lock')))
  for (const name of Object.keys(pin.moduleFiles)) {
    const target = join(sdk, name)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, readFileSync(join(upstream, name)))
  }
  return { dir, base, sdk, project }
}

test('actual SDK fence rejects stale owners, duplicate/late results and concurrent slot replacement', { timeout: 90000 }, async () => {
  const out = mkdtempSync(join(cache, 'native-lifecycle-jvm-'))
  try {
    const harness = emit(out, 'FenceHost.kt', `package app.tauri.plugin
fun main() {
 val f=ActivityResultFence(); val a=Any(); val b=Any()
 check(f.bind(a).isEmpty())
 val one=f.begin(a,"activity")
 check(f.bind(a).isEmpty())
 try { f.begin(a,"activity"); error("busy slot replaced") } catch(e:IllegalStateException) { check(e.message=="activity_result_busy") }
 check(!f.take(one.copy()))
 check(f.take(one)); check(!f.take(one))
 val two=f.begin(a,"activity"); check(two.key!=one.key); check(!f.take(one)); check(f.take(two))
 val old=f.begin(a,"activity"); check(f.bind(b)==listOf(old)); check(!f.take(old))
 val current=f.begin(b,"activity"); check(f.detach(a).isEmpty()); check(f.isCurrent(b)); check(f.take(current))
 try { f.begin(a,"activity"); error("old owner admitted") } catch(e:IllegalStateException) { check(e.message=="activity_changed") }
 val p=f.begin(b,"permissions"); val i=f.begin(b,"intent_sender"); val r=f.begin(b,"activity")
 check(f.detach(b).toSet()==setOf(p,i,r)); check(!f.take(p)); check(!f.take(i)); check(!f.take(r)); check(!f.isCurrent(b))
 try { f.begin(b,"activity"); error("closed owner admitted") } catch(e:IllegalStateException) { check(e.message=="activity_changed") }
 var epoch:Any?=b; val receipts=mutableListOf<Pair<String?,String?>>()
 val once=ActivityInvocationFence(b,{it===epoch}){s,e->receipts.add(s to e)}
 once.respond(true,"ok"); once.respond(false,"duplicate"); check(receipts==listOf("ok" to null))
 val pending=ActivityInvocationFence(b,{it===epoch}){s,e->receipts.add(s to e)}
 epoch=Any(); check(!pending.isCurrent()); var writes=0; writes++
 pending.respond(true,"committed"); pending.respond(false,"duplicate")
 check(writes==1 && receipts.size==2 && receipts.last().first==null && receipts.last().second!!.contains("activity_changed_outcome_unknown"))
 val absent=ActivityInvocationFence(null,{true}){s,e->check(s==null && e!!.contains("outcome_unknown"))}; absent.respond(true,"not-admitted")
 println("UNKNOWN_OUTCOME_JSON="+receipts[1].second)
 println("FENCE_CASES_PASSED=11")
}
`)
    const classpath = compile(out, [join(source, 'ActivityResultFence.kt'), harness])
    const output = runJvm(out, 'run', ['-cp', classpath, 'app.tauri.plugin.FenceHostKt'])
    assert.match(output, /FENCE_CASES_PASSED=11/)
    const sdkError = parse(output.split('\n').find(line => line.startsWith('UNKNOWN_OUTCOME_JSON=')).slice('UNKNOWN_OUTCOME_JSON='.length))
    const { NativeStateClient } = await import('../src/services/nativeState.ts')
    let writes = 0
    const client = new NativeStateClient(async action => {
      if (action === 'receipt') return { found: false }
      writes++
      throw sdkError
    })
    client.acceptSettings({ revision: 1, raw: '{}' })
    await assert.rejects(client.mutate('settingsPatch', { patches: [] }))
    await assert.rejects(client.mutate('readingAdd', { deltas: [] }), error => error.code === 'native_mutation_pending')
    assert.equal(writes, 1, 'unknown SDK response must retain the original canonical mutation envelope')
  } finally { rmSync(out, { recursive: true, force: true }) }
})

function kotlinFunction(text, name) {
  const at = text.indexOf(`fun ${name}(`)
  assert.ok(at >= 0, name)
  const start = text.indexOf('{', at)
  let depth = 1, end = start + 1
  for (; end < text.length && depth; end++) {
    if (text[end] === '{') depth++
    else if (text[end] === '}') depth--
  }
  assert.equal(depth, 0, name)
  return text.slice(at, end)
}

test('SDK failure notification releases actual folder select admission without clearing a newer picker', { timeout: 90000 }, () => {
  const text = readFileSync(join(root, 'src-tauri/android/MonitoredFolderPlugin.kt'), 'utf8')
  const out = mkdtempSync(join(cache, 'native-lifecycle-picker-'))
  try {
    const harness = emit(out, 'PickerHost.kt', `package app.tauri.plugin
import java.util.concurrent.atomic.AtomicBoolean
class Invoke { var code:String?=null; fun reject(message:String,value:String){code=value} }
class Intent(val action:String) { fun addFlags(flags:Int){}; companion object { const val ACTION_OPEN_DOCUMENT_TREE="tree"; const val FLAG_GRANT_READ_URI_PERMISSION=1; const val FLAG_GRANT_PERSISTABLE_URI_PERMISSION=2; const val FLAG_GRANT_PREFIX_URI_PERMISSION=4 } }
class Caller {
 private val admission=Any(); private var destroyed=false
 private class Lane { var working=false }; private val enumerationLane=Lane(); private val interactiveLane=Lane()
 private val selecting=AtomicBoolean(false); private var pendingPicker:Invoke?=null
 var failure:((String)->Unit)?=null
 fun startActivityForResult(i:Invoke,t:Intent,n:String){ startActivityForResult(i,t,n,{}) }
 fun startActivityForResult(i:Invoke,t:Intent,n:String,notify:(String)->Unit){failure=ActivityResultFailure({code->i.reject(code,code)},notify)}
 private fun reject(i:Invoke,e:Exception){i.reject("unavailable","unavailable")}
 fun busy()=selecting.get(); fun replace(i:Invoke){pendingPicker=i;selecting.set(true)}
 ${kotlinFunction(text, 'reserveSelection')}
 ${text.includes('fun releaseSelection(') ? kotlinFunction(text, 'releaseSelection') : ''}
 ${kotlinFunction(text, 'select')}
}
fun main() {
 for(code in listOf("activity_result_busy","launch_failed")) {
  val c=Caller();val first=Invoke();c.select(first);check(c.busy());val old=c.failure!!;old(code)
  check(!c.busy()){ "selection admission leaked after "+code };check(first.code==code)
  val next=Invoke();c.select(next);check(c.busy());old(code);check(c.busy());c.failure!!(code);check(!c.busy())
  val stale=Caller();val original=Invoke();stale.select(original);val late=stale.failure!!;stale.replace(Invoke());late(code);check(stale.busy())
 }
 println("PICKER_FAILURE_CASES_PASSED=6")
}
`)
    const classpath = compile(out, [join(source, 'ActivityResultFence.kt'), harness])
    assert.match(runJvm(out, 'run', ['-cp', classpath, 'app.tauri.plugin.PickerHostKt']), /PICKER_FAILURE_CASES_PASSED=6/)
    const handle = readFileSync(join(source, 'PluginHandle.kt'), 'utf8')
    assert.ok(handle.includes('ActivityResultFailure(') && handle.includes('onFailure'), 'SDK handle must wire the production failure helper')
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('overlay uses pinned SDK sources and preserves public SDK entry points', () => {
  const f = fixture()
  try {
    const entries = tauriLifecycleEntries(f.base, f.project, f.sdk)
    assert.equal(entries.length, Object.keys(pin.moduleFiles).length + pin.extraSources.length + 1)
    assert.ok(entries.every(e => e.path.startsWith(resolve(f.project, 'native-sdk/tauri-android') + sep)))
    const original = readFileSync(join(f.sdk, 'src/main/java/app/tauri/plugin/PluginManager.kt'), 'utf8')
    const patched = entries.find(e => e.path.endsWith('plugin' + sep + 'PluginManager.kt')).data.toString()
    for (const [, name] of original.matchAll(/^  fun (\w+)\(/gm)) assert.match(patched, new RegExp('  fun '+name+'(?:<|\\()'))
    assert.ok(patched.includes('activityResultRegistry.register(accepted.key, contract)'))
    assert.ok(patched.includes('ActivityInvocationFence(ownerEpoch'))
    const fence = readFileSync(join(source, 'ActivityResultFence.kt'), 'utf8')
    assert.ok(fence.includes('activity_changed_outcome_unknown'))
    assert.ok(fence.includes('settled.compareAndSet(false, true)'))
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('upstream drift and dependency version changes fail before writing any overlay', () => {
  const f = fixture()
  try {
    const path = join(f.sdk, 'src/main/java/app/tauri/plugin/PluginManager.kt')
    writeFileSync(path, readFileSync(path, 'utf8') + '\n// drift\n')
    assert.throws(() => tauriLifecycleEntries(f.base, f.project, f.sdk), /Pinned SDK source changed/)
    writeFileSync(path, readFileSync(join(upstream, 'src/main/java/app/tauri/plugin/PluginManager.kt')))
    const lock = join(f.base, 'src-tauri/Cargo.lock')
    writeFileSync(lock, readFileSync(lock, 'utf8').replace(/name = "tauri"\r?\nversion = "2\.11\.5"/, 'name = "tauri"\nversion = "2.12.3"'))
    assert.throws(() => tauriLifecycleEntries(f.base, f.project, f.sdk), /locked Tauri 2.11.5/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('malformed and escaping pin metadata are rejected', () => {
  const f = fixture(), file = join(f.base, 'src-tauri/android-sdk/tauri-2.11.5/upstream.json')
  try {
    writeFileSync(file, '{bad')
    assert.throws(() => tauriLifecycleEntries(f.base, f.project, f.sdk), /Invalid lifecycle SDK pin/)
    writeFileSync(file, JSON.stringify({ ...pin, extraSources: ['../outside.kt'] }))
    assert.throws(() => tauriLifecycleEntries(f.base, f.project, f.sdk), /Invalid SDK source path/)
    writeFileSync(file, JSON.stringify({ ...pin, extraSources: [...pin.extraSources, ...pin.extraSources] }))
    assert.throws(() => tauriLifecycleEntries(f.base, f.project, f.sdk), /pin schema/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})
