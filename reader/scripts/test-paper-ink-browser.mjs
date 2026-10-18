import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { settingsDefaults } from '../src/stores/settings.ts'

const artifacts = resolve(process.env.PAPER_INK_ARTIFACTS || resolve(import.meta.dirname, '../../artifacts/paper-ink-browser'))
let server, browser, origin
const report = { runtime: 'isolated live Vite application / Microsoft Edge', cases: [], pageErrors: [], blockedExternalOrigins: [], apkBuilt: false, nativeDeviceTested: false }
const zh = '白纸墨黑使用留白和字号建立层次，批注不应遮住原来的文字。这里是重复的合成测试文本，不包含私人书籍。'
const en = 'Paper and ink use space and typography for hierarchy. Overlapping annotations must never cover or lighten the original letters. This is synthetic text, not a private book.'
function epub(lang) {
  const text = lang === 'zh' ? zh : en
  return Array.from(zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/book.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:pagewise:paper-ink-${lang}</dc:identifier><dc:title>Paper ink ${lang}</dc:title><dc:language>${lang}</dc:language><meta property="dcterms:modified">2026-10-19T00:00:00Z</meta></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`),
    'OEBPS/chapter.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}"><head><title>Paper ink</title></head><body><h1>Paper and ink</h1>${Array.from({ length: 24 }, (_, i) => `<p id="p${i}">${text.repeat(3)} ${i} <a href="#p10">Reference</a></p>`).join('')}</body></html>`),
  }))
}
function pdf() {
  const stream = 'BT /F1 18 Tf 40 720 Td (Paper and ink synthetic PDF) Tj 0 -30 Td (Original page pixels must not be inverted.) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let source = '%PDF-1.4\n', offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(source.length); source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const start = source.length
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Array.from(Buffer.from(source, 'ascii'))
}
before(async () => {
  await mkdir(artifacts, { recursive: true })
  server = await createServer({ root: resolve(import.meta.dirname, '..'), configLoader: 'runner', logLevel: 'error', server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(import.meta.dirname, '..'), realpathSync(resolve(import.meta.dirname, '../node_modules'))] } } })
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
})
after(async () => { await browser?.close(); await server?.close(); await writeFile(resolve(artifacts, 'results.json'), JSON.stringify(report, null, 2) + '\n') })
async function setup(lang, width) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: lang === 'zh' ? 'zh-CN' : 'en-US' })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { report.blockedExternalOrigins.push(url.origin); return route.abort() }
    return route.continue()
  })
  const initial = settingsDefaults()
  initial.language = lang; initial.appearance = 'light'; initial.reader.theme = 'light'; initial.reader.portraitScroll = false; initial.reader.flow = 'scrolled'
  initial.readingMode.eink.enabled = true
  initial.readingMode.eyeCare.dim = 30
  initial.readingMode.night = { ...initial.readingMode.night, schedule: true, from: '00:00', to: '23:59' }
  await context.addInitScript(state => { if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify(state)); sessionStorage.setItem('lightread-dianjing-intro-seen', '1') }, initial)
  const page = await context.newPage()
  page.on('pageerror', e => report.pageErrors.push(e.message))
  await page.goto(`${origin}/#/library`)
  const ids = await page.evaluate(async fixtures => {
    const { getStorage } = await import('/src/storage/index.ts')
    const storage = await getStorage(), ids = {}
    for (const [format, bytes] of Object.entries(fixtures)) ids[format] = await storage.addBook({ title: `Paper ink fixture ${format}`, author: 'Synthetic fixture', format, fileName: `paper-ink.${format}`, addedAt: Date.now(), progress: 0, tags: [] }, new Blob([new Uint8Array(bytes)]))
    return ids
  }, { epub: epub(lang), pdf: pdf() })
  return { context, page, ids }
}
async function openEpub(f) {
  await f.page.goto(`${origin}/#/read/${f.ids.epub}`)
  await f.page.waitForFunction(() => { const v = document.querySelector('.reader')?.__vueParentComponent?.setupState; return v && !v.loading && v.view?.renderer?.getContents?.()[0]?.doc?.getElementById('p0') }, undefined, { timeout: 30000 })
  assert.equal(await f.page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.error), '')
}
async function theme(page, name) {
  await page.evaluate(name => { const v = document.querySelector('.reader, .paper').__vueParentComponent.setupState; v.settings.reader.theme = name; v.showBars?.() }, name)
  await page.waitForFunction(name => document.querySelector('.reader, .paper')?.dataset.readerTheme === name, name)
}
async function readerState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.reader'), v = root.__vueParentComponent.setupState, content = v.view.renderer.getContents()[0], doc = content.doc
    const style = getComputedStyle(root), text = doc.defaultView.getComputedStyle(doc.getElementById('p0')), link = doc.defaultView.getComputedStyle(doc.querySelector('a'))
    return { theme: root.dataset.readerTheme, globalBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), bg: style.getPropertyValue('--bg').trim(), fg: text.color, uiText: style.getPropertyValue('--text').trim(), muted: style.getPropertyValue('--text-3').trim(), border: style.getPropertyValue('--border').trim(), link: link.color, linkDecoration: link.textDecorationLine, highlightCount: doc.defaultView.CSS?.highlights?.get('lr-annotation')?.size ?? 0, lines: content.overlayer?.element.querySelectorAll('line').length ?? 0, filledMarks: content.overlayer?.element.querySelectorAll('g[fill]:not([fill="none"])').length ?? 0, dim: !!v.modes.dimOverlayStyle.value, overflow: document.documentElement.scrollWidth > innerWidth + 1, fontSize: text.fontSize }
  })
}
async function addEpubMarks(page) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(i => { const v = document.querySelector('.reader').__vueParentComponent.setupState, { doc, index } = v.view.renderer.getContents()[0], p = doc.getElementById('p0'), range = doc.createRange(); range.setStart(p.firstChild, i * 3); range.setEnd(p.firstChild, 60 + i * 3); v.selection = { cfi: v.view.getCFI(index, range), text: range.toString() } }, i)
    await page.locator('.highlight-bar .hl-color').nth(i).click()
    await page.waitForFunction(count => { const v = document.querySelector('.reader').__vueParentComponent.setupState; return v.annotations.length === count && !v.selection }, i + 1)
  }
  await page.waitForFunction(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState, c = v.view.renderer.getContents()[0]; return c.doc.defaultView.CSS.highlights.get('lr-annotation')?.size === 4 && c.overlayer.element.querySelectorAll('line').length >= 4 })
}
test('real EPUB: bilingual day/night surfaces, overlapping annotations, panel cancellation and old-WebView fallback', { timeout: 150000 }, async () => {
  for (const lang of ['zh', 'en']) for (const width of [390, 960]) {
    const f = await setup(lang, width), { page } = f
    try {
      await openEpub(f); await addEpubMarks(page)
      for (const mode of ['light', 'dark']) {
        await theme(page, mode)
        await page.waitForFunction(mode => { const v = document.querySelector('.reader').__vueParentComponent.setupState, doc = v.view.renderer.getContents()[0].doc; return doc.defaultView.getComputedStyle(doc.getElementById('p0')).color === (mode === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)') }, mode)
        const snapshot = await readerState(page)
        assert.equal(snapshot.bg, mode === 'dark' ? '#000000' : '#ffffff')
        assert.equal(snapshot.uiText, mode === 'dark' ? '#ffffff' : '#000000')
        assert.equal(snapshot.globalBg, snapshot.bg)
        assert.equal(snapshot.muted, mode === 'dark' ? '#bbbbbb' : '#555555')
        assert.equal(snapshot.highlightCount, 4); assert.equal(snapshot.filledMarks, 0); assert.equal(snapshot.dim, false); assert.equal(snapshot.overflow, false)
        assert.equal(snapshot.link, snapshot.fg); assert.match(snapshot.linkDecoration, /underline/)
        const before = await page.evaluate(() => JSON.stringify(document.querySelector('.reader').__vueParentComponent.setupState.settings.reader))
        await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.openTypography('color'))
        await page.locator('.settings-pop').waitFor()
        assert.equal(await page.locator('.theme-btn').count(), 5)
        assert.ok((await page.locator('.theme-btn[aria-pressed="true"]').innerText()).includes('✓'))
        assert.equal(await page.locator('.settings-pop [data-section="color"] input[type="range"]').isDisabled(), true)
        assert.equal(await page.locator('.settings-pop').evaluate(e => getComputedStyle(e).backgroundColor), mode === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)')
        await page.locator('.theme-btn').nth(mode === 'dark' ? 0 : 3).click()
        await page.locator('.tp-close').click()
        assert.equal(await page.evaluate(() => JSON.stringify(document.querySelector('.reader').__vueParentComponent.setupState.settings.reader)), before)
        await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.togglePanel('annotations'))
        await page.locator('.panel .anno-item').first().waitFor()
        assert.equal(await page.locator('.panel .anno-dot').count(), 4)
        assert.equal(new Set(await page.locator('.panel .anno-dot').allTextContents()).size, 4)
        assert.ok(await page.locator('.panel .anno-dot').evaluateAll(nodes => nodes.every(e => getComputedStyle(e).borderRadius === '4px' && e.scrollWidth <= e.clientWidth + 1)))
        assert.equal(await page.locator('.panel').evaluate(e => getComputedStyle(e).backgroundColor), mode === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)')
        await page.screenshot({ path: resolve(artifacts, `${lang}-${width}-${mode}.png`) })
        await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.closeOverlays())
        report.cases.push({ lang, width, mode, ...snapshot, typographyCancelPreserved: true, annotationsPanelLabels: 4 })
      }
      if (lang === 'zh' && width === 390) {
        await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState, win = v.view.renderer.getContents()[0].doc.defaultView; win.__savedHighlight = win.Highlight; Object.defineProperty(win, 'Highlight', { configurable: true, value: undefined }); v.drawStoredAnnotations() })
        await page.waitForFunction(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState, c = v.view.renderer.getContents()[0]; return !c.doc.defaultView.CSS.highlights.has('lr-annotation') && c.overlayer.element.querySelectorAll('line').length >= 4 })
        report.oldWebViewFallback = 'underline-only, no glyph-covering fill'
        await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState, win = v.view.renderer.getContents()[0].doc.defaultView; Object.defineProperty(win, 'Highlight', { configurable: true, value: win.__savedHighlight }); v.drawStoredAnnotations() })
        await page.evaluate(async () => { const v = document.querySelector('.reader').__vueParentComponent.setupState; await v.removeAnnotation(v.annotations[0]) })
        await page.waitForFunction(() => document.querySelector('.reader').__vueParentComponent.setupState.view.renderer.getContents()[0].doc.defaultView.CSS.highlights.get('lr-annotation')?.size === 3)
        report.deletionClearsBackground = true
      }
      await page.evaluate(() => { document.querySelector('.reader').__vueParentComponent.setupState.settings.reader.fontSize = 40 })
      await page.waitForFunction(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState, doc = v.view.renderer.getContents()[0].doc; return parseFloat(doc.defaultView.getComputedStyle(doc.getElementById('p0')).fontSize) >= 32 })
      report.cases.push({ lang, width, largeBodyText: await readerState(page) })
      await page.reload(); await openEpub(f)
      assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.highlights.length), lang === 'zh' && width === 390 ? 3 : 4)
    } finally { await f.context.close() }
  }
  assert.deepEqual(report.pageErrors, [])
})
test('real PDF: original page pixels retained, monochrome line marks and reflow night colors', { timeout: 60000 }, async () => {
  const f = await setup('en', 960), { page } = f
  try {
    await page.goto(`${origin}/#/read/${f.ids.pdf}`)
    await page.waitForFunction(() => document.querySelector('.p-canvas canvas')?.width > 0, undefined, { timeout: 30000 })
    await page.evaluate(async () => { const v = document.querySelector('.paper').__vueParentComponent.setupState; const { getStorage } = await import('/src/storage/index.ts'); const storage = await getStorage(); for (const [i, color] of ['yellow', 'green', 'blue', 'red'].entries()) { const rec = { bookId: v.bookId, kind: 'highlight', cfi: v.encodeLoc(1, [{ x: 40, y: 64 + i * 30, w: 160, h: 18 }]), text: 'Synthetic PDF mark', color, createdAt: Date.now() }; const id = await storage.addAnnotation(rec); v.annotations.push({ ...rec, id }) } })
    await page.locator('.p-hl-rect').first().waitFor({ state: 'attached' })
    for (const mode of ['light', 'dark']) {
      await theme(page, mode)
      const actual = await page.evaluate(() => { const root = document.querySelector('.paper'), canvas = document.querySelector('.p-canvas canvas'), s = getComputedStyle(root), h = getComputedStyle(document.querySelector('.p-hl-rect')); return { bg: s.getPropertyValue('--bg').trim(), borderStyles: Array.from(document.querySelectorAll('.p-hl-rect')).map(e => getComputedStyle(e).borderBottomStyle), markBackground: h.backgroundColor, markOpacity: h.opacity, canvasFilter: getComputedStyle(canvas).filter, whitePixel: Array.from(canvas.getContext('2d').getImageData(10, 10, 1, 1).data), reflow: root.__vueParentComponent.setupState.reflowStyle } })
      assert.equal(actual.bg, mode === 'dark' ? '#000000' : '#ffffff')
      assert.equal(actual.markBackground, 'rgba(0, 0, 0, 0)'); assert.equal(actual.markOpacity, '1'); assert.equal(actual.canvasFilter, 'none')
      assert.deepEqual(actual.whitePixel, [255, 255, 255, 255]); assert.equal(new Set(actual.borderStyles).size, 4)
      assert.equal(actual.reflow['--reflow-bg'], actual.bg)
      await page.screenshot({ path: resolve(artifacts, `pdf-${mode}.png`) })
      report.cases.push({ pdf: true, mode, ...actual })
    }
    await page.evaluate(async () => document.querySelector('.paper').__vueParentComponent.setupState.switchPdfLayout('reflow'))
    await page.locator('.reflow-article').waitFor()
    assert.equal(await page.locator('.reflow-scroll').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(0, 0, 0)')
    assert.deepEqual(report.pageErrors, [])
  } finally { await f.context.close() }
})
