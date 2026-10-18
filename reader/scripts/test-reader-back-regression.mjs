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
      window.backFixture = { calls: 0, original, library }
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
    assert.equal(await page.evaluate(() => typeof window.__pagewiseReaderBack), 'undefined')
    await context.close()
  } finally { await browser?.close(); await server.close() }
})
