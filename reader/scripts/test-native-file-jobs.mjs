import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createNativeFileJobClient } from '../src/services/nativeFileJobs.ts'

function journal() {
  const entries = new Map()
  return { getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k), entries }
}
const input = { folderId: 'saf-fixture', documentId: 'synthetic.pdf' }
function snapshot(payload, state = 'succeeded', patch = {}) {
  return { ...payload, documentId: payload.documentId ?? '', state, code: '', result: { path: 'cache/pagewise-read/fixture.bin' }, ...patch }
}

test('service receipt is consumed before ACK; a re-created client reconnects after a lost start response', async () => {
  const storage = journal(), ids = [], calls = []
  let lost = true, request
  const call = async (action, payload) => {
    calls.push(action)
    if (action === 'start') {
      ids.push(payload.id); request = payload
      assert.ok([...storage.entries.values()][0].includes(payload.id), 'journal must precede native admission')
      if (lost) { lost = false; throw Object.assign(new Error('lost ACK'), { code: 'unavailable' }) }
      return snapshot(payload, 'running')
    }
    if (action === 'status') return snapshot(request)
    if (action === 'ack') { assert.ok(calls.includes('consume')); return {} }
    throw new Error(action)
  }
  await assert.rejects(createNativeFileJobClient(call, storage).run('read', input, async () => {}), { code: 'unavailable' })
  const value = await createNativeFileJobClient(call, storage, async () => {}).run('read', input, async result => { calls.push('consume'); return result.path })
  assert.equal(value, 'cache/pagewise-read/fixture.bin')
  assert.equal(ids[0], ids[1], 'no new native request identity after page rebuild')
  assert.deepEqual(calls, ['start', 'start', 'status', 'consume', 'ack'])
  assert.equal(storage.entries.size, 0)
})

test('renamed inspect retires an ambiguous old envelope without losing its physical release identity', async () => {
  const storage = journal(), starts = [], cancelled = []
  let lost = true, held = true
  const call = async (action, payload) => {
    if (action === 'start') {
      starts.push(payload)
      if (lost) { lost = false; throw { code: 'unavailable' } }
      assert.equal(payload.request.fileName, 'new.epub')
      return snapshot(payload, 'succeeded', { result: { format: 'epub' } })
    }
    if (action === 'status') return snapshot(starts[0], 'running')
    if (action === 'cancel') { cancelled.push(payload.id); return { id: payload.id, state: 'cancelled' } }
    if (action === 'ack') { if (held) { held = false; throw { code: 'busy' } } return {} }
    assert.fail(action)
  }
  await assert.rejects(createNativeFileJobClient(call, storage).run('inspect', { ...input, request: { fileName: 'old.epub' } }, async x => x), { code: 'unavailable' })
  await assert.rejects(createNativeFileJobClient(call, storage).run('inspect', { ...input, request: { fileName: 'new.epub' } }, async x => x), { code: 'busy' })
  assert.ok(storage.getItem('pagewise-native-file-releases-v1').includes(starts[0].id))
  const result = await createNativeFileJobClient(call, storage).run('inspect', { ...input, request: { fileName: 'new.epub' } }, async x => x)
  assert.equal(result.format, 'epub')
  assert.deepEqual(cancelled, [starts[0].id])
  assert.notEqual(starts[0].id, starts[1].id)
  assert.equal(storage.entries.size, 0)
})

test('renamed inspect can retire an already-expired legacy envelope without losing future requests', async () => {
  const storage = journal(), oldId = crypto.randomUUID()
  storage.setItem('pagewise-native-file-jobs-v1', JSON.stringify({ [JSON.stringify(['inspect', input.folderId, input.documentId])]: oldId }))
  const result = await createNativeFileJobClient(async (action, payload) => {
    if (action === 'status') { assert.equal(payload.id, oldId); throw { code: 'not_found' } }
    if (action === 'start') { assert.notEqual(payload.id, oldId); return snapshot(payload, 'succeeded', { result: { format: 'epub' } }) }
    return {}
  }, storage).run('inspect', { ...input, request: { fileName: 'new.epub' } }, async value => value)
  assert.equal(result.format, 'epub')
  assert.equal(storage.entries.size, 0)
})

test('corrupt inspect journal cannot cancel a job owned by another kind or document', async () => {
  const storage = journal(), oldId = crypto.randomUUID()
  storage.setItem('pagewise-native-file-jobs-v1', JSON.stringify({ [JSON.stringify(['inspect', input.folderId, input.documentId])]: oldId }))
  const client = createNativeFileJobClient(async (action, payload) => {
    if (action === 'status') return snapshot({ ...payload, kind: 'import', folderId: 'app-import', documentId: 'another-batch' }, 'running')
    assert.fail('mismatched identity cannot authorize cancel, ACK or new admission')
  }, storage)
  await assert.rejects(client.run('inspect', { ...input, request: { fileName: 'new.epub' } }, async value => value), { code: 'invalid_receipt' })
  assert.ok(storage.getItem('pagewise-native-file-jobs-v1').includes(oldId))
})

test('sixteen explicit admission rejections cannot exhaust the journal or block a later scan', async () => {
  const storage = journal()
  let busy = true
  const client = createNativeFileJobClient(async (action, payload) => {
    if (action === 'start' && busy) throw { code: 'busy' }
    return action === 'start' ? snapshot(payload) : {}
  }, storage)
  for (let i = 0; i < 16; i++) {
    await assert.rejects(client.run('read', { ...input, documentId: `synthetic-${i}.pdf` }, async () => assert.fail('not admitted')), { code: 'busy' })
    assert.equal(storage.entries.size, 0)
  }
  busy = false
  assert.equal(await client.run('list', { folderId: input.folderId }, async () => 'listed'), 'listed')
  assert.equal(await client.run('read', input, async () => 'read'), 'read')
  assert.equal(storage.entries.size, 0)
})

test('a busy reconnect does not erase an earlier unknown admission identity', async () => {
  const storage = journal(), ids = []
  let attempt = 0
  const call = async (action, payload) => {
    if (action !== 'start') return {}
    ids.push(payload.id)
    if (attempt++ === 0) throw { code: 'unavailable' }
    if (attempt === 2) throw { code: 'busy' }
    return snapshot(payload)
  }
  await assert.rejects(createNativeFileJobClient(call, storage).run('read', input, async () => 0), { code: 'unavailable' })
  await assert.rejects(createNativeFileJobClient(call, storage).run('read', input, async () => 0), { code: 'busy' })
  assert.equal(storage.entries.size, 1)
  assert.equal(await createNativeFileJobClient(call, storage).run('read', input, async () => 1), 1)
  assert.equal(new Set(ids).size, 1)
})

test('dependency and native terminal errors never become empty files or a complete empty listing', async () => {
  for (const code of ['permission_denied', 'timeout', 'interrupted', 'background_start_denied', 'receipt_error']) {
    const calls = [], storage = journal()
    await assert.rejects(createNativeFileJobClient(async (action, payload) => {
      calls.push(action)
      return action === 'start' ? snapshot(payload, 'failed', { code }) : {}
    }, storage).run('read', input, async () => assert.fail('consumer cannot run on failure')), { code })
    assert.deepEqual(calls, ['start', 'ack'])
    assert.equal(storage.entries.size, 0)
  }
})

test('invalid response identity preserves reconnect journal and cannot consume another document', async () => {
  const storage = journal(), calls = []
  await assert.rejects(createNativeFileJobClient(async (action, payload) => {
    calls.push(action); return snapshot(payload, 'succeeded', { documentId: 'another.pdf' })
  }, storage).run('read', input, async () => assert.fail('invalid receipt')), { code: 'invalid_receipt' })
  assert.deepEqual(calls, ['start'])
  assert.equal(storage.entries.size, 1)
})

test('cancellation is sent to native, does not claim completion or discard active receipts', async () => {
  const calls = [], storage = journal(), controller = new AbortController()
  let request
  const client = createNativeFileJobClient(async (action, payload) => {
    calls.push(action)
    if (action === 'start') request = payload
    return action === 'cancel' ? {} : snapshot(request, 'running')
  }, storage, async () => { controller.abort() })
  await assert.rejects(client.run('read', input, async () => assert.fail('cancelled'), controller.signal), { code: 'cancelled' })
  assert.deepEqual(calls, ['start', 'status', 'cancel'])
  assert.equal(storage.entries.size, 1, 'cancellation is not proof native IO has settled')
})

test('same-document consumers cannot share a temp-file receipt; cleanup failure cannot replay consumed bytes', async () => {
  const storage = journal(), calls = [], ids = []
  let unblock, lost = true
  const gate = new Promise(resolve => { unblock = resolve })
  const client = createNativeFileJobClient(async (action, payload) => {
    calls.push(action)
    if (action === 'ack' && lost) { lost = false; throw Object.assign(new Error('cleanup ACK lost'), { code: 'unavailable' }) }
    if (action === 'start') ids.push(payload.id)
    return snapshot(payload)
  }, storage)
  const first = client.run('read', input, async () => { await gate; return 42 })
  await assert.rejects(client.run('read', input, async () => 0), { code: 'busy' })
  unblock(); assert.equal(await first, 42)
  assert.equal(storage.entries.size, 1, 'lost cleanup ACK retains an independent release journal, not a live-job pointer')
  assert.ok(storage.entries.has('pagewise-native-file-releases-v1'))
  const rebuilt = createNativeFileJobClient(async (action, payload) => {
    calls.push(action)
    if (action === 'start') ids.push(payload.id)
    return snapshot(payload)
  }, storage)
  assert.equal(await rebuilt.run('read', input, async () => 43), 43)
  assert.notEqual(ids[0], ids[1], 'reconnect releases the previous receipt rather than replaying consumed bytes')
  assert.equal(storage.entries.size, 0)
  assert.deepEqual(calls, ['start', 'ack', 'ack', 'start', 'ack'])
})

test('new shell wiring uses a non-exported dataSync service and does not fall back after native job errors', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
  assert.match(read('../src/services/monitoredFolder.ts'), /withNativeFileJob\('list'/)
  assert.match(read('../src/services/monitoredFolder.ts'), /withNativeFileJob\('read'/)
  const service = read('../src-tauri/android/NativeFileJobs.kt')
  assert.doesNotMatch(service, /import android\.webkit|evaluateJavascript|addJavascriptInterface/)
  assert.match(service, /START_NOT_STICKY/)
  assert.match(service, /onTimeout\(/)
  assert.match(service, /"interrupted"/)
  const prepare = read('./prepare-android-project.mjs')
  assert.match(prepare, /FOREGROUND_SERVICE_DATA_SYNC/)
  assert.match(prepare, /NativeFileJobService" android:foregroundServiceType="dataSync" android:exported="false"/)
})
