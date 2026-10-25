import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'

const artifacts = resolve(import.meta.dirname, '../../.cache/ui-ux-20261022/reader-more-regression')
let server, browser, origin
before(async () => {
  await mkdir(artifacts, { recursive: true })
  server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  // Dev-module transformation is not the reader's runtime readiness contract.
  await server.warmupRequest('/src/views/ReaderView.vue')
  await server.waitForRequestsIdle()
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
    await page.goto(origin + '/#/library', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, undefined, { timeout: 20000 })
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
  } catch (error) {
    await page.screenshot({ path: resolve(artifacts, `failure-${width}.png`) })
    console.log(JSON.stringify(await page.evaluate(() => {
      const v = document.querySelector('.reader')?.__vueParentComponent?.setupState
      return { path: location.hash, loading: v?.loading, ready: !!v?.view?.lastLocation?.cfi, text: document.body.innerText.slice(0, 600) }
    })))
    throw error
  } finally {
    await context.close()
    console.log(JSON.stringify({ productionVue: true, width, externalOrigins: external, pageErrors: errors }))
    assert.deepEqual(external, [])
    assert.deepEqual(errors, [])
  }
}

async function selectFixtureText(page) {
  return page.evaluate(() => {
    const v = document.querySelector('.reader').__vueParentComponent.setupState
    const section = v.view.renderer.getContents().find(s => s.doc?.body?.querySelector('p'))
    if (!section) throw new Error('Missing rendered synthetic paragraph')
    const doc = section.doc
    const node = doc.createTreeWalker(doc.querySelector('p'), NodeFilter.SHOW_TEXT).nextNode()
    if (!node) throw new Error('Missing rendered synthetic text node')
    const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(node.length, 45))
    const selected = doc.getSelection(); selected.removeAllRanges(); selected.addRange(range)
    doc.dispatchEvent(new Event('selectionchange'))
    return { quote: range.toString(), write: v.t('reader.writeNote'), close: v.t('reader.closeIdeaEditor'), save: v.t('reader.saveNote') }
  })
}

for (const width of [992, 390]) test(`PW-02/PW-03 actual reader ${width}px: draft close/reopen/save and accessible targets`, { timeout: 45000 }, async () => {
  await withReader(async (page, id) => {
    const selected = await selectFixtureText(page)
    await page.locator('.highlight-bar').waitFor()
    const targets = await page.locator('.highlight-bar button').evaluateAll(buttons => buttons.map(b => ({ text: b.textContent, width: Math.round(b.getBoundingClientRect().width * 1000) / 1000, height: Math.round(b.getBoundingClientRect().height * 1000) / 1000 })))
    assert.ok(targets.length >= 6)
    assert.ok(targets.every(r => r.width >= 48 && r.height >= 48), JSON.stringify(targets))
    await page.locator('.highlight-bar').getByRole('button', { name: selected.write, exact: true }).click()
    const count = () => page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id).then(rows => rows.length), id)
    assert.equal(await count(), 0, 'opening an idea editor cannot commit a highlight')
    await page.locator('.annotation-pop .note-input').fill('SYNTHETIC RECOVERABLE IDEA')
    await page.locator('.annotation-pop').getByRole('button', { name: selected.close, exact: true }).click()
    await page.locator('.annotation-pop').waitFor({ state: 'hidden' })
    assert.equal(await count(), 0, 'closing a draft must not commit an annotation')
    await selectFixtureText(page)
    await page.locator('.highlight-bar').getByRole('button', { name: selected.write, exact: true }).click()
    assert.equal(await page.locator('.annotation-pop .note-input').inputValue(), 'SYNTHETIC RECOVERABLE IDEA')
    await page.locator('.annotation-pop').getByRole('button', { name: selected.close, exact: true }).click()
    const draftContextId = await page.evaluate(async id => (await import('/src/services/noteDrafts.ts')).listDrafts(id)[0]?.contextId, id)
    assert.ok(draftContextId?.startsWith('sel:'))
    await page.goto(`${origin}/#/library`)
    await page.locator('.reader').waitFor({ state: 'hidden' })
    await page.goto(`${origin}/#/read/${id}?draft=${encodeURIComponent(draftContextId)}`)
    await page.locator('.annotation-pop .note-input').waitFor()
    assert.equal(await page.locator('.annotation-pop .note-input').inputValue(), 'SYNTHETIC RECOVERABLE IDEA', 'cross-page recovery must not require selecting the quote again')
    await page.locator('.annotation-pop').getByRole('button', { name: selected.save, exact: true }).click()
    await page.locator('.annotation-pop').waitFor({ state: 'hidden' })
    const records = await page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id), id)
    assert.equal(records.length, 1)
    assert.equal(records[0].note, 'SYNTHETIC RECOVERABLE IDEA')
    assert.equal(records[0].text, selected.quote)
    await page.screenshot({ path: resolve(artifacts, `pw02-saved-${width}.png`) })
  }, width)
})

for (const width of [992, 390]) test(`PW-02 actual reader ${width}px: acknowledged write plus cleanup failure recovers without duplication`, { timeout: 45000 }, async () => {
  await withReader(async (page, id) => {
    const selected = await selectFixtureText(page)
    await page.locator('.highlight-bar').getByRole('button', { name: selected.write, exact: true }).click()
    await page.locator('.annotation-pop .note-input').fill('SYNTHETIC CLEANUP FAILURE')
    await page.evaluate(() => {
      const original = Storage.prototype.removeItem
      Storage.prototype.removeItem = function (key) {
        if (String(key).startsWith('pagewise:note-draft:v1:')) throw new DOMException('Synthetic cleanup failure', 'SecurityError')
        return original.call(this, key)
      }
      window.__pwRestoreDraftStorage = () => { Storage.prototype.removeItem = original; delete window.__pwRestoreDraftStorage }
    })
    try {
      await page.locator('.annotation-pop').getByRole('button', { name: selected.save, exact: true }).click()
      await page.locator('.annotation-pop [role="alert"]').waitFor()
      const committed = await page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id), id)
      assert.equal(committed.length, 1)
      assert.equal(await page.locator('.annotation-pop .note-input').inputValue(), 'SYNTHETIC CLEANUP FAILURE')
      await page.locator('.annotation-pop').getByRole('button', { name: selected.close, exact: true }).click()
      const contextId = await page.evaluate(async id => (await import('/src/services/noteDrafts.ts')).listDrafts(id)[0].contextId, id)
      await page.evaluate(() => window.__pwRestoreDraftStorage())
      await page.goto(`${origin}/#/library`)
      await page.locator('.reader').waitFor({ state: 'hidden' })
      await page.goto(`${origin}/#/read/${id}?draft=${encodeURIComponent(contextId)}`)
      await page.locator('.annotation-pop .note-input').waitFor()
      await page.locator('.annotation-pop [role="status"]').waitFor()
      await page.locator('.annotation-pop .note-input').fill('SYNTHETIC UPDATED EXISTING IDEA')
      await page.locator('.annotation-pop').getByRole('button', { name: selected.save, exact: true }).click()
      await page.locator('.annotation-pop').waitFor({ state: 'hidden' })
      const after = await page.evaluate(async id => ({
        records: await (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id),
        drafts: (await import('/src/services/noteDrafts.ts')).listDrafts(id),
      }), id)
      assert.equal(after.records.length, 1)
      assert.equal(after.records[0].id, committed[0].id)
      assert.equal(after.records[0].note, 'SYNTHETIC UPDATED EXISTING IDEA')
      assert.equal(after.drafts.length, 0)
      await page.screenshot({ path: resolve(artifacts, `pw02-cleanup-recovered-${width}.png`) })
    } finally { await page.evaluate(() => window.__pwRestoreDraftStorage?.()) }
  }, width)
})

test('PW-02 actual reader: unconfirmed save receipt keeps input and offers scoped inspection', { timeout: 45000 }, async () => {
  await withReader(async (page, id) => {
    const selected = await selectFixtureText(page)
    await page.locator('.highlight-bar').getByRole('button', { name: selected.write, exact: true }).click()
    await page.locator('.annotation-pop .note-input').fill('SYNTHETIC LOST RECEIPT')
    const installed = await page.evaluate(async () => {
      const storage = await (await import('/src/storage/index.ts')).getStorage()
      const original = storage.addAnnotation
      const intercepted = async function (record) {
        await original.call(this, record)
        storage.addAnnotation = original
        throw new Error('SYNTHETIC LOST WRITE RECEIPT')
      }
      storage.addAnnotation = intercepted
      window.__pwRestoreAnnotationWrite = () => { storage.addAnnotation = original; delete window.__pwRestoreAnnotationWrite }
      return storage.addAnnotation === intercepted
    })
    assert.equal(installed, true)
    try {
      await page.locator('.annotation-pop').getByRole('button', { name: selected.save, exact: true }).click()
      await page.locator('.annotation-pop [role="alert"]').waitFor()
      await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState; v.captureNoteDraft(); v.noteDraftSaver?.flush() })
      assert.match(await page.locator('.annotation-pop [role="alert"]').innerText(), /save result is unconfirmed/)
      await page.locator('.annotation-pop').getByRole('button', { name: 'Check saved notes', exact: true }).waitFor()
      assert.equal(await page.locator('.annotation-pop .note-input').inputValue(), 'SYNTHETIC LOST RECEIPT')
      assert.equal(await page.locator('.annotation-pop').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
      const records = await page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id), id)
      assert.equal(records.length, 1)
      await page.screenshot({ path: resolve(artifacts, 'pw02-unconfirmed-390.png') })
      await page.locator('.annotation-pop .note-input').fill('SYNTHETIC EXPLICIT RETRY')
      await page.locator('.annotation-pop').getByRole('button', { name: selected.save, exact: true }).click()
      await page.locator('.annotation-pop').waitFor({ state: 'hidden' })
      const after = await page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id), id)
      assert.equal(after.length, 1)
      assert.equal(after[0].id, records[0].id)
      assert.equal(after[0].note, 'SYNTHETIC EXPLICIT RETRY')
      assert.equal('draftContextId' in after[0], false)
    } finally { await page.evaluate(() => window.__pwRestoreAnnotationWrite?.()) }
  }, 390)
})

test('PW-02/R4 actual reader: foreign corrupt drafts are isolated and current corruption remains visible', { timeout: 45000 }, async () => {
  await withReader(async (page, id) => {
    const selected = await selectFixtureText(page)
    const foreignKey = await page.evaluate(async () => {
      const { buildDraftKey } = await import('/src/services/noteDrafts.ts')
      const key = buildDraftKey('FOREIGN_SYNTHETIC_BOOK', 'sel:broken')
      localStorage.setItem(key, '{BROKEN FOREIGN SYNTHETIC JSON')
      return key
    })
    const write = () => page.locator('.highlight-bar').getByRole('button', { name: selected.write, exact: true }).click()
    await write()
    await page.locator('.annotation-pop .note-input').waitFor()
    await page.locator('.annotation-pop .note-input').fill('SYNTHETIC VALID CURRENT DRAFT')
    await page.locator('.annotation-pop').getByRole('button', { name: selected.close, exact: true }).click()
    const contextId = await page.evaluate(async id => (await import('/src/services/noteDrafts.ts')).listDrafts(id)[0].contextId, id)
    await selectFixtureText(page)
    const brokenKey = await page.evaluate(async id => {
      const { buildDraftKey } = await import('/src/services/noteDrafts.ts')
      const key = buildDraftKey(id, 'sel:broken-current')
      localStorage.setItem(key, '{BROKEN CURRENT SYNTHETIC JSON')
      return key
    }, id)
    await write()
    await page.locator('.highlight-bar [role="alert"]').waitFor()
    assert.match(await page.locator('.highlight-bar [role="alert"]').innerText(), /草稿暂不可用/)
    assert.equal(await page.locator('.annotation-pop').count(), 0)
    const retained = await page.evaluate(async ({ id, contextId, foreignKey, brokenKey }) => ({
      draft: (await import('/src/services/noteDrafts.ts')).loadNoteDraft({ bookId: id, contextId }),
      records: await (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id),
      foreign: localStorage.getItem(foreignKey), broken: localStorage.getItem(brokenKey),
    }), { id, contextId, foreignKey, brokenKey })
    assert.equal(retained.draft.success, true)
    assert.equal(retained.draft.draft.text, 'SYNTHETIC VALID CURRENT DRAFT')
    assert.equal(retained.records.length, 0)
    assert.equal(retained.foreign, '{BROKEN FOREIGN SYNTHETIC JSON')
    assert.equal(retained.broken, '{BROKEN CURRENT SYNTHETIC JSON')
    await page.screenshot({ path: resolve(artifacts, 'pw02-enumeration-error-390.png') })
    await page.evaluate(key => localStorage.removeItem(key), brokenKey)
    await write()
    assert.equal(await page.locator('.annotation-pop .note-input').inputValue(), 'SYNTHETIC VALID CURRENT DRAFT')
    await page.locator('.annotation-pop').getByRole('button', { name: selected.save, exact: true }).click()
    await page.locator('.annotation-pop').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).listAnnotations(id).then(records => records.length), id), 1)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), foreignKey), '{BROKEN FOREIGN SYNTHETIC JSON')
  }, 390, 'zh')
})

for (const width of [992, 390]) test(`PW-03/PW-10 actual typography ${width}px: labels above controls and 48px touch targets`, { timeout: 45000 }, async () => {
  await withReader(async page => {
    const title = await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState; v.showBars(); return v.t('reader.typography') })
    await page.getByTitle(title, { exact: true }).click()
    await page.locator('.settings-pop').waitFor()
    const rects = await page.locator('.settings-pop button, .settings-pop select').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { text: n.textContent?.slice(0, 30), width: Math.round(r.width * 1000) / 1000, height: Math.round(r.height * 1000) / 1000 } }).filter(r => r.width && r.height))
    assert.ok(rects.every(r => r.width >= 48 && r.height >= 48), JSON.stringify(rects))
    const labels = await page.locator('.set-row').evaluateAll(rows => rows.map(row => { const label = row.querySelector('.tp-label'), control = row.querySelector('input,button,select'); return label && control && label.getBoundingClientRect().height && control.getBoundingClientRect().height ? label.getBoundingClientRect().bottom <= control.getBoundingClientRect().top + 1 : true }))
    assert.ok(labels.every(Boolean))
    await page.screenshot({ path: resolve(artifacts, `pw10-typography-${width}.png`) })
  }, width)
})

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
