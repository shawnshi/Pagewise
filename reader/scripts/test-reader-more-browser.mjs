import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'

const artifacts = resolve(import.meta.dirname, '../../.cache/typography-visual-20261018-r3/reader-more-regression')
let server, browser, origin
before(async () => {
  await mkdir(artifacts, { recursive: true })
  server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function withReader(run, width = 992, language = 'en') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' })
  await context.addInitScript(language => {
    if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({
      version: 14, language, usageStats: true, ambient: { scene: 'rain-study', master: 0.8 },
      ttsEngine: 'system', ttsRate: 1.25, dailyGoalMinutes: 45,
      readingMode: { typewriter: { soundPreset: 'mechanical', soundVolume: 0.2 } },
    }))
  }, language)
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
    const id = await page.evaluate(async language => {
      const { useSettings } = await import('/src/stores/settings.ts')
      const s = useSettings()
      s.language = language
      s.reader.flow = 'scrolled'; s.reader.portraitScroll = false; s.reader.continuousScroll = false
      s.autoReadMode = 'scroll'; s.autoReadSeconds = 10
      const { getStorage } = await import('/src/storage/index.ts')
      const text = Array.from({ length: 160 }, (_, i) => `SYNTHETIC PARAGRAPH ${i}. ` + 'Only synthetic local test content. '.repeat(30)).join('\n\n')
      return (await getStorage()).addBook({ title: 'UI-MORE-FIXTURE', author: 'Fixture Author', fileName: 'UI-MORE-FIXTURE.txt', format: 'txt', tags: [], addedAt: 1 }, new Blob([text]))
    }, language)
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
    // Search sheets can cover the toolbar. Exercise the DOM activation handler here;
    // unobstructed pointer activation is covered by the retirement cases below.
    await page.locator('.reader-more-btn').evaluate(button => button.click())
    await page.locator('.reader-more-menu').waitFor()
    assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.panel), 'none', 'More must replace Search, not stack')
    await search.click()
    await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))
    assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.panel), 'search')
    await page.keyboard.press('Escape')
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

for (const language of ['zh', 'en']) for (const width of [992, 390]) test(`retired features ${language} ${width}px: upgrade, More, listening, modes and settings`, { timeout: 45000 }, async () => {
  await withReader(async page => {
    const prefs = await page.evaluate(async () => {
      const { useSettings, settingsDefaults } = await import('/src/stores/settings.ts')
      const s = useSettings(), defaults = settingsDefaults()
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.showBars()
      return {
        retired: ['ambient', 'usageStats'].filter(key => Object.hasOwn(s.$state, key) || Object.hasOwn(defaults, key)),
        ttsEngine: s.ttsEngine, ttsRate: s.ttsRate, goal: s.dailyGoalMinutes,
        soundPreset: s.readingMode.typewriter.soundPreset, soundVolume: s.readingMode.typewriter.soundVolume,
        tts: v.t('tts.title'), modes: v.t('readingMode.title'),
      }
    })
    assert.deepEqual(prefs.retired, [])
    assert.equal(prefs.ttsEngine, 'system'); assert.equal(prefs.ttsRate, 1.25)
    assert.equal(prefs.goal, 45); assert.equal(prefs.soundPreset, 'mechanical'); assert.equal(prefs.soundVolume, 0.2)
    await page.locator('.reader-more-btn').click()
    const menu = page.locator('.reader-more-menu')
    await menu.waitFor()
    assert.equal(await menu.getByRole('menuitem', { name: /背景音|Ambient sound/i }).count(), 0)
    await page.screenshot({ path: resolve(artifacts, `${language}-${width}-more.png`) })
    assert.equal(await menu.getByRole('menuitem', { name: prefs.tts, exact: true }).count(), 0, 'Listening moved out of More')
    await page.keyboard.press('Escape')
    await page.locator('.bar.top').getByRole('button', { name: prefs.tts, exact: true }).click()
    await page.locator('.tts-panel').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.reader-more-btn').click()
    await menu.getByRole('menuitem', { name: prefs.modes, exact: true }).click()
    await page.locator('.rm-panel').waitFor()
    await page.keyboard.press('Escape')
    await page.goto(origin + '/#/settings')
    await page.locator('#settings-general').waitFor()
    assert.equal(await page.getByText(/使用统计|Usage statistics/i).count(), 0)
    assert.equal(await page.locator('#settings-general .language-input').inputValue(), language, 'Language control remains')
    assert.equal(await page.locator('#settings-general .segmented button').count(), 3, 'System/light/dark appearance controls remain')
    await page.screenshot({ path: resolve(artifacts, `${language}-${width}-settings.png`) })
    await page.reload({ waitUntil: 'networkidle' })
    const persisted = await page.evaluate(async () => {
      const { useSettings } = await import('/src/stores/settings.ts')
      const s = useSettings()
      return { retired: ['ambient', 'usageStats'].filter(key => Object.hasOwn(s.$state, key)), ttsEngine: s.ttsEngine, goal: s.dailyGoalMinutes }
    })
    assert.deepEqual(persisted, { retired: [], ttsEngine: 'system', goal: 45 })
  }, width, language)
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
