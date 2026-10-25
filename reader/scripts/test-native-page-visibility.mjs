import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { compile, emit, runJvm, root, files } from './native-import-test-tools.mjs'
import { homedir } from 'node:os'
import { createNativePageVisibility } from '../src/services/nativePageVisibility.ts'
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const turn = () => new Promise(resolve => setImmediate(resolve))

test('acknowledged native surface hides Web focus/a11y and restores exact original attributes', async () => {
  const oldDocument = globalThis.document
  const attributes = new Map([['aria-hidden', 'false'], ['inert', 'original']])
  const element = { getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) }
  globalThis.document = { getElementById: () => element }
  try {
    const f = fixture(async action => ({ applied: true, visible: action === 'show' }))
    await f.owner.show('native', 'library', {})
    assert.equal(attributes.get('aria-hidden'), 'true'); assert.equal(attributes.get('inert'), '')
    await f.owner.hide('native')
    assert.deepEqual([...attributes], [['aria-hidden', 'false'], ['inert', 'original']])
  } finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument }
})

test('failed native hide cannot reactivate obscured Web controls', async () => {
  const oldDocument = globalThis.document
  const attributes = new Map()
  const element = { getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) }
  globalThis.document = { getElementById: () => element }
  try {
    const f = fixture(async action => { if (action === 'hide') throw { code: 'draft_write_outcome_unknown' }; return { applied: true, visible: true } })
    await f.owner.show('native', 'library', {})
    await assert.rejects(() => f.owner.hide('native'), e => e.code === 'draft_write_outcome_unknown')
    assert.equal(attributes.get('aria-hidden'), 'true'); assert.equal(attributes.get('inert'), '')
  } finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument }
})
function fixture(hook = async () => ({ applied: true, visible: true })) {
  let generation = 0
  const calls = []
  const send = async (action, payload) => {
    calls.push({ action, ...payload })
    if (action === 'visibilityTicket') return { session: payload.session, generation: ++generation }
    return hook(action, payload)
  }
  return { calls, owner: createNativePageVisibility('realm-1', send), send }
}
test('latest owner dispatches while old show ACK is pending; old ACK cannot become current', async () => {
  const old = deferred(), entered = deferred()
  const f = fixture(async (action, p) => { if (p.page === 'library') { entered.resolve(); return old.promise } return { applied: true, visible: action === 'show' } })
  const first = f.owner.show('A', 'library', {}); await entered.promise
  assert.equal((await f.owner.show('B', 'settings', {})).applied, true)
  old.resolve({ applied: true, visible: true }); assert.equal((await first).obsolete, true)
  const before = f.calls.length; assert.equal((await f.owner.hide('A')).obsolete, true); assert.equal(f.calls.length, before)
  assert.deepEqual(f.calls.filter(x => x.action === 'show').map(x => x.page), ['library', 'settings'])
})
test('rapid settings/library/settings coalesces unissued obsolete transitions', async () => {
  const f = fixture()
  const a = f.owner.show('A', 'settings', {}), b = f.owner.show('B', 'library', {}), c = f.owner.show('C', 'settings', {})
  assert.equal((await a).obsolete, true); assert.equal((await b).obsolete, true); assert.equal((await c).applied, true)
  assert.deepEqual(f.calls.filter(x => x.action === 'show').map(x => x.page), ['settings'])
})
test('two concurrent leave guards await one physical hide and the same failure/ACK', async () => {
  const ack = deferred(), entered = deferred()
  const f = fixture(async action => { if (action === 'hide') { entered.resolve(); return ack.promise } return { applied: true, visible: true } })
  await f.owner.show('A', 'annotations', {})
  const a = f.owner.hide('A'), b = f.owner.hide('A'); assert.equal(a, b)
  await entered.promise; let completed = false; void b.then(() => { completed = true }); await turn(); assert.equal(completed, false)
  ack.resolve({ applied: true, visible: false }); assert.equal((await a).applied, true); await b
  assert.equal(f.calls.filter(x => x.action === 'hide').length, 1)
})
test('failed draft ACK rejects leave, preserves ownership and never automatically retries/hides again', async () => {
  let fail = true
  const f = fixture(async action => { if (action === 'hide' && fail) throw Object.assign(new Error('draft_save_failed'), { code: 'draft_save_failed' }); return { applied: true, visible: action === 'show' } })
  await f.owner.show('A', 'annotations', {})
  await assert.rejects(f.owner.hide('A'), /draft_save_failed/)
  assert.equal(f.calls.filter(x => x.action === 'hide').length, 1)
  fail = false; assert.equal((await f.owner.hide('A')).applied, true)
  assert.equal(f.calls.filter(x => x.action === 'hide').length, 2)
})
test('show failure has no automatic hide/business replay', async () => {
  const f = fixture(async () => { throw new Error('native_pages_error') })
  await assert.rejects(f.owner.show('A', 'book', { id: 'synthetic' }), /native_pages_error/)
  assert.deepEqual(f.calls.map(x => x.action), ['visibilityTicket', 'show'])
})
test('stale lease/session and invalid ticket are not successful acknowledgements', async () => {
  const f = fixture(async () => ({ applied: false, stale: true }))
  await assert.rejects(f.owner.show('A', 'library', {}), /stale_native_visibility/)
  const bad = createNativePageVisibility('realm-1', async () => ({ session: 'old-realm', generation: 1 }))
  await assert.rejects(bad.show('A', 'library', {}), /stale_native_visibility/)
})
test('ticket timeout releases dispatch without sending old show after its late ticket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ticket = deferred(), started = deferred(), calls = []
  const owner = createNativePageVisibility('realm', async (action, p) => { calls.push({ action, ...p }); if (action === 'visibilityTicket' && p.intent === 1) { started.resolve(); return ticket.promise } return action === 'visibilityTicket' ? { session: p.session, generation: 2 } : { applied: true, visible: true } })
  const old = owner.show('A', 'library', {}); await started.promise
  const rejected = assert.rejects(old, /native_visibility_timeout/); t.mock.timers.tick(35_000); await rejected
  assert.equal((await owner.show('B', 'settings', {})).applied, true)
  ticket.resolve({ session: 'realm', generation: 1 }); await turn()
  assert.deepEqual(calls.filter(x => x.action === 'show').map(x => x.page), ['settings'])
})
test('command timeout does not acknowledge late success or replay the command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ack = deferred(), started = deferred()
  const f = fixture(async () => { started.resolve(); return ack.promise })
  const work = f.owner.show('A', 'library', {}); await started.promise
  const rejected = assert.rejects(work, /native_visibility_timeout/); t.mock.timers.tick(35_000); await rejected
  ack.resolve({ applied: true, visible: true }); await turn()
  assert.equal(f.calls.filter(x => x.action === 'show').length, 1)
})
test('actual Kotlin draft ACK barrier and native session/ticket/lease fence', () => {
  const out = resolve(root, '../.cache/native-pages-lifecycle-host', `${Date.now()}-${process.pid}`)
  mkdirSync(out, { recursive: true })
  const source = resolve(root, 'src-tauri/android/NativePageVisibility.kt')
  const harness = emit(out, 'NativeLifecycleHost.kt', `package io.pagewise.reader
private var assertions = 0
private fun ok(value: Boolean) { check(value); assertions++ }
private class Draft(initial: String = "base") {
  val writes = mutableListOf<Pair<String, (String?) -> Unit>>()
  val errors = mutableListOf<String?>()
  val state = NativeDraftBarrier(initial, { text, done -> writes.add(text to done) }, { errors.add(it) })
  fun ack(index: Int, error: String? = null) = writes[index].second(error)
}
fun main() {
  ok(nativeClassificationFailureStatus(true, "unknown", "database_error").contains("提交结果未确认"))
  ok(nativeClassificationFailureStatus(true, "", "classification_outcome_unknown").contains("提交结果未确认"))
  ok(nativeClassificationFailureStatus(true, "", "").contains("提交结果未确认"))
  ok(nativeClassificationFailureStatus(true, "not_committed", "conflict").contains("提交被拒绝"))
  ok(nativeClassificationFailureStatus(false, "", "").contains("生成未完成"))
  run { val d = Draft(); var left = false; d.state.flush { ok(it == null); left = true }; ok(left); ok(d.writes.isEmpty()) }
  run { val d = Draft(); d.state.edit("one"); d.state.autosave(); d.state.edit("latest"); d.state.autosave(); var left = false; d.state.flush { ok(it == null); left = true }; ok(d.writes.size == 1); ok(!left); d.ack(0); ok(d.writes[1].first == "latest"); ok(!left); d.ack(1); ok(left); ok(d.state.confirmed == "latest"); d.ack(0, "late_duplicate"); ok(d.state.confirmed == "latest") }
  run { val d = Draft(); d.state.edit("pending"); d.state.autosave(); d.state.edit("base"); var left = false; d.state.flush { left = it == null }; ok(!left); d.ack(0); ok(!left); ok(d.writes.size == 2); ok(d.writes[1].first == "base"); d.ack(1); ok(left) }
  run { val d = Draft(); d.state.edit("quota-text"); var result: String? = null; d.state.flush { result = it }; d.ack(0, "quota"); ok(result == "quota"); ok(d.state.desired == "quota-text"); ok(!d.state.isConfirmed()); d.state.edit("newest"); d.state.autosave(); ok(d.writes.size == 1); d.state.flush { result = it }; ok(d.writes.size == 2); ok(d.writes[1].first == "newest"); d.ack(1); ok(result == null); ok(d.state.isConfirmed()) }
  run { val d = Draft(); d.state.edit("x"); val results = mutableListOf<String?>(); d.state.flush { results.add(it) }; d.state.flush { results.add(it) }; ok(results.isEmpty()); d.ack(0, "commit_outcome_unknown"); ok(results == listOf("commit_outcome_unknown", "commit_outcome_unknown")); d.state.autosave(); ok(d.writes.size == 1) }
  run { val d = Draft(); d.state.edit("x"); var error: String? = null; d.state.flush { error = it }; d.state.abandon(false); ok(error == "draft_unconfirmed"); d.ack(0); ok(d.writes.size == 1); ok(error == "draft_unconfirmed") }
  run { val d = Draft(); d.state.edit("x"); var allowed = false; d.state.flush { allowed = it == null }; d.state.abandon(true); ok(allowed); d.ack(0); ok(d.writes.size == 1); ok(d.state.confirmed == "x") }
  run { val d = NativeDraftBarrier("base", { _, _ -> throw IllegalStateException("private-detail") }, {}); d.edit("x"); var error: String? = null; d.flush { error = it }; ok(error == "draft_outcome_unknown"); ok(d.desired == "x") }
  run { val d = Draft(); d.state.edit("x"); var successes = 0; var busy = 0; repeat(33) { d.state.flush { if (it == null) successes++ else if (it == "busy") busy++ } }; ok(busy == 1); ok(d.writes.size == 1); d.ack(0); ok(successes == 32) }
  val f = NativePageVisibilityFence(); f.beginSession("realm-a")
  val one = f.ticket("realm-a", 1, 0)!!; ok(f.admit("realm-a", one, 1)); ok(f.isCurrent("realm-a", one, 2)); ok(!f.admit("realm-a", one, 3))
  val two = f.ticket("realm-a", 2, 4)!!; ok(!f.isCurrent("realm-a", one, 5)); ok(!f.admit("realm-a", one, 5)); ok(f.admit("realm-a", two, 5)); ok(f.ticket("realm-a", 1, 6) == null); ok(f.isCurrent("realm-a", two, 6))
  ok(!f.isCurrent("realm-a", two, 30_005)); ok(!f.admit("realm-a", two, 40_000))
  val three = f.ticket("realm-a", 3, 50_000)!!; f.beginSession("realm-b"); ok(!f.admit("realm-a", three, 50_001)); ok(f.ticket("realm-a", 4, 50_001) == null)
  val fresh = f.ticket("realm-b", 1, 50_002)!!; ok(f.admit("realm-b", fresh, 50_003)); ok(f.ticket("realm-b", 0, 50_004) == null); ok(!f.admit("realm-b", fresh + 1, 50_004))
  run { val pager = NativeDraftPager(); val ids = mutableListOf<Int>(); ids.addAll(pager.window(23)); pager.next(); ids.addAll(pager.window(23)); pager.next(); ids.addAll(pager.window(23)); ok(ids == (0 until 23).toList()); pager.next(); ok(pager.window(23).first == 20); pager.previous(); ok(pager.window(23).first == 10); ok(pager.window(3).toList() == listOf(0, 1, 2)); ok(pager.window(0).isEmpty()) }
  run { val state = NativeStatsUiState(); for (kind in listOf("week", "month", "year", "all", "range")) { state.offset = 80; state.bookOffset = 40; state.changePeriod(kind, "2026-10-21"); ok(state.offset == 0); ok(state.bookOffset == 0); ok(state.anchor == "2026-10-21") } }
  run {
    val queue = java.util.ArrayDeque<() -> Unit>(); val calls = mutableListOf<String>(); var result: List<Pair<String, String?>>? = null; var unknown = false
    val ids = mutableListOf("a", "b", "c")
    val batch = NativeSelectionBatch(ids, { queue.add(it) }, { id, done -> calls.add(id); done(if (id == "b") "commit_outcome_unknown" else null); done(null) }, { _, _ -> }, { rows, u -> result = rows; unknown = u })
    ids.add("not-authorized-after-start"); batch.start(); batch.start(); while (queue.isNotEmpty()) queue.removeFirst().invoke()
    ok(calls == listOf("a", "b")); ok(unknown); ok(result!![0].second == null); ok(result!![1].second == "commit_outcome_unknown"); ok(result!![2].second == "not_run"); ok(result!!.size == 3)
  }
  run {
    val queue = java.util.ArrayDeque<() -> Unit>(); var finished: List<Pair<String, String?>>? = null
    val batch = NativeSelectionBatch(listOf("a", "b", "c"), { queue.add(it) }, { id, done -> done(if (id == "b") "source_linked_book" else null) }, { _, _ -> }, { rows, u -> ok(!u); finished = rows })
    batch.start(); while (queue.isNotEmpty()) queue.removeFirst().invoke()
    ok(finished!!.count { it.second == null } == 2); ok(finished!![1].second == "source_linked_book")
  }
  run {
    val queue = java.util.ArrayDeque<() -> Unit>(); var callback: ((String?) -> Unit)? = null; var finished: List<Pair<String, String?>>? = null
    val batch = NativeSelectionBatch(listOf("a", "b"), { queue.add(it) }, { _, done -> callback = done }, { _, _ -> }, { rows, _ -> finished = rows })
    batch.start(); queue.removeFirst().invoke(); batch.stopAfterCurrent(); callback!!(null)
    while (queue.isNotEmpty()) queue.removeFirst().invoke()
    ok(finished!![0].second == null); ok(finished!![1].second == "not_run")
  }
  println("assertions=" + assertions)
}`)
  const sdk = resolve(process.env.ANDROID_HOME || resolve(process.env.USERPROFILE, 'AppData/Local/Android/Sdk'), 'platforms')
  const jar = readdirSync(sdk).map(p => resolve(sdk, p, 'android.jar')).filter(existsSync).sort().at(-1)
  assert.ok(jar, 'Installed SDK jar required; never install dependencies from this test')
  const boundary = emit(out, 'NativePageReply.kt', 'package io.pagewise.reader\ninternal typealias NativePageReply = (org.json.JSONObject?, String?) -> Unit\n')
  const statsSource = resolve(root, 'src-tauri/android/NativeStatsPanel.kt')
  const coreApis = files(resolve(homedir(), '.gradle/caches/8.14.3/transforms')).filter(p => p.endsWith('core-1.13.1-api.jar'))
  assert.equal(coreApis.length, 1, 'Expected cached AndroidX core API for native path compilation; never install a test dependency')
  const classpath = compile(out, [source, statsSource, resolve(root, 'src-tauri/android/NativeStatsSettingsUi.kt'), resolve(root, 'src-tauri/android/NativeUi.kt'), resolve(root, 'src-tauri/android/NativeUiMetrics.kt'), boundary, harness], [jar, coreApis[0]])
  const output = runJvm(out, 'run', ['-cp', classpath, 'io.pagewise.reader.NativeLifecycleHostKt'])
  assert.match(output, /assertions=\d+/)
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex')
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ productionSource: source, statsUiSourceHash: createHash('sha256').update(readFileSync(statsSource)).digest('hex'), sha256: hash, output: output.trim(), syntheticOnly: true, androidRuntime: false }, null, 2))
})
test('route lifecycle and editor wiring has no fire-and-forget unmount hide or post-dismiss blind draft write', () => {
  const vue = readFileSync(resolve(root, 'src/views/NativePageView.vue'), 'utf8')
  assert.match(vue, /onBeforeRouteLeave\(leave\)/); assert.match(vue, /onBeforeRouteUpdate\(leave\)/)
  assert.doesNotMatch(vue, /void hideNativePage|hideNativePage\(\)\.catch/)
  const note = readFileSync(resolve(root, 'src-tauri/android/NativeNoteEditor.kt'), 'utf8')
  assert.ok(note.includes('window.setCancelable(false)')); assert.match(note, /BackApi33/); assert.match(note, /flushForLeave/); assert.match(note, /draft\.abandon\(safeClose\)/); assert.doesNotMatch(note, /if \(desired != savedDraft\) pumpDraft/)
})
