import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from './vite-isolated.mjs'

let server, browser, base
const output = resolve(import.meta.dirname, '../../.cache/library-redesign-v1')
before(async () => {
  await mkdir(output, { recursive: true })
  server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--disable-background-networking'] })
})
after(async () => { await browser?.close(); await server?.close() })

async function isolated(run, width = 992) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const url = route.request().url()
    try { return new URL(url).origin === base || /^(blob:|data:)/.test(url) ? route.continue() : route.abort('blockedbyclient') }
    catch { return route.abort('blockedbyclient') }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(base + '/#/library', { waitUntil: 'networkidle' })
    await page.locator('.library').waitFor()
    const ids = await page.evaluate(async () => {
      const { getStorage } = await import('/src/storage/index.ts')
      const { useLibrary } = await import('/src/stores/library.ts')
      const { createClassification, BOOK_CATEGORIES } = await import('/src/services/bookClassification.ts')
      const storage = await getStorage()
      const classification = createClassification()
      classification.category = { value: BOOK_CATEGORIES[0].id, source: 'manual', locked: false }
      classification.topics = ['主题一', '主题二', '主题三'].map(value => ({ value, source: 'manual', locked: false }))
      const common = { author: '', format: 'txt', fileName: 'fixture.txt', tags: [], addedAt: 1 }
      const missing = await storage.addReferencedBook({ ...common, title: 'A 文件缺失', progress: .42, lastReadAt: 30, readingStatus: 'paused', classification, sourceRef: { folderId: 'old', documentId: 'old-document', relativePath: 'old.txt', version: 'old' } })
      await storage.updateBook(missing, { fileAvailability: 'missing' })
      const healthy = await storage.addBook({ ...common, title: 'B 正常书', author: 'Synthetic Author', publisher: 'Synthetic Press', publicationDate: '2001', lastReadAt: 20, language: 'zh', classification }, new Blob(['# Chapter one\n\nSynthetic reading content.\n\nSecond paragraph.']))
      await storage.updateBook(healthy, { fileAvailability: 'available' })
      const legacy = await storage.addBook({ ...common, title: 'C 历史标签', tags: ['旧标签一', '旧标签二', '旧标签三'] }, new Blob(['Synthetic text.']))
      await storage.addAnnotation({ bookId: missing, cfi: 'chapter-1', text: 'Synthetic quote', note: 'Keep this note', color: '#000000', createdAt: 1 })
      await useLibrary().refresh()
      return { missing, healthy, legacy }
    })
    await page.locator('.book-card').first().waitFor()
    await run(page, ids)
    assert.deepEqual(errors, [], 'no unhandled browser errors')
  } finally { await context.close() }
}

for (const width of [992, 390]) test(`${width}px: per-book problems, one filter panel, compact rows and settings-only folder controls`, { timeout: 60000 }, () => isolated(async (page, ids) => {
  assert.equal(await page.locator('.monitored-folder-banner, .tag-row, .advanced-filter-dialog').count(), 0)
  assert.equal(await page.locator('.library .open-filter').count(), 1)
  const lost = page.locator(`[id="book-card-${ids.missing}"]`)
  assert.match(await lost.innerText(), /文件不可用/)
  assert.equal((await lost.locator('.read-action').innerText()).trim(), '重新定位')
  assert.equal(await lost.locator('.book-tags span:not(.format-label)').count(), 2)
  assert.doesNotMatch(await page.locator('.book-card').allInnerTexts().then(x => x.join('\n')), /未知出版社|未知时间|佚名|来自监测文件夹|Synthetic Press|2001/)
  assert.ok((await page.locator('.resume-card').boundingBox()).height <= 72)
  assert.equal(await page.locator('.pagination button').count(), 0)
  await page.locator('.open-filter').click()
  assert.equal(await page.locator('#library-filters fieldset').count(), 5)
  await page.locator('#library-filters select[aria-label="文件状态"]').selectOption('available')
  assert.equal(await page.locator('.book-card').count(), 3, 'draft does not filter before Apply')
  await page.locator('.apply-filter').click()
  assert.equal(await page.locator('.book-card').count(), 1)
  assert.ok(await page.locator(`[id="book-card-${ids.healthy}"]`).isVisible())
  await page.locator('.library-notice button').click()
  assert.equal(await page.locator('.book-card').count(), 1)
  assert.ok(await lost.isVisible(), 'global unavailable view is not hidden by the previous available-only filter')
  await page.getByRole('button', { name: '返回原筛选' }).click()
  assert.ok(await page.locator(`[id="book-card-${ids.healthy}"]`).isVisible())
  await page.locator('.btn-clear-chips').click()
  await page.evaluate(() => document.documentElement.classList.add('pagewise-eink'))
  await page.screenshot({ path: resolve(output, `library-${width}.png`), fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow')
  await page.locator('.pagination a').click()
  await page.locator('#library-page-size').selectOption('24')
  assert.equal(await page.evaluate(async () => (await import('/src/services/librarySession.ts')).loadLibrarySession().pageSize), 24)
  assert.ok(await page.locator('#settings-library-display-heading').isVisible())
}, width))

test('real reader return reorders recent books, but live metadata updates and chosen title order stay stable', { timeout: 60000 }, () => isolated(async (page, ids) => {
  const order = () => page.locator('.book-card').evaluateAll(nodes => nodes.map(node => node.id))
  const before = await order()
  await page.evaluate(async id => {
    const { getStorage } = await import('/src/storage/index.ts'); await (await getStorage()).updateBook(id, { lastReadAt: 1000 })
    await (await import('/src/stores/library.ts')).useLibrary().refresh()
  }, ids.healthy)
  assert.deepEqual(await order(), before, 'browse order must not jump')
  await page.locator(`[id="book-card-${ids.healthy}"] .read-action`).click()
  await page.locator('.reader').waitFor()
  await page.evaluate(async () => { const { router } = await import('/src/router/index.ts'); await router.push('/library') })
  await page.locator('.book-card').first().waitFor()
  assert.equal((await order())[0], `book-card-${ids.healthy}`)
  await page.locator('.sort').selectOption('title')
  const titleOrder = await order()
  await page.locator(`[id="book-card-${ids.healthy}"] .read-action`).click()
  await page.locator('.reader').waitFor()
  await page.evaluate(async () => { const { router } = await import('/src/router/index.ts'); await router.push('/library') })
  await page.locator('.book-card').first().waitFor()
  assert.deepEqual(await order(), titleOrder)
  const healthy = page.locator(`[id="book-card-${ids.healthy}"]`)
  await healthy.locator('.more').click()
  await healthy.locator('.pin').click()
  await page.waitForFunction(id => document.querySelector('.book-card')?.id === id, `book-card-${ids.healthy}`)
  await healthy.locator('.more').click()
  await healthy.locator('.pin').click()
  await page.waitForFunction(id => document.querySelector('.book-card')?.id === id, titleOrder[0])
  assert.deepEqual(await order(), titleOrder)
}))

test('pagination jumps and clamps after applying filters; page size is outside the library', { timeout: 60000 }, () => isolated(async page => {
  await page.evaluate(async () => {
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    for (let i = 0; i < 12; i++) await storage.addBook({ title: `Extra ${i}`, author: '', format: 'txt', fileName: 'extra.txt', tags: [], addedAt: 1 }, new Blob(['Synthetic text']))
    await (await import('/src/stores/library.ts')).useLibrary().refresh()
  })
  assert.equal(await page.locator('.pagination select').count(), 0)
  await page.locator('.page-jump input').fill('2')
  await page.locator('.page-jump button').click()
  assert.match(await page.locator('.pagination [role=status]').innerText(), /2 \/ 2/)
  await page.locator('.open-filter').click()
  await page.locator('#library-filters select[aria-label="文件状态"]').selectOption('missing')
  await page.locator('.apply-filter').click()
  assert.equal(await page.locator('.book-card').count(), 1)
  assert.equal(await page.locator('.pagination button').count(), 0)
}))

test('partial scan without missing books stays visible and rescan never reports unconditional success', { timeout: 60000 }, () => isolated(async (page, ids) => {
  await page.evaluate(async id => {
    const { createFolderLibrary, useFolderLibrary } = await import('/src/services/folderLibrary.ts')
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    await storage.updateBook(id, { fileAvailability: 'available' })
    const controller = createFolderLibrary({ getStorage: async () => storage,
      prepareBookImport: async () => { throw new Error('Synthetic parser failure') },
      getMonitoredFolder: async () => ({ id: 'fixture', label: 'Synthetic books', permission: 'granted' }), selectMonitoredFolder: async () => null,
      listMonitoredFiles: async () => ({ complete: true, errors: [], files: [{ documentId: 'broken', name: 'broken.txt', relativePath: 'broken.txt', size: 4, modifiedAt: 1 }] }),
      readMonitoredFile: async () => new Uint8Array([1, 2, 3, 4]).buffer, subscribeMonitoredFolderChanges: () => () => {} })
    await controller.rescan()
    const { toRaw } = await import('/scripts/fixtures/vue-test-runtime.mjs')
    const singleton = useFolderLibrary()
    const status = toRaw(singleton.status)
    status.value = controller.status.value
    singleton.rescan = async () => { await controller.rescan(); status.value = controller.status.value }
    await (await import('/src/stores/library.ts')).useLibrary().refresh()
    await (await import('/scripts/fixtures/vue-test-runtime.mjs')).nextTick()
    const { toasts } = await import('/src/services/toast.ts'); toasts.splice(0)
  }, ids.missing)
  assert.equal(await page.locator('.library-notice').count(), 1)
  assert.match(await page.locator('.library-notice').innerText(), /部分|未完成/)
  assert.equal(await page.locator('.library-notice a[href*="section=folder"]').count(), 1)
  const card = page.locator(`[id="book-card-${ids.missing}"]`)
  await card.locator('.more').click()
  await card.getByRole('button', { name: '重新扫描', exact: true }).click()
  await page.locator('.toast').last().waitFor()
  const messages = await page.evaluate(async () => [...(await import('/src/services/toast.ts')).toasts].map(x => ({ type: x.type, message: x.message })))
  assert.ok(messages.some(x => x.type === 'error' && /部分|未完成/.test(x.message)))
  assert.ok(!messages.some(x => x.type === 'success'))
}))

for (const failure of [false, true]) test(`dialog -> real relink controller -> actual IndexedDB: ${failure ? 'parse failure preserves old data' : 'successful recovery retains notes'}`, { timeout: 60000 }, () => isolated(async (page, ids) => {
  await page.evaluate(async ({ id, failure }) => {
    const { createFolderLibrary, useFolderLibrary } = await import('/src/services/folderLibrary.ts')
    const { prepareBookImport } = await import('/src/services/importer.ts')
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    const content = new TextEncoder().encode('The same synthetic edition.\n\nRestored text.').buffer
    const controller = createFolderLibrary({ getStorage: async () => storage,
      prepareBookImport: async file => { if (failure) throw new Error('injected parse failure'); return prepareBookImport(file) },
      getMonitoredFolder: async () => ({ id: 'new-folder', label: 'Synthetic books', permission: 'granted' }), selectMonitoredFolder: async () => null,
      listMonitoredFiles: async () => ({ complete: true, errors: [], files: ['restored', 'other-edition'].map(documentId => ({ documentId, name: `${documentId}.txt`, relativePath: `${documentId}.txt`, size: content.byteLength, modifiedAt: 1 })) }),
      readMonitoredFile: async () => content, subscribeMonitoredFolderChanges: () => () => {} })
    Object.assign(useFolderLibrary(), { relinkCandidates: controller.relinkCandidates, relink: controller.relink })
    window.__relinkBefore = await storage.getBook(id)
  }, { id: ids.missing, failure })
  await page.locator(`[id="book-card-${ids.missing}"] .read-action`).click()
  await page.locator('.relink-dialog[open]').waitFor()
  const confirm = page.locator('.relink-dialog .btn-primary')
  assert.ok(await confirm.isDisabled())
  await page.locator('#relink-candidate').selectOption('restored')
  assert.ok(await confirm.isDisabled(), 'same-edition confirmation is mandatory')
  await page.locator('.confirm-edition input').check()
  assert.ok(await confirm.isEnabled())
  await page.locator('#relink-candidate').selectOption('other-edition')
  assert.ok(await confirm.isDisabled(), 'confirmation for A must not authorize candidate B')
  assert.equal(await page.locator('.confirm-edition input').isChecked(), false)
  assert.equal(await page.evaluate(async id => {
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    return (await storage.getBook(id)).sourceRef.documentId
  }, ids.missing), 'old-document', 'changing the candidate never updates the old source')
  await page.locator('#relink-candidate').selectOption('restored')
  assert.ok(await confirm.isDisabled())
  await page.locator('.confirm-edition input').check()
  await confirm.click()
  if (failure) await page.locator('.relink-dialog [role=alert]').waitFor()
  else await page.locator('.relink-dialog').waitFor({ state: 'detached' })
  const result = await page.evaluate(async id => {
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    return { before: window.__relinkBefore, after: await storage.getBook(id), notes: await storage.listAnnotations(id), count: (await storage.listBooks()).length }
  }, ids.missing)
  assert.equal(result.count, 3)
  assert.equal(result.notes[0].note, 'Keep this note')
  if (failure) assert.deepEqual(result.after, result.before)
  else {
    assert.equal(result.after.id, result.before.id)
    assert.equal(result.after.progress, .42)
    assert.equal(result.after.title, result.before.title)
    assert.equal(result.after.sourceRef.documentId, 'restored')
    assert.equal(result.after.fileAvailability, 'available')
    assert.equal(await page.locator('.file-recovery').count(), 0)
  }
}))
