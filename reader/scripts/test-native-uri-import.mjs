import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, open, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareNativeUriInputs, stageNativeImportInput, createNativeBookImportClient } from '../src/services/nativeBookImport.ts'

const rejectsCode = (work, code) => assert.rejects(work, error => error.code === code)
const metadata = size => ({ size, mtime: new Date(1000), isDirectory: false })
function fakeIo(size, options = {}) {
  const counts = { opens: 0, closes: 0, reads: 0, largestRead: 0 }
  return { counts, name: async () => options.name ?? 'BOOK.EPUB', open: async () => {
    counts.opens++; let position = 0
    return { stat: async () => metadata(options.changed && position > 0 ? size + 1 : size), close: async () => { counts.closes++ }, read: async buffer => {
      counts.reads++; counts.largestRead = Math.max(counts.largestRead, buffer.byteLength)
      if (options.failRead) throw Object.assign(new Error('synthetic_read_error'), { code: 'synthetic_read_error' })
      const count = Math.min(buffer.byteLength, size - position); buffer.fill(91, 0, count); position += count; return count || null
    } }
  } }
}

test('real file handles stream URI source in bounded 256 KiB chunks with exact bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagewise-native-uri-'))
  let opened = 0, closed = 0, largest = 0
  try {
    const source = join(directory, 'BOOK.EPUB'), target = join(directory, 'staged.bin')
    const original = await open(source, 'w'); await original.truncate(8 * 1024 * 1024 + 17); await original.close()
    const io = { name: async path => { assert.equal(path, 'content://synthetic/book'); return 'BOOK.EPUB' }, open: async () => {
      const file = await open(source, 'r'); opened++
      return { stat: async () => { const s = await file.stat(); return { size: s.size, mtime: s.mtime, isDirectory: s.isDirectory() } }, read: async buffer => { largest = Math.max(largest, buffer.length); return (await file.read(buffer)).bytesRead }, close: async () => { await file.close(); closed++ } }
    } }
    const [input] = await prepareNativeUriInputs(['content://synthetic/book'], io)
    assert.equal(input.sourceKind, 'uri'); assert.equal(input.name, 'BOOK.EPUB'); assert.equal(input.size, 8 * 1024 * 1024 + 17)
    let writer, written = 0, begin = 0
    try {
      const path = await stageNativeImportInput(input, 'cache/import-synthetic.bin', async (command, args) => {
        assert.equal(args.path, 'cache/import-synthetic.bin')
        if (command === 'begin_import_file') { begin++; writer = await open(target, 'w'); return }
        assert.equal(command, 'append_import_file')
        const bytes = Buffer.from(args.data, 'base64'); assert.ok(bytes.length <= 256 * 1024)
        await writer.write(bytes); written += bytes.length
      })
      assert.equal(path, 'cache/import-synthetic.bin')
    } finally { await writer?.close() }
    assert.equal(begin, 1); assert.equal(written, input.size); assert.equal(largest, 256 * 1024); assert.equal(opened, 2); assert.equal(closed, 2)
    assert.deepEqual(await readFile(target), await readFile(source))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('cancelled/failed append closes the actual source generator; upload cleanup stays with existing owner', async () => {
  const io = fakeIo(700000), [source] = await prepareNativeUriInputs(['content://synthetic/one'], io)
  let chunks = 0
  await rejectsCode(() => stageNativeImportInput(source, 'cache/import-synthetic.bin', async command => {
    if (command === 'append_import_file' && ++chunks === 2) throw Object.assign(new Error('synthetic_ack_loss'), { code: 'synthetic_ack_loss' })
  }), 'synthetic_ack_loss')
  assert.equal(io.counts.opens, 2); assert.equal(io.counts.closes, 2); assert.equal(chunks, 2)
})

test('source read failure/changed metadata never returns a successful staged path', async () => {
  for (const options of [{ failRead: true }, { changed: true }]) {
    const io = fakeIo(30, options), [source] = await prepareNativeUriInputs(['content://synthetic/one'], io)
    await rejectsCode(() => stageNativeImportInput(source, 'cache/import-synthetic.bin', async () => {}), options.failRead ? 'synthetic_read_error' : 'source_changed')
    assert.equal(io.counts.opens, io.counts.closes)
  }
})

test('unknown sizes, oversized batches and unsafe filenames fail before upload and close metadata handles', async () => {
  const empty = fakeIo(0); await rejectsCode(() => prepareNativeUriInputs(['content://synthetic/empty'], empty), 'invalid_file_metadata'); assert.equal(empty.counts.opens, empty.counts.closes)
  const large = fakeIo(1024 ** 3); await rejectsCode(() => prepareNativeUriInputs(['content://synthetic/a', 'content://synthetic/b'], large), 'resource_limit'); assert.equal(large.counts.opens, large.counts.closes); assert.equal(large.counts.reads, 0)
  const unsafe = fakeIo(20, { name: '../book.epub' }); await rejectsCode(() => prepareNativeUriInputs(['content://synthetic/a'], unsafe), 'invalid_file_name'); assert.equal(unsafe.counts.opens, 0)
  await rejectsCode(() => prepareNativeUriInputs(Array(129).fill('content://synthetic/a'), fakeIo(20)), 'resource_limit')
})

test('legacy real File input retains existing 2 MiB Blob chunk behavior', async () => {
  const file = new File([new Uint8Array(2 * 1024 * 1024 + 19)], 'BOOK.EPUB')
  const sizes = []
  await stageNativeImportInput(file, 'cache/import-synthetic.bin', async command => {
    if (command === 'begin_import_file') return
  })
  await stageNativeImportInput(file, 'cache/import-synthetic.bin', async (command, args) => { if (command === 'append_import_file') sizes.push(Buffer.from(args.data, 'base64').length) })
  assert.deepEqual(sizes, [2 * 1024 * 1024, 19])
})

test('URI input reuses original batch journal, path-before-upload ownership and request receipts', async () => {
  const journal = new Map(), io = fakeIo(12)
  const [source] = await prepareNativeUriInputs(['content://synthetic/owner'], io)
  let capturedIdentity = '', stageCount = 0, jobCount = 0
  const client = createNativeBookImportClient({
    libraryRoot: () => '', journal: { getItem: key => journal.get(key) ?? null, setItem: (key, value) => journal.set(key, value), removeItem: key => journal.delete(key) },
    stage: async (file, path) => {
      stageCount++
      const pending = JSON.parse([...journal.values()][0]); assert.ok(pending.paths.includes(path)); assert.equal(pending.phase, 'preparing')
      capturedIdentity = pending.identity
      return stageNativeImportInput(file, path, async () => {})
    }, cleanup: async () => {}, cleanupBatch: async () => {}, cancelBatch: async () => {},
    job: async (kind, input, consume) => {
      assert.equal(kind, 'import'); jobCount++; assert.equal(input.request.items[0].fileName, 'BOOK.EPUB')
      return consume({ total: 1, done: 1, imported: 1, updated: 0, skipped: 0, failed: 0, complete: true, finished: true, errors: [], results: [{ ok: true, fileName: 'BOOK.EPUB', bookId: randomUUID() }] })
    },
  })
  const results = await client.files([source], 'native synthetic import')
  assert.equal(results.length, 1); assert.equal(results[0].ok, true); assert.equal(stageCount, 1); assert.equal(jobCount, 1)
  assert.ok(capturedIdentity.includes('content://synthetic/owner')); assert.equal(journal.size, 0); assert.equal(io.counts.opens, io.counts.closes)
})
