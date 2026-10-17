import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { resolve, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { collapse } from 'foliate-js/epubcfi.js'

let server, browser, origin
const run = process.env.UI_LABEL_RUN || 'browser-current'
assert.match(run, /^[a-z0-9-]+$/)
const evidence = resolve(import.meta.dirname, '../../.cache/bottom-nav-v03-20261017-01', run)
const results = []
before(async () => {
  assert.equal(existsSync(evidence), false, 'Do not overwrite earlier browser evidence')
  mkdirSync(evidence, { recursive: true })
  server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
})
after(async () => {
  await browser?.close(); await server?.close()
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n')
})

async function controls(page, selector, labelSelector) {
  return page.locator(selector).evaluateAll((elements, labelSelector) => elements.filter(el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }).map(el => {
    const r = el.getBoundingClientRect(), label = el.querySelector(labelSelector), lr = label?.getBoundingClientRect(), s = label && getComputedStyle(label)
    const visible = !!lr && lr.width > 0 && lr.height > 0 && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = css => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
    const chain = []; for (let p = label; p; p = p.parentElement) chain.unshift(p)
    let bg = [255, 255, 255]
    for (const p of chain) { const c = rgba(getComputedStyle(p).backgroundColor), a = c[3] / 255; bg = bg.map((v, i) => c[i] * a + v * (1 - a)) }
    const lum = c => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
    const fg = label ? rgba(s.color).slice(0, 3) : [0, 0, 0], l = [lum(fg), lum(bg)].sort((a, b) => a - b)
    return {
      foreground: fg, background: bg, contrast: (l[1] + 0.05) / (l[0] + 0.05),
      text: label?.textContent.trim(), width: r.width, height: r.height,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      labelVisible: visible, font: s ? parseFloat(s.fontSize) : 0,
      labelContained: visible && lr.left >= r.left - 1 && lr.right <= r.right + 1 && lr.top >= r.top - 1 && lr.bottom <= r.bottom + 1,
      labelUnclipped: !!label && label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1,
    }
  }), labelSelector)
}
function assertControls(items, width, font = 13) {
  assert.ok(items.length > 0)
  for (const item of items) {
    assert.ok(item.text && item.labelVisible, `Always-visible text required: ${JSON.stringify(item)}`)
    assert.ok(item.labelContained && item.labelUnclipped, `Text must not be cropped or spill outside action: ${JSON.stringify(item)}`)
    assert.ok(item.font >= font, `Text too small: ${JSON.stringify(item)}`)
    assert.ok(item.contrast >= 4.5, `Text contrast below 4.5:1: ${JSON.stringify(item)}`)
    assert.ok(item.width >= 48 && item.height >= 48, `Touch target below 48px: ${JSON.stringify(item)}`)
    assert.ok(item.left >= -1 && item.right <= width + 1, `Action outside viewport: ${JSON.stringify(item)}`)
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]
    const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
    assert.equal(overlap, false, `Actions overlap: ${a.text}/${b.text}`)
  }
}
const cases = [
  [992, 'zh', false], [390, 'zh', false], [768, 'zh', false], [1280, 'zh', false],
  [992, 'en', false], [390, 'en', false], [768, 'en', false], [1280, 'en', false],
  [992, 'zh', true], [390, 'en', true],
]
for (const [width, language, eink] of cases) test(`actual labeled UI ${width}px ${language} ${eink ? 'eink' : 'normal'}`, { timeout: 40000 }, async t => {
  if (results.some(x => x.passed === false)) { t.skip('Stopped after the first failure; repair from evidence before further executions'); return }
  const key = `${width}-${language}-${eink ? 'eink' : 'normal'}`
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
  const external = [], errors = [], result = { key, width, language, eink, actualProductionComponents: true }
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/') || /^(blob:|data:)/.test(url)) return route.continue()
    try { external.push(new URL(url).origin) } catch { external.push('invalid-url') }
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(origin + '/#/library', { waitUntil: 'networkidle' })
    await page.evaluate(async ({ language, eink }) => {
      const s = (await import('/src/stores/settings.ts')).useSettings()
      s.language = language; s.appearance = language === 'en' ? 'dark' : 'light'; s.usageStats = false
      s.readingMode.eink.enabled = eink
      s.reader.flow = 'paginated'; s.reader.portraitScroll = false; s.reader.continuousScroll = false
      const root = document.documentElement
      if (innerWidth === 390) for (const [side, value] of Object.entries({ top: 24, bottom: 20, left: 12, right: 18 })) root.style.setProperty(`--lr-safe-${side}`, `${value}px`)
    }, { language, eink })
    await page.waitForTimeout(250)
    result.effectiveTheme = await page.evaluate(() => document.documentElement.dataset.theme)
    assert.equal(result.effectiveTheme, eink || language === 'zh' ? 'light' : 'dark')
    result.navigation = await controls(page, '.sidebar .nav-item', '.nav-label')
    assert.equal(result.navigation.length, 5)
    assertControls(result.navigation, width)
    result.navigationGeometry = await page.evaluate(() => {
      const nav = document.querySelector('.sidebar').getBoundingClientRect(), main = document.querySelector('.main').getBoundingClientRect()
      const rect = r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height })
      return { navigation: rect(nav), main: rect(main), viewportHeight: innerHeight }
    })
    const geometry = result.navigationGeometry
    assert.ok(geometry.navigation.top >= geometry.main.bottom - 1, 'Main navigation must be below content, not a left-side rail or an overlap')
    assert.ok(Math.abs(geometry.navigation.bottom - geometry.viewportHeight) <= 1, 'Main navigation must reach viewport bottom')
    assert.ok(Math.abs(geometry.navigation.left - geometry.main.left) <= 1 && Math.abs(geometry.navigation.right - geometry.main.right) <= 1, 'Content and bottom navigation must use the same safe horizontal bounds')
    if (width === 390) assert.ok(result.navigation.every(x => x.bottom <= geometry.viewportHeight - 20 + 1), 'Navigation actions must remain above gesture safe area')
    await page.locator('.sidebar a[href$="/notes"]').click()
    await page.waitForURL('**/#/notes')
    await page.locator('.sidebar a[href$="/notes"][aria-current="page"]').waitFor()
    result.navigationScroll = await page.evaluate(() => {
      const main = document.querySelector('.main'), nav = document.querySelector('.sidebar')
      const before = nav.getBoundingClientRect().top
      const fixture = document.createElement('div'); fixture.style.height = '1800px'; fixture.dataset.scrollFixture = 'synthetic'
      main.append(fixture); main.scrollTop = main.scrollHeight
      const scrolled = main.scrollTop > 0, after = nav.getBoundingClientRect().top
      fixture.remove(); main.scrollTop = 0
      return { scrolled, bottomNavigationStayedStill: Math.abs(before - after) <= 1 }
    })
    assert.deepEqual(result.navigationScroll, { scrolled: true, bottomNavigationStayedStill: true })
    await page.locator('.sidebar a[href$="/settings"]').focus()
    assert.equal(await page.locator('.sidebar a[href$="/settings"]').evaluate(el => el === document.activeElement), true)
    await page.screenshot({ path: join(evidence, `${key}-navigation.png`) })
    const id = await page.evaluate(async () => {
      const storage = await (await import('/src/storage/index.ts')).getStorage()
      const text = Array.from({ length: 70 }, (_, i) => `SYNTHETIC ${i}. Only synthetic local UI acceptance text. `.repeat(8)).join('\n\n')
      return storage.addBook({ title: 'UI-LABEL-VISIBILITY', author: 'Synthetic author', fileName: 'UI-LABEL-VISIBILITY.txt', format: 'txt', tags: [], addedAt: 1 }, new Blob([text]))
    })
    await page.goto(`${origin}/#/read/${id}`)
    await page.waitForFunction(() => {
      const v = document.querySelector('.reader')?.__vueParentComponent?.setupState
      return v && !v.loading && v.view?.lastLocation?.cfi && v.view.renderer?.getContents?.().some(c => c.doc?.body?.textContent?.includes('SYNTHETIC'))
    }, undefined, { timeout: 20000 })
    assert.equal(await page.locator('.sidebar').count(), 0, 'Immersive reader must not gain main-navigation chrome')
    const before = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.showBars(); v.cancelBarsTimer()
      return v.view.lastLocation.cfi
    })
    await page.waitForFunction(() => {
      const el = document.querySelector('.bar.top'), r = el.getBoundingClientRect()
      return r.top >= -1 && getComputedStyle(el).opacity === '1'
    })
    result.toolbarBackgrounds = await page.locator('.bar').evaluateAll(bars => bars.map(bar => {
      const s = getComputedStyle(bar), c = document.createElement('canvas'); c.width = c.height = 1
      const ctx = c.getContext('2d'); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1)
      return { alpha: ctx.getImageData(0, 0, 1, 1).data[3], backdrop: s.backdropFilter }
    }))
    assert.ok(result.toolbarBackgrounds.every(x => x.alpha === 255 && x.backdrop === 'none'), 'Toolbar text must not blend with underlying book content')
    result.top = await controls(page, '.bar.top .icon-btn', '.btn-text')
    assertControls(result.top, width)
    result.chapters = await controls(page, '.progress-row .chapter-btn', '.btn-text')
    assert.equal(result.chapters.length, 2); assertControls(result.chapters, width, 12)
    result.dock = await controls(page, '.dock button', 'span')
    if (result.dock.length) assertControls(result.dock, width)
    await page.locator('.reader-more-btn').click()
    await page.locator('.reader-more-menu').waitFor()
    assertControls(await controls(page, '.reader-more-item', 'span'), width)
    assert.equal(await page.evaluate(() => window.__pagewiseReaderBack()), true)
    await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))
    const after = await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.view.lastLocation.cfi)
    assert.equal(collapse(after), collapse(before), 'UI operations must retain primary reading anchor')
    await page.screenshot({ path: join(evidence, `${key}-reader.png`) })
    assert.deepEqual(external, []); assert.deepEqual(errors, [])
    result.passed = true
  } catch (error) {
    result.passed = false; result.error = String(error)
    await page.screenshot({ path: join(evidence, `${key}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    result.externalOrigins = external; result.pageErrors = errors
    results.push(result)
    await context.close()
  }
})
