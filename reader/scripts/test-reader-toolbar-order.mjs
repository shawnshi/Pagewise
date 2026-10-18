import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'

const artifacts = resolve(import.meta.dirname, '../../.cache/pdf-cache-20261018/toolbar-verification', `${process.pid}-${Date.now()}`)
const viteCache = resolve(import.meta.dirname, '../../.cache/pdf-cache-20261018/toolbar-vite-cache')
let server, browser, origin

function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let page = 1; page <= 3; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page * 2 + 3} 0 R >>`)
    const stream = `BT /F1 18 Tf 40 420 Td (SYNTHETIC PDF PAGE ${page}) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`).toString('base64')
}

before(async () => {
  await mkdir(artifacts, { recursive: true })
  server = await createServer({
    root: resolve(import.meta.dirname, '..'),
    cacheDir: viteCache,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`

  const executablePath = process.env.PAGEWISE_TEST_BROWSER || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    chromium.executablePath(),
  ].find(existsSync)

  browser = await chromium.launch({ executablePath, headless: true })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

async function withReader(run, width = 992, language = 'zh') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' })
  await context.addInitScript(lang => {
    localStorage.setItem('lightread-settings', JSON.stringify({
      version: 14,
      language: lang,
      reader: { flow: 'scrolled', portraitScroll: false, continuousScroll: false },
      ttsEngine: 'system',
      ttsRate: 1.0,
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
    const id = await page.evaluate(async lang => {
      const { useSettings } = await import('/src/stores/settings.ts')
      const s = useSettings()
      s.language = lang
      s.reader.flow = 'scrolled'
      s.reader.portraitScroll = false
      s.reader.continuousScroll = false
      const { getStorage } = await import('/src/storage/index.ts')
      const text = Array.from({ length: 40 }, (_, i) => `Synthetic chapter line ${i}. Text body for toolbar validation.`).join('\n\n')
      return (await getStorage()).addBook(
        { title: 'SYNTHETIC-TOOLBAR-TEST', author: 'Synthetic Author', fileName: 'SYNTHETIC-TOOLBAR-TEST.txt', format: 'txt', tags: [], addedAt: 1 },
        new Blob([text])
      )
    }, language)

    await page.goto(`${origin}/#/read/${id}`)
    await page.waitForFunction(() => {
      const v = document.querySelector('.reader')?.__vueParentComponent?.setupState
      return v && !v.loading && v.view?.renderer?.scrolled && v.view?.lastLocation?.cfi
    }, undefined, { timeout: 25000 })

    await run(page, id)
  } finally {
    await context.close()
    assert.deepEqual(external, [], 'No external network requests allowed')
    assert.deepEqual(errors, [], 'No uncaught page errors')
  }
}

async function withPdfReader(run, width = 992, language = 'zh') {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' })
  await context.addInitScript(lang => {
    localStorage.setItem('lightread-settings', JSON.stringify({
      version: 14,
      language: lang,
      pdf: { mode: 'paged', spreadMode: 'single', renderer: 'pdfium' },
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
    const pdfBase64 = syntheticPdf()
    const id = await page.evaluate(async ({ lang, base64 }) => {
      const { useSettings } = await import('/src/stores/settings.ts')
      const s = useSettings()
      s.language = lang
      const { getStorage } = await import('/src/storage/index.ts')
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
      return (await getStorage()).addBook(
        { title: 'SYNTHETIC-PDF-TOOLBAR', author: 'Synthetic Author', fileName: 'synthetic.pdf', format: 'pdf', tags: [], kind: 'paper', addedAt: 1 },
        new Blob([bytes], { type: 'application/pdf' })
      )
    }, { lang: language, base64: pdfBase64 })

    await page.goto(`${origin}/#/read-pdf/${id}`)
    await page.locator('.pdf-toolbar').waitFor({ state: 'visible', timeout: 25000 })
    await page.waitForFunction(() => {
      const state = document.querySelector('.paper')?.__vueParentComponent?.setupState
      return state && !state.loading && !state.error && state.pageCount === 3
    }, undefined, { timeout: 30000 })
    await run(page, id)
  } finally {
    await context.close()
    assert.deepEqual(external, [], 'No external network requests allowed')
    assert.deepEqual(errors, [], 'No uncaught page errors')
  }
}

const EXPECTED_LABELS = {
  zh: ['目录', '搜索', '书签', '批注', '阅读助手', '朗读', '排版'],
  en: ['TOC', 'Search', 'Bookmark', 'Annotations', 'Reading assistant', 'Read aloud', 'Typography'],
}

for (const language of ['zh', 'en']) {
  for (const width of [992, 390]) {
    test(`ReaderView toolbar order, labels and geometry (${language}, ${width}px)`, { timeout: 45000 }, async () => {
      await withReader(async page => {
        // Ensure bars are visible
        await page.evaluate(() => {
          const v = document.querySelector('.reader').__vueParentComponent.setupState
          v.showBars()
        })
        await page.locator('.bar.top').waitFor({ state: 'visible' })

        // Extract the 7 primary actions from .bar-actions
        const actions = await page.locator('.bar-actions > .reader-action-btn:not(.reader-more-btn)').evaluateAll(btns => {
          return btns.map(b => {
            const rect = b.getBoundingClientRect()
            const textSpan = b.querySelector('.btn-text')
            return {
              text: (textSpan?.textContent || '').trim(),
              title: b.getAttribute('title') || '',
              ariaLabel: b.getAttribute('aria-label') || '',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              visible: rect.width > 0 && rect.height > 0 && getComputedStyle(b).display !== 'none' && getComputedStyle(b).visibility !== 'hidden',
              isDeskOnly: b.classList.contains('desk-only'),
            }
          })
        })

        assert.equal(actions.length, 7, 'Must have exactly 7 primary toolbar actions')

        const expected = EXPECTED_LABELS[language]
        const actualLabels = actions.map(a => a.text)
        assert.deepEqual(actualLabels, expected, `Exact seven action order must match for ${language}`)

        // Verify bookmark label has NO "添加" / "Add"
        const bookmarkAction = actions[2]
        assert.ok(!bookmarkAction.text.includes('添加'), 'Bookmark label must not contain "添加"')
        assert.ok(!bookmarkAction.text.includes('Add'), 'Bookmark label must not contain "Add"')

        // Verify all 7 are visible and min48px at 390px
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i]
          assert.ok(a.visible, `Action ${expected[i]} must be visible`)
          assert.ok(!a.isDeskOnly, `Action ${expected[i]} must not be desk-only`)
          assert.ok(
            a.rect.width >= 48,
            `Action ${expected[i]} width ${a.rect.width} must be >= 48px at ${width}px`
          )
          assert.ok(
            a.rect.height >= 48,
            `Action ${expected[i]} height ${a.rect.height} must be >= 48px at ${width}px`
          )
          // No horizontal clipping: x >= 0 and right edge <= viewport width
          assert.ok(a.rect.x >= 0, `Action ${expected[i]} x ${a.rect.x} must be >= 0`)
          assert.ok(
            a.rect.x + a.rect.width <= width + 2,
            `Action ${expected[i]} right edge ${a.rect.x + a.rect.width} must not overflow ${width}px`
          )
        }

        // At 390px, verify sensible wrapping into two rows
        if (width === 390) {
          const row1Y = actions[0].rect.y
          const row2Y = actions[4].rect.y
          assert.ok(
            row2Y > row1Y + 20,
            `At 390px toolbar must wrap: row1 Y=${row1Y}, row2 Y=${row2Y}`
          )
        }

        // Verify NO duplicate mobile dock actions
        const dockButtons = await page.locator('.dock button').count()
        assert.equal(dockButtons, 0, 'No duplicate mobile toolbar actions in dock')

        // Verify More menu
        const moreBtn = page.locator('.reader-more-btn')
        assert.ok(await moreBtn.isVisible(), 'More button must be visible after 7 primaries')
        await moreBtn.click()
        const moreMenu = page.locator('.reader-more-menu')
        await moreMenu.waitFor({ state: 'visible' })

        // Check items in More menu: bookmark and read-aloud MUST be removed!
        const moreItems = await moreMenu.locator('[role="menuitem"]').evaluateAll(items =>
          items.map(it => it.textContent.trim())
        )
        assert.ok(
          !moreItems.some(it => it.includes('书签') || it.includes('Bookmark')),
          'Duplicate Bookmark must be removed from More menu'
        )
        assert.ok(
          !moreItems.some(it => it.includes('朗读') || it.includes('Read aloud')),
          'Duplicate Read aloud must be removed from More menu'
        )
        // Secondary items remain in More
        assert.ok(moreItems.length >= 2, 'Secondary features (modes, fullscreen) must remain in More menu')

        // Dismiss More menu
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.querySelector('.reader-more-menu'))

        // Verify interaction: Click Bookmark action
        const bookmarkBtn = page.locator('.bar-actions > .reader-action-btn').nth(2)
        const initialBookmarked = await page.evaluate(
          () => document.querySelector('.reader').__vueParentComponent.setupState.isBookmarked
        )
        assert.equal(initialBookmarked, false, 'Initially not bookmarked')

        await bookmarkBtn.click()
        await page.waitForFunction(
          () => document.querySelector('.reader').__vueParentComponent.setupState.isBookmarked === true
        )
        assert.equal(
          await page.evaluate(
            () => document.querySelector('.reader').__vueParentComponent.setupState.isBookmarked
          ),
          true,
          'Clicking bookmark toggles to true'
        )

        // Toggle bookmark back
        await bookmarkBtn.click()
        await page.waitForFunction(
          () => document.querySelector('.reader').__vueParentComponent.setupState.isBookmarked === false
        )

        // Verify interaction: Click Read aloud opens TTS panel
        const readAloudBtn = page.locator('.bar-actions > .reader-action-btn').nth(5)
        await readAloudBtn.click()
        await page.locator('.tts-panel').waitFor({ state: 'visible' })

        // Native back dismisses TTS panel
        assert.equal(await page.evaluate(() => window.__pagewiseReaderBack()), true)
        await page.waitForFunction(() => !document.querySelector('.tts-panel'))
      }, width, language)
    })
  }
}

for (const language of ['zh', 'en']) {
  for (const width of [992, 390]) {
    test(`PdfReaderView toolbar order, labels and geometry (${language}, ${width}px)`, { timeout: 45000 }, async () => {
      await withPdfReader(async page => {
        const primaryActions = await page.locator('.toolbar-primary .pdf-action-btn').evaluateAll(btns => {
          return btns.map(b => {
            const rect = b.getBoundingClientRect()
            const textSpan = b.querySelector('span')
            return {
              text: (textSpan?.textContent || '').trim(),
              title: b.getAttribute('title') || '',
              disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              visible: rect.width > 0 && rect.height > 0 && getComputedStyle(b).display !== 'none',
            }
          })
        })

        assert.equal(primaryActions.length, 7, 'PDF toolbar must expose 7 primary actions')

        const expected = EXPECTED_LABELS[language]
        const actualLabels = primaryActions.map(a => a.text)
        assert.deepEqual(actualLabels, expected, `Exact seven action order in PDF must match for ${language}`)

        // New page bookmarks and the real reading-assistant panel are available after load.
        assert.ok(!primaryActions[2].disabled, 'Bookmark in PDF must be enabled')
        assert.ok(!primaryActions[4].disabled, 'Reading assistant in PDF must be enabled')

        // Real capabilities must NOT be disabled
        assert.ok(!primaryActions[0].disabled, 'TOC in PDF must be enabled')
        assert.ok(!primaryActions[1].disabled, 'Search in PDF must be enabled')
        assert.ok(!primaryActions[3].disabled, 'Annotations in PDF must be enabled')
        assert.ok(!primaryActions[5].disabled, 'Read aloud in PDF must be enabled')
        assert.ok(!primaryActions[6].disabled, 'Typography in PDF must be enabled')

        // Geometry at 390px
        for (let i = 0; i < primaryActions.length; i++) {
          const a = primaryActions[i]
          assert.ok(a.visible, `PDF Action ${expected[i]} must be visible`)
          assert.ok(
            a.rect.width >= 48,
            `PDF Action ${expected[i]} width ${a.rect.width} must be >= 48px at ${width}px`
          )
          assert.ok(
            a.rect.height >= 48,
            `PDF Action ${expected[i]} height ${a.rect.height} must be >= 48px at ${width}px`
          )
          assert.ok(a.rect.x >= 0, `PDF Action ${expected[i]} x >= 0`)
          assert.ok(
            a.rect.x + a.rect.width <= width + 2,
            `PDF Action ${expected[i]} must not overflow ${width}px`
          )
        }

        if (width === 390) {
          const row1Y = primaryActions[0].rect.y
          const row2Y = primaryActions[4].rect.y
          assert.ok(
            row2Y > row1Y + 20,
            `At 390px PDF toolbar must wrap: row1 Y=${row1Y}, row2 Y=${row2Y}`
          )
        }
      }, width, language)
    })
  }
}
