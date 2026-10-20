import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'

let server, browser, origin
const run = process.env.LIBRARY_UI_RUN || 'initial'
assert.match(run, /^[a-z0-9-]+$/)
const output = resolve(readerRoot, '../.cache/library-ui-20261020/browser', run)
mkdirSync(output, { recursive: true })
before(async () => {
  server = await createServer({ root: readerRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 4426, strictPort: true } })
  await server.listen()
  origin = 'http://127.0.0.1:4426'
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function fresh(width, language = 'zh', theme = 'light', eink = false) {
  const context = await browser.newContext({ viewport: { width, height: 1180 }, serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return /^https?:$/.test(url.protocol) && url.origin !== origin ? route.abort() : route.continue()
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/#/library')
  await page.waitForSelector('.library')
  await page.evaluate(async ({ language, theme, eink }) => {
    const { useSettings } = await import('/src/stores/settings.ts')
    const settings = useSettings()
    settings.language = language
    settings.appearance = theme
    settings.readingMode.eink.enabled = eink
    window.__library = (await import('/src/stores/library.ts')).useLibrary()
    window.__storage = await (await import('/src/storage/index.ts')).getStorage()
  }, { language, theme, eink })
  await page.waitForFunction(() => window.__library.loaded)
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, eink ? 'light' : theme)
  return { context, page, errors }
}

async function seed(page) {
  await page.evaluate(async () => {
    const classify = value => value ? { version: 1, revision: 1, category: { value, locked: false, source: 'manual' }, topics: [], feature: null, facets: {}, legacyTags: [] } : undefined
    const rows = [
      { title: 'Alpha computing', addedAt: 10, lastReadAt: 500, publicationDate: '2000', category: 'computing-ai' },
      { title: 'Beta computing', addedAt: 30, publicationDate: '2024-02', category: 'computing-ai' },
      { title: 'Gamma health', addedAt: 20, lastReadAt: 700, publicationDate: '2023', category: 'medicine-health' },
      { title: 'Delta unclassified', addedAt: 40 },
      { title: 'Epsilon custom', addedAt: 25, lastReadAt: 100, publicationDate: '2024-02-29', category: 'arts-design' },
      ...Array.from({ length: 12 }, (_, i) => ({ title: `Filler ${String(i).padStart(2, '0')}`, addedAt: 1 + i / 100, category: i < 6 ? 'computing-ai' : i < 10 ? 'medicine-health' : undefined })),
    ]
    window.__ids = {}
    for (const { category, ...meta } of rows) {
      const id = await window.__storage.addBook({ author: 'Synthetic author', format: 'txt', fileName: meta.title + '.txt', tags: [], ...meta, classification: classify(category) }, new Blob(['Synthetic local book text'], { type: 'text/plain' }))
      window.__ids[meta.title] = id
    }
    await window.__library.refresh()
  })
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 12)
}
const titles = page => page.locator('.book-card .title').allTextContents()
const tab = (page, value) => page.locator(`.category-tabs button[data-category="${value}"]`)

for (const config of [{ width: 992 }, { width: 390, eink: true }, { width: 390, language: 'en', theme: 'dark' }]) {
  test(`real library categories/search/sorts/return at ${JSON.stringify(config)}`, { timeout: 100000 }, async () => {
    const { context, page, errors } = await fresh(config.width, config.language, config.theme, config.eink)
    try {
      await seed(page)
      assert.equal(await page.locator('select.sort').inputValue(), 'added')
      assert.deepEqual((await titles(page)).slice(0, 5), ['Delta unclassified', 'Beta computing', 'Epsilon custom', 'Gamma health', 'Alpha computing'])
      assert.deepEqual(await page.locator('.category-tabs button').first().getAttribute('data-category'), '')
      assert.equal(await page.locator('.category-tabs button').count(), 5)
      assert.equal(await tab(page, 'engineering-industry').count(), 0)
      assert.equal(await tab(page, 'computing-ai').locator('.category-count').innerText(), '8')
      assert.equal(await page.locator('.tag-manage,.tag-manage-modal').count(), 0)
      await page.locator('.pagination').getByRole('button', { name: config.language === 'en' ? 'Next page' : '下一页', exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 5)
      await tab(page, 'computing-ai').click()
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 8)
      assert.equal(await tab(page, 'computing-ai').getAttribute('aria-pressed'), 'true')
      await page.locator('input.search').fill('computing')
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2)
      await page.locator('select.sort').selectOption('published')
      assert.deepEqual(await titles(page), ['Beta computing', 'Alpha computing'])
      await page.locator('select.sort').selectOption('recent')
      assert.deepEqual(await titles(page), ['Alpha computing', 'Beta computing'])
      await page.locator('select.sort').selectOption('added')
      assert.deepEqual(await titles(page), ['Beta computing', 'Alpha computing'])
      await page.locator('select.sort').selectOption('published')
      const metrics = await page.locator('.category-tabs').evaluate(nav => {
        const active = nav.querySelector('[aria-pressed="true"]'), style = getComputedStyle(active)
        const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((n, x, i) => n + x * [.2126, .7152, .0722][i], 0)
        const fg = luminance(style.color), bg = luminance(style.backgroundColor)
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, navWidth: nav.clientWidth, scrollWidth: nav.scrollWidth, heights: [...nav.querySelectorAll('button')].map(button => button.getBoundingClientRect().height), contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), fg: style.color, bg: style.backgroundColor }
      })
      assert.ok(metrics.heights.every(height => height >= 48))
      assert.ok(metrics.documentWidth <= metrics.viewport + 1, 'category overflow must stay inside its own row')
      assert.ok(metrics.contrast >= 4.5, JSON.stringify(metrics))
      if (config.width === 390) assert.ok(metrics.scrollWidth > metrics.navWidth)
      await tab(page, '__unclassified__').focus()
      await page.keyboard.press('Enter')
      assert.equal(await tab(page, '__unclassified__').getAttribute('aria-pressed'), 'true')
      await page.locator('input.search').fill('')
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 3)
      await tab(page, 'computing-ai').click()
      await page.locator('input.search').fill('computing')
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2)
      await page.locator('.book-card').filter({ hasText: 'Beta computing' }).locator('.book-body').click()
      await page.waitForSelector('.book-detail')
      await page.evaluate(async () => { await window.__storage.updateBook(window.__ids['Alpha computing'], { publicationDate: '2030' }) })
      await page.goBack()
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2)
      assert.equal(await page.locator('select.sort').inputValue(), 'published')
      assert.equal(await page.locator('input.search').inputValue(), 'computing')
      assert.equal(await tab(page, 'computing-ai').getAttribute('aria-pressed'), 'true')
      assert.deepEqual(await titles(page), ['Alpha computing', 'Beta computing'])
      await page.screenshot({ path: resolve(output, `${config.width}-${config.language || 'zh'}-${config.theme || 'light'}.png`), fullPage: true })
      await page.evaluate(async () => {
        for (const book of window.__library.books.filter(book => book.classification?.category?.value === 'computing-ai')) await window.__storage.deleteBook(book.id)
        await window.__library.refresh()
      })
      await page.waitForFunction(() => !document.querySelector('.category-tabs [data-category="computing-ai"]'))
      assert.equal(await tab(page, '').getAttribute('aria-pressed'), 'true')
      assert.deepEqual(errors, [])
      writeFileSync(resolve(output, `${config.width}-${config.language || 'zh'}-${config.theme || 'light'}.json`), JSON.stringify({ config, metrics, pageErrors: errors, categoryRemovedReset: true, returnAfterPublicationEdit: true }, null, 2))
    } finally { await context.close() }
  })
}

test('empty library has no populated categories and still offers default and publication sorting', { timeout: 60000 }, async () => {
  const { context, page, errors } = await fresh(390)
  try {
    assert.equal(await page.locator('.category-tabs').count(), 0)
    assert.equal(await page.locator('select.sort').inputValue(), 'added')
    assert.equal(await page.locator('select.sort option[value="published"]').count(), 1)
    assert.equal(await page.locator('.tag-manage').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
