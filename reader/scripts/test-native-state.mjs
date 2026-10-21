import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { NativeStateClient, getNativeState, hasNativeState, initializeNativeState, settingsDiff, stateError } from '../src/services/nativeState.ts'
import { legacyStateSource, migrateNativeState } from '../src/services/nativeStateMigration.ts'
import { normalizeLegacySettings, useSettings } from '../src/stores/settings.ts'
import { getLibraryRoot } from '../src/storage/types.ts'
import { createReadingIdentity } from '../src/services/localReadingIdentity.ts'
import { aggregateReadingLog, createDexieReadingLogStore, createReadingLog } from '../src/services/readingLog.ts'

// Protocol contract fixture, NOT proof of Android SQLite/Activity behavior. All values are synthetic.
function parseFixture(raw) {
  try { return JSON.parse(raw) } catch (error) { assert.fail(`Invalid synthetic fixture JSON: ${error.name}`) }
}
const clone = value => parseFixture(JSON.stringify(value))
function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name))
}
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical)}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value)
const initialRaw = JSON.stringify({ version: 16, libraryRoot: '', aiProvider: 'deepseek', aiBaseUrl: 'https://synthetic.invalid/v1', aiApiKey: 'SYNTHETIC-NOT-A-KEY', aiModel: 'synthetic-model',
  aiProfiles: { openai: { baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC-SECOND-NOT-A-KEY', model: 'synthetic-paid-model' } },
  dianjing: { enabled: true, consentAll: true, perBook: { 'fixture-book': false }, channel: 'own', level: 'smart' } })
const row = n => ({ key: `fixture-device|2026-01-01|id:fixture-${String(n).padStart(4, '0')}`, device: 'fixture-device', day: '2026-01-01', bookId: `fixture-${String(n).padStart(4, '0')}`, title: 'Synthetic', kind: 'book', seconds: n + 1, updatedAt: 1 })
function source(rows = [row(0)], raw = initialRaw) {
  const calls = { settings: 0, snapshot: 0 }
  const snapshot = { rows: clone(rows), deviceId: 'fixture-device', hashes: [{ id: 'fixture-0000', hash: 'fixture-hash' }] }
  return { calls, snapshotValue: snapshot,
    settings() { calls.settings++; return raw },
    async snapshot() { calls.snapshot++; return clone(snapshot) },
  }
}
function server({ complete = false, raw = JSON.stringify(normalizeLegacySettings(initialRaw)), root = '', locate = complete } = {}) {
  let state = complete ? 'complete' : 'empty', settingsRaw = raw, revision = 1, manifest = null
  let identity = { deviceId: 'fixture-device', hashes: [['fixture-0000', 'fixture-hash']] }
  const chunks = new Map(), records = new Map(), receipts = new Map(), calls = []
  let failChunk = -1, lose = null, receiptUnavailable = false
  const snapshot = () => ({ revision, raw: settingsRaw })
  function status() { return state === 'complete' ? { state, settings: snapshot(), rows: records.size } : { state, nextChunk: chunks.size, stagedRows: [...chunks.values()].reduce((n, raw) => n + parseFixture(raw).length, 0) } }
  function at(value, path) {
    let node = value
    for (const key of path.slice(0, -1)) {
      if (!node || typeof node[key] !== 'object') return { present: false }
      node = node[key]
    }
    return Object.hasOwn(node, path.at(-1)) ? { present: true, value: node[path.at(-1)] } : { present: false }
  }
  async function invoke(action, payload, requestedRoot) {
    calls.push({ action, payload: clone(payload), root: requestedRoot })
    if (!locate && requestedRoot === undefined) throw stateError('migration_not_initialized')
    if (requestedRoot !== undefined && requestedRoot !== root) throw stateError('unsupported_library_root')
    if (action === 'status') return status()
    if (action === 'migrationBegin') {
      assert.equal(typeof payload.settings, 'string'); assert.equal(typeof payload.identity, 'string')
      assert.equal(payload.chunks, Math.ceil(payload.rows / 256))
      if (manifest && canonical(manifest) !== canonical(payload)) throw stateError('migration_source_changed')
      manifest = clone(payload); state = 'staging'; return status()
    }
    if (action === 'migrationChunk') {
      assert.equal(typeof payload.rows, 'string', 'raw JSON rows, not a parsed array')
      const rows = parseFixture(payload.rows)
      assert.ok(rows.length > 0 && rows.length <= 256)
      if (chunks.has(payload.ordinal) && chunks.get(payload.ordinal) !== payload.rows) throw stateError('migration_source_changed')
      if (payload.ordinal === failChunk) { failChunk = -1; throw stateError('unavailable') }
      chunks.set(payload.ordinal, payload.rows)
      return { ordinal: payload.ordinal }
    }
    if (action === 'migrationCommit') {
      assert.equal(chunks.size, manifest.chunks)
      for (let i = 0; i < chunks.size; i++) for (const item of parseFixture(chunks.get(i))) {
        assert.equal(records.has(item.key), false)
        records.set(item.key, item)
      }
      assert.equal(records.size, manifest.rows)
      settingsRaw = manifest.settings; identity = parseFixture(manifest.identity)
      identity.deviceId ??= 'fixture-native-generated-once'
      state = 'complete'; locate = true
      return status()
    }
    if (action === 'settingsGet') return snapshot()
    if (action === 'identityGet') return { deviceId: identity.deviceId }
    if (action === 'hashesPage') {
      const rows = identity.hashes.filter(([id]) => id > payload.after).sort(([a], [b]) => a.localeCompare(b)).slice(0, 256)
      return { rows, next: rows.at(-1)?.[0] ?? payload.after }
    }
    if (action === 'readingPage') {
      assert.equal(payload.limit, 256)
      const rows = [...records.values()].filter(row => row.key > payload.after).sort((a, b) => a.key.localeCompare(b.key)).slice(0, payload.limit)
      return { rows, next: rows.at(-1)?.key ?? payload.after }
    }
    if (action === 'receipt') {
      if (receiptUnavailable) throw stateError('unavailable')
      const prior = receipts.get(payload.requestId)
      return prior ? { found: true, fingerprint: prior.fingerprint, result: prior.settings ? snapshot() : prior.result } : { found: false }
    }
    assert.match(payload.requestId, /^[a-f0-9-]{36}$/)
    assert.ok(Number.isFinite(payload.createdAt))
    const fingerprint = digest(action + '\0' + canonical(payload))
    const old = receipts.get(payload.requestId)
    if (old) {
      if (old.fingerprint !== fingerprint) throw stateError('request_conflict')
      return old.settings ? snapshot() : clone(old.result)
    }
    let result
    if (action === 'settingsPatch') {
      const document = parseFixture(settingsRaw)
      for (const patch of payload.patches) {
        if (patch.path[0] === 'libraryRoot') throw stateError('library_move_required')
        if (canonical(at(document, patch.path)) !== canonical(patch.before)) throw stateError('settings_conflict')
      }
      for (const patch of payload.patches) {
        let node = document
        for (const key of patch.path.slice(0, -1)) node = node[key] ??= {}
        if (patch.after.present) node[patch.path.at(-1)] = clone(patch.after.value)
        else delete node[patch.path.at(-1)]
      }
      settingsRaw = JSON.stringify(document); revision++; result = snapshot()
    } else if (action === 'readingAdd') {
      for (const d of payload.deltas) {
        const key = `${d.device}|${d.day}|${d.ref}`, previous = records.get(key)
        records.set(key, { key, device: d.device, day: d.day, bookId: d.ref.slice(3), title: d.title, kind: d.kind, seconds: (previous?.seconds ?? 0) + d.seconds, updatedAt: payload.now })
      }
      result = { ok: true }
    } else if (action === 'readingPutMax') {
      assert.ok(payload.rows.length <= 256)
      let changed = 0
      for (const item of payload.rows) if (!records.has(item.key) || records.get(item.key).seconds < item.seconds) { records.set(item.key, clone(item)); changed++ }
      result = { changed }
    } else throw Error(`Unexpected action: ${action}`)
    receipts.set(payload.requestId, { fingerprint, result, settings: action === 'settingsPatch' })
    if (lose === action) { lose = null; throw stateError('commit_outcome_unknown') }
    return clone(result)
  }
  return { invoke, calls, records, receipts, chunks, snapshot,
    failChunk: n => { failChunk = n }, lose: action => { lose = action }, failReceipt: value => { receiptUnavailable = value },
    changeSettings: changes => { settingsRaw = JSON.stringify({ ...parseFixture(settingsRaw), ...changes }); revision++ },
  }
}
const readyClient = s => { const c = new NativeStateClient(s.invoke); c.acceptSettings(s.snapshot()); return c }

test('complete locator status reads NO legacy settings, stats, accounts or baselines', async () => {
  const s = server({ complete: true }), src = source()
  const c = new NativeStateClient(s.invoke)
  await migrateNativeState(c, src, normalizeLegacySettings)
  assert.deepEqual(src.calls, { settings: 0, snapshot: 0 })
  assert.equal(c.settings().aiApiKey, 'SYNTHETIC-NOT-A-KEY')
})

test('missing locator reads only root, then complete status avoids normalization and legacy databases', async () => {
  const s = server({ complete: true, locate: false }), src = source([], '{"libraryRoot":"","reader":null}')
  await migrateNativeState(new NativeStateClient(s.invoke), src, normalizeLegacySettings)
  assert.deepEqual(src.calls, { settings: 1, snapshot: 0 })
  assert.equal(s.calls[0].root, undefined); assert.equal(s.calls[1].root, '')
})

test('migration replays acknowledged ordinals; raw rows, paid keys, identity and consent survive', async () => {
  const rows = Array.from({ length: 257 }, (_, n) => row(n)), src = source(rows), s = server()
  s.failChunk(1)
  await assert.rejects(migrateNativeState(new NativeStateClient(s.invoke), src, normalizeLegacySettings), /unavailable/)
  assert.equal(s.chunks.size, 1)
  const c = new NativeStateClient(s.invoke)
  await migrateNativeState(c, src, normalizeLegacySettings)
  assert.equal(s.calls.filter(call => call.action === 'migrationChunk' && call.payload.ordinal === 0).length, 2)
  assert.deepEqual(await c.readingStore().all(), rows)
  assert.equal(await c.identity().getDeviceId(), 'fixture-device')
  assert.deepEqual(await c.identity().getHashes(), new Map([['fixture-0000', 'fixture-hash']]))
  assert.equal(c.settings().aiProfiles.openai.apiKey, 'SYNTHETIC-SECOND-NOT-A-KEY')
  assert.equal(c.settings().pagewiseCompanion.perBook['fixture-book'], false)
  assert.equal(c.settings().pagewiseCompanion.channel, 'own')
  await migrateNativeState(new NativeStateClient(s.invoke), src, normalizeLegacySettings)
  assert.deepEqual(src.calls, { settings: 2, snapshot: 2 }, 'restart after completion must not read recovery stores')
})

test('changed migration settings/rows surface instead of overwriting stage or accepting defaults', async () => {
  const s = server(), src = source(Array.from({ length: 257 }, (_, n) => row(n)))
  s.failChunk(1)
  await assert.rejects(migrateNativeState(new NativeStateClient(s.invoke), src, normalizeLegacySettings))
  src.snapshotValue.rows[0].seconds++
  await assert.rejects(migrateNativeState(new NativeStateClient(s.invoke), src, normalizeLegacySettings), /migration_source_changed/)
  assert.equal(s.records.size, 0)
})

test('corrupt settings, identity, hash, log and unsupported roots fail before commit; no default replacement', async () => {
  for (const raw of ['', '{bad', 'null', '[]', '{"reader":null}', '{"libraryRoot":1}', '{"aiProfiles":{"openai":{"apiKey":42}}}', '{"typographyBooks":[]}', '{"typographyBooks":{"fixture-book":{"fontSize":"broken"}}}']) {
    const s = server()
    await assert.rejects(migrateNativeState(new NativeStateClient(s.invoke), source([], raw), normalizeLegacySettings))
    assert.equal(s.calls.some(call => call.action === 'migrationCommit'), false)
  }
  for (const corrupt of [src => { src.snapshotValue.deviceId = 3 }, src => { src.snapshotValue.hashes[0].hash = '' }, src => { src.snapshotValue.rows[0].seconds = '5' }]) {
    const s = server(), src = source(); corrupt(src)
    await assert.rejects(migrateNativeState(new NativeStateClient(s.invoke), src, normalizeLegacySettings))
    assert.equal(s.calls.some(call => call.action === 'migrationBegin'), false)
  }
  const s = server()
  await assert.rejects(migrateNativeState(new NativeStateClient(s.invoke), source([], '{"libraryRoot":"content://fixture"}'), normalizeLegacySettings), /unsupported_library_root/)
})

test('canonical failures surface without probing recovery stores', async () => {
  const src = source(), c = new NativeStateClient(async () => { throw stateError('database_error') })
  await assert.rejects(migrateNativeState(c, src, normalizeLegacySettings), /database_error/)
  assert.deepEqual(src.calls, { settings: 0, snapshot: 0 })
  assert.throws(() => c.settingsSnapshot(), /not_initialized/)
})

test('field existence/value CAS merges disjoint updates, rejects overlap and blocks library moves', async () => {
  const s = server({ complete: true }), a = readyClient(s), b = readyClient(s)
  const before = a.settings()
  await a.patchSettings(settingsDiff(before, { ...before, dailyGoalMinutes: 55 }))
  await b.patchSettings(settingsDiff(before, { ...before, ttsRate: 1.25 }))
  assert.equal(b.settings().dailyGoalMinutes, 55)
  await assert.rejects(a.patchSettings(settingsDiff(before, { ...before, dailyGoalMinutes: 99 })), /settings_conflict/)
  assert.equal(a.settings().ttsRate, 1.25, 'conflict refreshes canonical snapshot')
  await assert.rejects(a.patchSettings(settingsDiff(a.settings(), { ...a.settings(), libraryRoot: '/fixture' })), /library_move_required/)
  const deletion = settingsDiff({ x: null }, {})
  assert.deepEqual(deletion, [{ path: ['x'], before: { present: true, value: null }, after: { present: false } }])
})

test('lost ACK uses receipt current settings, no duplicate credentials receipt or double reading increment', async () => {
  const s = server({ complete: true }), c = readyClient(s)
  s.lose('settingsPatch')
  await c.patchSettings(settingsDiff(c.settings(), { ...c.settings(), dailyGoalMinutes: 42 }))
  assert.equal(c.settings().dailyGoalMinutes, 42)
  assert.equal(s.calls.filter(call => call.action === 'settingsPatch').length, 1)
  assert.equal(s.calls.filter(call => call.action === 'receipt').length, 1)
  const delta = { device: 'fixture-device', day: '2026-01-01', ref: 'id:fixture-book', title: 'Fixture', kind: 'book', seconds: 5 }
  s.lose('readingAdd')
  await c.readingStore().add([delta], 10)
  assert.equal((await c.readingStore().all())[0].seconds, 5)
  const payload = s.calls.find(call => call.action === 'readingAdd').payload
  await s.invoke('readingAdd', payload)
  assert.equal((await c.readingStore().all())[0].seconds, 5)
})

test('receipt outage retains request envelope, blocks unrelated mutation and reconciles original ID', async () => {
  const s = server({ complete: true }), c = readyClient(s)
  const delta = { device: 'fixture-device', day: '2026-01-01', ref: 'id:fixture-book', title: 'Fixture', kind: 'book', seconds: 5 }
  s.lose('readingAdd'); s.failReceipt(true)
  await assert.rejects(c.readingStore().add([delta], 10), /unavailable/)
  await assert.rejects(c.readingStore().add([{ ...delta, seconds: 6 }], 10), /native_mutation_pending/)
  s.failReceipt(false)
  await c.readingStore().add([delta], 10)
  assert.equal(s.calls.filter(call => call.action === 'readingAdd').length, 1)
  assert.equal((await c.readingStore().all())[0].seconds, 5)
})

test('NS-CLIENT-01: capped empty receipts retain delayed envelope; explicit recovery is receipt-only', async () => {
  const s = server({ complete: true }), envelopes = []
  let delayed = true
  const c = new NativeStateClient(async (action, payload, root) => {
    if (action === 'readingAdd' && delayed) {
      envelopes.push(clone(payload))
      throw stateError('unavailable')
    }
    return s.invoke(action, payload, root)
  })
  c.acceptSettings(s.snapshot())
  const delta = { device: 'fixture-device', day: '2026-01-01', ref: 'id:fixture-book', title: 'Fixture', kind: 'book', seconds: 5 }
  await assert.rejects(c.readingStore().add([delta], 10), /unavailable/)
  assert.equal(envelopes.length, 3)
  assert.equal(s.calls.filter(call => call.action === 'receipt').length, 3)
  await assert.rejects(c.readingStore().add([{ ...delta, seconds: 6 }], 11), /native_mutation_pending/)
  await assert.rejects(c.reconcilePendingMutation(), /native_mutation_unresolved/)
  await assert.rejects(c.readingStore().add([delta], 10), /native_mutation_unresolved/)
  assert.equal(envelopes.length, 3, 'cap and receipt-only recovery cannot execute a fourth request')
  assert.ok(envelopes.every(value => canonical(value) === canonical(envelopes[0])))
  // Delivery happens after all three empty receipts; none of them was a cancellation fence.
  await s.invoke('readingAdd', envelopes[0])
  await c.reconcilePendingMutation()
  assert.equal(envelopes.length, 3)
  assert.equal((await c.readingStore().all())[0].seconds, 5)
  delayed = false
  await c.readingStore().add([{ ...delta, seconds: 6 }], 11)
  const newEnvelope = s.calls.filter(call => call.action === 'readingAdd').at(-1).payload
  assert.notEqual(newEnvelope.requestId, envelopes[0].requestId)
  assert.equal((await c.readingStore().all())[0].seconds, 11)
})

test('NS-CLIENT-01: native_state_error after commit reconciles its receipt without duplicating work', async () => {
  const s = server({ complete: true })
  let lose = true
  const c = new NativeStateClient(async (action, payload, root) => {
    const result = await s.invoke(action, payload, root)
    if (['readingAdd', 'settingsPatch'].includes(action) && lose) { lose = false; throw stateError('native_state_error') }
    return result
  })
  c.acceptSettings(s.snapshot())
  const delta = { device: 'fixture-device', day: '2026-01-01', ref: 'id:fixture-book', title: 'Fixture', kind: 'book', seconds: 5 }
  await c.readingStore().add([delta], 10)
  assert.equal(s.calls.filter(call => call.action === 'receipt').length, 1)
  assert.equal(s.calls.filter(call => call.action === 'readingAdd').length, 1)
  assert.equal((await c.readingStore().all())[0].seconds, 5)
  lose = true
  await c.patchSettings(settingsDiff(c.settings(), { ...c.settings(), dailyGoalMinutes: 81 }))
  assert.equal(c.settings().dailyGoalMinutes, 81)
  assert.equal(s.calls.filter(call => call.action === 'settingsPatch').length, 1)
  assert.equal(s.calls.filter(call => call.action === 'receipt').length, 2)
})

test('explicit pending recovery and putMax resume later pages without a replacement lost-ACK UUID', async () => {
  const s = server({ complete: true }), c = readyClient(s)
  const rows = Array.from({ length: 257 }, (_, n) => row(n))
  let page = 0
  const invoke = c.invoke
  const another = new NativeStateClient(async (action, payload, root) => {
    if (action === 'readingPutMax' && ++page === 2) { s.lose(action); s.failReceipt(true) }
    return invoke(action, payload, root)
  })
  another.acceptSettings(s.snapshot())
  await assert.rejects(another.readingStore().putMax(rows), /unavailable/)
  s.failReceipt(false)
  assert.equal(await another.readingStore().putMax(rows), 0)
  assert.equal(s.records.size, 257)
  assert.equal(s.receipts.size, 4, 'two initial page UUIDs plus two safe max replays; no second lost page increment')
})

test('bounded unknown transport retry never changes UUID/createdAt; invalid pagination is not empty success', async () => {
  const envelopes = []
  const c = new NativeStateClient(async (action, payload) => {
    if (action === 'receipt') return { found: false }
    envelopes.push(clone(payload)); throw stateError('unavailable')
  })
  c.acceptSettings({ revision: 1, raw: '{}' })
  await assert.rejects(c.mutate('readingAdd', { deltas: [], now: 1 }), /unavailable/)
  assert.equal(envelopes.length, 3)
  assert.ok(envelopes.every(item => canonical(item) === canonical(envelopes[0])))
  const broken = new NativeStateClient(async () => ({ rows: [row(1)], next: '' }))
  broken.acceptSettings({ revision: 1, raw: '{}' })
  await assert.rejects(broken.readingStore().all(), /invalid_native_page/)
})

test('reading putMax batches at 256 and reports real changed count; migration never grants retired trial', async () => {
  const s = server({ complete: true }), c = readyClient(s), rows = Array.from({ length: 257 }, (_, n) => row(n))
  assert.equal(await c.readingStore().putMax(rows), 257)
  assert.equal(await c.readingStore().putMax(rows), 0)
  assert.deepEqual(s.calls.filter(call => call.action === 'readingPutMax').map(call => call.payload.rows.length), [256, 1, 256, 1])
  const migrated = normalizeLegacySettings(JSON.stringify({ version: 12, aiProvider: 'trial', aiApiKey: 'SYNTHETIC-RETIRED', dianjing: { enabled: true, consentAll: true, channel: 'auto' } }))
  assert.equal(migrated.aiProvider, 'trial'); assert.equal(migrated.aiApiKey, 'SYNTHETIC-RETIRED')
  assert.equal(migrated.pagewiseCompanion.channel, 'builtin')
})

test('distinct id:/h: rows retain exact JS sum; max merge applies only to the identical immutable key', async () => {
  const s = server({ complete: true }), c = readyClient(s), store = c.readingStore()
  const id = { ...row(0), seconds: 0.1 }
  const landedDifference = { key: 'fixture-device|2026-01-01|h:fixture-hash', device: 'fixture-device', day: '2026-01-01', hash: 'fixture-hash', title: 'Synthetic', kind: 'book', seconds: 0.2, updatedAt: 1 }
  assert.equal(await store.putMax([id, landedDifference]), 2)
  assert.equal(await store.putMax([{ ...id, seconds: 0.05 }, landedDifference]), 0)
  const rows = await store.all(), hashes = await c.identity().getHashes()
  assert.equal(rows.length, 2)
  const total = 0.1 + 0.2
  assert.equal(aggregateReadingLog(rows, hashes)['fixture-device']['2026-01-01']['fixture-hash'], total)
  const log = createReadingLog({ store, identity: c.identity(), listBooks: async () => [{ id: 'fixture-0000', title: 'Synthetic' }] })
  const day = (await log.loadDaily())['2026-01-01']
  assert.equal(day.books.length, 1)
  assert.equal(day.seconds, total)
  assert.equal(day.books[0].seconds, total)
})

test('real readonly legacy adapter counts rows and accesses only deviceId and hash/log tables', async t => {
  const opened = [], modes = [], reads = [], handles = []
  const values = { log: [row(0)], hashes: [{ id: 'fixture-book', hash: 'H' }] }
  const fakeIndexedDB = { open(name) {
    opened.push(name)
    const request = {}
    const db = { objectStoreNames: { contains: name => ['log', 'kv', 'hashes'].includes(name) }, close() { handles.push('closed') },
      transaction(_stores, mode) {
        modes.push(mode)
        const tx = { objectStore(store) { return {
          get(key) { reads.push([store, key]); assert.equal(store, 'kv'); assert.equal(key, 'deviceId'); const r = {}; queueMicrotask(() => { r.result = { key, value: 'fixture-device' }; r.onsuccess() }); return r },
          count() { assert.notEqual(store, 'kv'); reads.push([store, 'count']); const r = {}; queueMicrotask(() => { r.result = values[store].length; r.onsuccess() }); return r },
          getAll() { assert.notEqual(store, 'kv'); reads.push([store, 'all']); const r = {}; queueMicrotask(() => { r.result = values[store]; r.onsuccess() }); return r },
        } } }
        setImmediate(() => tx.oncomplete())
        return tx
      },
    }
    request.result = db
    queueMicrotask(() => request.onsuccess())
    return request
  } }
  replaceGlobal(t, 'indexedDB', fakeIndexedDB)
  replaceGlobal(t, 'localStorage', { getItem(key) { assert.equal(key, 'lightread-settings'); return initialRaw }, setItem() { assert.fail('legacy write') } })
  const legacy = legacyStateSource()
  assert.equal(legacy.settings(), initialRaw)
  const snap = await legacy.snapshot()
  assert.equal(snap.deviceId, 'fixture-device'); assert.equal(snap.rows.length, 1)
  assert.deepEqual(modes, ['readonly', 'readonly']); assert.equal(handles.length, 2)
  assert.deepEqual(opened.sort(), ['lightread-stats', 'lightread-sync'])
  assert.equal(reads.some(([store, key]) => store === 'kv' && key !== 'deviceId'), false)
})

test('bootstrap/Pinia/root/reading/identity share native snapshot, reject before init and never dual-write', async t => {
  let failSettings = false
  const s = server({ complete: true })
  let legacyAccesses = 0
  replaceGlobal(t, 'localStorage', { getItem() { legacyAccesses++; throw Error('legacy read forbidden') }, setItem() { legacyAccesses++; throw Error('legacy write forbidden') } })
  replaceGlobal(t, 'indexedDB', { open() { legacyAccesses++; throw Error('legacy open forbidden') } })
  replaceGlobal(t, 'window', { LightReadInsets: { nativeStorageVersion: () => 1 }, __TAURI_INTERNALS__: { invoke(command, args) {
    assert.equal(command, 'native_state')
    if (args.action === 'settingsPatch' && failSettings) throw stateError('database_error')
    return s.invoke(args.action, args.payload, args.libraryRoot)
  } } })
  assert.equal(hasNativeState(), true)
  assert.throws(() => getLibraryRoot(), /native_state_not_initialized/)
  assert.throws(() => { setActivePinia(createPinia()); useSettings() }, /native_state_not_initialized/)
  await initializeNativeState()
  assert.equal(getLibraryRoot(), '')
  setActivePinia(createPinia())
  const settings = useSettings(), errors = []
  const stop = settings.persistOnChange(error => errors.push(error))
  assert.equal(settings.aiProfiles.openai.apiKey, 'SYNTHETIC-SECOND-NOT-A-KEY')
  // Native page return refresh publishes its current settings without echo writes.
  s.changeSettings({ ttsRate: 1.4 })
  await settings.reloadNativeSettings()
  assert.equal(settings.ttsRate, 1.4)
  assert.equal(s.calls.some(call => call.action === 'settingsPatch'), false)
  // Native UI changes a disjoint field before the WebView's next write.
  s.changeSettings({ ttsRate: 1.5 })
  settings.dailyGoalMinutes = 44
  settings.pagewiseCompanion.perBook['fixture-book'] = true
  await settings.flushNativeSettings()
  assert.equal(settings.ttsRate, 1.5)
  assert.equal(getNativeState().settings().pagewiseCompanion.perBook['fixture-book'], true)
  assert.equal(Object.hasOwn(getNativeState().settings(), 'dianjing'), false, 'native has one canonical consent field')
  const identity = createReadingIdentity(), log = createDexieReadingLogStore()
  assert.equal(await identity.getDeviceId(), 'fixture-device')
  assert.deepEqual(await identity.getHashes(), new Map([['fixture-0000', 'fixture-hash']]))
  await log.putMax([row(0)]); assert.equal((await log.all()).length, 1)
  // Explicit durable transaction does not publish a calibration on write failure.
  failSettings = true
  const before = clone(settings.typographyBooks)
  await assert.rejects(settings.commitTypography({ scope: 'book', bookId: 'fixture-book', language: 'en', settings: { fontSize: 21 }, dim: 0 }), /database_error/)
  assert.deepEqual(settings.typographyBooks, before)
  failSettings = false
  const beforeDraftRecovery = s.calls.length
  const draftRecovery = await settings.reloadNativeSettings()
  assert.equal(draftRecovery.failedCommits.length, 1, 'failed explicit draft survives a rejected queue')
  assert.ok(draftRecovery.failedCommits[0].paths.some(path => path[0] === 'typographyBooks' && path[1] === 'fixture-book'))
  assert.deepEqual(Object.keys(draftRecovery.failedCommits[0]), ['paths'], 'recovery report does not expose retained values')
  assert.deepEqual(draftRecovery.unsavedPaths, [])
  assert.equal(s.calls.slice(beforeDraftRecovery).some(call => call.action === 'settingsGet'), true)
  assert.equal(s.calls.slice(beforeDraftRecovery).some(call => call.action === 'settingsPatch'), false)
  await assert.rejects(settings.flushNativeSettings(), /settings_recovery_required/)
  stop()
  // Direct watcher failures are visible to its handler AND awaitable, never localStorage fallback.
  setActivePinia(createPinia()); const second = useSettings(); const stopSecond = second.persistOnChange(error => errors.push(error))
  failSettings = true
  second.dailyGoalMinutes = 45
  await assert.rejects(second.flushNativeSettings(), /database_error/)
  await Promise.resolve()
  assert.equal(errors.length, 1)
  second.ttsVoice = 'synthetic-unsaved-voice'
  await assert.rejects(second.flushNativeSettings(), /database_error/)
  failSettings = false
  s.changeSettings({ dailyGoalMinutes: 55, httpProxy: 'synthetic-native-proxy' })
  const beforeDirtyRecovery = s.calls.length
  const dirtyRecovery = await second.reloadNativeSettings()
  assert.equal(second.dailyGoalMinutes, 45, 'overlapping failed dirty value must not be silently discarded')
  assert.equal(second.ttsVoice, 'synthetic-unsaved-voice', 'queued later edit must not disappear')
  assert.equal(second.httpProxy, 'synthetic-native-proxy', 'unrelated canonical edits still refresh')
  assert.deepEqual(dirtyRecovery.unsavedPaths.map(path => path.join('.')).sort(), ['dailyGoalMinutes', 'ttsVoice'])
  assert.deepEqual(dirtyRecovery.failedCommits, [])
  assert.equal(s.calls.slice(beforeDirtyRecovery).some(call => call.action === 'settingsPatch'), false, 'recovery never resubmits dirty edits under new UUIDs')
  await assert.rejects(second.flushNativeSettings(), /settings_recovery_required/)
  stopSecond()
  // Unknown commit: recovery must settle its original receipt before any settingsGet.
  setActivePinia(createPinia()); const third = useSettings(); const stopThird = third.persistOnChange(error => errors.push(error))
  s.lose('settingsPatch'); s.failReceipt(true)
  third.dailyGoalMinutes = 66
  await assert.rejects(third.flushNativeSettings(), /unavailable/)
  const beforeUnresolvedRecovery = s.calls.length
  await assert.rejects(third.reloadNativeSettings(), /unavailable/)
  assert.deepEqual(s.calls.slice(beforeUnresolvedRecovery).map(call => call.action), ['receipt'])
  s.failReceipt(false)
  const beforeSettledRecovery = s.calls.length
  const settledRecovery = await third.reloadNativeSettings()
  assert.deepEqual(settledRecovery, { unsavedPaths: [], failedCommits: [] })
  assert.deepEqual(s.calls.slice(beforeSettledRecovery).map(call => call.action), ['receipt', 'settingsGet'])
  third.dailyGoalMinutes = 67
  await third.flushNativeSettings()
  assert.equal(getNativeState().settings().dailyGoalMinutes, 67, 'settled clean recovery unpoisons subsequent writes')
  stopThird()
  assert.equal(legacyAccesses, 0)
})

test('absent legacy databases abort first-open upgrades and never create recovery copies', async t => {
  let aborts = 0
  replaceGlobal(t, 'indexedDB', { open() {
    const request = { transaction: { abort() { aborts++; queueMicrotask(() => request.onerror()) } } }
    queueMicrotask(() => request.onupgradeneeded({ oldVersion: 0 }))
    return request
  } })
  const result = await legacyStateSource().snapshot()
  assert.deepEqual(result, { rows: [], hashes: [], deviceId: null })
  assert.equal(aborts, 2)
})

test('lost migration commit ACK resumes from complete status without rereading legacy stats/settings', async () => {
  const s = server(), src = source([])
  const c = new NativeStateClient(async (...args) => {
    const result = await s.invoke(...args)
    if (args[0] === 'migrationCommit') throw stateError('commit_outcome_unknown')
    return result
  })
  await assert.rejects(migrateNativeState(c, src, normalizeLegacySettings), /commit_outcome_unknown/)
  await migrateNativeState(c, src, normalizeLegacySettings)
  assert.deepEqual(src.calls, { settings: 1, snapshot: 1 })
  assert.equal(await c.identity().getDeviceId(), 'fixture-device')
})

test('frozen protocol retains raw strings and current-settings receipts, never JavaScriptInterface settings', () => {
  const kotlin = readFileSync(new URL('../src-tauri/android/NativeStateStore.kt', import.meta.url), 'utf8')
  assert.match(kotlin, /string\(payload, "settings", MAX_JSON\)/)
  assert.match(kotlin, /string\(payload, "rows", 2 \* 1024 \* 1024\)/)
  assert.match(kotlin, /cached.has\("settingsRevision"\)\) settings\(\)/)
  assert.match(kotlin, /"migration_source_changed"/)
})
