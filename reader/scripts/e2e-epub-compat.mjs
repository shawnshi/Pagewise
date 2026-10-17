/**
 * Run after starting the built app (default http://localhost:4173, override with E2E_BASE).
 * No external fixture downloads. Scenarios:
 *  - EPUB import + reading with Object/Map.groupBy removed (HarmonyOS 4.x WebView, GitHub #9)
 *  - same, with a document provider that returns broken File slices
 *  - "legacy WebView": also removes structuredClone, Array/String/TypedArray .at, findLast(Index),
 *    crypto.randomUUID, AbortSignal.timeout, navigator.clipboard and constructable stylesheets
 *    (Chrome 89 / Safari 15 level), then imports an EPUB and a CBZ (fixed-layout renderer).
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const base = process.env.E2E_BASE ?? 'http://localhost:4173'
const title = 'EPUB Compatibility Fixture'
const chapterText = 'EPUB-COMPAT-BODY: 旧版 WebView 也能读取正文。'
const epub = zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`),
  'OEBPS/package.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">urn:uuid:lightread-epub-compat</dc:identifier>
        <dc:title id="title">${title}</dc:title>
        <dc:creator id="author">Compatibility Author</dc:creator>
        <dc:language>zh</dc:language>
        <meta property="dcterms:modified">2026-10-03T00:00:00Z</meta>
        <meta refines="#title" property="title-type">main</meta>
        <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="chapter"/></spine>
    </package>`),
  'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
      <head><title>Contents</title></head>
      <body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">兼容章节</a></li></ol></nav></body>
    </html>`),
  'OEBPS/chapter.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml" lang="zh">
      <head><title>兼容章节</title></head>
      <body><h1>兼容章节</h1><p>${chapterText}</p></body>
    </html>`),
  // Exceed foliate's extended ZIP tail scan so the provider scenario needs random reads.
  'OEBPS/padding.bin': [new Uint8Array(1_100_000), { level: 0 }],
})

// 1×1 PNG pages: the comic book opens through foliate's fixed-layout renderer (adoptedStyleSheets)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const comicTitle = 'legacy-comic'
const cbz = zipSync({ '001.png': [new Uint8Array(png), { level: 0 }], '002.png': [new Uint8Array(png), { level: 0 }] })

/** Strip APIs that Chrome 89 / Safari 15 era WebViews lack, before any app script runs. */
function removeModernApis() {
  const typed = Object.getPrototypeOf(Int8Array.prototype)
  for (const [obj, key] of [
    [Array.prototype, 'at'], [String.prototype, 'at'], [typed, 'at'],
    [Array.prototype, 'findLast'], [Array.prototype, 'findLastIndex'], [typed, 'findLast'], [typed, 'findLastIndex'],
    [globalThis, 'structuredClone'], [AbortSignal, 'timeout'], [Object.getPrototypeOf(crypto), 'randomUUID'],
    [Object.getPrototypeOf(navigator), 'clipboard'],
    [ShadowRoot.prototype, 'adoptedStyleSheets'], [Document.prototype, 'adoptedStyleSheets'],
    [CSSStyleSheet.prototype, 'replaceSync'], [CSSStyleSheet.prototype, 'replace'],
  ]) delete obj[key]
  // Safari < 16.4: CSSStyleSheet exists but is not constructible
  const Native = CSSStyleSheet
  const Illegal = function CSSStyleSheet() { throw new TypeError('Illegal constructor') }
  Illegal.prototype = Native.prototype
  Object.defineProperty(globalThis, 'CSSStyleSheet', { configurable: true, writable: true, value: Illegal })
  window.__legacyMissingAtStartup = [
    typeof [].at, typeof [].findLast, typeof structuredClone, typeof crypto.randomUUID,
    typeof AbortSignal.timeout, typeof navigator.clipboard, 'adoptedStyleSheets' in ShadowRoot.prototype,
  ].every(v => v === 'undefined' || v === false)
}

const browser = await chromium.launch({ headless: true })
try {
  for (const simulateProvider of [false, true, 'legacy']) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' })
    try {
      await context.route('https://api.github.com/repos/yzfly/LightRead/releases/latest', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tag_name: 'v0.0.0', body: '', published_at: '2026-01-01', assets: [] }),
      }))
      if (simulateProvider === 'legacy') await context.addInitScript(removeModernApis)
      await context.addInitScript(({ simulateProvider }) => {
        delete Object.groupBy
        delete Map.groupBy
        window.__epubCompatMissingAtStartup = typeof Object.groupBy === 'undefined' && typeof Map.groupBy === 'undefined'
        window.__epubCompatBadSlices = 0
        if (simulateProvider !== true) return
        const providerFiles = new WeakSet()
        document.addEventListener('change', event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
            for (const file of event.target.files ?? []) providerFiles.add(file)
          }
        }, true)
        const slice = File.prototype.slice
        File.prototype.slice = function (start, end, type) {
          // Keep the ZIP magic check intact; break the selected provider's directory reads.
          // The fallback's new in-memory File is deliberately not in this WeakSet.
          if (providerFiles.has(this) && !(start === 0 && end === 4)) {
            window.__epubCompatBadSlices++
            return new Blob([new Uint8Array(Math.max(0, (end ?? this.size) - (start ?? 0)))], { type })
          }
          return slice.call(this, start, end, type)
        }
      }, { simulateProvider })

      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
      assert.equal(await page.evaluate(() => window.__epubCompatMissingAtStartup), true)
      assert.deepEqual(await page.evaluate(() => [typeof Object.groupBy, typeof Map.groupBy]), ['function', 'function'])

      await page.setInputFiles('input[type="file"][multiple]', {
        name: simulateProvider === true ? 'provider-file.epub' : 'legacy-webview.epub',
        mimeType: 'application/epub+zip',
        buffer: Buffer.from(epub),
      })
      const card = page.locator('.book-card').filter({ hasText: title })
      await card.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await card.innerText(), /Compatibility Author/)
      if (simulateProvider === true) assert.ok(await page.evaluate(() => window.__epubCompatBadSlices > 0))
      await card.click()
      await page.waitForSelector('foliate-view', { timeout: 15_000 })
      await page.waitForFunction(expected => {
        const view = document.querySelector('foliate-view')
        return view?.renderer?.getContents?.().some(({ doc }) => doc?.body?.textContent?.includes(expected))
      }, chapterText, { timeout: 15_000 })
      assert.equal(await page.evaluate(() => document.querySelector('foliate-view')?.book?.metadata?.title), title)
      if (simulateProvider === 'legacy') {
        assert.equal(await page.evaluate(() => window.__legacyMissingAtStartup), true)
        assert.deepEqual(await page.evaluate(() => [typeof [].at, typeof [].findLast, typeof structuredClone,
          typeof crypto.randomUUID, typeof AbortSignal.timeout, typeof navigator.clipboard?.writeText]),
        ['function', 'function', 'function', 'function', 'function', 'function'])
        // Fixed-layout renderer (CBZ) builds its shadow styles with new CSSStyleSheet()
        await page.evaluate(() => { location.hash = '#/library' })
        await page.locator('.book-card').first().waitFor({ state: 'visible', timeout: 15_000 })
        await page.setInputFiles('input[type="file"][multiple]', { name: `${comicTitle}.cbz`, mimeType: 'application/vnd.comicbook+zip', buffer: Buffer.from(cbz) })
        const comic = page.locator('.book-card').filter({ hasText: comicTitle })
        await comic.waitFor({ state: 'visible', timeout: 15_000 })
        await comic.click()
        await page.waitForFunction(() => {
          const renderer = document.querySelector('foliate-view')?.renderer
          // The renderer's shadow root is closed; its :host { display: flex } rule proves the sheet applied
          return renderer?.localName === 'foliate-fxl' && getComputedStyle(renderer).display === 'flex'
            && renderer.getContents?.().some(({ doc }) => doc?.querySelector('img'))
        }, null, { timeout: 15_000 })
      }
      assert.deepEqual(errors, [], `Unhandled errors: ${errors.join('; ')}`)
      const label = simulateProvider === 'legacy' ? ', Chrome 89 / Safari 15 level APIs and a fixed-layout CBZ'
        : simulateProvider ? ' and broken provider slices' : ''
      console.log(`PASS EPUB import and reading with missing groupBy APIs${label}`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
