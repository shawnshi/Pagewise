import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { build, preview, createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'
import ts from 'typescript'
import { settingsDefaults } from '../src/stores/settings.ts'

const workspace = resolve(import.meta.dirname, '../..'), reader = resolve(workspace, 'reader')
const artifacts = resolve(workspace, process.env.PDF_BROWSER_ARTIFACTS || '.cache/performance-20261019')
const browserPort = Number(process.env.PDF_BROWSER_PORT || 41873)
const harnessPath = relative(workspace, resolve(artifacts, 'worker-harness.html')).replaceAll('\\', '/')
const report = { runtime: 'Desktop Edge; synthetic PDFs; no BOOX/device behavior proved', cases: [], errors: [] }
let browser, server, builtServer, builtOrigin, origin
function pdf(pages = 12, repeats = 120) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], kids = []
  for (let i = 0; i < pages; i++) {
    const page = objects.length + 1, content = page + 1, link = page + 2
    kids.push(`${page} 0 R`)
    const stream = `BT /F1 12 Tf 40 720 Td (Page ${i + 1} synthetic searchable text) Tj ` + Array.from({ length: repeats }, (_, j) => `0 -1 Td (Synthetic worker text ${j} repeated.) Tj `).join('') + ' ET'
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R /Annots [${link} 0 R] >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Annot /Subtype /Link /Rect [40 700 240 730] /A << /S /URI /URI (https://example.invalid/synthetic) >> >>')
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  let source = '%PDF-1.4\n', offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(source.length); source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const start = source.length
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Array.from(Buffer.from(source, 'ascii'))
}
before(async () => {
  await mkdir(artifacts, { recursive: true })
  // Embed the frozen production baseline function, not a hand-written performance surrogate.
  const baseline = await readFile(process.env.PDF_BASELINE_VIEW || resolve(artifacts, 'baseline/reader/src/views/PdfReaderView.vue'), 'utf8')
  const script = baseline.split('<script setup lang="ts">')[1].split('</script>')[0]
  const ast = ts.createSourceFile('baseline.ts', script, ts.ScriptTarget.Latest, true)
  const functions = ['mupdfDoc', 'renderBitmapCanvas'].map(name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast)).join('\n')
  const oldFunctions = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const harness = `<script type="module">
import { PdfRasterClient } from '/reader/src/services/pdfRasterClient.ts';
import { PdfiumDoc, hitBoundary, rangeText, rangeRects } from '/reader/src/services/pdfium.ts';
import { initMupdf } from '/reader/src/services/mupdf.ts';
import { pdfRenderTarget } from '/reader/src/services/pdfRenderBudget.ts';
let renderBytes, mupdfDocPromise=null, mupdfRenderFailed=false, readerAlive=true, pdm=null;
const settings={pdf:{renderer:'mupdf'}}, dimensionsOf=()=>({w:600,h:800}), displaySizeOf=()=>({w:930,h:1240}), DPR=()=>2;
${oldFunctions}
window.pdfHarness={PdfRasterClient,PdfiumDoc,hitBoundary,rangeText,rangeRects, baseline:async bytes=>{renderBytes=new Uint8Array(bytes);return renderBitmapCanvas(1,1)}};
</script>`
  const html = resolve(artifacts, 'worker-harness.html')
  await writeFile(html, harness)
  const outDir = resolve(artifacts, 'worker-built')
  await build({ root: workspace, configFile: resolve(reader, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true, rolldownOptions: { input: html } } })
  builtServer = await preview({ root: workspace, configFile: resolve(reader, 'vite.config.ts'), build: { outDir }, preview: { host: '127.0.0.1', port: browserPort + 1, strictPort: true } })
  builtOrigin = `http://127.0.0.1:${builtServer.httpServer.address().port}`
  // Vite build sets NODE_ENV in this test process; restore it for Vue's dev inspection surface.
  process.env.NODE_ENV = 'development'
  server = await createServer({ root: reader, logLevel: 'error', server: { host: '127.0.0.1', port: browserPort, strictPort: true, fs: { allow: [reader, realpathSync(resolve(reader, 'node_modules'))] } } })
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
}, { timeout: 120000 })
after(async () => {
  await browser?.close(); await server?.close(); await builtServer?.close()
  await writeFile(resolve(artifacts, 'pdf-browser-results.json'), JSON.stringify(report, null, 2) + '\n')
})
async function context(base) {
  const context = await browser.newContext({ viewport: { width: 930, height: 1240 }, deviceScaleFactor: 2 })
  await context.route('**/*', route => { const u = new URL(route.request().url()); return ['http:', 'https:'].includes(u.protocol) && u.origin !== base ? route.abort() : route.continue() })
  return context
}

test('production-built Worker: same full-DPR pixels as frozen baseline; responsive UI; geometry/link coordinates; bounded search', { timeout: 120000 }, async () => {
  const ctx = await context(builtOrigin), page = await ctx.newPage()
  page.on('pageerror', e => report.errors.push(e.message))
  try {
    await page.goto(`${builtOrigin}/${harnessPath}`)
    await page.waitForFunction(() => window.pdfHarness)
    const actual = await page.evaluate(async bytes => {
      const { PdfRasterClient, PdfiumDoc, hitBoundary, rangeText, rangeRects, baseline } = window.pdfHarness
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
      const client = new PdfRasterClient(blob)
      const heartbeat = async action => {
        let beats = 0, maxGap = 0, last = performance.now()
        const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; beats++ }, 2)
        const start = performance.now(); const value = await action(); const elapsed = performance.now() - start
        maxGap = Math.max(maxGap, performance.now() - last); clearInterval(timer)
        return { value, elapsed, beats, maxGap }
      }
      const request = { page: 0, width: 1860, height: 2480, renderer: 'mupdf' }
      const cold = await heartbeat(() => client.render(request, 0))
      const canvas = document.createElement('canvas'); canvas.width = 1860; canvas.height = 2480
      const draw = bitmap => { canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); return canvas.getContext('2d').getImageData(0, 0, 1860, 2480).data }
      const pixels = draw(cold.value.bitmap)
      const old = await heartbeat(() => baseline(bytes))
      const oldPixels = old.value.getContext('2d').getImageData(0, 0, 1860, 2480).data
      let different = 0, ink = 0
      for (let i = 0; i < pixels.length; i++) { if (pixels[i] !== oldPixels[i]) different++; if (i % 4 === 0 && pixels[i] < 200) ink++ }
      const warm = [], baselineWarm = []
      for (let i = 0; i < 7; i++) {
        const run = await heartbeat(() => client.render(request, 0)); run.value.bitmap.close(); warm.push({ elapsed: run.elapsed, beats: run.beats, maxGap: run.maxGap })
        const oldRun = await heartbeat(() => baseline(bytes)); oldRun.value.width = oldRun.value.height = 0
        baselineWarm.push({ elapsed: oldRun.elapsed, beats: oldRun.beats, maxGap: oldRun.maxGap })
      }
      const summary = runs => { const sorted = runs.map(r => r.elapsed).sort((a, b) => a - b); return { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)] } }
      const geom = await PdfiumDoc.open(await blob.arrayBuffer())
      const model = geom.text(0), rects = rangeRects(model, 0, 6), boundary = hitBoundary(model, model.boxes[0], model.boxes[1] + model.boxes[3] / 2)
      const links = geom.links(0)
      const codesBefore = geom.textCache.bytes
      for (let p = 0; p < geom.pages.length; p++) geom.pageCodes(p)
      const codesAfter = geom.textCache.bytes
      let unboundedGeometryBytes = 0
      for (let p = 0; p < geom.pages.length; p++) {
        const t = geom.text(p)
        unboundedGeometryBytes += t.codes.byteLength + t.boxes.byteLength + t.sizes.byteLength + t.lines.length * 48
      }
      const geometryBytes = geom.textCache.bytes
      const pdfiumResult = await client.render({ ...request, renderer: 'pdfium' }, 0)
      const pdfiumRenderer = pdfiumResult.renderer; pdfiumResult.bitmap.close()
      const text = rangeText(model, 0, 6)
      const invalid = await client.render({ ...request, width: 100000 }, 0).then(() => 'bad', e => e.message)
      geom.close(); client.close()
      return { dimensions: [canvas.width, canvas.height], renderer: cold.value.renderer, different, ink, cold: { elapsed: cold.elapsed, beats: cold.beats, maxGap: cold.maxGap }, baseline: { elapsed: old.elapsed, beats: old.beats, maxGap: old.maxGap }, warm, baselineWarm, warmSummary: summary(warm), baselineWarmSummary: summary(baselineWarm), selection: { text, rects, boundary }, links, codesBefore, codesAfter, geometryBytes, unboundedGeometryBytes, pdfiumRenderer, invalid, blobBytes: blob.size }
    }, pdf(100, 400))
    report.cases.push({ name: 'built-worker', ...actual })
    assert.deepEqual(actual.dimensions, [1860, 2480]); assert.equal(actual.renderer, 'mupdf')
    assert.equal(actual.different, 0); assert.ok(actual.ink > 100)
    assert.ok(actual.cold.beats > 0, 'UI remains responsive while worker initializes and rasterizes')
    assert.match(actual.selection.text, /Page 1/); assert.ok(actual.selection.rects.length > 0); assert.ok(actual.selection.boundary <= 1)
    assert.deepEqual(actual.links[0], { x: 40, y: 70, w: 200, h: 30, url: 'https://example.invalid/synthetic' })
    assert.equal(actual.codesBefore, actual.codesAfter, 'lightweight search does not retain geometry')
    assert.ok(actual.geometryBytes <= 8 * 1024 * 1024)
    assert.ok(actual.unboundedGeometryBytes > 8 * 1024 * 1024, 'workload must exercise geometry eviction')
    assert.equal(actual.pdfiumRenderer, 'pdfium')
    assert.match(actual.invalid, /Invalid PDF raster dimensions/)
    assert.deepEqual(report.errors, [])
  } finally { await ctx.close() }
})

async function appFixture(mode = 'paged') {
  const ctx = await context(origin), initial = settingsDefaults()
  initial.pdf.renderer = 'mupdf'; initial.pdf.mode = mode; initial.reader.portraitScroll = false; initial.reader.flow = 'paginated'
  await ctx.addInitScript(state => { localStorage.setItem('lightread-settings', JSON.stringify(state)) }, initial)
  const page = await ctx.newPage()
  await page.goto(`${origin}/#/library`)
  const id = await page.evaluate(async bytes => {
    const { getStorage } = await import('/src/storage/index.ts')
    return (await getStorage()).addBook({ title: 'Worker synthetic', author: 'Fixture', format: 'pdf', fileName: 'synthetic.pdf', addedAt: Date.now(), progress: 0, tags: [] }, new Blob([new Uint8Array(bytes)]))
  }, pdf())
  return { ctx, page, id }
}
test('actual reader: page-turn cache reuse, rapid navigation/zoom, search and close during pending raster', { timeout: 60000 }, async () => {
  const { ctx, page, id } = await appFixture()
  page.on('pageerror', e => report.errors.push(e.message))
  try {
    await page.goto(`${origin}/#/read-pdf/${id}`)
    await page.waitForFunction(() => document.querySelector('.paper canvas')?.width > 0, undefined, { timeout: 30000 })
    const actual = await page.evaluate(async () => {
      const v = document.querySelector('.paper').__vueParentComponent.setupState
      if (!v.bookPaged) throw new Error('Paged fixture is not actually paged')
      // Font/toolbar readiness can change the initial target by a few pixels.
      // Reuse is required for an identical settled target, not across raster sizes.
      await document.fonts.ready
      await v.renderPaged()
      const original = document.querySelector('[data-page="1"] .p-canvas canvas')
      const cacheBefore = [...v.bitmapCache.entries.keys()]
      const start = performance.now(); await v.pagedGoto(2); const turnMs = performance.now() - start
      if (!document.querySelector('[data-page="2"] .p-canvas canvas')) throw new Error('Page two never mounted')
      const revisitStart = performance.now(); await v.pagedGoto(1); const revisitMs = performance.now() - revisitStart
      const sameCanvas = original === document.querySelector('[data-page="1"] .p-canvas canvas')
      const cacheAfter = [...v.bitmapCache.entries.keys()]
      await Promise.allSettled([v.pagedGoto(3), v.applyZoom(1.25), v.pagedGoto(8), v.applyZoom(1), v.pagedGoto(4)])
      await v.pagedGoto(4)
      v.pdfSearchQuery = 'Page 9'; await v.runPdfSearch()
      const hits = v.pdfSearchResults.map(h => h.page)
      const activeCanvas = document.querySelector('[data-page="9"] .p-canvas canvas')
      for (let p = 1; p <= 6; p++) await v.renderRasterCanvas(p, 2700, 3600, 1)
      const visibleSurvivedPressure = !!activeCanvas?.isConnected && activeCanvas.width > 0
      return { turnMs, revisitMs, sameCanvas, visibleSurvivedPressure, cacheBefore, cacheAfter, hits, error: v.error, bitmapBytes: v.bitmapCache.bytes, page: v.currentPage, renderer: document.querySelector('.p-canvas canvas')?.dataset.renderer }
    })
    report.cases.push({ name: 'actual-reader', ...actual })
    assert.equal(actual.error, ''); assert.ok(actual.sameCanvas); assert.ok(actual.visibleSurvivedPressure); assert.ok(actual.hits.includes(9)); assert.ok(actual.bitmapBytes <= 96 * 1024 * 1024)
    await page.evaluate(() => { const v = document.querySelector('.paper').__vueParentComponent.setupState; void v.pagedGoto(11); location.hash = '#/library' })
    await page.waitForURL('**/#/library'); await page.waitForTimeout(150)
    assert.deepEqual(report.errors, [])
  } finally { await ctx.close() }
})

test('PERF-REVIEW-001: prefetched scroll page becomes visible and survives bitmap pressure', { timeout: 60000 }, async () => {
  const { ctx, page, id } = await appFixture('scroll')
  page.on('pageerror', e => report.errors.push(e.message))
  try {
    await page.goto(`${origin}/#/read-pdf/${id}`)
    await page.waitForFunction(() => document.querySelector('[data-page="1"] .p-canvas canvas')?.width > 0)
    await page.evaluate(async () => {
      const v = document.querySelector('.paper').__vueParentComponent.setupState
      if (v.bookPaged) throw new Error('Scroll fixture is paged')
      await document.fonts.ready
      await v.applyZoom(3)
    })
    await page.waitForFunction(() => {
      const v = document.querySelector('.paper').__vueParentComponent.setupState
      return !v.prefetchDraining && !v.rendering.size
    })
    const actual = await page.evaluate(async () => {
      const v = document.querySelector('.paper').__vueParentComponent.setupState
      await v.renderScrollPage(3, 1)
      const canvas = document.querySelector('[data-page="3"] .p-canvas canvas')
      if (!canvas?.width) throw new Error('Page 3 was not prefetched')
      v.scrollGoto(3)
      v.updateViewport()
      const entry = [...v.bitmapCache.entries].find(([, entry]) => entry.value === canvas)
      const pinned = !!entry && v.bitmapCache.pinned.has(entry[0])
      // Real worker neighbors compete with the already-mounted visible page.
      for (const p of [4, 5, 6]) await v.renderRasterCanvas(p, 2700, 3600, 1)
      return { page: v.currentPage, pinned, visibleSurvivedPressure: canvas.isConnected && canvas.width > 0, bytes: v.bitmapCache.bytes, error: v.error }
    })
    report.cases.push({ name: 'scroll-visible-pressure', ...actual })
    assert.equal(actual.page, 3)
    assert.ok(actual.pinned, 'already-rendered visible scroll page must regain its pin')
    assert.ok(actual.visibleSurvivedPressure, 'prefetch evicted a visible scroll canvas')
    assert.ok(actual.bytes <= 96 * 1024 * 1024)
    assert.equal(actual.error, '')
    assert.deepEqual(report.errors, [])
  } finally { await ctx.close() }
})

test('actual reader: Worker unavailable is a deliberate safe error, not synchronous raster fallback', { timeout: 45000 }, async () => {
  const { ctx, page, id } = await appFixture()
  try {
    await page.evaluate(() => { window.Worker = class { constructor() { throw new DOMException('Synthetic CSP denial', 'SecurityError') } } })
    await page.evaluate(id => { location.hash = `#/read-pdf/${id}` }, id)
    await page.waitForFunction(() => document.querySelector('.paper')?.__vueParentComponent.setupState.error, undefined, { timeout: 20000 })
    const actual = await page.evaluate(() => ({ error: document.querySelector('.paper').__vueParentComponent.setupState.error, canvases: document.querySelectorAll('.p-canvas canvas').length }))
    report.cases.push({ name: 'worker-unavailable', ...actual })
    assert.match(actual.error, /Worker unavailable.*Synthetic CSP denial/); assert.equal(actual.canvases, 0)
  } finally { await ctx.close() }
})
