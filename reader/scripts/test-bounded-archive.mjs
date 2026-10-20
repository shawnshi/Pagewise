import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import * as fflate from 'fflate'
import * as yaml from 'yaml'
import { normalizeRow, rowKey } from '../src/services/readingLog.ts'
import { readBoundedArchive, ARCHIVE_LIMITS } from '../src/services/boundedArchive.ts'

// Execute the complete production module, replacing only persistence boundaries.
export async function loadBackup(storage, options = {}) {
  const cache = new Map()
  const synth = (name, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { identifier: name })
  const storageModule = synth('storage', { getStorage: async () => storage, newId: () => crypto.randomUUID() })
  const logModule = synth('reading-log', {
    normalizeRow, rowKey,
    listReadingLog: async () => { if (options.exportLogError) throw new Error('log unavailable'); return options.exportLogRows ?? [] },
    importReadingLogRows: async rows => { if (options.importLogError) throw new Error('log write failed'); storage.logs.push(...rows); return rows.length },
  })
  async function source(path) {
    if (cache.has(path)) return cache.get(path)
    const text = await readFile(path, 'utf8')
    const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    const mod = new vm.SourceTextModule(code, { identifier: path })
    cache.set(path, mod)
    await mod.link(async spec => {
      if (spec === '../storage') return storageModule
      if (spec.endsWith('readingLog.ts')) return logModule
      if (spec === 'fflate') return synth(spec, fflate)
      if (spec === 'yaml') return synth(spec, yaml)
      let target = resolve(dirname(path), spec)
      if (!target.endsWith('.ts')) target += '.ts'
      return source(target)
    })
    return mod
  }
  globalThis.__APP_VERSION__ = 'test'
  const mod = await source(resolve('src/services/backup.ts'))
  await mod.evaluate()
  return mod.namespace
}

export function store(initial = [], fail = '') {
  const books = initial.map(([id, bytes]) => ({ id, title: 'Edition', author: '', tags: [], fileName: 'same.txt', format: 'txt', addedAt: 1, size: bytes.length }))
  const blobs = new Map(initial.map(([id, bytes]) => [id, new Blob([bytes])]))
  return {
    books, blobs, annotations: [], logs: [], writes: [],
    async listBooks() { return books },
    async getBookFile(id) { if (fail === 'read') throw new Error('unreadable existing book'); return blobs.get(id) },
    async addBook(meta, blob) { if (fail === 'book' && books.length) throw new Error('disk full'); const id = `new-${books.length}`; books.push({ ...meta, id }); blobs.set(id, blob); this.writes.push('book'); return id },
    async getCoverUrl() { return undefined },
    async listAnnotations(id) { return this.annotations.filter(a => a.bookId === id) },
    async addAnnotation(a) { if (fail === 'annotation') throw new Error('annotation disk full'); this.annotations.push(a); this.writes.push('annotation') },
    async listSources() { return [] }, async addSource() { this.writes.push('source') },
    async listBooklists() { return [] }, async listBooklistWanted() { return [] },
  }
}
function archive(contents = ['new bytes'], extras = {}, level = 6) {
  const books = contents.map((content, i) => ({ id: `old-${i}`, title: 'Edition', author: '', tags: [], fileName: 'same.txt', format: 'txt', size: content.length, addedAt: 1, fileEntry: `assets/${i}.txt` }))
  const annotations = books.map(book => ({ id: `a-${book.id}`, bookId: book.id, cfi: 'p1', text: 'edition note', color: 'yellow', createdAt: 1 }))
  const entries = { 'manifest.json': fflate.strToU8(JSON.stringify({ app: 'lightread', version: 1, books, annotations, sources: [] })) }
  contents.forEach((bytes, i) => { entries[`assets/${i}.txt`] = fflate.strToU8(bytes) })
  return fflate.zipSync({ ...entries, ...extras }, { level })
}
const file = bytes => new File([bytes], 'test.zip')

test('same name with different bytes retains editions and binds annotations only to restored bytes', async () => {
  const s = store([['existing', 'old bytes']]); const api = await loadBackup(s)
  const result = await api.importBackup(file(archive()))
  assert.equal(result.books, 1); assert.equal(s.books.length, 2)
  assert.equal(s.annotations[0].bookId, 'new-1')
})
test('same verified bytes merges idempotently, including duplicate payloads within one archive', async () => {
  const s = store([['existing', 'new bytes']]); const api = await loadBackup(s)
  const bytes = archive(['new bytes', 'new bytes'])
  assert.equal((await api.importBackup(file(bytes))).books, 0)
  await api.importBackup(file(bytes)); assert.equal(s.annotations.length, 1)
})
test('unreadable same-name content fails closed before annotations', async () => {
  const s = store([['existing', 'new bytes']], 'read'); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(file(archive())), /unreadable/)
  assert.deepEqual(s.writes, [])
})
test('malformed optional reading log rejects before any writes', async () => {
  for (const raw of ['{', '{}', JSON.stringify({ format: 'org.lightread.reading-log', version: 1, rows: [{ key: 'bad' }] })]) {
    const s = store(); const api = await loadBackup(s)
    await assert.rejects(api.importBackup(file(archive(['new bytes'], { 'reading-log.json': fflate.strToU8(raw) }))))
    assert.deepEqual(s.writes, [])
  }
})
test('optional export failures are surfaced, not reported as complete', async () => {
  const s = store(); const api = await loadBackup(s, { exportLogError: true })
  await assert.rejects(api.exportBackup(), /log unavailable/)
})
test('mid-write failure reports confirmed progress and uncertain failed operation', async () => {
  const s = store([], 'annotation'); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(file(archive())), error => {
    assert.equal(error.progress.books, 1); assert.equal(error.progress.annotations, 0)
    assert.match(error.message, /annotation disk full/); assert.match(error.message, /partial|Partial/)
    return true
  })
  assert.deepEqual(s.writes, ['book'])
})
test('failure on the second book preserves the first confirmed write without claiming rollback', async () => {
  const s = store([], 'book'); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(file(archive(['first', 'second']))), error => {
    assert.equal(error.progress.books, 1); assert.equal(error.progress.annotations, 0)
    assert.match(error.message, /failed operation may have written.*no rollback/)
    return true
  })
  assert.equal(s.books.length, 1); assert.equal(await s.blobs.get('new-0').text(), 'first')
})
test('legacy v2 content checksums are verified before writes', async () => {
  const entries = fflate.unzipSync(archive())
  const manifest = JSON.parse(fflate.strFromU8(entries['manifest.json']))
  const content = entries['assets/0.txt']
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', content))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  manifest.format = 'org.lightread.library'; manifest.version = 2
  manifest.books[0].content = { path: 'assets/0.txt', mediaType: 'text/plain', byteLength: content.length, sha256: hash }
  entries['manifest.json'] = fflate.strToU8(JSON.stringify(manifest))
  const s = store(); const api = await loadBackup(s)
  assert.equal((await api.importBackup(file(fflate.zipSync(entries)))).books, 1)
  entries['assets/0.txt'] = fflate.strToU8('bad bytes')
  const target = store(); const receiver = await loadBackup(target)
  await assert.rejects(receiver.importBackup(file(fflate.zipSync(entries))), /SHA-256/)
  assert.deepEqual(target.writes, [])
})
test('reading-log storage failure is observable with confirmed book progress', async () => {
  const s = store(); const api = await loadBackup(s, { importLogError: true })
  const rows = [{ key: 'device|2026-10-20|id:old-0', seconds: 5, updatedAt: 1 }]
  await assert.rejects(api.importBackup(file(archive(['new bytes'], { 'reading-log.json': fflate.strToU8(JSON.stringify({ format: 'org.lightread.reading-log', version: 1, rows })) }))), error => {
    assert.equal(error.progress.books, 1); assert.equal(error.progress.annotations, 1)
    assert.equal(error.progress.readingLog, 0); assert.match(error.message, /log write failed/)
    return true
  })
})
test('valid reading rows are remapped and remain idempotent', async () => {
  const s = store(); const api = await loadBackup(s)
  const rows = [{ key: 'device|2026-10-20|id:old-0', bookId: 'old-0', seconds: 5, updatedAt: 1 }]
  await api.importBackup(file(archive(['new bytes'], { 'reading-log.json': fflate.strToU8(JSON.stringify({ format: 'org.lightread.reading-log', version: 1, rows })) })))
  assert.equal(s.logs[0].key, 'device|2026-10-20|id:new-0')
})
test('malformed booklists reject before book writes', async () => {
  const s = store(); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(file(archive(['new bytes'], { 'booklists.json': fflate.strToU8('{"format":"org.lightread.booklists","version":1,"lists":[{}]}') }))))
  assert.deepEqual(s.writes, [])
})
test('streamed production OKF export and optional-free legacy inputs remain readable', async () => {
  const s = store([['source', 'synthetic content']]); const api = await loadBackup(s)
  const blob = await api.exportBackup()
  const target = store(); const receiver = await loadBackup(target)
  const result = await receiver.importBackup(blob)
  assert.equal(result.books, 1)
  assert.equal(await target.blobs.get(target.books[0].id).text(), 'synthetic content')
  assert.equal((await receiver.importBackup(blob)).books, 0)
})

function records(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  const start = view.getUint32(end + 16, true)
  const entries = []
  for (let pos = start; pos < end;) {
    assert.equal(view.getUint32(pos, true), 0x02014b50)
    entries.push({ central: pos, local: view.getUint32(pos + 42, true) })
    pos += 46 + view.getUint16(pos + 28, true) + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true)
  }
  return { view, entries, end, start }
}
test('ZIP size, entry count, total and per-entry expansion budgets reject before reads or allocations', async () => {
  let touched = false
  await assert.rejects(readBoundedArchive({ size: ARCHIVE_LIMITS.archiveBytes + 1, slice() { touched = true; throw new Error('must not read') } }), /archive size/)
  assert.equal(touched, false)
  const many = fflate.zipSync(Object.fromEntries(Array.from({ length: ARCHIVE_LIMITS.entries + 1 }, (_, i) => [`a${i}`, new Uint8Array()])) )
  await assert.rejects(readBoundedArchive(file(many)), /directory budget/)
  for (const [name, size] of [['manifest.json', ARCHIVE_LIMITS.metadataBytes + 1], ['asset', ARCHIVE_LIMITS.entryBytes + 1]]) {
    const bytes = fflate.zipSync({ [name]: new Uint8Array([1]) }); const { view, entries } = records(bytes)
    view.setUint32(entries[0].central + 24, size, true)
    await assert.rejects(readBoundedArchive(file(bytes)), /expansion budget/)
  }
  const bytes = fflate.zipSync({ a: new Uint8Array(), b: new Uint8Array(), c: new Uint8Array() })
  const { view, entries } = records(bytes)
  for (const entry of entries) view.setUint32(entry.central + 24, 64 * 1024 * 1024, true)
  await assert.rejects(readBoundedArchive(file(bytes)), /expansion budget/)
})
test('duplicate paths, local/central mismatches, CRC damage and malformed DEFLATE are rejected', async () => {
  const duplicate = fflate.zipSync({ a: new Uint8Array([1]), b: new Uint8Array([2]) })
  const d = records(duplicate)
  duplicate[d.entries[1].central + 46] = 97; duplicate[d.entries[1].local + 30] = 97
  await assert.rejects(readBoundedArchive(file(duplicate)), /duplicate/)
  const crc = fflate.zipSync({ a: new Uint8Array([1, 2, 3]) }, { level: 0 })
  crc[31] ^= 1
  await assert.rejects(readBoundedArchive(file(crc)), /CRC/)
  const malformed = fflate.zipSync({ a: fflate.strToU8('hello world') })
  malformed[31] = 7
  await assert.rejects(readBoundedArchive(file(malformed)))
  const mismatch = fflate.zipSync({ a: new Uint8Array() }); mismatch[30] = 98
  await assert.rejects(readBoundedArchive(file(mismatch)), /local path/)
})
test('actual truncated DEFLATE payload fails even with a structurally complete ZIP directory', async () => {
  const original = fflate.zipSync({ body: fflate.strToU8('synthetic content'.repeat(1000)) })
  const { view: old, entries, start } = records(original)
  const compressed = old.getUint32(entries[0].central + 20, true)
  const remove = start - 1
  const bytes = new Uint8Array(original.length - 1)
  bytes.set(original.subarray(0, remove)); bytes.set(original.subarray(remove + 1), remove)
  const view = new DataView(bytes.buffer)
  const central = start - 1
  view.setUint32(18, compressed - 1, true)
  view.setUint32(central + 20, compressed - 1, true)
  view.setUint32(bytes.length - 22 + 16, central, true)
  await assert.rejects(readBoundedArchive(file(bytes)))
})
test('missing native raw-DEFLATE capability fails closed while stored ZIP still restores', async () => {
  const original = globalThis.DecompressionStream
  globalThis.DecompressionStream = class { constructor() { throw new TypeError('unsupported format') } }
  try {
    const s = store(); const api = await loadBackup(s)
    await assert.rejects(api.importBackup(file(archive())), /original archive is unchanged.*uncompressed ZIP/)
    assert.deepEqual(s.writes, [])
    assert.equal((await api.importBackup(file(archive(['new bytes'], {}, 0)))).books, 1)
  } finally { globalThis.DecompressionStream = original }
})
test('forged small output size stops actual expansion and rejects before storage writes', async () => {
  const bytes = archive(['a'.repeat(2 * 1024 * 1024)])
  const { view, entries } = records(bytes)
  const content = entries[1]
  view.setUint32(content.central + 24, 1, true); view.setUint32(content.local + 22, 1, true)
  const s = store(); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(file(bytes)), /actual expansion/)
  assert.deepEqual(s.writes, [])
})
test('incremental input does not call whole-file arrayBuffer and cancellation prevents writes', async () => {
  class SlicedFile extends File { arrayBuffer() { throw new Error('whole-file materialization') } }
  const bytes = archive(['a'.repeat(1024 * 1024)])
  const start = performance.now()
  const result = await readBoundedArchive(new SlicedFile([bytes], 'bounded.zip'))
  console.log(JSON.stringify({ receipt: 'bounded-read', compressedBytes: bytes.length, expandedContentBytes: result['assets/0.txt'].length, elapsedMs: performance.now() - start, processPeakRssKiB: process.resourceUsage().maxRSS }))
  assert.equal(result['assets/0.txt'].length, 1024 * 1024)
  const controller = new AbortController(); controller.abort()
  const s = store(); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(file(bytes), undefined, controller.signal), /cancelled/)
  assert.deepEqual(s.writes, [])
})
test('cancellation during native decompression stops before library writes', async () => {
  const controller = new AbortController()
  const bytes = archive(['a'.repeat(10000)])
  const { view, entries } = records(bytes)
  const dataStart = entries[0].local + 30 + view.getUint16(entries[0].local + 26, true)
  class InterruptFile extends File {
    slice(...args) {
      const blob = super.slice(...args)
      const read = blob.arrayBuffer.bind(blob)
      blob.arrayBuffer = async () => {
        const result = await read()
        if (args[0] === dataStart) controller.abort()
        return result
      }
      return blob
    }
  }
  const s = store(); const api = await loadBackup(s)
  await assert.rejects(api.importBackup(new InterruptFile([bytes], 'cancel.zip'), undefined, controller.signal), /cancelled/)
  assert.deepEqual(s.writes, [])
})
test('truncated archive and unsafe ZIP paths reject before writes', async () => {
  const bytes = archive()
  for (const bad of [bytes.subarray(0, bytes.length - 12), archive(['new bytes'], { '../escape': new Uint8Array([1]) })]) {
    const s = store(); const api = await loadBackup(s)
    await assert.rejects(api.importBackup(file(bad)))
    assert.deepEqual(s.writes, [])
  }
})
