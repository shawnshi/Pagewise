import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSpeechSession, speechSourceVersion } from '../src/services/nativeSpeechSession.ts'

const options = { rate: 1, voice: 'offline', deadline: 0, stopAtSection: false }
const identity = async () => ({ owner: 'test-book', sourceVersion: 'extract-v1:content-hash' })
const wait = async condition => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 2)) }
  throw new Error('condition not reached')
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function actor() {
  let id = 0
  const log = []
  let items = [], coverage = new Set(), expected = 0
  const state = { id: '', owner: '', sourceVersion: '', instance: 'native-instance', generation: 0, sequence: 0,
    state: 'idle', index: 0, count: 0, key: '', text: '', committed: false, reason: '', code: '', ...options }
  const snapshot = () => structuredClone(state)
  const call = async (action, args) => {
    log.push({ action, args: structuredClone(args) })
    if (action === 'status') return snapshot()
    if (action === 'begin') {
      items = []; coverage = new Set(); expected = args.expectedUnits
      Object.assign(state, args, { id: `queue-${++id}`, state: 'preparing', count: 0, index: 0, committed: false, generation: state.generation + 1 })
    } else {
      assert.equal(args.id, state.id, 'mutations are session-scoped')
      assert.equal(args.instance, state.instance, 'mutations are instance-scoped')
      assert.equal(args.generation, state.generation, 'mutations are generation-scoped')
      assert.equal(typeof args.requestId, 'string')
      if (action === 'append') {
        assert.equal(args.offset, items.length)
        assert.ok(args.items.length <= 100)
        items.push(...args.items); args.coverage.forEach(unit => coverage.add(unit)); state.count = items.length
      } else if (action === 'commit') {
        assert.equal(coverage.size, expected)
        assert.equal(args.count, items.length)
        const index = args.startKey ? items.findIndex(item => item.key === args.startKey) : 0
        assert.ok(index >= 0)
        Object.assign(state, args, { state: args.autoplay ? 'playing' : 'paused', index, key: items[index].key, text: items[index].text, committed: true })
      } else if (action === 'pause') { state.state = 'paused'; state.reason = 'user' }
      else if (action === 'resume') { state.state = 'playing'; state.reason = '' }
      else if (action === 'configure') Object.assign(state, args)
      else if (action === 'stop' || action === 'discard') { state.state = 'stopped' }
      else if (action === 'seek') { state.index += args.delta; state.key = items[state.index].key }
      else throw new Error(`unexpected ${action}`)
      if (action !== 'append') state.generation++
    }
    state.sequence++
    return snapshot()
  }
  return { state, log, call, snapshot, get items() { return items }, finish() { state.state = 'finished'; state.index = state.count; state.key = items.at(-1)?.key ?? ''; state.text = items.at(-1)?.text ?? ''; state.sequence++ } }
}
function feed(count = 3, failAt = -1) {
  let n = 0, covered = []
  return {
    expectedUnits: 3,
    drainCoverage() { const result = covered; covered = []; return result },
    async next() {
      if (n === failAt) throw Object.assign(new Error('extract failed'), { code: 'extraction_failed' })
      if (n === count) { covered.push(0, 1, 2); return null }
      const key = `${Math.floor(n / 201)}:0:${n % 201}`
      n++; return { key, text: `synthetic sentence ${n}`, sectionEnd: n % 201 === 0 }
    },
  }
}

test('complete preparation exceeds old 200-sentence batch and commits once with no JS refill', async t => {
  const native = actor(), states = []
  const client = new NativeSpeechSession(identity, state => states.push(state), native.call)
  t.after(() => client.detach())
  const playback = client.play(feed(603), options, '1:0:0')
  await wait(() => native.state.state === 'playing')
  assert.equal(native.items.length, 603)
  assert.equal(native.state.index, 201)
  assert.equal(native.log.filter(x => x.action === 'commit').length, 1)
  assert.equal(native.log.filter(x => x.action === 'append').length, 7)
  const commands = native.log.length
  native.finish(); await client.refresh(); assert.equal(await playback, 'finished')
  assert.deepEqual(native.log.slice(commands).map(x => x.action), ['status'])
  assert.ok(states.some(state => state.state === 'preparing'))
  client.detach()
})

test('middle extraction failure discards staging and never commits partial content', async () => {
  const native = actor(), client = new NativeSpeechSession(identity, () => {}, native.call)
  await assert.rejects(client.play(feed(603, 201), options), { code: 'extraction_failed' })
  assert.equal(native.log.some(x => x.action === 'commit'), false)
  assert.equal(native.log.at(-1).action, 'discard')
  client.detach()
})

test('late begin after cancellation cannot publish or play an orphan queue', async () => {
  const native = actor(), begun = deferred(), release = deferred()
  const call = async (action, args) => {
    const result = await native.call(action, args)
    if (action === 'begin') { begun.resolve(); await release.promise }
    return result
  }
  const client = new NativeSpeechSession(identity, () => {}, call)
  const playback = client.play(feed(), options)
  await begun.promise; await client.stop(); release.resolve()
  assert.equal(await playback, 'stopped')
  assert.equal(native.state.state, 'stopped')
  assert.equal(native.log.some(x => x.action === 'commit'), false)
})

test('late commit ACK followed by stop reconciles generation before stopping own session', async () => {
  const native = actor(), committed = deferred(), release = deferred()
  const call = async (action, args) => {
    const result = await native.call(action, args)
    if (action === 'commit') { committed.resolve(); await release.promise }
    return result
  }
  const client = new NativeSpeechSession(identity, () => {}, call)
  const playback = client.play(feed(), options)
  await committed.promise
  const stopping = client.stop(); release.resolve(); await stopping
  assert.equal(await playback, 'stopped')
  assert.equal(native.state.state, 'stopped')
})

test('detach removes observation without stopping committed native playback', async () => {
  const native = actor(), client = new NativeSpeechSession(identity, () => {}, native.call)
  const playback = client.play(feed(), options)
  await wait(() => native.state.state === 'playing')
  client.detach()
  assert.equal(await playback, 'stopped')
  assert.equal(native.state.state, 'playing')
  assert.equal(native.log.some(x => x.action === 'stop'), false)
})

test('attach to restored paused queue only observes; it cannot issue resume or navigation', async () => {
  const native = actor(), client = new NativeSpeechSession(identity, () => {}, native.call)
  const playback = client.play(feed(), options)
  await wait(() => native.state.state === 'playing'); client.detach(); await playback
  native.state.state = 'paused'; native.state.reason = 'process_restart'
  const from = native.log.length
  const reconnected = new NativeSpeechSession(identity, () => {}, native.call)
  assert.equal((await reconnected.attach()).state, 'paused')
  assert.deepEqual(native.log.slice(from).map(x => x.action), ['status'])
  reconnected.detach()
})

test('source version mismatch refuses ordinal reuse and does not mutate native state', async () => {
  const native = actor(), client = new NativeSpeechSession(identity, () => {}, native.call)
  const playback = client.play(feed(), options)
  await wait(() => native.state.state === 'playing'); client.detach(); await playback
  const changed = new NativeSpeechSession(async () => ({ owner: 'test-book', sourceVersion: 'changed' }), () => {}, native.call)
  await assert.rejects(changed.attach(), { code: 'source_changed' })
  assert.equal(native.state.state, 'playing')
  changed.detach()
})

test('pause during preparation commits paused and user resume is explicit', async () => {
  const native = actor(), barrier = deferred(), entered = deferred(), source = feed()
  const next = source.next
  source.next = async () => { entered.resolve(); await barrier.promise; return next() }
  const client = new NativeSpeechSession(identity, () => {}, native.call)
  const playback = client.play(source, options)
  await entered.promise; await client.pause(); barrier.resolve()
  await wait(() => native.state.committed)
  assert.equal(native.state.state, 'paused')
  await client.resume(); assert.equal(native.state.state, 'playing')
  native.finish(); await client.refresh(); await playback
  client.detach()
})

test('prepare quota rejection remains an error and is never reported as end of book', async () => {
  const native = actor()
  const call = async (action, args) => { if (action === 'append') throw { code: 'resource_limit' }; return native.call(action, args) }
  const client = new NativeSpeechSession(identity, () => {}, call)
  await assert.rejects(client.play(feed(), options), { code: 'resource_limit' })
  assert.equal(native.log.some(x => x.action === 'commit'), false)
  client.detach()
})

test('a finished native queue reconciles its last locator without restoring playback', async () => {
  const native = actor(), client = new NativeSpeechSession(identity, () => {}, native.call)
  const playback = client.play(feed(), options)
  await wait(() => native.state.state === 'playing'); native.finish(); await client.refresh(); await playback; client.detach()
  const observed = [], from = native.log.length
  const restored = new NativeSpeechSession(identity, snapshot => observed.push(snapshot), native.call)
  assert.equal(await restored.attach(), null)
  assert.equal(observed.at(-1).key, '0:0:2')
  assert.equal(restored.attached, false)
  assert.deepEqual(native.log.slice(from).map(x => x.action), ['status'])
  restored.detach()
})

test('resume from an already complete native checkpoint never appends or restarts stale web text', async () => {
  const native = actor()
  Object.assign(native.state, await identity(), { id: 'completed', count: 3, index: 3, state: 'finished', committed: true, key: '0:0:2' })
  const call = async (action, args) => {
    if (action === 'begin') { assert.equal(args.resumeFromCheckpoint, true); native.log.push({ action, args }); return native.snapshot() }
    return native.call(action, args)
  }
  const client = new NativeSpeechSession(identity, () => {}, call)
  const source = feed(); source.resumeFromCheckpoint = true
  assert.equal(await client.play(source, options, '0:0:0'), 'finished')
  assert.deepEqual(native.log.map(x => x.action), ['status', 'begin'])
  client.detach()
})

test('source identity binds real bytes and extractor version, not display metadata', async () => {
  const first = await speechSourceVersion(new Blob(['test']), 'extract-v1')
  assert.equal(first, 'extract-v1:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
  assert.notEqual(await speechSourceVersion(new Blob(['changed']), 'extract-v1'), first)
  assert.notEqual(await speechSourceVersion(new Blob(['test']), 'extract-v2'), first)
})
