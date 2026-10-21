import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'
const output = resolve(readerRoot, '../.cache/native-pages-20261021/routes-browser')
mkdirSync(output, { recursive: true })
test('real NativePageView/Vue Router await leave ACK, abort failed leave, fence book updates and perform reader handoff', async () => {
  const fixture = {
    name: 'native-route-platform-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id === '/__native-routes.js') return '\0native-routes-entry'
      if (importer?.includes('/NativePageView.vue') && id === '../services/nativePages') return '\0native-routes-platform'
    },
    load(id) {
      if (id === '\0native-routes-platform') return `
        import { createNativePageVisibility } from '/src/services/nativePageVisibility.ts';
        const f = window.fixture = { calls: [], pending: [], failHide: false, deferHide: false, generation: 0 };
        const visibility = createNativePageVisibility('synthetic-router-realm', async (action, payload) => {
          f.calls.push({ action, ...payload });
          if (action === 'visibilityTicket') return { session: payload.session, generation: ++f.generation };
          if (action === 'hide' && f.failHide) throw new Error('draft_save_failed');
          if (action === 'hide' && f.deferHide) return new Promise(resolve => f.pending.push(resolve));
          return { applied: true, visible: action === 'show' };
        });
        export const showNativePage = (page, params, owner) => visibility.show(owner, page, params);
        export const hideNativePage = owner => visibility.hide(owner);
      `
      if (id === '\0native-routes-entry') return `
        import { createApp, h, nextTick } from 'vue';
        import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
        import NativePage from '/src/views/NativePageView.vue';
        const Reader = { render: () => h('div', { 'data-reader': 'synthetic' }, 'Synthetic reader') };
        const router = createRouter({ history: createMemoryHistory(), routes: [
          { path: '/library', component: NativePage }, { path: '/settings', component: NativePage },
          { path: '/book/:id', component: NativePage }, { path: '/read/:id', component: Reader }
        ] });
        window.fixture.router = router; window.fixture.nextTick = nextTick;
        await router.push('/library'); await router.isReady();
        createApp({ render: () => h(RouterView) }).use(router).mount('#app');
      `
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__native-routes.html') return next()
        res.setHeader('content-type', 'text/html'); res.end('<div id="app"></div><script type="module" src="/__native-routes.js"></script>')
      })
    },
  }
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser
  const results = []
  try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true })
    for (const width of [390, 992]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
      const errors = [], external = []
      try {
        await context.route('**/*', route => {
          if (route.request().url().startsWith(origin + '/')) return route.continue()
          external.push(new URL(route.request().url()).origin); return route.abort()
        })
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
        await page.goto(origin + '/__native-routes.html', { waitUntil: 'domcontentloaded', timeout: 45000 })
        await page.waitForFunction(() => window.fixture?.calls.some(c => c.action === 'show' && c.page === 'library'))
        await page.evaluate(async () => { fixture.failHide = true; await fixture.router.push('/read/synthetic-a') })
        assert.equal(await page.evaluate(() => fixture.router.currentRoute.value.path), '/library')
        assert.match(await page.getByRole('alert').innerText(), /页面尚不能离开/)
        assert.equal(await page.locator('[data-reader]').count(), 0)
        await page.evaluate(() => { fixture.failHide = false; fixture.deferHide = true; fixture.navigation = fixture.router.push('/settings') })
        await page.waitForFunction(() => fixture.pending.length === 1)
        assert.equal(await page.evaluate(() => fixture.router.currentRoute.value.path), '/library', 'route must not commit before draft ACK')
        await page.evaluate(async () => { fixture.deferHide = false; fixture.pending.shift()({ applied: true, visible: false }); await fixture.navigation })
        await page.waitForFunction(() => fixture.calls.some(c => c.action === 'show' && c.page === 'settings'))
        assert.equal(await page.evaluate(() => fixture.router.currentRoute.value.path), '/settings')
        await page.evaluate(async () => { await fixture.router.push('/book/synthetic-a?section=notes') })
        await page.waitForFunction(() => fixture.calls.some(c => c.action === 'show' && c.page === 'book' && c.params.id === 'synthetic-a'))
        await page.evaluate(async () => { fixture.failHide = true; await fixture.router.push('/book/synthetic-b?section=notes') })
        assert.equal(await page.evaluate(() => fixture.router.currentRoute.value.params.id), 'synthetic-a', 'reused component book-id update must also pass leave barrier')
        await page.evaluate(async () => { fixture.failHide = false; await fixture.router.push('/book/synthetic-b?section=notes') })
        await page.waitForFunction(() => fixture.calls.some(c => c.action === 'show' && c.params?.id === 'synthetic-b'))
        const before = await page.evaluate(() => fixture.calls.filter(c => c.action === 'hide').length)
        await page.evaluate(async () => { await fixture.router.push('/read/synthetic-b'); await fixture.nextTick(); await fixture.nextTick() })
        assert.equal(await page.locator('[data-reader]').count(), 1)
        assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.action === 'hide').length), before + 1, 'unmount must not issue a second hide')
        await page.evaluate(() => fixture.router.back())
        await page.waitForFunction(() => fixture.router.currentRoute.value.path === '/book/synthetic-b')
        await page.screenshot({ path: resolve(output, `${width}-guarded-route.png`) })
        assert.deepEqual(errors, []); assert.deepEqual(external, [])
        results.push({ width, failedLeaveBlocked: true, deferredLeaveWaitedForAck: true, reusedBookIdGuarded: true, nativeToReader: true, historyBack: true, externalRequests: 0 })
      } finally { await context.close() }
    }
    writeFileSync(resolve(output, 'result.json'), JSON.stringify({ actualVueComponentAndRouter: true, nativeBoundary: 'synthetic IPC only; not Android Views runtime', results }, null, 2))
  } finally { await browser?.close(); await server.close() }
})
