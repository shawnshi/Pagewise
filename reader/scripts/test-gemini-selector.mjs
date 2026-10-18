import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from './vite-isolated.mjs'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

// A fresh browser context mounts only the owned selector, never the application/library.
test('selector renders localized labels, keyboard focus and isolated persistent profiles', { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body><div id="app"></div><script type="module" src="/__gemini-entry.js"></script></body></html>`
  const entry = `
    import { createApp, h } from 'vue';
    import { createPinia } from 'pinia';
    import AiProviderSelector from '/src/components/AiProviderSelector.vue';
    import { useSettings } from '/src/stores/settings.ts';
    if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({
      version: 14, aiProvider: 'siliconflow', aiBaseUrl: 'https://synthetic.invalid/v1',
      aiModel: 'synthetic-original', aiApiKey: 'synthetic-other-provider'
    }));
    const app = createApp({ setup() {
      const settings = useSettings();
      settings.persistOnChange();
      window.__geminiStore = settings;
      window.__changes = 0;
      return () => h(AiProviderSelector, { onChange: () => { window.__changes++ } });
    }});
    app.use(createPinia()); app.mount('#app');
  `
  const server = await createServer({
    configFile: false,
    root,
    cacheDir: fileURLToPath(new URL('../../.cache/v03/vite-gemini', import.meta.url)),
    plugins: [vue(), {
      name: 'gemini-selector-harness',
      resolveId(id) { if (id === '/__gemini-entry.js') return '\0gemini-entry' },
      load(id) { if (id === '\0gemini-entry') return entry },
      configureServer(s) {
        s.middlewares.use('/__gemini-test', (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html) })
      },
    }],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  let browser
  try {
    await server.listen()
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
    const context = await browser.newContext()
    const external = []
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue()
      external.push(new URL(route.request().url()).origin)
      return route.abort()
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin + '/__gemini-test')
    try {
      await page.locator('#ai-provider').waitFor({ timeout: 15000 })
    } catch (error) {
      throw new Error(`Selector failed to mount; page errors: ${JSON.stringify(errors)}`, { cause: error })
    }
    for (const width of [992, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const control = page.getByLabel('AI 服务', { exact: true })
      assert.equal(await control.count(), 1)
      assert.equal(await control.inputValue(), 'siliconflow')
      assert.equal(await control.locator('option[value="gemini"]').innerText(), 'Google Gemini')
      const box = await control.boundingBox()
      assert.ok(box.height >= 48)
      assert.ok(box.x >= 0 && box.x + box.width <= width)
    }
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('#ai-provider').evaluate(el => el === document.activeElement), true)
    assert.notEqual(await page.locator('#ai-provider').evaluate(el => getComputedStyle(el).outlineStyle), 'none')
    await page.selectOption('#ai-provider', 'gemini')
    assert.equal(await page.evaluate(() => window.__geminiStore.aiApiKey), '')
    assert.equal(await page.evaluate(() => window.__geminiStore.aiModel), 'gemini-3.8-flash')
    assert.equal(await page.evaluate(() => window.__changes), 1)
    await page.evaluate(() => {
      window.__geminiStore.aiApiKey = 'synthetic-google-only'
      window.__geminiStore.aiModel = 'synthetic-custom-gemini'
      window.__geminiStore.language = 'en'
    })
    assert.equal(await page.getByLabel('AI service', { exact: true }).count(), 1)
    await page.selectOption('#ai-provider', 'siliconflow')
    assert.equal(await page.evaluate(() => window.__geminiStore.aiApiKey), 'synthetic-other-provider')
    assert.equal(await page.evaluate(() => window.__geminiStore.aiModel), 'synthetic-original')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('lightread-settings')).aiProfiles?.gemini?.model === 'synthetic-custom-gemini')
    await page.reload()
    await page.locator('#ai-provider').waitFor()
    await page.selectOption('#ai-provider', 'gemini')
    assert.equal(await page.evaluate(() => window.__geminiStore.aiApiKey), 'synthetic-google-only')
    assert.equal(await page.evaluate(() => window.__geminiStore.aiModel), 'synthetic-custom-gemini')
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [], 'no external request, AI or otherwise')
    await context.close()
  } finally {
    await browser?.close()
    await server.close()
  }
})
