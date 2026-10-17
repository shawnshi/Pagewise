import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, readFile, mkdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { queryLibraryBooks } from '../src/services/libraryQuery.ts'
import { restorableView, restoreView, rememberView } from '../src/services/navigationSession.ts'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')
const loadTs = async (path, replacements = []) => {
  let js = stripTypeScriptTypes(await source(path))
  for (const [from, to] of replacements) js = js.replaceAll(from, to)
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const { readerPath } = await loadTs('../src/services/readerRoute.ts', [
  ["'./format'", JSON.stringify(new URL('../src/services/format.ts', import.meta.url).href)],
])

function makeStore(code, storage) {
  const body = stripTypeScriptTypes(code).replace(/^import [^\r\n]*\r?\n/gm, '').replace('export const useLibrary =', 'return')
  const options = new Function('defineStore', 'getStorage', 'recordReading', body)(
    (_id, options) => options, async () => storage, async () => {},
  )
  const state = options.state()
  for (const [name, action] of Object.entries(options.actions)) state[name] = action.bind(state)
  return state
}

test('library refresh reads only books, leaves archive/wanted data untouched, and propagates read errors', async () => {
  const legacy = Object.freeze({ id: 'legacy', title: 'Synthetic PDF', author: '', tags: [], format: 'pdf', kind: 'paper', location: '2', progress: 2 / 3, addedAt: 1 })
  const historical = { lists: [{ id: 'old-list' }], wanted: [{ id: 'wanted', title: 'Synthetic PDF' }] }
  const before = JSON.stringify(historical)
  const calls = []
  const storage = new Proxy({ listBooks: async () => [legacy] }, {
    get(target, key) {
      if (key === 'then') return undefined
      calls.push(key)
      if (!(key in target)) throw new Error(`unexpected retired storage call: ${String(key)}`)
      return target[key]
    },
  })
  const store = makeStore(await source('../src/stores/library.ts'), storage)
  await store.refresh()
  await store.refresh()
  assert.deepEqual(calls, ['listBooks', 'listBooks'])
  assert.equal(store.books[0], legacy)
  assert.equal(store.loaded, true)
  assert.equal(JSON.stringify(historical), before)
  for (const key of Object.keys(store)) assert.doesNotMatch(key, /booklist|wanted/i)
  const broken = makeStore(await source('../src/stores/library.ts'), { listBooks: async () => { throw new Error('read failure') } })
  await assert.rejects(broken.refresh(), /read failure/)
  assert.equal(broken.loaded, false)
})

test('source-linked deletion is refused from persisted metadata; copied batch results stay accurate', async () => {
  const sourceBook = Object.freeze({ id: 'source', kind: 'paper', location: '2', progress: 0.5,
    sourceRef: Object.freeze({ folderId: 'fixture', documentId: 'document', relativePath: 'fixture.pdf', version: '1' }) })
  const books = new Map([['source', sourceBook], ['copy', { id: 'copy' }], ['single', { id: 'single' }]])
  const deleted = []
  const store = makeStore(await source('../src/stores/library.ts'), {
    getBook: async id => {
      if (id === 'unreadable') throw new Error('metadata read failure')
      return books.get(id)
    },
    deleteBook: async id => {
      deleted.push(id)
      if (id === 'broken') throw new Error('delete failure')
      books.delete(id)
    },
  })
  // The store cache may be stale or unloaded; persisted source ownership must win.
  store.books = [{ id: 'source' }, { id: 'copy' }, { id: 'single' }, { id: 'broken' }, { id: 'unreadable' }]
  await assert.rejects(store.removeBook('source'), /Source-linked books cannot be removed/)
  assert.deepEqual(deleted, [])
  const result = await store.batchRemoveBooks(['source', 'copy', 'copy', 'broken', 'unreadable'])
  assert.deepEqual(result, { succeeded: 1, failed: 3, failedIds: ['source', 'broken', 'unreadable'] })
  assert.deepEqual(deleted, ['copy', 'broken'])
  assert.deepEqual(store.books.map(book => book.id), ['source', 'single', 'broken', 'unreadable'])
  assert.equal(books.get('source'), sourceBook)
  assert.equal(sourceBook.location, '2')
  await store.removeBook('single')
  assert.equal(books.has('single'), false)
  assert.deepEqual(store.books.map(book => book.id), ['source', 'broken', 'unreadable'])
})

test('legacy paper PDFs stay visible and route normally without mutating metadata or positions', () => {
  const books = Object.freeze([
    Object.freeze({ id: 'legacy', title: 'Old PDF', author: '', tags: [], kind: 'paper', format: 'pdf', addedAt: 1, location: '2', progress: 0.5 }),
    Object.freeze({ id: 'ordinary', title: 'PDF', author: '', tags: [], kind: 'book', format: 'pdf', addedAt: 2 }),
  ])
  const before = JSON.stringify(books)
  assert.deepEqual(queryLibraryBooks(books, { formats: ['pdf'] }).items.map(book => book.id), ['ordinary', 'legacy'])
  assert.equal(readerPath(books[0]), '/read-pdf/legacy')
  assert.equal(readerPath(books[1]), '/read-pdf/ordinary')
  assert.equal(JSON.stringify(books), before)
  assert.throws(() => readerPath({ id: 'old', format: 'djvu' }), /Unsupported/)
})

test('navigation restores old PDF IDs into the generic reader, never persists transient locations', () => {
  let saved = JSON.stringify({ version: 1, path: '/read-paper/legacy' })
  const memory = { getItem: () => saved, setItem: (_key, value) => { saved = value } }
  assert.equal(restoreView(memory), '/read-pdf/legacy')
  assert.equal(restorableView('/papers'), '/library')
  assert.equal(rememberView('/read-paper/legacy', memory).success, true)
  assert.equal(JSON.parse(saved).path, '/read-pdf/legacy')
  assert.equal(restorableView('/read-pdf/legacy'), '/read-pdf/legacy')
  for (const value of ['/read-paper/', '/read-paper/id?loc=3', '/read-pdf/id#x', '/read-pdf/a b', null, {}]) {
    assert.equal(restorableView(value), null)
  }
})

test('retired public services/components/commands are absent; reader adaptations remain', async () => {
  for (const path of ['../src/services/convertLibraryBook.ts', '../src/services/bookToEpub.ts', '../src/services/booklists.ts',
    '../src/components/BooklistImportDialog.vue', '../src/components/BooklistShareDialog.vue', '../src/components/BooklistWantedPanel.vue']) {
    await assert.rejects(access(new URL(path, import.meta.url)), { code: 'ENOENT' })
  }
  const { scripts } = JSON.parse(await source('../package.json'))
  for (const command of ['test:convert-epub', 'e2e:convert-epub', 'test:booklists', 'e2e:booklists']) assert.equal(command in scripts, false)
  const importer = await source('../src/services/importer.ts')
  const bibliography = await source('../src/services/bibliographicMetadata.ts')
  assert.match(importer, /import \{ readBookMetadata \} from '\.\/bibliographicMetadata'/)
  assert.match(importer, /await readBookMetadata\(file, format\)/)
  assert.match(bibliography, /const \{ convertToEpub \} = await import\('\.\/textToEpub'\)/)
  assert.match(bibliography, /const \{ title \} = await convertToEpub\(file, file\.name, format as 'txt' \| 'md'\)/)
  const pdf = await source('../src/views/PdfReaderView.vue')
  assert.doesNotMatch(pdf, /meta\.value\?\.kind|SEL_PROMPT|openRight|runTranslateFor|cachedTranslation|paperTranslate|paper\.(setupHint|translateFailed|translating)|\/papers|\/read-paper\//)
  for (const contract of ['PdfiumDoc.open', 'initMupdf', 'library.saveProgress', 'storage.listAnnotations', 'decodeLoc', 'pdfSearchResults', 'zoomStep']) assert.ok(pdf.includes(contract), contract)
  assert.match(pdf, /kind: 'book'/)
})

function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let page = 1; page <= 3; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page * 2 + 3} 0 R >>`)
    const stream = `BT /F1 18 Tf 40 420 Td (SYNTHETIC PDF PAGE ${page}) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`).toString('base64')
}

// Dedicated localhost entry avoids importing other lanes' temporarily retired callers.
const harness = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import PdfReader from '/src/views/PdfReaderView.vue';
import { getStorage } from '/src/storage/index.ts';
import { useSettings } from '/src/stores/settings.ts';
import { useLibrary } from '/src/stores/library.ts';
import '/src/styles/main.css';
const pinia = createPinia(); setActivePinia(pinia);
const settings = useSettings(); settings.language='en'; settings.usageStats=false; settings.reader.portraitScroll=false;
settings.pdf.mode='paged'; settings.pdf.spreadMode='single'; settings.pdf.renderer=new URL(location.href).searchParams.get('renderer') || 'pdfium';
const storage = await getStorage();
const bytes = Uint8Array.from(atob('${syntheticPdf()}'), c => c.charCodeAt(0));
const id = await storage.addBook({ title:'Synthetic PDF', author:'Fixture', format:'pdf', fileName:'synthetic.pdf', tags:[], kind:'paper', addedAt:1, location:'2', progress:2/3 }, new Blob([bytes], {type:'application/pdf'}));
await storage.addAnnotation({id:'saved-note',bookId:id,cfi:'p:2:[[40,80,100,20]]',text:'SAVED NOTE',note:'PRESERVED NOTE',color:'#ffee88',createdAt:1});
const library = useLibrary(); await library.refresh();
const router = createRouter({history:createMemoryHistory(),routes:[{path:'/read-pdf/:id',component:PdfReader},{path:'/library',component:{render:()=>h('div','LIBRARY')}}]});
await router.push('/read-pdf/'+id); await router.isReady();
window.__fixture={storage,id,settings,library,router};
createApp({render:()=>h(RouterView,{key:router.currentRoute.value.path})}).use(pinia).use(router).mount('#app');
</script></body></html>`

const selectedPdfRenderer = process.env.PAGEWISE_TEST_PDF_RENDERER
const pdfCaseName = selectedPdfRenderer === 'mupdf' ? 'MuPDF only' : 'both PDF engines'
test(`synthetic browser: ${pdfCaseName}, legacy progress/annotations, controls, TXT/Markdown adaptation`, { timeout: 120_000 }, async () => {
  assert.ok(selectedPdfRenderer === undefined || selectedPdfRenderer === 'mupdf', 'Only the explicit MuPDF-only selection or default both-engine coverage is supported')
  const { createServer, normalizePath } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const { chromium } = await import('playwright')
  const executablePath = process.env.PAGEWISE_TEST_BROWSER || [chromium.executablePath(),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
  assert.ok(executablePath, 'Installed browser required; no download/install permitted')
  const artifacts = fileURLToPath(new URL('../../.cache/v03/', import.meta.url))
  await mkdir(artifacts, { recursive: true })
  const mupdfWasm = await realpath(new URL('../node_modules/mupdf/dist/mupdf-wasm.wasm', import.meta.url))
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    cacheDir: `${artifacts}/vite`, optimizeDeps: { include: ['vue', 'pinia', 'vue-router', 'dexie', 'fflate', 'yaml'] }, server: { host: '127.0.0.1', port: 0 },
    plugins: [vue(), { name: 'retirement-fixture',
      configResolved(config) { config.server.fs.allow.push(normalizePath(mupdfWasm)) },
      resolveId(id) { if (id === '/__v03_entry__.js') return '\0retirement-entry' },
      load(id) { if (id === '\0retirement-entry') return harness.split('<script type="module">')[1].split('</script>')[0] },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__v03__')) return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(harness.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="/__v03_entry__.js"></script>'))
      }) },
    }],
  })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ executablePath, headless: true })
    console.log(`browser: ${browser.version()}, fresh contexts, localhost only`)
    for (const renderer of selectedPdfRenderer === 'mupdf' ? ['mupdf'] : ['pdfium', 'mupdf']) {
      const context = await browser.newContext({ viewport: { width: 992, height: 1200 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
      const errors = []
      const external = []
      await context.route('**/*', route => {
        const url = route.request().url()
        if (url.startsWith(origin + '/') || /^(blob:|data:)/.test(url)) return route.continue()
        external.push(new URL(url).origin); return route.abort()
      })
      try {
        const page = await context.newPage()
        const fatal = new Promise((_, reject) => page.on('pageerror', error => { errors.push(error.message); reject(error) }))
        void fatal.catch(() => {})
        await page.goto(`${origin}/__v03__?renderer=${renderer}`)
        await Promise.race([page.locator('.p-canvas canvas').first().waitFor({ timeout: 40_000 }), fatal])
        assert.equal(await page.locator('.p-canvas canvas').first().getAttribute('data-renderer'), renderer, 'no hidden engine fallback')
        assert.equal(await page.locator('.page-input').inputValue(), '2', 'legacy saved page restored')
        assert.equal(await page.getByText('Translate', { exact: true }).count(), 0)
        await page.getByTitle('Highlights', { exact: true }).click()
        await page.getByText('PRESERVED NOTE', { exact: true }).waitFor()
        await page.getByTitle('Highlights', { exact: true }).click()
        await page.getByTitle('Next page', { exact: true }).click()
        await page.waitForFunction(async () => (await window.__fixture.storage.getBook(window.__fixture.id)).location === '3')
        await page.getByTitle(/Zoom in/).click()
        await page.keyboard.press('Control+f')
        await page.locator('.pdf-search-input').fill('SYNTHETIC')
        await page.locator('.p-search-rect').first().waitFor()
        await page.screenshot({ path: `${artifacts}/pdf-${renderer}-992.png` })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: `${artifacts}/pdf-${renderer}-390.png` })
        const adaptation = await page.evaluate(async () => {
          const { convertToEpub } = await import('/src/services/textToEpub.ts')
          const { makeFoliateBook } = await import('/src/services/foliateBook.ts')
          const results = []
          for (const format of ['txt','md']) {
            const { epub } = await convertToEpub(new Blob(['# Fixture\n\nINTERNAL TEXT MARKER']), 'fixture.'+format, format)
            const book = await makeFoliateBook(new File([epub], 'internal.epub'))
            try {
              const texts = await Promise.all(book.sections.map(async section => (await section.createDocument()).body.textContent))
              results.push({format,hasText:texts.join('').includes('INTERNAL TEXT MARKER')})
            } finally { book.destroy?.() }
          }
          let rejected = false
          try { await convertToEpub(new Blob(['no']), 'bad.html', 'html') } catch { rejected = true }
          return {results,rejected}
        })
        assert.deepEqual(adaptation, {results:[{format:'txt',hasText:true},{format:'md',hasText:true}],rejected:true})
        const data = await page.evaluate(async () => ({ book: await window.__fixture.storage.getBook(window.__fixture.id), notes: await window.__fixture.storage.listAnnotations(window.__fixture.id) }))
        assert.equal(data.book.kind, 'paper', 'legacy data not rewritten')
        assert.equal(data.notes[0].note, 'PRESERVED NOTE')
        await page.locator('.document-back').click()
        await page.getByText('LIBRARY', { exact: true }).waitFor()
        assert.deepEqual(errors, [])
        assert.deepEqual(external, [], 'no provider/telemetry/network access')
        console.log(`${renderer}: saved page, navigation/save, search, zoom, annotation, library Back, TXT/MD passed`)
      } finally { await context.close() }
    }
  } finally { await browser?.close(); await server.close() }
})
