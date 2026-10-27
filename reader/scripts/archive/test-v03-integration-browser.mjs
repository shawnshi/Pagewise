import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { resolve } from 'node:path'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'

let server, browser, base
before(async () => {
  server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--disable-background-networking'] })
})
after(async () => { await browser?.close(); await server?.close() })
async function isolated(run, width = 992) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).origin === base || /^(blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort('blockedbyclient'))
  const page = await context.newPage()
  try {
    await page.goto(base + '/#/library', { waitUntil: 'networkidle' })
    await page.locator('.library').waitFor()
    return await run(page)
  } finally { await context.close() }
}

test('archive actual OKF/legacy roundtrip preserves bibliography precision/state, never restores machine-local grants', { timeout: 60000 }, async () => {
  await isolated(async page => {
    const result = await page.evaluate(async () => {
      const { getStorage } = await import('/src/storage/index.ts')
      const { exportBackup, importBackup } = await import('/src/services/backup.ts')
      const { unzipSync, zipSync, strToU8, strFromU8 } = await import('/node_modules/fflate/esm/browser.js')
      const storage = await getStorage()
      const dates = ['1972', '1972-05', '1972-05-09']
      for (const [i, publicationDate] of dates.entries()) {
        await storage.addBook({ id: `precision-${i}`, title: `Synthetic ${i}`, author: 'Fixture Author', fileName: `fixture-${i}.txt`, format: 'txt', tags: ['fixture'], publisher: 'Fixture Press', publicationDate, readingStatus: 'paused', addedAt: 1 }, new Blob(['Synthetic archive body']))
      }
      const archive = await exportBackup()
      const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()))
      const manifest = JSON.parse(strFromU8(entries['manifest.json']))
      const clear = async () => { for (const book of await storage.listBooks()) await storage.deleteBook(book.id) }
      await clear(); await importBackup(archive)
      const okf = await storage.listBooks()
      for (const key of Object.keys(entries)) if (key.endsWith('.md')) delete entries[key]
      for (const book of manifest.books) { book.sourceRef = { folderId: 'foreign-machine', documentId: 'foreign-grant', relativePath: 'fixture.txt', version: '1' }; book.fileAvailability = 'permission-denied' }
      entries['manifest.json'] = strToU8(JSON.stringify(manifest))
      const legacy = new Blob([zipSync(entries)])
      await clear(); await importBackup(legacy)
      const json = await storage.listBooks()
      await clear()
      manifest.books[0].readingStatus = 'not-a-state'
      entries['manifest.json'] = strToU8(JSON.stringify(manifest))
      let rejected = false
      try { await importBackup(new Blob([zipSync(entries)])) } catch { rejected = true }
      return { okf, json, rejected, countAfterInvalid: (await storage.listBooks()).length }
    })
    for (const books of [result.okf, result.json]) {
      assert.deepEqual(books.map(x => x.publicationDate).sort(), ['1972', '1972-05', '1972-05-09'])
      for (const book of books) { assert.equal(book.publisher, 'Fixture Press'); assert.equal(book.readingStatus, 'paused'); assert.equal(book.sourceRef, undefined); assert.equal(book.fileAvailability, undefined) }
    }
    assert.equal(result.rejected, true); assert.equal(result.countAfterInvalid, 0)
  })
})

test('4000 metadata references: bounded serial scans extract only changed content', { timeout: 60000 }, async () => {
  await isolated(async page => {
    const result = await page.evaluate(async () => {
      const { createFolderLibrary } = await import('/src/services/folderLibrary.ts')
      const { prepareBookImport } = await import('/src/services/importer.ts')
      const files = Array.from({ length: 4000 }, (_, i) => ({ documentId: String(i), name: `${i}.txt`, relativePath: `nested/${i}.txt`, size: 32, modifiedAt: 1 }))
      const books = new Map(files.map(f => [f.documentId, { id: f.documentId, title: 'Manual title', author: 'Manual author', format: 'txt', fileName: f.name, tags: ['manual'], readingStatus: 'paused', location: 'saved-cfi', progress: 0.5, addedAt: 1, hasCover: false, fileAvailability: 'available', sourceRef: { folderId: 'fixture', documentId: f.documentId, relativePath: f.relativePath, version: JSON.stringify([f.size, f.modifiedAt]) } }]))
      let reads = 0, parses = 0, active = 0, peak = 0, updates = 0
      const folder = { id: 'fixture', label: 'Synthetic 4000', permission: 'granted' }
      const controller = createFolderLibrary({
        getMonitoredFolder: async () => folder, selectMonitoredFolder: async () => folder,
        subscribeMonitoredFolderChanges: () => () => {},
        listMonitoredFiles: async () => ({ files, complete: true, errors: [] }),
        readMonitoredFile: async () => { reads++; active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return new TextEncoder().encode('Synthetic changed content') },
        prepareBookImport: async (...args) => { parses++; return prepareBookImport(...args) },
        getStorage: async () => ({ listBooks: async () => [...books.values()], updateBook: async (id, patch) => { updates++; Object.assign(books.get(id), patch) }, addReferencedBook: async () => { throw Error('Unexpected duplicate') } }),
      })
      const ms = []
      for (let i = 0; i < 5; i++) { const start = performance.now(); await controller.rescan(); ms.push(performance.now() - start) }
      const unchanged = { reads, parses, updates }
      files[100].modifiedAt++
      await controller.rescan(); await controller.rescan()
      return { ms, unchanged, reads, parses, updates, peak, count: books.size, book: books.get('100'), status: controller.status.value }
    })
    assert.deepEqual(result.unchanged, { reads: 0, parses: 0, updates: 0 })
    assert.equal(result.reads, 1); assert.equal(result.parses, 1); assert.equal(result.updates, 1); assert.equal(result.peak, 1); assert.equal(result.count, 4000)
    assert.equal(result.book.title, 'Manual title'); assert.equal(result.book.location, 'saved-cfi'); assert.equal(result.book.readingStatus, 'paused'); assert.equal(result.status.state, 'idle')
    console.log(JSON.stringify({ workload: 4000, unchangedScanMs: result.ms, changedReads: result.reads, peakConcurrentReads: result.peak }))
  })
})

for (const width of [992, 390]) test(`actual Vue app ${width}px: folder status, legacy overview, filters/order, Gemini, labeled reader panels`, { timeout: 60000 }, async () => {
  await isolated(async page => {
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    const bookId = await page.evaluate(async () => {
      const { getStorage } = await import('/src/storage/index.ts'); const storage = await getStorage()
      const id = await storage.addBook({ title: 'Synthetic UI Book', author: 'Embedded Author', fileName: 'fixture.txt', format: 'txt', tags: ['history'], publisher: 'Embedded Press', publicationDate: '1972-05', addedAt: 1 }, new Blob(['# Synthetic chapter\n\nOnly synthetic reading content.\n\nSecond paragraph.']))
      const { useLibrary } = await import('/src/stores/library.ts'); await useLibrary().refresh()
      return id
    })
    await page.locator('.book-card').waitFor()
    assert.equal(await page.locator('input[type=file]').count(), 0, 'no manual library import')
    assert.equal(await page.locator('.monitored-folder-banner').count(), 0, 'folder management is settings-only')
    await page.locator('.book-card').click()
    await page.waitForURL(`**/#/book/${bookId}`)
    const order = await page.evaluate(async () => (await import('/src/services/librarySession.ts')).loadLibrarySession().orderedBookIds)
    assert.deepEqual(order, [bookId], 'detail navigation preserves result order')
    const overview = await page.locator('.book-detail').innerText()
    for (const value of ['Embedded Author', 'Embedded Press', '1972-05', 'history']) assert.ok(overview.includes(value), value)
    await page.goto(base + '/#/settings?section=ai', { waitUntil: 'networkidle' })
    const provider = page.locator('#ai-provider')
    await provider.selectOption('gemini')
    const selected = await page.evaluate(async () => {
      const { useSettings } = await import('/src/stores/settings.ts'); const s = useSettings()
      return { provider: s.aiProvider, model: s.aiModel, key: s.aiApiKey, base: s.aiBaseUrl }
    })
    assert.deepEqual(selected, { provider: 'gemini', model: 'gemini-4-argon', key: '', base: 'https://generativelanguage.googleapis.com/v1beta/openai/' })
    await page.goto(base + `/#/read/${bookId}`, { waitUntil: 'networkidle' })
    await page.locator('.reader').waitFor()
    await page.locator('.bar.top').hover()
    const controls = page.locator('.bar.top button:visible')
    assert.ok(await controls.count() >= 4, 'actual primary reader controls')
    for (const control of await controls.all()) {
      const text = (await control.innerText()).trim(); assert.ok(text, 'visible reader control label')
      const box = await control.boundingBox(); assert.ok(box.width >= 48 && box.height >= 48, `${text}: ${JSON.stringify(box)}`)
    }
    assert.ok(await page.locator('.reader .app-icon').count() > 0)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, actualVue: true, overview: true, geminiProfile: true, readerControls: await controls.count() }))
  }, width)
})
