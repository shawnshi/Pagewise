import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

const sourcePath = new URL('../src/services/folderLibrary.ts', import.meta.url)
const stubs = {
  './monitoredFolder': 'export const MONITORED_FOLDER_LIMITS={files:5000,readBytes:64*1024*1024}; export const getMonitoredFolder=()=>{},selectMonitoredFolder=()=>{},listMonitoredFiles=()=>{},readMonitoredFile=()=>{},subscribeMonitoredFolderChanges=()=>{};',
  '../storage': 'export const getStorage=()=>{throw new Error("Injected storage required")};',
  './importer': 'export const prepareBookImport=()=>{throw new Error("Injected parser required")};',
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourcePath.href) {
      if (Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
      if (specifier === './format') return next(new URL('../src/services/format.ts', import.meta.url).href, context)
    }
    return next(specifier, context)
  },
})
let createFolderLibrary
try { ({ createFolderLibrary } = await import(sourcePath.href)) }
finally { hooks.deregister() }
const settle = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t) {
  let now = 1_000_000, poll, hint, permission = 'granted', readFailure
  let folderId = 'synthetic-tree'
  const descriptor = { documentId: 'doc-1', name: 'synthetic.epub', relativePath: 'synthetic.epub', size: null, modifiedAt: null }
  const counts = { read: 0, parse: 0, list: 0 }
  let files = [descriptor], complete = true
  const records = new Map()
  const old = { now: Date.now, interval: globalThis.setInterval, clear: globalThis.clearInterval }
  Date.now = () => now
  globalThis.setInterval = callback => { poll = callback; return 1 }
  globalThis.clearInterval = () => { poll = undefined }
  const deps = {
    getMonitoredFolder: async () => ({ id: folderId, label: 'Synthetic', permission }),
    selectMonitoredFolder: async () => ({ id: folderId, label: 'Synthetic', permission }),
    listMonitoredFiles: async () => { counts.list++; return { files: files.map(file => ({ ...file })), complete, errors: [] } },
    readMonitoredFile: async () => { counts.read++; if (readFailure) throw readFailure; return new Uint8Array([1, 2, 3]) },
    subscribeMonitoredFolderChanges: callback => { hint = callback; return () => { hint = undefined } },
    prepareBookImport: async () => { counts.parse++; return { meta: { title: 'Synthetic', fileName: descriptor.name, format: 'epub' } } },
    getStorage: async () => ({
      listBooks: async () => structuredClone([...records.values()]),
      addReferencedBook: async meta => { const id = `book-${records.size}`; records.set(id, { ...meta, id }); return id },
      updateBook: async (id, patch) => { Object.assign(records.get(id), structuredClone(patch)) },
    }),
  }
  const manager = createFolderLibrary(deps)
  let stop = manager.start()
  t.after(() => { stop(); Date.now = old.now; globalThis.setInterval = old.interval; globalThis.clearInterval = old.clear })
  await settle()
  return { manager, counts, records, descriptor,
    poll: async (elapsed = 60_000) => { now += elapsed; poll(); await settle() },
    hint: async () => { hint(); await settle() },
    permission: value => { permission = value },
    failure: value => { readFailure = value },
    folder: value => { folderId = value },
    listing: (value, isComplete = true) => { files = value; complete = isComplete },
    restart: async () => { stop(); stop = manager.start(); await settle() },
  }
}

test('routine polls reuse successful unknown-metadata reads for at most five minutes', async t => {
  const f = await fixture(t)
  assert.equal(f.counts.read, 1)
  for (let i = 0; i < 4; i++) await f.poll()
  assert.equal(f.counts.list, 5, 'enumeration continues while source parsing is deferred')
  assert.equal(f.counts.read, 1, 'unchanged unknown-metadata source must not be read every minute')
  assert.equal(f.counts.parse, 1)
  await f.poll()
  assert.equal(f.counts.read, 2, 'automatic content recheck is not deferred past five minutes')
})

test('explicit refresh and provider hints bypass automatic recheck cache', async t => {
  const f = await fixture(t)
  await f.manager.rescan()
  assert.equal(f.counts.read, 2)
  await f.hint()
  assert.equal(f.counts.read, 3)
})

test('changed metadata or filename bypass cache and reader deferral preserves pending work', async t => {
  const f = await fixture(t)
  f.descriptor.modifiedAt = 42
  await f.poll()
  assert.equal(f.counts.read, 2)
  f.descriptor.name = 'renamed.epub'
  f.descriptor.relativePath = 'renamed.epub'
  await f.poll()
  assert.equal(f.counts.read, 3)
  f.manager.setReadingActive(true)
  await f.hint()
  assert.equal(f.counts.read, 3)
  f.manager.setReadingActive(false)
  await settle()
  assert.equal(f.counts.read, 4)
})

test('permission loss remains observable and recovery retries unavailable records', async t => {
  const f = await fixture(t)
  f.permission('lost')
  await f.poll()
  assert.equal(f.manager.status.value.state, 'permission-denied')
  assert.equal([...f.records.values()][0].fileAvailability, 'permission-denied')
  f.permission('granted')
  await f.poll()
  assert.equal(f.counts.read, 2)
  assert.equal([...f.records.values()][0].fileAvailability, 'available')
})

test('unknown-metadata success cache stays bounded across changing partial listings', async t => {
  const f = await fixture(t)
  f.listing(Array.from({ length: 5000 }, (_, i) => ({ ...f.descriptor, documentId: `other-${i}` })), false)
  await f.manager.rescan()
  assert.equal(f.counts.read, 5001)
  assert.equal(f.manager.status.value.state, 'partial')
  assert.equal(f.records.get('book-0').fileAvailability, 'available', 'incomplete listing cannot mark the original missing')
  f.listing([f.descriptor])
  await f.poll()
  assert.equal(f.counts.read, 5002, 'oldest cached source is evicted once the 5000-record bound is reached')
})

test('failed rechecks do not refresh success cache and restart clears session cache', async t => {
  const f = await fixture(t)
  f.failure(new Error('synthetic provider failure'))
  await f.poll(300_000)
  assert.equal(f.manager.status.value.state, 'partial')
  await f.poll()
  assert.equal(f.counts.read, 3, 'failed reads must not acquire a fresh cache lifetime')
  f.failure(undefined)
  await f.poll()
  assert.equal(f.counts.read, 4)
  await f.restart()
  assert.equal(f.counts.read, 5)
})
