import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'

const output = resolve(readerRoot, '../.cache/ai-provider-options/browser')
mkdirSync(output, { recursive: true })

test('real settings offer only five providers and model dropdowns, with no automatic network or credential transfer', { timeout: 100000 }, async () => {
  const server = await createServer({ root: readerRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true })
    for (const width of [992, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1180 }, serviceWorkers: 'block' })
      const external = [], errors = []
      try {
        await context.route('**/*', route => {
          if (route.request().url().startsWith(origin + '/')) return route.continue()
          external.push(new URL(route.request().url()).origin)
          return route.abort()
        })
        await context.addInitScript(() => localStorage.setItem('lightread-settings', JSON.stringify({
          version: 16, language: 'zh', aiProvider: 'siliconflow', aiBaseUrl: 'https://synthetic.invalid/retired',
          aiApiKey: 'synthetic-archived-only', aiModel: 'synthetic-old-model',
        })))
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        // Gate on the actual settings controls, not unrelated font/image load completion.
        await page.goto(origin + '/#/settings?section=ai', { waitUntil: 'domcontentloaded', timeout: 45000 })
        try { await page.locator('#ai-provider').waitFor({ timeout: 45000 }) }
        catch (error) { throw new Error(`Settings did not mount: ${JSON.stringify({ errors, external })}`, { cause: error }) }
        const provider = page.locator('#ai-provider'), model = page.locator('#ai-model')
        assert.deepEqual(await provider.locator('option:not([disabled])').evaluateAll(options => options.map(o => o.value)), ['trial', 'deepseek', 'openai', 'gemini', 'openrouter'])
        assert.equal(await provider.inputValue(), '')
        assert.equal(await model.isDisabled(), true)
        assert.equal(await page.locator('.provider-retired').count(), 1)
        assert.equal(await page.locator('#ai-key').count(), 0)
        for (const [id, expected] of [['deepseek','deepseek-flash'], ['openai','gpt-6.1-sol'], ['gemini','gemini-4-argon'], ['openrouter','openai/gpt-6.1-sol']]) {
          await provider.selectOption(id)
          assert.equal(await model.inputValue(), expected)
          assert.equal(await page.locator('#ai-key').inputValue(), '')
          assert.ok(await model.locator('option').count() >= 2)
          const box = await model.boundingBox()
          assert.ok(box.height >= 48 && box.x >= 0 && box.x + box.width <= width)
          await page.locator('#ai-key').fill(`synthetic-${id}-only`)
          if (id === 'openai') await model.selectOption('gpt-6-astra')
        }
        await provider.selectOption('openai')
        assert.equal(await model.inputValue(), 'gpt-6-astra')
        assert.equal(await page.locator('#ai-key').inputValue(), 'synthetic-openai-only')
        await provider.focus()
        await page.keyboard.press('Tab')
        assert.equal(await model.evaluate(el => el === document.activeElement), true)
        await page.evaluate(async () => {
          const store = (await import('/src/stores/settings.ts')).useSettings()
          store.aiModel = 'synthetic-preserved-model'
          store.language = 'en'
        })
        assert.equal(await model.inputValue(), 'synthetic-preserved-model')
        assert.match(await model.locator('option:checked').innerText(), /^Saved:/)
        assert.equal(await page.getByLabel('Model', { exact: true }).count(), 1)
        await page.screenshot({ path: resolve(output, `${width}-model-dropdown.png`), fullPage: true })
        await provider.selectOption('trial')
        assert.equal(await page.locator('#ai-key').count(), 0)
        assert.equal(await model.locator('option').count(), 1)
        assert.equal(await model.inputValue(), 'deepseek-ai/DeepSeek-V4-Flash')
        await provider.selectOption('deepseek')
        assert.equal(await page.locator('#ai-key').inputValue(), 'synthetic-deepseek-only')
        assert.equal(await model.inputValue(), 'deepseek-flash')
        const archive = await page.evaluate(async () => (await import('/src/stores/settings.ts')).useSettings().aiProfiles.siliconflow)
        assert.equal(archive.apiKey, 'synthetic-archived-only')
        assert.deepEqual(external, [])
        assert.deepEqual(errors, [])
      } finally { await context.close() }
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})
