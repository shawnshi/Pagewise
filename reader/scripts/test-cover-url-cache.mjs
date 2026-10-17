import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCoverUrlCache } from '../src/services/coverUrlCache.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(options = {}) {
  const calls = []
  const revoked = []
  const cache = createCoverUrlCache({
    load(id, signal) {
      return new Promise((resolve, reject) => calls.push({ id, signal, resolve, reject }))
    },
    revoke(url) { revoked.push(url) },
    ...options,
  })
  return { cache, calls, revoked }
}

test('deduplicates IDs, per-lease cancellation, idempotent release and no early revoke', async () => {
  const { cache, calls, revoked } = harness()
  const a = cache.acquire('a')
  const b = cache.acquire('a')
  a.release(); a.release()
  assert.equal(await a.ready, undefined)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.aborted, false)
  calls[0].resolve('blob:a')
  assert.equal(await b.ready, 'blob:a')
  cache.dispose(); cache.dispose()
  assert.deepEqual(revoked, [])
  b.release(); b.release()
  assert.deepEqual(revoked, ['blob:a'])
  assert.equal(cache.stats().references, 0)
  assert.equal(await cache.acquire('disposed').ready, undefined)
})

test('bounded queue and physical concurrency, queued cancellation never loads', async () => {
  const { cache, calls } = harness({ maxEntries: 4, maxConcurrent: 2 })
  const leases = ['a', 'b', 'c', 'd'].map(id => cache.acquire(id))
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(cache.stats().queued, 2)
  leases[2].release()
  assert.equal(await leases[2].ready, undefined)
  calls[0].resolve('blob:a')
  await tick()
  assert.deepEqual(calls.map(call => call.id), ['a', 'b', 'd'])
  assert.equal(cache.stats().loading, 2)
  calls[1].resolve(undefined)
  calls[2].resolve('blob:d')
  await Promise.all(leases.map(lease => lease.ready))
  leases.forEach(lease => lease.release())
  cache.dispose()
})

test('release-before-load skips loader; release during load revokes late URL, holds concurrency slot', async () => {
  const { cache, calls, revoked } = harness({ maxEntries: 2, maxConcurrent: 1 })
  const early = cache.acquire('early')
  early.release()
  await tick()
  assert.equal(calls.length, 0)
  const a = cache.acquire('a')
  await tick()
  a.release()
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(await a.ready, undefined)
  const b = cache.acquire('a')
  await tick()
  assert.equal(calls.length, 1)
  calls[0].resolve('blob:late')
  await tick()
  assert.deepEqual(revoked, ['blob:late'])
  assert.equal(calls.length, 2)
  calls[1].resolve('blob:new')
  assert.equal(await b.ready, 'blob:new')
  b.release(); cache.dispose()
  assert.deepEqual(revoked, ['blob:late', 'blob:new'])
})

test('LRU evicts only idle, references may share one slot, hard capacity reports rejection', async () => {
  const { cache, calls, revoked } = harness({ maxEntries: 2 })
  const a = cache.acquire('a'), b = cache.acquire('b')
  await tick()
  calls[0].resolve('blob:a'); calls[1].resolve('blob:b')
  await Promise.all([a.ready, b.ready])
  await assert.rejects(cache.acquire('overflow').ready, RangeError)
  assert.equal(cache.stats().entries, 2)
  a.release(); b.release()
  const again = cache.acquire('a')
  assert.equal(await again.ready, 'blob:a')
  again.release()
  const c = cache.acquire('c')
  assert.deepEqual(revoked, ['blob:b'])
  await tick()
  calls[2].resolve('blob:c'); await c.ready
  cache.dispose()
  assert.deepEqual(revoked, ['blob:b', 'blob:a'])
  c.release()
  assert.deepEqual(revoked, ['blob:b', 'blob:a', 'blob:c'])
})

test('dispose cancels pending/queued, aborts load, drops late URL and drains stats', async () => {
  const { cache, calls, revoked } = harness({ maxConcurrent: 1 })
  const a = cache.acquire('a'), b = cache.acquire('b')
  await tick()
  cache.dispose()
  assert.equal(calls[0].signal.aborted, true)
  assert.deepEqual(await Promise.all([a.ready, b.ready]), [undefined, undefined])
  calls[0].resolve('blob:late')
  await tick()
  assert.equal(calls.length, 1)
  assert.deepEqual(revoked, ['blob:late'])
  assert.deepEqual(cache.stats(), { entries: 0, queued: 0, loading: 0, references: 0, urls: 0, disposed: true })
  a.release(); b.release()
})

test('load rejection is shared, never no-cover, no automatic retries; sync throw also rejects', async () => {
  const { cache, calls } = harness()
  const a = cache.acquire('a'), b = cache.acquire('a')
  const failure = new Error('read failed')
  const checks = [a, b].map(lease => assert.rejects(lease.ready, error => error === failure))
  await tick(); calls[0].reject(failure)
  await Promise.all(checks); await tick()
  assert.equal(calls.length, 1)
  assert.equal(cache.stats().entries, 0)
  a.release(); b.release(); cache.dispose()
  const sync = harness({ load() { throw failure } })
  await assert.rejects(sync.cache.acquire('a').ready, error => error === failure)
  await tick(); sync.cache.dispose()
})

test('late load rejection after cancellation is consumed and lets the queue continue', async () => {
  const { cache, calls } = harness({ maxConcurrent: 1 })
  const a = cache.acquire('a')
  await tick()
  a.release()
  const b = cache.acquire('b')
  calls[0].reject(new Error('aborted I/O'))
  assert.equal(await a.ready, undefined)
  await tick()
  assert.deepEqual(calls.map(call => call.id), ['a', 'b'])
  cache.dispose()
  calls[1].reject(new Error('disposed I/O'))
  assert.equal(await b.ready, undefined)
  await tick()
  assert.equal(cache.stats().loading, 0)
})

test('no-cover is cached separately from failure and consumes a bounded entry', async () => {
  const { cache, calls, revoked } = harness({ maxEntries: 1 })
  const a = cache.acquire('a')
  await tick(); calls[0].resolve(undefined)
  assert.equal(await a.ready, undefined)
  a.release()
  const b = cache.acquire('a')
  assert.equal(await b.ready, undefined)
  assert.equal(calls.length, 1)
  b.release(); cache.dispose()
  assert.deepEqual(revoked, [])
})

test('limits reject invalid values', () => {
  for (const value of [0, -1, NaN, Infinity, 1.1]) {
    for (const key of ['maxEntries', 'maxConcurrent']) assert.throws(() => harness({ [key]: value }), RangeError)
  }
})

test('4000 sequential synthetic covers stay bounded and revoke every owned URL once', async () => {
  const revoked = new Set()
  const cache = createCoverUrlCache({ load: async id => `blob:${id}`, revoke: url => {
    assert.equal(revoked.has(url), false); revoked.add(url)
  } })
  for (let i = 0; i < 4000; i++) {
    const lease = cache.acquire(String(i))
    assert.equal(await lease.ready, `blob:${i}`)
    lease.release()
    assert.ok(cache.stats().entries <= 32)
    assert.ok(cache.stats().loading <= 2)
  }
  cache.dispose(); await tick()
  assert.equal(revoked.size, 4000)
  assert.equal(cache.stats().entries, 0)
})
