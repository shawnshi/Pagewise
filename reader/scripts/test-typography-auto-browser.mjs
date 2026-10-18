import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { settingsDefaults } from '../src/stores/settings.ts'

const artifactRun = process.env.TYPOGRAPHY_BROWSER_RUN || 'browser-final'
if (!/^[\w-]+$/.test(artifactRun)) throw new Error('Invalid typography artifact namespace')
const artifacts = resolve(import.meta.dirname, '../../.cache/typography-nesting-20261018-r4', artifactRun)
let server, browser, origin
const zh = '合成阅读段落用于检验排版、缩进与阅读位置，文字不含任何私人资料。'
const en = 'The reader opens the synthetic book and keeps the words in their original order. This paragraph is only for typography and position testing.'
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function epub(language, { mixed = false, vertical = false, fixed = false, second = false } = {}) {
  let paragraphs = ''
  for (let i = 0; i < 70; i++) {
    const text = mixed ? i % 2 ? en : zh : language.startsWith('en') ? en : zh
    paragraphs += `<p id="p${i}"${i === 1 ? ' style="font:italic 700 9px/1.2 serif !important; margin-block-start:6px !important"' : ''}>${xml(text.repeat(3))} ${i}</p>`
  }
  const content = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" lang="${language}" xml:lang="${language}"><head><title>Synthetic</title><meta name="viewport" content="width=600,height=800"/><style>html,body{font-size:10px!important}p{margin:0}blockquote p{font-size:11px!important;text-indent:7px!important}.poem p{white-space:pre-line;font-size:12px!important}${vertical ? 'body{writing-mode:vertical-rl}p{font-size:20px!important;line-height:2!important;text-indent:9px!important}' : ''}</style></head><body><h1>Synthetic chapter</h1>${paragraphs}<blockquote><p id="quote">${xml(en)}</p></blockquote><div class="poem"><p id="poem">Verse one<br/>Verse two</p></div></body></html>`
  return Array.from(zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/book.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:pagewise:typography-synthetic</dc:identifier><dc:title>Synthetic typography</dc:title><dc:language>${language}</dc:language><meta property="dcterms:modified">2026-10-17T00:00:00Z</meta>${fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${second ? '<item id="second" href="chapter2.xhtml" media-type="application/xhtml+xml"/>' : ''}</manifest><spine><itemref idref="chapter"/>${second ? '<itemref idref="second"/>' : ''}</spine></package>`),
    'OEBPS/chapter.xhtml': strToU8(content),
    ...(second ? { 'OEBPS/chapter2.xhtml': strToU8(content) } : {}),
  }))
}
const balanced = Array.from({ length: 70 }, (_, i) => (i % 2 ? en : zh).repeat(3)).join('\n\n')
const fixtures = [
  { name: 'MIX-2', bytes: epub('zh-CN', { mixed: true, second: true }), format: 'epub' },
  { name: 'MIX-U', bytes: epub('', { mixed: true }), format: 'epub' },
  { name: 'MIX-TXT', bytes: Array.from(strToU8(balanced)), format: 'txt' },
  { name: 'MIX-MD', bytes: Array.from(strToU8(balanced)), format: 'md' },
  { name: 'ZH', bytes: epub('zh-CN'), format: 'epub' },
  { name: 'EN', bytes: epub('en-US'), format: 'epub' },
  { name: 'MIX', bytes: epub('zh-CN', { mixed: true }), format: 'epub' },
  { name: 'VERT', bytes: epub('zh', { vertical: true }), format: 'epub' },
  { name: 'FIXED', bytes: epub('en', { fixed: true }), format: 'epub' },
  { name: 'TXT', bytes: Array.from(strToU8(Array.from({ length: 70 }, (_, i) => `${i} ${en.repeat(3)}`).join('\n\n'))), format: 'txt' },
]
before(async () => {
  await mkdir(artifacts, { recursive: true })
  server = await createServer({ root: resolve(import.meta.dirname, '..'), cacheDir: resolve(artifacts, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(viewport = { width: 992, height: 1322 }, locale = 'zh') {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage(); const errors = [], external = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    let requestOrigin
    try { requestOrigin = new URL(route.request().url()).origin }
    catch { errors.push('Invalid request URL'); return route.abort() }
    if (requestOrigin !== origin) { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  const initial = settingsDefaults(); initial.language = locale; initial.reader.portraitScroll = false
  await page.addInitScript(state => {
    if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify(state))
    sessionStorage.setItem('lightread-dianjing-intro-seen', '1')
    window.__typographyObservedErrors = []
    window.addEventListener('error', event => { window.__typographyObservedErrors.push(event.message) })
  }, initial)
  await page.goto(`${origin}/#/library`)
  const ids = await page.evaluate(async fixtures => {
    const { getStorage } = await import('/src/storage/index.ts')
    const storage = await getStorage(), ids = {}
    for (const item of fixtures) {
      ids[item.name] = await storage.addBook({ title: `Synthetic ${item.name}`, author: 'Fixture', format: item.format, fileName: `typography-${item.name}.${item.format}`, addedAt: Date.now(), progress: 0, tags: [] }, new Blob([new Uint8Array(item.bytes)]))
    }
    return ids
  }, fixtures)
  return { page, context, ids, errors, external }
}
async function open(f, name) {
  await f.page.goto(`${origin}/#/read/${f.ids[name]}`)
  await f.page.waitForFunction(id => { const v = document.querySelector('.reader')?.__vueParentComponent?.setupState; return v && v.bookId === id && !v.loading }, f.ids[name], { timeout: 25000 })
  assert.equal(await f.page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.error), '', name + ' opens successfully')
}
async function state(page) {
  return page.evaluate(() => {
    const v = document.querySelector('.reader').__vueParentComponent.setupState
    const doc = v.view.renderer.getContents?.()[0]?.doc
    const plain = value => { try { return JSON.parse(JSON.stringify(value)) } catch (cause) { throw new Error('Non-serializable reader state', { cause }) } }
    const css = id => { const p = doc?.getElementById(id) ?? (['p0', 'p1', 'p2'].includes(id) ? doc?.querySelectorAll('p')[Number(id.slice(1))] : null); if (!p) return null; const c = doc.defaultView.getComputedStyle(p); return { size: c.fontSize, height: c.lineHeight, indent: c.textIndent, weight: c.fontWeight, italic: c.fontStyle, margin: c.marginBlockStart, align: c.textAlign, marked: p.hasAttribute('data-pw-paragraph') } }
    return { profile: v.effectiveTypography.profile, prefs: plain(v.effectiveReader), context: plain(v.bookTypographyContext), books: plain(v.settings.typographyBooks), globals: plain(v.settings.reader), cfi: v.currentCfi, p0: css('p0'), p1: css('p1'), p2: css('p2'), quote: css('quote'), poem: css('poem'), fontWarning: v.typographyFontWarning, fixed: v.fixedLayout, text: doc?.body.textContent }
  })
}
async function panel(page) {
  const labels = await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState; v.showBars(); return [v.t('reader.typography'), v.t('reader.dockTypography')] })
  let button = page.getByRole('button', { name: labels[0], exact: true })
  if (!await button.count()) button = page.getByRole('button', { name: labels[1], exact: true })
  await button.first().click()
  const dialog = page.locator('.settings-pop[role=dialog]')
  await dialog.waitFor(); return dialog
}
async function setFont(dialog, value) {
  const input = dialog.locator('input[type=range][min="8"]'); await input.fill(String(value)); await input.dispatchEvent('input')
}
async function apply(dialog) { await dialog.locator('.tp-btn-apply').click(); await dialog.waitFor({ state: 'detached', timeout: 20000 }) }
async function positionInfo(page) {
  return page.evaluate(async () => {
    const v = document.querySelector('.reader').__vueParentComponent.setupState
    const { getStorage } = await import('/src/storage/index.ts')
    const meta = await (await getStorage()).getBook(v.bookId)
    return { bookId: v.bookId, current: v.currentCfi, primary: v.readerSession.reading, saved: meta.location, fraction: meta.progress }
  })
}
async function navigateMiddle(page) {
  return page.evaluate(async () => {
    const v = document.querySelector('.reader').__vueParentComponent.setupState
    const { doc, index } = v.view.renderer.getContents()[0]
    const target = doc.createRange(); target.selectNodeContents(doc.getElementById('p35')); target.collapse(true)
    await v.goToText(v.view.getCFI(index, target))
    const resolved = await v.view.resolveNavigation(v.currentCfi), range = resolved.anchor(doc)
    const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
    const id = element.closest('p')?.id
    if (!id || Number(id.slice(1)) < 10) throw new Error('Middle-of-book fixture navigation failed')
    range.collapse(true)
    return { id, cfi: v.view.getCFI(index, range) }
  })
}
async function anchorVisible(page, id) {
  return page.evaluate(async anchor => {
    const v = document.querySelector('.reader').__vueParentComponent.setupState
    const doc = v.view.renderer.getContents()[0].doc, resolved = await v.view.resolveNavigation(anchor.cfi)
    const range = resolved.anchor(doc); range.collapse(true)
    const a = range.getClientRects()[0], b = doc.defaultView.frameElement.getBoundingClientRect(), c = document.querySelector('.reader .content').getBoundingClientRect()
    return !!a && a.left + b.left >= c.left - 1 && a.left + b.left <= c.right + 1 && a.top + b.top < c.bottom && a.bottom + b.top > c.top
  }, id)
}
async function checkClean(f, name) {
  const observed = await f.page.evaluate(() => window.__typographyObservedErrors ?? [])
  await writeFile(resolve(artifacts, `${name}-diagnostics.json`), JSON.stringify({ observed, pageErrors: f.errors, externalRequests: f.external }, null, 2))
  const known = new Set(['ResizeObserver loop completed with undelivered notifications.', 'ResizeObserver loop limit exceeded'])
  assert.deepEqual(observed.filter(message => !known.has(message)), [])
  assert.deepEqual(f.errors, []); assert.deepEqual(f.external, [])
  await f.page.screenshot({ path: resolve(artifacts, `${name}.png`), fullPage: true })
}

test('actual iframe CSS: Chinese, English, mixed and converted TXT defaults; semantic blocks and inline conflicts', { timeout: 120000 }, async () => {
  const f = await setup()
  try {
    const rows = []
    for (const [name, profile, height] of [['ZH', 'zh', 1.7], ['EN', 'en', 1.55], ['MIX', 'mixed', 1.75], ['TXT', 'en', 1.55], ['MIX-U', 'mixed', 1.75], ['MIX-TXT', 'mixed', 1.75], ['MIX-MD', 'mixed', 1.75]]) {
      await open(f, name); const a = await state(f.page); rows.push({ name, profile: a.profile, p0: a.p0, p1: a.p1, quote: a.quote })
      assert.equal(a.profile, profile, name); assert.equal(Object.keys(a.books).length, 0)
      const size = profile === 'en' ? 29 : 30
      const geometry = await f.page.evaluate(() => {
        const v = document.querySelector('.reader').__vueParentComponent.setupState
        const doc = v.view.renderer.getContents()[0].doc
        return { width: doc.querySelector('p').getBoundingClientRect().width, viewport: innerWidth, cap: v.effectiveTypography.maxLineLength }
      })
      assert.ok(geometry.width / geometry.viewport > 0.79 && geometry.width / geometry.viewport < 0.87, 'default page uses its measured page edges, not a narrow character cap')
      assert.equal(geometry.cap, 0)
      rows[rows.length - 1].geometry = geometry
      if (fixtures.find(item => item.name === name).format !== 'epub') {
        assert.ok(a.p0?.marked && a.p1?.marked, 'converted prose is actually prepared')
        assert.equal(a.p0.size, `${size}px`); assert.ok(Math.abs(parseFloat(a.p0.height) - size * height) < 0.15)
        if (name === 'TXT') assert.ok(Math.abs(parseFloat(a.p1.indent) - 29 * 1.2) < 0.1)
        else { assert.equal(a.p0.indent, '0px'); assert.ok(Math.abs(parseFloat(a.p1.size) - 30 * 0.96) < 0.1); assert.ok(Math.abs(parseFloat(a.p1.height) / parseFloat(a.p1.size) - 1.55) < 0.01) }
        continue
      }
      assert.equal(a.p0.size, `${size}px`); assert.ok(Math.abs(parseFloat(a.p0.height) - size * height) < 0.15)
      assert.equal(a.p0.indent, name === 'ZH' ? '60px' : '0px', 'English openings omit indent; Chinese retains 2em')
      assert.equal(a.quote.marked, false); assert.equal(a.quote.size, '11px'); assert.equal(a.quote.indent, '7px')
      assert.equal(a.poem.marked, false); assert.equal(a.poem.size, '12px')
      assert.equal(a.p1.weight, '700'); assert.equal(a.p1.italic, 'italic', 'author emphasis survives metric cleanup')
      if (name === 'EN') { assert.equal(a.p1.size, '29px'); assert.ok(Math.abs(parseFloat(a.p1.indent) - 29 * 1.2) < 0.1) }
      if (name === 'MIX') { assert.ok(Math.abs(parseFloat(a.p1.size) - 30 * 0.96) < 0.1); assert.ok(Math.abs(parseFloat(a.p1.height) - 30 * 0.96 * 1.55) < 0.2); assert.equal(a.p1.align, 'start') }
    }
    await writeFile(resolve(artifacts, 'rendered-defaults.json'), JSON.stringify(rows, null, 2))
    await checkClean(f, 'automatic-defaults')
  } finally { await f.context.close() }
})

test('real panel: cancel, per-book display persistence, reload, cross-book isolation and publisher round-trip', { timeout: 120000 }, async () => {
  const f = await setup()
  try {
    await open(f, 'EN'); const anchor = await navigateMiddle(f.page); const before = await state(f.page)
    const trace = [{ phase: 'middle', ...await positionInfo(f.page) }]
    let d = await panel(f.page); await setFont(d, 28); await d.locator('.tp-btn-cancel').click()
    assert.deepEqual((await state(f.page)).prefs, before.prefs); assert.deepEqual((await state(f.page)).books, {})
    d = await panel(f.page); await setFont(d, 28)
    await d.locator('.theme-btn').nth(1).click()
    await apply(d)
    trace.push({ phase: 'after-apply', ...await positionInfo(f.page) })
    const edited = await state(f.page); assert.equal(edited.p1.size, '28px'); assert.equal(edited.books[f.ids.EN].fontSize, 28)
    assert.deepEqual(edited.globals, before.globals)
    assert.equal(await anchorVisible(f.page, anchor), true, 'pre-change logical paragraph remains visible after reflow')
    await open(f, 'ZH'); const other = await state(f.page); assert.equal(other.prefs.fontSize, 30); assert.equal(other.prefs.theme, before.globals.theme)
    await open(f, 'EN'); assert.equal((await state(f.page)).p1.size, '28px')
    trace.push({ phase: 'reopened', ...await positionInfo(f.page) })
    await f.page.reload(); await f.page.waitForFunction(() => { const v = document.querySelector('.reader')?.__vueParentComponent.setupState; return v && !v.loading && !v.error })
    assert.equal((await state(f.page)).p1.size, '28px')
    trace.push({ phase: 'reloaded', ...await positionInfo(f.page) })
    await writeFile(resolve(artifacts, 'position-trace.json'), JSON.stringify({ anchor, trace }, null, 2))
    assert.equal(await anchorVisible(f.page, anchor), true, 'middle-of-book position survives reload')
    d = await panel(f.page)
    const labels = await f.page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState; return { publisher: v.t('uiV02.copy.出版原貌'), optimized: v.t('uiV02.copy.自动优化') } })
    await d.getByRole('button', { name: labels.publisher, exact: true }).click(); await apply(d)
    const publisher = await state(f.page); assert.equal(publisher.p1.size, '9px'); assert.equal(publisher.p1.weight, '700'); assert.equal(publisher.p1.margin, '6px')
    d = await panel(f.page); await d.getByRole('button', { name: labels.optimized, exact: true }).click(); await apply(d)
    const again = await state(f.page); assert.equal(again.p1.size, '28px'); assert.equal(again.text, before.text)
    await checkClean(f, 'book-override-reopened')
  } finally { await f.context.close() }
})

test('real foliate close and the owner release an opened book exactly once', { timeout: 60000 }, async () => {
  const f = await setup()
  try {
    await open(f, 'EN')
    await f.page.evaluate(() => {
      const book = document.querySelector('.reader').__vueParentComponent.setupState.view.book
      const original = book.destroy
      window.__actualBookDestroyCount = 0
      book.destroy = function (...args) { window.__actualBookDestroyCount++; return original.apply(this, args) }
    })
    await open(f, 'ZH')
    assert.equal(await f.page.evaluate(() => window.__actualBookDestroyCount), 1)
    await checkClean(f, 'real-book-release')
  } finally { await f.context.close() }
})

test('PW-TYPO-02: mixed edits retain untouched English rules after apply, chapter change and reopen', { timeout: 120000 }, async () => {
  const f = await setup()
  try {
    await open(f, 'MIX-2')
    let d = await panel(f.page); await setFont(d, 28); await d.locator('.theme-btn').nth(2).click(); await apply(d)
    const leading = async expected => {
      const a = await state(f.page), ratio = parseFloat(a.p1.height) / parseFloat(a.p1.size)
      assert.ok(Math.abs(ratio - expected) < 0.01, 'English leading must match field provenance')
      assert.equal(a.p1.align, 'start')
      return a
    }
    let a = await leading(1.55)
    assert.equal(Object.hasOwn(a.books[f.ids['MIX-2']], 'lineHeight'), false)
    assert.equal(Object.hasOwn(a.books[f.ids['MIX-2']], 'justify'), false)
    await f.page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      await v.view.renderer.goTo({ index: 1, anchor: 0 })
    })
    await leading(1.55)
    await open(f, 'ZH'); await open(f, 'MIX-2'); await leading(1.55)
    d = await panel(f.page); const slider = d.locator('input[type=range][min="1.0"]')
    await slider.fill('2'); await slider.dispatchEvent('input'); await apply(d)
    a = await leading(2); assert.equal(a.books[f.ids['MIX-2']].lineHeight, 2)
    await open(f, 'MIX-U'); d = await panel(f.page); await d.locator('.theme-btn').nth(2).click(); await apply(d)
    await leading(1.55)
    await checkClean(f, 'mixed-transaction')
  } finally { await f.context.close() }
})

test('real font-promise rejection/timeout rolls back; a late completion cannot apply stale layout', { timeout: 90000 }, async () => {
  const f = await setup()
  try {
    await open(f, 'ZH'); const anchor = await navigateMiddle(f.page), before = await state(f.page)
    for (const mode of ['reject', 'timeout']) {
      await f.page.evaluate(mode => {
        const v = document.querySelector('.reader').__vueParentComponent.setupState, fonts = v.view.renderer.getContents()[0].doc.fonts
        const original = fonts.load.bind(fonts); let called = false
        window.__restoreTypographyFonts = () => { fonts.load = original }
        fonts.load = (...args) => {
          if (called) return original(...args)
          called = true
          return mode === 'reject' ? Promise.reject(new Error('fixture font promise rejected')) : new Promise(resolve => { window.__completeLateTypographyFont = () => resolve([]) })
        }
      }, mode)
      const d = await panel(f.page); await setFont(d, 30); await d.locator('.tp-btn-apply').click()
      await d.locator('[role=alert]').waitFor({ timeout: 18000 })
      let a = await state(f.page); assert.deepEqual(a.books, before.books); assert.equal(a.p1.size, before.p1.size)
      assert.equal(await anchorVisible(f.page, anchor), true)
      await f.page.evaluate(async mode => {
        window.__restoreTypographyFonts()
        if (mode === 'timeout') {
          window.__completeLateTypographyFont()
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
        }
      }, mode)
      a = await state(f.page); assert.deepEqual(a.books, before.books); assert.equal(a.p1.size, before.p1.size)
      await d.locator('.tp-btn-cancel').click()
    }
    await checkClean(f, 'font-promise-failures')
  } finally { await f.context.close() }
})

test('storage-denied apply rolls back actual iframe CSS and keeps the editable draft open', { timeout: 90000 }, async () => {
  const f = await setup()
  try {
    await open(f, 'ZH'); const before = await state(f.page)
    const d = await panel(f.page); await setFont(d, 30)
    await f.page.evaluate(() => {
      window.__originalSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) { if (key === 'lightread-settings') throw new Error('fixture quota denied'); return window.__originalSetItem.call(this, key, value) }
    })
    await d.locator('.tp-btn-apply').click()
    await d.locator('[role=alert]').waitFor({ timeout: 20000 })
    const failed = await state(f.page); assert.equal(failed.p1.size, before.p1.size); assert.deepEqual(failed.books, before.books); assert.deepEqual(failed.globals, before.globals)
    assert.equal(await d.locator('input[type=range][min="8"]').inputValue(), '30')
    await f.page.evaluate(() => { Storage.prototype.setItem = window.__originalSetItem })
    await d.locator('.tp-btn-cancel').click(); await checkClean(f, 'failed-apply-rollback')
  } finally { await f.context.close() }
})

test('fixed and vertical publications are protected; a missing custom font uses an explicit startup fallback', { timeout: 90000 }, async () => {
  const f = await setup()
  try {
    for (const name of ['VERT', 'FIXED']) {
      await open(f, name); const a = await state(f.page)
      assert.ok(a.context.protectedLayout); assert.equal(a.prefs.displayMode, 'publisher')
      if (name === 'VERT') { assert.equal(a.p2.size, '20px'); assert.equal(a.p2.indent, '9px') }
    }
    await f.page.evaluate(async id => { const { useSettings } = await import('/src/stores/settings.ts'); useSettings().setBookTypography(id, { fontFamily: 'custom:MissingFixtureFont' }) }, f.ids.EN)
    await open(f, 'EN'); const missing = await state(f.page); assert.equal(missing.fontWarning, true); assert.equal(missing.books[f.ids.EN].fontFamily, 'custom:MissingFixtureFont')
    let d = await panel(f.page); await setFont(d, 30); await d.locator('.tp-btn-apply').click()
    await d.locator('[role=alert]').waitFor({ timeout: 20000 })
    assert.equal((await state(f.page)).prefs.fontSize, 29); await d.locator('.tp-btn-cancel').click()
    d = await panel(f.page); await d.locator('.tp-btn-restore').click(); await setFont(d, 26); await apply(d)
    const restoreEdited = await state(f.page); assert.equal(restoreEdited.prefs.fontSize, 26); assert.equal(Object.hasOwn(restoreEdited.books, f.ids.EN), true)
    d = await panel(f.page); await d.locator('.tp-btn-restore').click(); await apply(d)
    const restored = await state(f.page); assert.equal(restored.fontWarning, false); assert.equal(Object.hasOwn(restored.books, f.ids.EN), false)
    await checkClean(f, 'protected-and-font-fallback')
  } finally { await f.context.close() }
})

test('PW-VIS-03: real iframe hierarchy preserves text, nodes, tables, media, emphasis and publisher metrics', { timeout: 90000 }, async () => {
  const f = await setup()
  try {
    const result = await f.page.evaluate(async () => {
      const { prepareTypographyDocument, UNKNOWN_TYPOGRAPHY_CONTEXT } = await import('/src/services/readerTypographyContext.ts')
      const { applyTypographyDocumentMode } = await import('/src/services/readerTypographyDocument.ts')
      const { getReaderCSS } = await import('/src/services/readerTheme.ts')
      const { useSettings, resolveEffectiveTypography } = await import('/src/stores/settings.ts')
      const frame = document.createElement('iframe'); frame.id = 'pw-semantic-fixture'
      frame.style.cssText = 'position:fixed;inset:0;width:833px;height:100%;border:0;background:white;z-index:99999'
      frame.sandbox = 'allow-same-origin'
      const loaded = new Promise(resolve => { frame.onload = resolve })
      frame.srcdoc = '<!doctype html><html lang="zh-CN" style="font-size:18px!important"><body style="margin:0"><h1 style="font-size:1.3em">章节标题</h1><p id="normal" style="font:italic 700 9px/1.2 serif!important">这是用于检验正文、强调与节点路径的合成文字。</p><figure style="margin:0"><svg width="480" height="240" viewBox="0 0 480 240" style="width:100%;height:auto"><rect width="480" height="240" fill="#597c94"/></svg><figcaption style="font-size:12px!important">图一：合成插图说明。<span id="nested-caption" style="font-size:42px!important;font-weight:700;font-style:italic">强</span></figcaption></figure><table style="width:100%"><caption style="font-size:12px">表一：结构保留</caption><tbody><tr><th>字段</th><th>数值</th></tr><tr><td id="small" style="font-size:14px!important;font-weight:700;font-style:italic">合成数据<span id="nested-cell" style="font-size:42px!important">大</span></td><td id="large" style="font-size:42px!important">大</td></tr></tbody></table><aside role="doc-footnote" style="font-size:12px">注：无私人资料。<span id="nested-note" style="font-size:42px!important;font-weight:700;font-style:italic">强</span></aside><div role="doc-footnote" style="font-size:12px"><p>脚注说明文字<span id="nested-note-div" style="font-size:42px!important;font-weight:700;font-style:italic">大</span></p></div><p role="doc-footnote" style="font-size:12px">自含脚注文字<span id="nested-note-self" style="font-size:42px!important;font-weight:700;font-style:italic">大</span></p><blockquote style="font-size:11px!important">保留引文原貌。</blockquote></body></html>'
      const inlineRoles = ['span','a','em','strong']
      const reverseCases = inlineRoles.map(tag => `<p>正文与脚注说明文字<${tag} role="doc-footnote" style="font-size:12px"><span id="reverse-${tag}" style="font-size:42px!important;font-weight:700;font-style:italic">大</span></${tag}></p>`).join('')
        + '<p>多层正文<span><em role="doc-footnote" style="font-size:12px"><span id="reverse-deep" style="font-size:42px!important;font-weight:700;font-style:italic">大</span></em></span></p>'
      frame.srcdoc = frame.srcdoc.replace('</body>', reverseCases + '</body>')
      document.body.append(frame); await loaded
      const doc = frame.contentDocument, nodes = [...doc.body.querySelectorAll('*')], text = doc.body.textContent
      const context = { ...UNKNOWN_TYPOGRAPHY_CONTEXT, profile: 'zh', language: 'zh-CN', source: 'metadata', protectedLayout: false, automaticFont: true, textScale: 1 }
      const store = useSettings(), prefs = resolveEffectiveTypography({ baseReaderPrefs: store.reader, language: 'zh', viewportWidth: 992, textScale: 1 })
      const css = el => { const s = doc.defaultView.getComputedStyle(el); return { size: parseFloat(s.fontSize), weight: s.fontWeight, italic: s.fontStyle, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height } }
      const nestedIds = ['nested-cell','nested-caption','nested-note','nested-note-div','nested-note-self',...inlineRoles.map(tag=>'reverse-'+tag),'reverse-deep']
      const source = { small: css(doc.getElementById('small')), large: css(doc.getElementById('large')), caption: css(doc.querySelector('figcaption')), table: [...doc.querySelectorAll('th,td')].map(el => el.textContent), image: css(doc.querySelector('svg')) }
      prepareTypographyDocument(doc, context); applyTypographyDocumentMode(doc, 'optimized')
      const style = doc.createElement('style'); doc.head.append(style)
      style.textContent = getReaderCSS({ ...store.reader, ...prefs }, false, undefined, prefs, context)
      await doc.fonts.ready
      const optimized = { normal: css(doc.getElementById('normal')), small: css(doc.getElementById('small')), large: css(doc.getElementById('large')), caption: css(doc.querySelector('figcaption')), note: css(doc.querySelector('aside')), title: css(doc.querySelector('h1')), quote: css(doc.querySelector('blockquote')), collisionFree: [...doc.querySelectorAll('[data-pw-semantic],[data-pw-semantic-text]')].every(el=>!el.closest('p[data-pw-paragraph]')), ordinaryCount: doc.querySelectorAll('p[data-pw-paragraph]').length, semanticCount: doc.querySelectorAll('[data-pw-semantic],[data-pw-semantic-text]').length, nested: nestedIds.map(id=>css(doc.getElementById(id))), image: css(doc.querySelector('svg')), table: [...doc.querySelectorAll('th,td')].map(el => el.textContent), sameNodes: nodes.every((el, i) => el === doc.body.querySelectorAll('*')[i]), sameText: text === doc.body.textContent }
      applyTypographyDocumentMode(doc, 'publisher')
      style.textContent = getReaderCSS({ ...store.reader, ...prefs }, false, undefined, { ...prefs, displayMode: 'publisher' }, context)
      const publisher = { small: css(doc.getElementById('small')), caption: css(doc.querySelector('figcaption')), normal: css(doc.getElementById('normal')), text: doc.body.textContent === text, nested: nestedIds.map(id=>css(doc.getElementById(id))), varsRestored: [...doc.querySelectorAll('[data-pw-semantic],[data-pw-semantic-text]')].every(el => !el.style.getPropertyValue('--pw-semantic-size')) }
      applyTypographyDocumentMode(doc, 'optimized'); style.textContent = getReaderCSS({ ...store.reader, ...prefs }, false, undefined, prefs, context)
      const roundTrip = nestedIds.map(id=>css(doc.getElementById(id)))
      return { source, optimized, publisher, roundTrip }
    })
    const { source, optimized, publisher } = result
    assert.equal(optimized.normal.size, 30); assert.equal(optimized.normal.weight, '700'); assert.equal(optimized.normal.italic, 'italic')
    assert.equal(optimized.title.size, 48); assert.equal(optimized.caption.size, 27); assert.equal(optimized.note.size, 27)
    assert.equal(optimized.small.size, 27); assert.ok(optimized.large.size >= source.large.size)
    assert.equal(optimized.small.weight, '700'); assert.equal(optimized.small.italic, 'italic'); assert.equal(optimized.quote.size, 11)
    assert.equal(optimized.collisionFree, true, 'All semantic text and ordinary prose paths must be disjoint in both nesting directions')
    assert.ok(optimized.ordinaryCount > 0, 'Do not satisfy exclusion by disabling all ordinary prose optimization')
    assert.ok(optimized.semanticCount >= 10)
    assert.equal(optimized.nested.length, 10)
    for (const el of optimized.nested) { assert.ok(el.size >= 42, 'PW-VIS-REVIEW-01: nested author large text must not shrink'); assert.equal(el.weight, '700'); assert.equal(el.italic, 'italic') }
    for (const el of publisher.nested) assert.equal(el.size, 42)
    assert.deepEqual(result.roundTrip, optimized.nested)
    assert.deepEqual(optimized.table, source.table); assert.equal(optimized.sameNodes, true); assert.equal(optimized.sameText, true)
    assert.ok(Math.abs(optimized.image.width / optimized.image.height - 2) < 0.001)
    assert.equal(publisher.small.size, 14); assert.equal(publisher.caption.size, 12); assert.equal(publisher.normal.size, 9)
    assert.equal(publisher.text, true); assert.equal(publisher.varsRestored, true)
    await f.page.locator('#pw-semantic-fixture').screenshot({ path: resolve(artifacts, 'semantic-hierarchy.png') })
    await writeFile(resolve(artifacts, 'semantic-hierarchy.json'), JSON.stringify(result, null, 2))
  } finally { await f.context.close() }
})

test('PW-VIS-REVIEW-02: global custom metrics reach real Chinese and English iframe paragraphs across calibration states', { timeout: 120000 }, async () => {
  const rows = []
  for (const mode of ['none','valid','stale']) {
    const f = await setup()
    try {
      await f.page.evaluate(async mode => {
        const { useSettings } = await import('/src/stores/settings.ts')
        const { measureTypographyCalibration } = await import('/src/services/readerTypographyProfiles.ts')
        const s = useSettings()
        Object.assign(s.reader, { fontSize:24, fontFamily:'Georgia, serif', lineHeight:2.2, letterSpacing:0.08, justify:false })
        if (mode !== 'none') s.setTypographyCalibration(measureTypographyCalibration(160,20,mode === 'valid' ? devicePixelRatio : devicePixelRatio + 0.2,1))
      }, mode)
      await open(f, 'MIX-2')
      const row = await f.page.evaluate(() => {
        const v = document.querySelector('.reader').__vueParentComponent.setupState
        const doc = v.view.renderer.getContents()[0].doc
        const metrics = id => { const c = doc.defaultView.getComputedStyle(doc.getElementById(id)); return { size:parseFloat(c.fontSize), leading:parseFloat(c.lineHeight)/parseFloat(c.fontSize), family:c.fontFamily, spacing:parseFloat(c.letterSpacing), align:c.textAlign } }
        return { calibration:v.effectiveTypography.calibration, source:v.effectiveTypography.source, zh:metrics('p0'), en:metrics('p1'), books:JSON.parse(JSON.stringify(v.settings.typographyBooks)) }
      })
      assert.equal(row.calibration, mode === 'valid' ? 'calibrated' : mode === 'stale' ? 'changed-dpr' : 'uncalibrated')
      assert.equal(row.source,'global'); assert.equal(row.zh.size,24); assert.ok(Math.abs(row.en.size - 24*0.96)<0.01)
      for (const p of [row.zh,row.en]) { assert.ok(Math.abs(p.leading-2.2)<0.01); assert.match(p.family,/Georgia/); assert.equal(p.align,'start'); assert.ok(Math.abs(p.spacing/p.size-0.08)<0.001) }
      assert.deepEqual(row.books,{})
      rows.push({ mode,syntheticRulerInput:true,...row })
    } finally { await f.context.close() }
  }
  await writeFile(resolve(artifacts,'global-custom-metrics.json'),JSON.stringify(rows,null,2))
})

test('PW-VIS-04: a real book-only publication baseline cancels cleanly, suspends visuals and restores saved preferences', { timeout: 120000 }, async () => {
  const f = await setup()
  try {
    await open(f, 'MIX')
    const before = await f.page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.settings.reader.theme = 'green'
      v.settings.dianjing.level = 'basic'
      v.settings.readingMode.wordGuide.enabled = true
      await Promise.resolve()
      return JSON.stringify({ reader: v.settings.reader, readingMode: v.settings.readingMode, dianjing: v.settings.dianjing })
    })
    let d = await panel(f.page)
    await d.locator('.tp-publication-baseline input').check()
    await d.locator('.tp-btn-cancel').click()
    assert.equal(Object.hasOwn((await state(f.page)).books, f.ids.MIX), false)
    d = await panel(f.page)
    await d.locator('.tp-publication-baseline input').check()
    await apply(d)
    const inspect = () => f.page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      return { baseline: v.publicationBaseline, theme: v.effectiveReader.theme, storedTheme: v.effectiveTypography.theme,
        wordGuide: v.modes.wordGuideActive.value, dianjing: v.dj.on.value, colors: JSON.parse(JSON.stringify(v.themeColors)),
        prefs: JSON.stringify({ reader: v.settings.reader, readingMode: v.settings.readingMode, dianjing: v.settings.dianjing }) }
    })
    const active = await inspect()
    assert.equal(active.baseline, true); assert.equal(active.theme, 'light'); assert.equal(active.storedTheme, 'green')
    assert.equal(active.wordGuide, false); assert.equal(active.dianjing, false)
    assert.equal(active.colors.bg, '#ffffff'); assert.equal(active.colors.fg, '#000000'); assert.equal(active.prefs, before)
    assert.deepEqual(Object.keys((await state(f.page)).books[f.ids.MIX]), ['publicationBaseline'])
    await f.page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.hideBars())
    await checkClean(f, 'publication-baseline')
    await open(f, 'ZH')
    assert.equal((await inspect()).baseline, false); assert.equal((await inspect()).theme, 'green')
    assert.equal((await inspect()).wordGuide, true)
    await open(f, 'MIX'); assert.equal((await inspect()).baseline, true)
    d = await panel(f.page); await d.locator('.tp-publication-baseline input').uncheck(); await apply(d)
    const restored = await inspect()
    assert.equal(restored.baseline, false); assert.equal(restored.theme, 'green'); assert.equal(restored.wordGuide, true)
    assert.equal(restored.prefs, before)
    await writeFile(resolve(artifacts, 'publication-baseline.json'), JSON.stringify({ active, restored }, null, 2))
  } finally { await f.context.close() }
})

test('mobile English UI has usable profile/calibration controls and no horizontal overflow', { timeout: 90000 }, async () => {
  const f = await setup({ width: 390, height: 844 }, 'en')
  try {
    await open(f, 'EN'); const d = await panel(f.page)
    assert.equal(await f.page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.settings.language), 'en')
    assert.ok(Array.from(await d.getAttribute('aria-label')).every(ch => ch.charCodeAt(0) < 128))
    await d.locator('select').first().selectOption('zh')
    assert.equal(await d.locator('select').first().inputValue(), 'zh')
    assert.ok(await d.locator('.tp-btn-apply').isVisible())
    const width = await f.page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    assert.ok(width.scroll <= width.client + 1)
    await d.locator('.tp-btn-cancel').click()
    await f.page.goto(`${origin}/#/settings`)
    const calibration = f.page.locator('.typography-calibration')
    await calibration.locator('summary').click()
    assert.ok(await calibration.locator('input[type=number]').isVisible())
    await calibration.locator('input[type=number]').fill('32')
    await calibration.getByRole('button', { name: 'Save measurement', exact: true }).click()
    await open(f, 'EN'); assert.equal((await state(f.page)).p1.size, '21px', 'UI measurement applies a conversion, not physical-size proof')
    await f.page.goto(`${origin}/#/settings`)
    await calibration.locator('summary').click(); await calibration.getByRole('button', { name: 'Clear calibration', exact: true }).click()
    await open(f, 'EN'); assert.equal((await state(f.page)).p1.size, '18px')
    await checkClean(f, 'mobile-english-calibration')
  } finally { await f.context.close() }
})
