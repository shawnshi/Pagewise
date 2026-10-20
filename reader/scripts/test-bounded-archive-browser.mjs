import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, readerRoot } from './vite-isolated.mjs'
import { chromium } from 'playwright'

const evidenceSuffix = process.env.PAGEWISE_ARCHIVE_EVIDENCE_SUFFIX ?? ''
if (evidenceSuffix && !/^[a-z0-9-]+$/.test(evidenceSuffix)) throw new Error('Invalid archive evidence namespace')
const evidence = resolve(readerRoot, '../.cache/audit-stage1', evidenceSuffix)
await mkdir(evidence, { recursive: true })
const server = await createServer({ root: readerRoot, cacheDir: resolve(evidence, 'vite'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), args: ['--disable-background-networking'] })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(origin, { waitUntil: 'networkidle' })
  const result = await page.evaluate(async () => {
    const { getStorage } = await import('/src/storage/index.ts')
    const { exportBackup, importBackup } = await import('/src/services/backup.ts')
    const { recordReading, listReadingLog } = await import('/src/services/readingLog.ts')
    const { zipSync, strToU8 } = await import('/node_modules/fflate/esm/browser.js')
    const storage = await getStorage()
    const original = await storage.addBook({ title: 'Edition', author: 'Synthetic', format: 'txt', fileName: 'same.txt', tags: [], addedAt: 1 }, new Blob(['first edition']))
    await storage.addAnnotation({ bookId: original, kind: 'highlight', cfi: 'p1', text: 'original', color: 'yellow', createdAt: 1 })
    const list = await storage.createBooklist('Synthetic list')
    await storage.addBooksToBooklist(list, [original])
    await storage.putBooklistWanted([{ id: 'wanted', booklistId: list, title: 'Synthetic wanted', author: '', addedAt: 1 }])
    // recordReading is the production API, backed by a fresh browser-only IndexedDB.
    await recordReading({ id: original, title: 'Edition', kind: 'book' }, 5)
    const exported = await exportBackup()
    await storage.deleteBook(original)
    const restored = await importBackup(new File([exported], 'roundtrip.zip'))
    if (restored.books !== 1) throw new Error('OKF roundtrip did not restore source book')
    const idempotent = await importBackup(new File([exported], 'roundtrip.zip'))
    if (idempotent.books || idempotent.annotations) throw new Error('OKF repeat restore not idempotent')
    const meta = { id: 'legacy', title: 'Edition', author: '', format: 'txt', fileName: 'same.txt', tags: [], addedAt: 1, fileEntry: 'body.txt' }
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ app: 'lightread', version: 1, books: [meta], sources: [], annotations: [{ id: 'legacy-note', bookId: 'legacy', cfi: 'p1', text: 'different edition', color: 'yellow', createdAt: 2 }] })),
      'body.txt': strToU8('second edition'),
    })
    const collision = await importBackup(new File([bytes], 'legacy-compressed.zip'))
    const books = await storage.listBooks()
    const content = []
    for (const book of books) content.push({ bytes: await (await storage.getBookFile(book.id)).text(), notes: (await storage.listAnnotations(book.id)).map(a => a.text) })
    return { restored, idempotent, collision, content, wanted: await storage.listBooklistWanted(), logs: await listReadingLog(), userAgent: navigator.userAgent }
  })
  assert.equal(result.collision.books, 1)
  assert.equal(result.content.length, 2)
  assert.deepEqual(result.content.find(book => book.bytes === 'first edition').notes, ['original'])
  assert.deepEqual(result.content.find(book => book.bytes === 'second edition').notes, ['different edition'])
  assert.equal(result.wanted.length, 1)
  assert.ok(result.logs.length)
  await writeFile(resolve(evidence, 'browser-result.json'), JSON.stringify(result, null, 2))
  console.log('PASS: real browser File/DecompressionStream + IndexedDB OKF/legacy roundtrip, edition isolation, annotations, booklists, reading log, repeat import')
  console.log(result.userAgent)
  await context.close()
} finally {
  await browser?.close()
  await server.close()
}
