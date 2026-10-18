import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { build, preview } from './vite-isolated.mjs'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const fontsDir = resolve(root, 'public/fonts')
const out = resolve(root, '../artifacts/font-embedding/verification')
const sha = value => createHash('sha256').update(value).digest('hex')

// This is a public-domain-style synthetic fixture, not a user book or library scan.
const sample = `<!doctype html><html lang="zh-CN"><head><style>
body { margin: 28px; } p { margin-block: .4em; }
.protected { font-family: monospace !important; font-size: 17px !important; }
</style></head><body><h1>阅读字体对照 · Reading specimens</h1><h2>藏繁鬱龘 · Chapter heading</h2>
<p><span id="han">阅读閱讀藏繁鬱骨令遍直返边邊</span>，<span id="latin">Café naïve façade Ångström αβγ</span>。<span id="punct">“引号”——……</span> 保持原文与内容结构。</p>
<p lang="en"><span id="english">Reading is a conversation across time. The quick brown fox moves quietly.</span> <em id="italic">Genuine italic, not a slanted roman.</em> <strong id="bold">A bold idea.</strong> <strong><em id="bolditalic">Bold italic.</em></strong></p>
<p>代码 <code><span id="code" class="protected" style="font-family:monospace!important;font-size:17px!important">const x = 42</span></code>；注音 <ruby>漢<rt><span id="ruby" class="protected">hàn</span></rt></ruby>；音标 <span class="ipa"><span id="ipa" class="protected" style="font-family:monospace!important">əɪʃʒŋɜ</span></span>；特殊字 <span data-pw-preserve-font><span id="special" class="protected" style="font-family:monospace!important">Ω</span></span>。</p>
<p>这是普通正文中的嵌入专用字形：<span class="ipa"><span id="inline-protected" style="font-family:monospace!important;font-size:17px!important">əɪʃ</span></span>，不应被正文替换。</p>
<p><span id="fallback">𠮷𡃁𠮶𠀀𰻞 ₀₁₂₃⁰¹²³∑∫√∞</span></p>
${'<p>清晨的光落在书页上，阅读让时间慢下来。藏、繁、鬱的内部空白应当完整；字体需要在连续阅读中判断，而不是只看一个字。</p>'.repeat(8)}
</body></html>`

async function platformFonts(page, selector) {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable'); await session.send('CSS.enable')
    const { root: dom } = await session.send('DOM.getDocument', { depth: -1, pierce: true })
    const findFrame = node => node.nodeName === 'IFRAME' && node.contentDocument ? node.contentDocument
      : (node.children || []).map(findFrame).find(Boolean)
    const frame = findFrame(dom)
    assert.ok(frame, 'real iframe is present in CDP DOM')
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: frame.nodeId, selector })
    assert.ok(nodeId, selector)
    return (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts
  } finally { await session.detach() }
}

function customFamily(fonts, pattern) {
  return fonts.some(f => f.isCustomFont && pattern.test(f.familyName))
}

let manifest
test('shipping font bytes, versions, licenses, axes and declared limitations match the manifest', async () => {
  const text = await readFile(resolve(fontsDir, 'manifest.json'), 'utf8')
  try { manifest = JSON.parse(text) }
  catch (error) { throw new Error('Invalid shipping font manifest JSON', { cause: error }) }
  assert.equal(manifest.fonts.length, 7)
  for (const font of manifest.fonts) {
    const bytes = await readFile(resolve(fontsDir, font.file))
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2')
    assert.equal(bytes.length, font.bytes)
    assert.equal(sha(bytes), font.sha256)
    const license = await readFile(resolve(fontsDir, font.license))
    assert.equal(sha(license), font.licenseSha256)
    assert.match(license.toString(), /SIL OPEN FONT LICENSE/i)
    assert.equal(sha(await readFile(resolve(root, 'dist/fonts', font.file))), font.sha256, 'production artifact contains exact bytes')
  }
  const han = manifest.fonts.find(f => /SourceHanSerif/.test(f.file))
  assert.ok(han.encodedCodepoints > 44000)
  assert.deepEqual(han.axes.wght, [250, 250, 900])
  assert.ok(['ZHS', 'ZHT', 'ZHH'].every(lang => han.haniLanguages.includes(lang)))
  assert.ok(han.features.includes('locl'))
  assert.equal(han.missingSamples.han, '')
  assert.ok(han.missingSamples.rare_han.includes('𠀀'), 'do not claim universal Unicode coverage')
  const literata = manifest.fonts.filter(f => /Literata/.test(f.file))
  assert.equal(literata.length, 2)
  assert.equal(literata.find(f => f.italic).style, 'Italic')
  assert.ok(literata.every(f => f.axes.wght[2] >= 700 && f.axes.opsz[0] === 7 && f.missingSamples.latin_greek === ''))
  const wenkai = manifest.fonts.find(f => /WenKai/.test(f.file))
  assert.equal(wenkai.style, 'Regular'); assert.deepEqual(wenkai.axes, {})
  assert.ok(wenkai.encodedCodepoints > 47000)
  const css = await readFile(resolve(fontsDir, 'fonts.css'), 'utf8')
  assert.doesNotMatch(css, /https?:|@import/)
})

test('production app + EPUB iframe use real local fonts, regional forms, weights, italic, rollback and offline assets', { timeout: 110000 }, async () => {
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const server = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 0, strictPort: false } }).catch(async error => { await browser.close(); throw error })
  const context = await browser.newContext({ viewport: { width: 1120, height: 1120 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const external = [], requested = [], failures = [], pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await context.route('**/*', route => {
    let url
    try { url = new URL(route.request().url()) }
    catch (error) { failures.push(`Invalid request URL: ${error.name}`); return route.abort('failed') }
    if (url.origin !== base) { external.push(url.origin); return route.abort('blockedbyclient') }
    if (url.pathname.includes('/fonts/')) requested.push(url.pathname)
    return route.continue()
  })
  page.on('requestfailed', req => { if (req.url().startsWith(`${base}/fonts/`)) failures.push(req.url()) })
  const report = { specimens: [], external, requested, failures, pageErrors }
  try {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    report.ui = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily, color: getComputedStyle(document.body).color, background: getComputedStyle(document.body).backgroundColor, faces: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family) }))
    assert.match(report.ui.family, /PW Source Han Sans/)
    assert.ok(report.ui.faces.includes('PW Source Han Sans'))
    report.uiViewports = []
    for (const width of [390, 768, 992, 1120]) {
      await page.setViewportSize({ width, height: 1120 })
      const measured = await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        return { viewport: innerWidth, document: document.documentElement.scrollWidth }
      })
      assert.ok(measured.document <= measured.viewport + 1, 'bundled UI font does not cause horizontal overflow')
      await page.screenshot({ path: resolve(out, `library-${width}.png`) })
      report.uiViewports.push(measured)
    }
    const entry = resolve(root, '../.cache/font-embedding/font-test-entry.ts')
    await mkdir(resolve(entry, '..'), { recursive: true })
    const src = name => JSON.stringify(resolve(root, `src/services/${name}.ts`).replaceAll('\\', '/'))
    await writeFile(entry, ['fonts','readerTypographyProfiles','readerTypographyContext','readerTypographyDocument','readerTheme'].map(name => `export * from ${src(name)};`).join('\n'))
    const compiled = await build({ root, configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, build: { write: false, minify: false, target: 'chrome105', lib: { entry, formats: ['iife'], name: 'PWFontTest' } } })
    const bundle = (Array.isArray(compiled) ? compiled.flatMap(r => r.output) : compiled.output).find(c => c.type === 'chunk' && c.isEntry)
    assert.ok(bundle)
    await page.addScriptTag({ content: bundle.code })
    assert.ok(await page.evaluate(() => !!window.PWFontTest), pageErrors.join('\n'))
    const makeFrame = async () => {
      await page.evaluate(async html => {
        document.getElementById('font-fixture')?.remove()
        const iframe = document.createElement('iframe'); iframe.id = 'font-fixture'
        iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:white;z-index:2147483647'
        const loaded = new Promise(resolve => { iframe.onload = resolve })
        iframe.srcdoc = html; document.body.append(iframe); await loaded
      }, sample)
    }
    const apply = async (key, lang = 'zh-CN', mode = 'optimized', profile = 'zh') => page.evaluate(async ({ key, lang, mode, profile }) => {
      const api = window.PWFontTest
      const doc = document.getElementById('font-fixture').contentDocument
      const before = doc.body.textContent
      doc.documentElement.lang = lang
      const context = { profile, language: lang, protectedLayout: false, automaticFont: key === 'auto', fontKey: key, textScale: 1 }
      api.prepareTypographyDocument(doc, context, profile)
      api.applyTypographyDocumentMode(doc, mode)
      try { await api.injectBundledFontsIntoDoc(doc) }
      catch (error) { throw new Error(`${error.message}; ${JSON.stringify({ key, url: doc.URL, state: doc.readyState, live: doc === document.getElementById('font-fixture').contentDocument, connected: !!doc.defaultView?.frameElement?.isConnected, links: [...doc.querySelectorAll('link')].map(l => ({ href: l.href, sheet: !!l.sheet })) })}`) }
      const family = api.resolveFontFamily(key, { profile, language: lang })
      const prefs = { fontSize: 26, lineHeight: 1.7, gap: 8, fontFamily: family, justify: false, letterSpacing: 0, displayMode: mode, profile, paragraphSpacing: .2, textIndent: 0, theme: 'light' }
      let style = doc.getElementById('specimen-style')
      if (!style) { style = doc.createElement('style'); style.id = 'specimen-style'; doc.head.append(style) }
      style.textContent = api.getReaderCSS(prefs, false, undefined, prefs, context)
      const start = performance.now()
      await doc.fonts.load(`${api.bundledFontWeight(key)} 26px ${family}`, '知頁ABCéα')
      await doc.fonts.ready
      await new Promise(r => doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(r)))
      const css = id => { const s = doc.defaultView.getComputedStyle(doc.getElementById(id)); return { family: s.fontFamily, weight: s.fontWeight, style: s.fontStyle, size: s.fontSize } }
      return { key, lang, loadMs: Math.round(performance.now() - start), textUnchanged: before === doc.body.textContent, bodyWeight: doc.defaultView.getComputedStyle(doc.body).fontWeight,
        opticalSizing: doc.defaultView.getComputedStyle(doc.body).fontOpticalSizing,
        headingWeight: doc.defaultView.getComputedStyle(doc.querySelector('h2')).fontWeight,
        headingFamily: doc.defaultView.getComputedStyle(doc.querySelector('h2')).fontFamily,
        italic: css('italic'), bold: css('bold'), bolditalic: css('bolditalic'), protected: ['code','ruby','ipa','special','inline-protected'].map(css),
        faces: [...doc.fonts].filter(f => f.status === 'loaded').map(f => ({ family: f.family, style: f.style, weight: f.weight })) }
    }, { key, lang, mode, profile })
    for (const key of ['auto', 'songti', 'songti-medium', 'songti-sans', 'sans', 'wenkai', 'literata', 'source-serif4']) {
      await makeFrame()
      const r = await apply(key, key === 'literata' || key === 'source-serif4' ? 'en' : 'zh-CN', 'optimized', /literata|source-serif4/.test(key) ? 'en' : 'zh')
      assert.ok(r.textUnchanged)
      assert.equal(r.opticalSizing, key === 'source-serif4' ? 'none' : 'auto')
      assert.equal(r.bodyWeight, key === 'songti-medium' ? '500' : '400')
      assert.equal(r.headingWeight, key === 'wenkai' ? '400' : key === 'songti-sans' || key === 'sans' ? '500' : '600')
      assert.ok(r.protected.every(s => /monospace/.test(s.family) && s.size === '17px'))
      assert.equal(r.italic.style, 'italic'); assert.equal(r.bold.weight, '700')
      assert.equal(r.bolditalic.style, 'italic'); assert.equal(r.bolditalic.weight, '700')
      r.hanFonts = await platformFonts(page, '#han')
      r.latinFonts = await platformFonts(page, '#latin')
      r.italicFonts = await platformFonts(page, '#italic')
      r.punctuationFonts = await platformFonts(page, '#punct')
      r.fallbackFonts = await platformFonts(page, '#fallback')
      assert.ok(customFamily(r.hanFonts, key === 'wenkai' ? /WenKai/ : key === 'sans' ? /Source Han Sans/ : /Source Han Serif/))
      assert.ok(customFamily(r.latinFonts, key === 'source-serif4' ? /Source Serif/ : /Literata/))
      assert.ok(r.italicFonts.some(f => f.isCustomFont && /Italic/i.test(f.postScriptName)), 'genuine italic font is rendered')
      if (key === 'songti' || key === 'auto') assert.ok(customFamily(r.punctuationFonts, /Source Han Serif/), 'Chinese punctuation is not stolen by Latin')
      if (key === 'songti-sans') assert.match(r.headingFamily, /PW Source Han Sans/)
      r.latinRaster = sha(await page.frameLocator('#font-fixture').locator('#latin').screenshot())
      r.hanRaster = sha(await page.frameLocator('#font-fixture').locator('#han').screenshot())
      r.screenshot = `${key}.png`
      await page.screenshot({ path: resolve(out, r.screenshot) })
      report.specimens.push(r)
    }
    const songti = report.specimens.find(s => s.key === 'songti'), medium = report.specimens.find(s => s.key === 'songti-medium')
    assert.equal(songti.latinRaster, medium.latinRaster, 'Chinese 400/500 trial keeps Latin Regular unchanged')
    assert.notEqual(songti.hanRaster, medium.hanRaster, 'real CJK 500 changes ink, not just a dropdown label')
    await makeFrame()
    const regionHashes = {}
    for (const lang of ['zh-CN', 'zh-TW', 'zh-HK']) {
      await apply('auto', lang)
      const locator = page.frameLocator('#font-fixture').locator('#han')
      regionHashes[lang] = sha(await locator.screenshot({ path: resolve(out, `${lang}.png`) }))
    }
    assert.equal(new Set(Object.values(regionHashes)).size, 3, 'SC, TC, HK use visibly different locl forms with identical text')
    report.regionHashes = regionHashes
    await makeFrame(); await apply('songti')
    await apply('songti', 'zh-CN', 'publisher')
    const restored = await page.frameLocator('#font-fixture').locator('#ipa').evaluate(el => el.style.fontFamily)
    assert.equal(restored, 'monospace', 'publisher round-trip restores author declaration')
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(failures, [])
    assert.deepEqual(external, [], 'no external font or other remote request is needed')
    const invalidSheet = () => page.evaluate(async () => {
      const source = document.querySelector('link[data-pw-bundled-fonts]')
      const old = source.href; source.href = new URL('/fonts/missing-font-sheet.css', old).href
      const iframe = document.createElement('iframe'); document.body.append(iframe)
      try { await window.PWFontTest.injectBundledFontsIntoDoc(iframe.contentDocument); return 'unexpected-success' }
      catch (e) { return e.message }
      finally { source.href = old; iframe.remove() }
    })
    report.invalidStylesheet = await invalidSheet()
    assert.equal(report.invalidStylesheet, 'Invalid bundled font stylesheet', 'SPA HTML returned with HTTP 200 is not valid CSS')
    await context.route('**/fonts/missing-font-sheet.css', route => route.fulfill({ status: 404, contentType: 'text/css', body: 'missing fixture' }))
    report.failureMode = await invalidSheet()
    assert.match(report.failureMode, /HTTP 404/, '404 is a real error, not a silent empty success')
    report.malformedFont = await page.evaluate(async () => {
      try { await new FontFace('Invalid fixture', new Uint8Array([1, 2, 3, 4]).buffer).load(); return 'unexpected-success' }
      catch (error) { return error.name }
    })
    assert.equal(report.malformedFont, 'SyntaxError')
    report.status = 'PASS'
  } finally {
    await writeFile(resolve(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n')
    await context.close(); await browser.close()
    await new Promise(resolve => server.httpServer.close(resolve))
  }
})
