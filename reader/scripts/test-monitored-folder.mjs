import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createMonitoredFolderService, getMonitoredFolder, selectMonitoredFolder, listMonitoredFiles, readMonitoredFile, subscribeMonitoredFolderChanges, monitoredFolderCapabilities, decodeBase64Bytes } from '../src/services/monitoredFolder.ts'

const folder = { id: 'saf-test', label: 'Synthetic books', permission: 'granted' }
const book = { documentId: 'provider:stable-1', name: 'quoted "书".epub', relativePath: 'nested/quoted "书".epub', size: null, modifiedAt: null }
const fail = code => Object.assign(new Error(code), { code })
const tick = () => new Promise(resolve => setTimeout(resolve, 300))
function fixture(state = { selected: null, revoked: false }) {
  const calls = { get: 0, list: 0, read: 0, watch: 0, stop: 0 }
  let event
  let selection = folder
  let listing = { files: [book], complete: true, errors: [] }
  let readFailure
  const transport = {
    async get() { calls.get++; return state.selected ? { ...state.selected, permission: state.revoked ? 'lost' : 'granted' } : null },
    async select() { if (selection) { state.selected = selection; state.revoked = false }; return selection },
    async list(id) {
      calls.list++
      if (id !== state.selected?.id) throw fail('invalid_reference')
      if (state.revoked) throw fail('permission_denied')
      if (listing instanceof Error) throw listing
      return listing
    },
    async read(id, documentId) {
      calls.read++
      if (id !== state.selected?.id || documentId !== book.documentId) throw fail('invalid_reference')
      if (state.revoked) throw fail('permission_denied')
      if (readFailure) throw fail(readFailure)
      return new Uint8Array([80, 75, 3, 4])
    },
    async watch(listener) { calls.watch++; event = listener; return () => { calls.stop++; event = undefined } },
  }
  return {
    service: createMonitoredFolderService(transport), transport, state, calls,
    cancel: () => { selection = null }, setListing: value => { listing = value },
    failRead: code => { readFailure = code }, event: () => event?.(),
  }
}

test('first use does not list or read; cancel leaves descriptor and subscriptions unchanged', async () => {
  const f = fixture()
  assert.equal(await f.service.getMonitoredFolder(), null)
  assert.deepEqual(f.calls, { get: 1, list: 0, read: 0, watch: 0, stop: 0 })
  await f.service.selectMonitoredFolder()
  let notifications = 0
  const stop = f.service.subscribeMonitoredFolderChanges(() => notifications++)
  f.cancel()
  assert.equal(await f.service.selectMonitoredFolder(), null)
  assert.deepEqual(await f.service.getMonitoredFolder(), folder)
  await tick()
  assert.equal(notifications, 0)
  stop()
})

test('persisted descriptors restore through a new service; revocation is lost, never cleared/empty', async () => {
  const first = fixture()
  await first.service.selectMonitoredFolder()
  const restarted = fixture(first.state)
  assert.deepEqual(await restarted.service.getMonitoredFolder(), folder)
  restarted.state.revoked = true
  assert.equal((await restarted.service.getMonitoredFolder()).permission, 'lost')
  await assert.rejects(restarted.service.listMonitoredFiles(folder.id), { code: 'permission_denied' })
  await assert.rejects(restarted.service.readMonitoredFile(folder.id, book.documentId), { code: 'permission_denied' })
  assert.equal(restarted.state.selected.id, folder.id)
  await restarted.service.selectMonitoredFolder()
  assert.equal((await restarted.service.getMonitoredFolder()).permission, 'granted')
})

test('nested metadata keeps unknown sizes and provider identity; unsupported files excluded', async () => {
  const f = fixture()
  await f.service.selectMonitoredFolder()
  f.setListing({ files: [book, { ...book, documentId: 'unsupported', name: 'cover.jpg', relativePath: 'cover.jpg' }], complete: true, errors: [] })
  assert.deepEqual(await f.service.listMonitoredFiles(folder.id), { files: [book], complete: true, errors: [] })
  const renamed = { ...book, name: 'renamed.PDF', relativePath: 'other/renamed.PDF', modifiedAt: 7 }
  f.setListing({ files: [renamed], complete: true, errors: [] })
  assert.equal((await f.service.listMonitoredFiles(folder.id)).files[0].documentId, book.documentId)
  assert.deepEqual(await f.service.readMonitoredFile(folder.id, book.documentId), new Uint8Array([80, 75, 3, 4]))
})

test('unauthorized tree/document references fail without substituting empty bytes', async () => {
  const f = fixture()
  await f.service.selectMonitoredFolder()
  for (const id of ['content://private/tree/other', '', '../outside']) await assert.rejects(f.service.listMonitoredFiles(id), { code: 'invalid_reference' })
  assert.equal(f.calls.list, 0, 'malformed folder IDs never reach native transport')
  await assert.rejects(f.service.listMonitoredFiles('other-tree'), { code: 'invalid_reference' })
  await assert.rejects(f.service.readMonitoredFile(folder.id, 'other:document'), { code: 'invalid_reference' })
  await assert.rejects(f.service.readMonitoredFile(folder.id, 'nul\0document'), { code: 'invalid_reference' })
  for (const code of ['not_found', 'unavailable', 'io_error', 'resource_limit']) {
    f.failRead(code)
    await assert.rejects(f.service.readMonitoredFile(folder.id, book.documentId), { code: code === 'resource_limit' ? 'unavailable' : code })
  }
  f.failRead('unknown_provider_error')
  await assert.rejects(f.service.readMonitoredFile(folder.id, book.documentId), { code: 'io_error' })
})

test('partial, provider-loading, empty and dependency errors remain distinct', async () => {
  const f = fixture()
  await f.service.selectMonitoredFolder()
  f.setListing({ files: [book], complete: false, errors: [{ code: 'provider_loading', message: 'private name is not propagated' }] })
  assert.deepEqual(await f.service.listMonitoredFiles(folder.id), { files: [book], complete: false, errors: [{ code: 'provider_loading' }] })
  f.setListing({ files: [], complete: true, errors: [{ code: 'io_error' }] })
  assert.equal((await f.service.listMonitoredFiles(folder.id)).complete, false)
  f.setListing({ files: [], complete: false, errors: [] })
  assert.equal((await f.service.listMonitoredFiles(folder.id)).errors[0].code, 'incomplete')
  f.setListing({ files: [], complete: true, errors: [] })
  assert.deepEqual(await f.service.listMonitoredFiles(folder.id), { files: [], complete: true, errors: [] })
  f.setListing(new Error('provider died'))
  await assert.rejects(f.service.listMonitoredFiles(folder.id), { code: 'io_error' })
})

test('malformed/oversized/duplicate listings never become a complete empty library', async () => {
  const f = fixture()
  await f.service.selectMonitoredFolder()
  for (const files of [
    [book, book], Array(5001).fill(book), [{ ...book, relativePath: '../escape.epub' }],
    [{ ...book, size: -1 }], [{ ...book, modifiedAt: 'unknown' }],
    [{ ...book, name: 'a/b.epub' }], [{ ...book, relativePath: '/nested/book.epub' }],
  ]) {
    f.setListing({ files, complete: true, errors: [] })
    await assert.rejects(f.service.listMonitoredFiles(folder.id), { code: 'io_error' })
  }
})

test('concurrent selection returns busy; failed selection releases ownership', async () => {
  let resolve
  const f = fixture()
  const service = createMonitoredFolderService({ ...f.transport, select: () => new Promise(r => { resolve = r }) })
  const pending = service.selectMonitoredFolder()
  await assert.rejects(service.selectMonitoredFolder(), { code: 'busy' })
  resolve(null)
  assert.equal(await pending, null)
  const next = service.selectMonitoredFolder()
  resolve(folder)
  assert.deepEqual(await next, folder)
  const failure = createMonitoredFolderService({ ...f.transport, select: async () => { throw fail('unavailable') } })
  await assert.rejects(failure.selectMonitoredFolder(), { code: 'unavailable' })
  await assert.rejects(failure.selectMonitoredFolder(), { code: 'unavailable' })
})

test('notifications coalesce; one shared watcher; disposal suppresses pending callbacks', async () => {
  const f = fixture()
  let count = 0
  const callback = () => count++
  const one = f.service.subscribeMonitoredFolderChanges(callback)
  const two = f.service.subscribeMonitoredFolderChanges(callback)
  await Promise.resolve()
  for (let i = 0; i < 10000; i++) f.event()
  await tick()
  assert.equal(count, 2)
  assert.equal(f.calls.watch, 1)
  one(); one()
  f.event()
  two()
  await tick()
  assert.equal(count, 2)
  assert.equal(f.calls.stop, 1)
})

test('late watcher registration is disposed and subscription count bounded', async () => {
  const f = fixture()
  let resolve
  let stopped = 0
  const service = createMonitoredFolderService({ ...f.transport, watch: () => new Promise(r => { resolve = r }) })
  const stop = service.subscribeMonitoredFolderChanges(() => {})
  stop()
  resolve(() => stopped++)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(stopped, 1)
  const stops = Array.from({ length: 32 }, () => f.service.subscribeMonitoredFolderChanges(() => {}))
  assert.throws(() => f.service.subscribeMonitoredFolderChanges(() => {}), { code: 'busy' })
  stops.forEach(stop => stop())
  await Promise.resolve()
})

test('rapid stop/start reuses an in-flight watcher instead of a stale teardown disabling it', async () => {
  const f = fixture()
  let resolve
  let watched = 0
  let stopped = 0
  const service = createMonitoredFolderService({ ...f.transport, watch: () => {
    watched++
    return new Promise(r => { resolve = r })
  } })
  const first = service.subscribeMonitoredFolderChanges(() => {})
  first()
  const second = service.subscribeMonitoredFolderChanges(() => {})
  resolve(() => stopped++)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(watched, 1)
  assert.equal(stopped, 0)
  second()
  assert.equal(stopped, 1)
})

test('real Tauri adapter uses only narrow commands, decodes bytes and cleans native/event subscriptions', async () => {
  const calls = []
  const win = new EventTarget()
  const doc = new EventTarget()
  doc.visibilityState = 'visible'
  let denied = false
  win.__TAURI_INTERNALS__ = { async invoke(command, args) {
    calls.push({ command, args })
    if (command === 'get_monitored_folder') return folder
    if (command === 'read_monitored_file') {
      if (denied) throw { code: 'permission_denied' }
      return { data: 'UEsDBA==' }
    }
    if (command === 'watch_monitored_folder') return null
    throw new Error('unexpected native command')
  } }
  globalThis.window = win
  globalThis.document = doc
  let stop
  try {
    assert.equal(monitoredFolderCapabilities().persistence, 'android-saf')
    assert.deepEqual(await getMonitoredFolder(), folder)
    assert.deepEqual(await readMonitoredFile(folder.id, book.documentId), new Uint8Array([80, 75, 3, 4]))
    assert.deepEqual(calls.at(-1), { command: 'read_monitored_file', args: { folderId: folder.id, documentId: book.documentId } })
    denied = true
    await assert.rejects(readMonitoredFile(folder.id, book.documentId), { code: 'permission_denied' })
    let count = 0
    stop = subscribeMonitoredFolderChanges(() => count++)
    await new Promise(resolve => setImmediate(resolve))
    win.dispatchEvent(new Event('pagewise-monitored-folder-change'))
    doc.dispatchEvent(new Event('visibilitychange'))
    await tick()
    assert.equal(count, 1)
    stop()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls.filter(c => c.command === 'watch_monitored_folder').map(c => c.args.enabled), [true, false])
    win.dispatchEvent(new Event('pagewise-monitored-folder-change'))
    doc.dispatchEvent(new Event('visibilitychange'))
    await tick()
    assert.equal(count, 1)
  } finally {
    stop?.()
    delete globalThis.window
    delete globalThis.document
  }
})

test('browser preview reports capability absence, not fake Android persistence', async () => {
  assert.equal(monitoredFolderCapabilities().supported, false)
  assert.equal(monitoredFolderCapabilities().persistence, 'none')
  assert.equal(await getMonitoredFolder(), null)
  await assert.rejects(selectMonitoredFolder(), { code: 'unavailable' })
  await assert.rejects(listMonitoredFiles(folder.id), { code: 'unavailable' })
})

test('native base64 transport decodes every byte without per-character callbacks', () => {
  // 高字节覆盖 UTF-8/二进制内容；嵌入文件头用于确认顺序没有旋转。
  const source = new Uint8Array(64 * 1024)
  for (let i = 0; i < source.length; i++) source[i] = (i * 37) & 0xff
  const encoded = Buffer.from(source).toString('base64')
  const decoded = decodeBase64Bytes(encoded)
  assert.equal(decoded.length, source.length)
  assert.deepEqual(decoded, source)
  // 目标代码路径必须保持线性循环；逐字符回调曾被实测放大约 45 倍。
  const service = readFileSync(new URL('../src/services/monitoredFolder.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(service, /Uint8Array\.from\(decoded/)
})
