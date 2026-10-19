import assert from 'node:assert/strict'
import test from 'node:test'
import { PdfRasterClient } from '../src/services/pdfRasterClient.ts'
import { PdfByteLru } from '../src/services/pdfResources.ts'

class FakeWorker {
  messages = []; terminated = 0
  postMessage(message) { this.messages.push(message) }
  terminate() { this.terminated++ }
  reply(message) { this.onmessage({ data: { ...this.messages.at(-1), ...message } }) }
}
const make = (deadline = 1000) => {
  const worker = new FakeWorker()
  const client = new PdfRasterClient(new Blob(['synthetic']), () => worker, deadline)
  return { worker, client }
}
const request = { page: 0, width: 10, height: 10, renderer: 'mupdf' }
const bitmap = () => ({ closed: 0, close() { this.closed++ } })

test('one serial raster owner, visible work overtakes queued thumbnails', async () => {
  const { worker, client } = make()
  try {
    const first = client.render(request, 0, 2).then(result => result.bitmap.close())
    const thumb = client.render(request, 0, 2).then(result => result.bitmap.close())
    const visible = client.render(request, 0).then(result => {
      assert.equal(worker.messages.at(-1).id, 3, 'next raster waits until consumer closes transferred output')
      result.bitmap.close()
    })
    assert.equal(worker.messages.length, 1)
    worker.reply({ ok: true })
    assert.equal(worker.messages.at(-1).id, 3)
    worker.reply({ bitmap: bitmap(), renderer: 'mupdf' }); await visible
    assert.equal(worker.messages.at(-1).id, 1)
    worker.reply({ bitmap: bitmap() }); await first
    worker.reply({ bitmap: bitmap() }); await thumb
  } finally { client.close() }
})

test('revision cancels obsolete queued work and closes stale active bitmap', async () => {
  const { worker, client } = make()
  const first = client.render(request, 0)
  worker.reply({ ok: true })
  const queued = client.render(request, 0)
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  client.setRevision(1)
  await rejected
  const stale = bitmap()
  worker.reply({ bitmap: stale })
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(stale.closed, 1)
  client.close()
})

test('close during open/render rejects work, terminates owner, late bitmap is closed', async () => {
  for (const ready of [false, true]) {
    const { worker, client } = make()
    const work = client.render(request, 0)
    if (ready) worker.reply({ ok: true })
    client.close()
    await assert.rejects(work, /closed/)
    const stale = bitmap(); worker.reply({ bitmap: stale })
    assert.equal(stale.closed, 1)
    assert.equal(worker.terminated, 1)
    await assert.rejects(client.render(request, 0), /closed/)
  }
})

test('worker/CSP/unavailable/messageerror fail explicitly, never run UI raster fallback', async () => {
  for (const mode of ['unavailable', 'error', 'messageerror']) {
    const worker = new FakeWorker()
    const client = new PdfRasterClient(new Blob(), () => { if (mode === 'unavailable') throw new Error('CSP blocked'); return worker })
    const work = client.render(request, 0)
    if (mode === 'error') worker.onerror({ message: 'crash', preventDefault() {} })
    if (mode === 'messageerror') worker.onmessageerror()
    await assert.rejects(work, /Worker unavailable|worker error|decoding/)
    await assert.rejects(client.render(request, 0))
    client.close()
  }
})

test('genuine deadlines terminate and allow only one reopen, without replay', async () => {
  const { worker, client } = make(5)
  await assert.rejects(client.render(request, 0), /deadline/)
  await assert.rejects(client.render(request, 0), /deadline/)
  await assert.rejects(client.render(request, 0), /deadline/)
  assert.equal(worker.messages.length, 2)
  assert.equal(worker.terminated, 2)
  client.close()
})

test('pending raster admission is bounded under a navigation storm', async () => {
  const { client, worker } = make()
  const jobs = Array.from({ length: 100 }, () => client.render(request, 0, 2).then(() => 'ok', e => e.name))
  assert.ok(client.queue.length <= 8)
  client.close()
  const results = await Promise.all(jobs)
  assert.equal(results.filter(x => x === 'AbortError').length, 92)
  assert.equal(worker.messages.length, 1)
})

test('visible pages cannot be evicted by prefetch pressure; admission fails instead', () => {
  const cache = new PdfByteLru(100)
  cache.pin(1); cache.set(1, 'current', 60)
  assert.equal(cache.set(3, 'prefetch', 50), false)
  cache.pin(2); assert.equal(cache.set(2, 'facing', 40), true)
  assert.equal(cache.set(3, 'prefetch', 40), false)
  assert.equal(cache.get(1), 'current'); assert.equal(cache.get(2), 'facing')
  assert.equal(cache.bytes, 100)
  cache.unpinAll(); assert.equal(cache.set(3, 'next view', 100), true)
  cache.clear(); assert.equal(cache.bytes, 0)
})

test('byte LRU evicts least recently used resources, rejects oversized entries and releases all', () => {
  const disposed = [], cache = new PdfByteLru(100, value => disposed.push(value))
  cache.set(1, 'a', 40); cache.set(2, 'b', 40); cache.get(1)
  cache.set(3, 'c', 40)
  assert.equal(cache.get(2), undefined); assert.deepEqual(disposed, ['b'])
  assert.equal(cache.set(4, 'oversized', 101), false)
  assert.equal(cache.bytes, 80)
  cache.clear(); assert.equal(cache.bytes, 0)
  assert.deepEqual(disposed, ['b', 'a', 'c'])
})
