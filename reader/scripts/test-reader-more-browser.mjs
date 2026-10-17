import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

let server, browser, origin
before(async () => {
  server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function withReader(run, width = 992) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' })
  const external = [], errors = []
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/') || /^(blob:|data:)/.test(url)) return route.continue()
    external.push(new URL(url).origin)
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(origin + '/#/library', { waitUntil: 'networkidle' })
    const id = await page.evaluate(async () => {
      const { useSettings } = await import('/src/stores/settings.ts')
      const s = useSettings()
      s.language = 'en'; s.usageStats = false
      s.reader.flow = 'scrolled'; s.reader.portraitScroll = false; s.reader.continuousScroll = false
      s.autoReadMode = 'scroll'; s.autoReadSeconds = 10
      const { getStorage } = await import('/src/storage/index.ts')
      const text = Array.from({ length: 160 }, (_, i) => `SYNTHETIC PARAGRAPH ${i}. ` + 'Only synthetic local test content. '.repeat(30)).join('\n\n')
      return (await getStorage()).addBook({ title: 'UI-MORE-FIXTURE', author: 'Fixture Author', fileName: 'UI-MORE-FIXTURE.txt', format: 'txt', tags: [], addedAt: 1 }, new Blob([text]))
    })
    await page.goto(`${origin}/#/read/${id}`)
    await page.waitForFunction(() => {
      const v = document.querySelector('.reader')?.__vueParentComponent?.setupState
      return v && !v.loading && v.view?.renderer?.scrolled && v.view?.lastLocation?.cfi
    }, undefined, { timeout: 20000 })
    await run(page, id)
  } finally {
    await context.close()
    console.log(JSON.stringify({ productionVue: true, width, externalOrigins: external, pageErrors: errors }))
    assert.deepEqual(external, [])
    assert.deepEqual(errors, [])
  }
}

for (const width of [992, 390]) test(`actual reader ${width}px: More replaces panels, Escape/native Back dismiss, CFI preserved`, { timeout: 45000 }, async () => {
  await withReader(async page => {
    const initial = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.showBars()
      return { cfi: v.view.lastLocation.cfi, search: v.t('reader.searchInBook') }
    })
    const search = page.getByTitle(initial.search, { exact: true })
    await search.click()
    await page.waitForFunction(() => document.querySelector('.reader').__vueParentComponent.setupState.panel === 'search')
    // Narrow sheets intentionally cover the toolbar; dismiss through the real Back path first.
    if (width < 720) await page.keyboard.press('Escape')
    await page.locator('.reader-more-btn').click()
    await page.locator('.reader-more-menu').waitFor()
    assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.panel), 'none', 'More must replace Search, not stack')
    await search.click()
    await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))
    assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.panel), 'search')
    if (width < 720) await page.keyboard.press('Escape')
    await page.locator('.reader-more-btn').click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))
    await page.locator('.reader-more-btn').click()
    assert.equal(await page.evaluate(() => window.__pagewiseReaderBack()), true)
    await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))
    assert.ok(page.url().includes('/#/read/'), 'native Back only dismissed the overlay')
    assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.view.lastLocation.cfi), initial.cfi)
  }, width)
})

test('actual reader motion: More holds a demonstrably moving scroll engine and primary CFI', { timeout: 45000 }, async () => {
  await withReader(async page => {
    const before = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.startAutoRead(); v.showBars()
      return Number(v.view.renderer.containerPosition)
    })
    await page.waitForFunction(start => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      return v.autoReading && v.view.renderer.scrolled && Number(v.view.renderer.containerPosition) > start + 12
    }, before, { timeout: 10000 })
    await page.locator('.reader-more-btn').click()
    await page.locator('.reader-more-menu').waitFor()
    await page.waitForTimeout(2200)
    const held = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      return { held: v.autoHeld(), position: Number(v.view.renderer.containerPosition), cfi: v.view.lastLocation.cfi }
    })
    await page.waitForTimeout(700)
    const after = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      return { held: v.autoHeld(), position: Number(v.view.renderer.containerPosition), cfi: v.view.lastLocation.cfi }
    })
    assert.equal(held.held, true, 'More must hold beyond the transient pointer grace period')
    assert.equal(after.held, true)
    assert.ok(Math.abs(after.position - held.position) <= 1, JSON.stringify({ held, after }))
    assert.equal(after.cfi, held.cfi)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))
    await page.waitForFunction(position => Number(document.querySelector('.reader').__vueParentComponent.setupState.view.renderer.containerPosition) > position + 5, after.position, { timeout: 10000 })
    await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.stopAutoRead())
  })
})

test('actual reader draft: More never stacks over or discards dirty editor, Escape retains recoverable input', { timeout: 45000 }, async () => {
  await withReader(async (page, bookId) => {
    const annotation = await page.evaluate(async id => {
      const instance = document.querySelector('.reader').__vueParentComponent
      const v = instance.setupState
      const a = { id: 'UI-MORE-DRAFT', bookId: id, cfi: v.view.lastLocation.cfi, text: 'Synthetic quotation', note: 'Saved note', color: '#ffee88', createdAt: 1 }
      v.activeAnnotation = a; await instance.proxy.$nextTick()
      return a
    }, bookId)
    await page.locator('.annotation-pop .note-input').fill('UNSAVED SOURCE INPUT')
    await page.locator('.reader-more-btn').evaluate(button => button.click())
    assert.equal(await page.locator('.reader-more-menu').count(), 0)
    const current = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      return { active: v.activeAnnotation?.id, draft: v.noteDraft }
    })
    assert.equal(current.active, annotation.id); assert.equal(current.draft, 'UNSAVED SOURCE INPUT')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.reader').__vueParentComponent.setupState.activeAnnotation)
    const recovered = await page.evaluate(async a => {
      const instance = document.querySelector('.reader').__vueParentComponent
      const v = instance.setupState
      v.activeAnnotation = a; await instance.proxy.$nextTick(); return v.noteDraft
    }, annotation)
    assert.equal(recovered, 'UNSAVED SOURCE INPUT')
  })
})
