import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'

const expectedLabels = {
  zh: ['在读', '最近阅读', '想读', '暂缓', '已读', '弃读'],
  en: ['Reading', 'Recent', 'Want to read', 'On hold', 'Read', 'Abandoned'],
}
const fixtures = [
  { title: 'TABS-READING', readingStatus: 'reading', progress: 0.4, lastReadAt: 200 },
  { title: 'TABS-WANTED', readingStatus: 'wanted', progress: null, lastReadAt: 100 },
  { title: 'TABS-PAUSED', readingStatus: 'paused', progress: 0.2, lastReadAt: 0 },
  { title: 'TABS-FINISHED', readingStatus: 'finished', progress: 1, lastReadAt: 400 },
  { title: 'TABS-ABANDONED', readingStatus: 'abandoned', progress: 0.3, lastReadAt: 300 },
  { title: 'TABS-UNMARKED', readingStatus: 'unmarked', progress: 0, lastReadAt: 0 },
]
const expectedCards = [
  ['TABS-READING'],
  ['TABS-FINISHED', 'TABS-ABANDONED', 'TABS-READING', 'TABS-WANTED'],
  ['TABS-WANTED'], ['TABS-PAUSED'], ['TABS-FINISHED'], ['TABS-ABANDONED'],
]

async function storageOperation(page, action, data) {
  return page.evaluate(async ({ action, data }) => {
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    const { useLibrary } = await import('/src/stores/library.ts')
    if (action === 'seed') {
      const { useSettings } = await import('/src/stores/settings.ts')
      useSettings().language = data.language
      for (const book of data.books) {
        await storage.addBook({
          ...book, author: 'Synthetic', format: 'txt', sourceType: 'import',
          addedAt: 1, updatedAt: 1, totalReadSeconds: 0,
          currentLocation: null, lastReadEventAt: null,
        }, new Blob(['SYNTHETIC TABS FIXTURE'], { type: 'text/plain' }))
      }
    } else if (action === 'unmark') {
      const book = (await storage.listBooks()).find(book => book.title === data)
      await storage.updateBook(book.id, { readingStatus: 'unmarked', progress: 0, lastReadAt: 0 })
    }
    await useLibrary().refresh()
    return (await storage.listBooks()).map(book => ({ title: book.title, status: book.readingStatus }))
  }, { action, data })
}

async function cards(page) {
  return (await page.locator('.book-list h2.book-title').allTextContents()).map(text => text.trim())
}

test('reading page has six correctly ordered and scoped tabs in zh/en at wide/narrow widths', { timeout: 120_000 }, async t => {
  const artifacts = resolve(readerRoot, '../.cache/reading-page-tabs', randomUUID())
  mkdirSync(artifacts, { recursive: true })
  // Late dependency discovery can reload the document during fixture seeding.
  const server = await createServer({
    root: readerRoot, cacheDir: resolve(artifacts, 'vite'), logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'pinia', 'dexie', 'fflate', 'marked', 'yaml'] },
    server: { host: '127.0.0.1', port: 43990, strictPort: false },
  })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const executablePath = [process.env.PAGEWISE_TEST_BROWSER, chromium.executablePath(),
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path))
    assert.ok(executablePath, 'An installed browser is required; no download')
    browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] })
    for (const language of ['zh', 'en']) for (const width of [992, 390]) {
      await t.test(`${language} ${width}px`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
        const external = []
        await context.route('**/*', route => {
          const url = new URL(route.request().url())
          if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) return route.continue()
          external.push(url.origin)
          return route.abort()
        })
        const page = await context.newPage()
        page.setDefaultNavigationTimeout(60_000)
        try {
          await page.goto(`${origin}/#/reading`, { waitUntil: 'networkidle' })
          const statuses = await storageOperation(page, 'seed', { language, books: fixtures })
          const tabs = page.getByRole('tab')
          assert.equal(await tabs.count(), 6)
          const labels = (await tabs.allTextContents()).map(text => text.trim().replace(/\s*\(\d+\)$/, '').trim())
          assert.deepEqual(labels, expectedLabels[language])
          for (let i = 0; i < 6; i++) {
            await tabs.nth(i).click()
            await page.waitForFunction(expected => [...document.querySelectorAll('.book-list h2.book-title')].map(el => el.textContent.trim()).join('|') === expected, expectedCards[i].join('|'))
            assert.deepEqual(await cards(page), expectedCards[i])
            assert.equal(await tabs.nth(i).getAttribute('aria-selected'), 'true')
          }
          assert.deepEqual(await storageOperation(page, 'inspect'), statuses, 'Filtering must not mutate stored status')
          await tabs.first().focus()
          await page.keyboard.press('Tab')
          assert.equal(await tabs.nth(1).evaluate(el => el === document.activeElement), true)
          const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth,
            wrapped: [...document.querySelectorAll('.segmented-btn')].some(el => el.scrollHeight > el.clientHeight) }))
          assert.ok(geometry.body <= geometry.width + 1, `Page overflow: ${JSON.stringify(geometry)}`)
          assert.equal(geometry.wrapped, false)
          await storageOperation(page, 'unmark', 'TABS-WANTED')
          await tabs.nth(2).click()
          assert.equal(await page.locator('.empty-title').textContent(), language === 'zh' ? '当前分类暂无书籍' : 'No books in this group')
          await storageOperation(page, 'unmark', 'TABS-ABANDONED')
          await tabs.nth(5).click()
          assert.equal(await page.locator('.empty-title').textContent(), language === 'zh' ? '当前分类暂无书籍' : 'No books in this group')
          assert.deepEqual(external, [], 'No remote requests are allowed')
          await page.screenshot({ path: resolve(artifacts, `${language}-${width}.png`) })
        } finally { await context.close() }
      })
    }
  } finally { await browser?.close(); await server.close() }
})
