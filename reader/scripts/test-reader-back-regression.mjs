import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'

test('production Vue native Back: draft/apply/selection priority, failed and pending progress, lifecycle', { timeout: 75000 }, async () => {
  const server = await createServer({ root: resolve(import.meta.dirname, '..'), cacheDir: resolve(import.meta.dirname, '../../.cache/native-back/vite'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') || /^(blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto(origin + '/#/library', { waitUntil: 'networkidle' })
    const id = await page.evaluate(async () => {
      const { getStorage } = await import('/src/storage/index.ts')
      const { useSettings } = await import('/src/stores/settings.ts')
      const s = useSettings(); s.reader.flow = 'scrolled'; s.reader.portraitScroll = false
      return (await getStorage()).addBook({ title: 'NATIVE-BACK-SYNTHETIC', author: 'Fixture', fileName: 'native-back.txt', format: 'txt', tags: [], addedAt: 1 }, new Blob(['Synthetic local reading fixture. '.repeat(1800)]))
    })
    await page.goto(`${origin}/#/read/${id}`)
    await page.waitForFunction(() => { const v = document.querySelector('.reader')?.__vueParentComponent.setupState; return v && !v.loading && v.view?.lastLocation?.cfi }, undefined, { timeout: 30000 })
    await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.settingsOpen = true
      v.typographyApplying = true
      window.__pagewiseReaderBack()
      await new Promise(resolve => setTimeout(resolve, 30))
      if (!v.settingsOpen) throw new Error('Back dismissed pending typography')
      v.typographyApplying = false
      window.__pagewiseReaderBack()
    })
    await page.waitForFunction(() => !document.querySelector('.reader').__vueParentComponent.setupState.settingsOpen)
    assert.ok(page.url().endsWith('/read/' + id))
    await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.selection = { text: 'Synthetic selection' }
      v.panel = 'search'
      window.__pagewiseReaderBack()
      await new Promise(resolve => setTimeout(resolve, 30))
      if (v.selection || v.panel !== 'search') throw new Error('Selection must close before panel')
      window.__pagewiseReaderBack()
    })
    await page.waitForFunction(() => document.querySelector('.reader').__vueParentComponent.setupState.panel === 'none')
    await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      v.activeAnnotation = { id: 'synthetic-unsaved', note: '' }; v.noteDraft = 'keep my draft'; v.noteSaving = true
      window.__pagewiseReaderBack()
      await new Promise(resolve => setTimeout(resolve, 30))
      if (!v.activeAnnotation || v.noteDraft !== 'keep my draft') throw new Error('Pending note dismissed')
      v.noteSaving = false; v.activeAnnotation = null
      v.barsVisible = false
      await v.readerSession.flush()
      const { useLibrary } = await import('/src/stores/library.ts')
      const library = useLibrary(), original = library.saveProgress
      window.backFixture = { calls: 0, original, library, readerOwner: window.__pagewiseReaderBack }
      library.saveProgress = () => { window.backFixture.calls++; return new Promise((resolve, reject) => { Object.assign(window.backFixture, { resolve, reject }) }) }
      v.readerSession.relocate({ cfi: v.view.lastLocation.cfi, fraction: 0.2 })
      window.__pagewiseReaderBack(); window.__pagewiseReaderBack(); window.__pagewiseReaderBack()
    })
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => window.backFixture.calls), 1)
    assert.ok(page.url().endsWith('/read/' + id), 'must not exit while save pending')
    await page.evaluate(() => window.backFixture.reject(new Error('synthetic save failure')))
    await page.waitForTimeout(100)
    assert.ok(page.url().endsWith('/read/' + id), 'must not exit after failed save')
    await page.evaluate(() => { window.__pagewiseReaderBack(); window.__pagewiseReaderBack() })
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.backFixture.calls), 2)
    await page.evaluate(() => { window.backFixture.library.saveProgress = window.backFixture.original; window.backFixture.resolve() })
    await page.waitForURL('**/#/library')
    await page.waitForFunction(() => !document.querySelector('.reader'))
    assert.deepEqual(await page.evaluate(async () => {
      const { router } = await import('/src/router/index.ts')
      const old = window.backFixture.readerOwner
      return { committed: router.currentRoute.value.path === '/library', replaced: window.__pagewiseReaderBack !== old, staleConsumed: old() }
    }), { committed: true, replaced: true, staleConsumed: false }, 'library may claim the shared slot, but the departed Reader owner must be inert')

    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(`${origin}/#/read/${id}`)
      await page.waitForFunction(() => { const el = document.querySelector('.reader'); const v = el?.__vueParentComponent?.setupState; return v && !v.loading && v.view?.lastLocation?.cfi })
      const before = await page.evaluate(async () => {
        const v = document.querySelector('.reader').__vueParentComponent.setupState
        v.barsVisible = true
        v.isFullscreen = false
        const current = location.hash
        window.__pagewiseReaderBack()
        await new Promise(resolve => setTimeout(resolve, 40))
        const systemBack = { hidden: !v.barsVisible, unchanged: location.hash === current }
        v.barsVisible = true
        return systemBack
      })
      assert.deepEqual(before, { hidden: true, unchanged: true }, 'system Back must retain toolbar priority')
      await page.locator('.reader-back-btn').click()
      await page.waitForURL('**/#/library', { timeout: 1800 })
    }
    await page.goto(`${origin}/#/read/${id}`)
    await page.waitForFunction(() => { const v = document.querySelector('.reader')?.__vueParentComponent.setupState; return v && !v.loading && v.view?.lastLocation?.cfi })
    await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      const { useLibrary } = await import('/src/stores/library.ts')
      const library = useLibrary(), original = library.saveProgress
      window.realRecovery = { calls: 0, allow: false, owner: window.__pagewiseReaderBack, cfi: v.view.lastLocation.cfi }
      library.saveProgress = (...args) => {
        window.realRecovery.calls++
        if (!window.realRecovery.allow) return Promise.reject(new Error('synthetic recovery failure'))
        return original(...args)
      }
      v.barsVisible = false
      v.readerSession.relocate({ cfi: window.realRecovery.cfi, fraction: 0.27 })
      window.__pagewiseReaderBack()
    })
    await page.waitForFunction(() => window.realRecovery.calls === 1 && !document.querySelector('.reader').__vueParentComponent.setupState.nativeBackPending)
    assert.ok(page.url().endsWith('/read/' + id), 'a failed actual leave must retain the Reader')
    assert.equal(await page.evaluate(() => window.__pagewiseReaderBack === window.realRecovery.owner), true)
    await page.evaluate(() => { window.realRecovery.allow = true; window.__pagewiseReaderBack(); window.__pagewiseReaderBack(); window.__pagewiseReaderBack() })
    await page.waitForURL('**/#/library')
    await page.waitForFunction(() => !document.querySelector('.reader'))
    const recovered = await page.evaluate(async id => {
      const { getStorage } = await import('/src/storage/index.ts')
      const { router } = await import('/src/router/index.ts')
      const book = await (await getStorage()).getBook(id)
      const f = window.realRecovery
      return { committed: router.currentRoute.value.path === '/library', attempts: f.calls, locationMatches: book.location === f.cfi, progress: book.progress, oldConsumed: f.owner(), ownerReplaced: window.__pagewiseReaderBack !== f.owner }
    }, id)
    assert.deepEqual(recovered, { committed: true, attempts: 2, locationMatches: true, progress: 0.27, oldConsumed: false, ownerReplaced: true })
    await context.close()
  } finally { await browser?.close(); await server.close() }
})
