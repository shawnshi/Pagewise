import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import vue from '@vitejs/plugin-vue'
import { createServer, readerRoot } from './vite-isolated.mjs'

const runLabel = process.env.COMPANION_CARD_RUN ?? `run-${Date.now()}-${process.pid}`
assert.match(runLabel, /^[A-Za-z0-9_-]+$/)
const artifacts = resolve(readerRoot, '../.cache/companion-20261020/card-browser', runLabel)
mkdirSync(artifacts, { recursive: true })
const staticOnly = process.argv.includes('--static')
const results = {
  run: runLabel,
  checks: [], metrics: [], diagnostics: [], errors: [], externalRequests: [], missingKeys: [],
}
const sha = source => createHash('sha256').update(source).digest('hex')
// Serve frozen, unchanged component/helper bytes. No diagnostic source instrumentation.
const originals = {
  card: readFileSync(resolve(readerRoot, 'src/components/PagewiseCompanionCard.vue'), 'utf8'),
  geometry: readFileSync(resolve(readerRoot, 'src/services/PagewiseCompanion/cardGeometry.ts'), 'utf8'),
}
const transformed = { card: originals.card, geometry: originals.geometry }
writeFileSync(resolve(artifacts, 'served-Card.vue'), transformed.card)
writeFileSync(resolve(artifacts, 'served-cardGeometry.ts'), transformed.geometry)
writeFileSync(resolve(artifacts, 'source-hashes.json'), JSON.stringify({ original: { card: sha(originals.card), geometry: sha(originals.geometry) }, served: { card: sha(transformed.card), geometry: sha(transformed.geometry) } }, null, 2))

const fixture = `
import { createApp, h, shallowRef, ref, nextTick } from 'vue';
import Card from '/src/components/PagewiseCompanionCard.vue';
import Status from '/src/components/PagewiseCompanionStatus.vue';
import '/src/styles/main.css';
const diagnostics=[], ids=new WeakMap();let seq=0;
window.__companionDiag={event:(event,data)=>diagnostics.push({event,...data}),idFor:object=>{if(!object)return null;if(!ids.has(object))ids.set(object,++seq);return ids.get(object)}};
window.__missingKeys=new Set();
const card = shallowRef(null), status = ref('loading'), active = ref(true), errorCode = ref(null);
const calls = {close:0,translate:0,expand:0,dismiss:0,inspect:0,settings:0,basic:0};
const dj = { card, status, active, errorCode, progress:ref(.42), closeCard(){calls.close++;card.value=null}, translate(){calls.translate++}, expand(){calls.expand++}, dismiss(){calls.dismiss++}, switchToBasic(){calls.basic++;status.value='idle'} };
createApp({setup:()=>()=>h('div', {class:'reader bars-on'}, [h('button',{id:'origin'},'Origin'),h('main',{id:'reading'},[h('p',{id:'source',style:'margin:120px 40px 0'},'原文概念和语境 Original concept and context.'),h('iframe',{id:'frame',srcdoc:'<style>body{margin:0;font:18px sans-serif}p{margin:35px 20px}</style><p id="framed">Frame original concept</p>',style:'position:absolute;left:60px;top:140px;width:280px;height:160px;border:3px solid black'})]),h(Status,{dj,'onOpen-settings':()=>calls.settings++}),h('footer',{id:'footer'},'Footer'),card.value?h(Card,{dj,onInspect:()=>calls.inspect++}):null])}).mount('#app');
window.qa={dj,calls,nextTick,diagnostics,async open({long=false,framed=false,kind='term'}={}){const doc=framed?document.querySelector('iframe').contentDocument:document;const node=doc.querySelector(framed?'#framed':'#source').firstChild;const range=doc.createRange();range.setStart(node,0);range.setEnd(node,Math.min(8,node.length));card.value={target:{kind,range,text:'Original text',item:{q:'概念 Concept',def:long?'长中文释义 unbreakable_identifier_'.repeat(250):'A short definition.',why:'A key reason',text:'A note',k:'history'}},rect:{left:1,right:2,top:1,bottom:2},translation:'',translating:false,translateError:false};await nextTick()},async late(){card.value={...card.value,translation:'译文与连续标识 LONG_IDENTIFIER_'.repeat(600)};await nextTick()},async close(){dj.closeCard();await nextTick()},async mode(value){document.documentElement.dataset.theme=value==='eink'?'light':value;document.documentElement.classList.toggle('pagewise-eink',value==='eink');await nextTick()}};
`
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{margin:0;height:100%;width:100%}.reader{--footer-h:64px;--lr-safe-top:8px;--lr-safe-bottom:12px;--lr-safe-left:8px;--lr-safe-right:8px;position:relative;height:100%;display:flex;flex-direction:column;overflow:hidden}#reading{flex:1;min-height:0;position:relative;overflow:auto}#footer{position:absolute;bottom:0;left:0;right:0;height:76px;background:var(--surface-2)}#origin{min-height:48px;flex-shrink:0}iframe{visibility:hidden}iframe.test-visible{visibility:visible}</style></head><body><div id="app"></div><script type="module" src="/companion-fixture.js"></script></body></html>`
const dictionaryAdapter = `import en from '/src/i18n/en.ts';import zh from '/src/i18n/zh.ts';export function t(key,params={}){let value=en[key]??zh[key];if(value===undefined){window.__missingKeys?.add(key);value=key}return Object.entries(params).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',String(v)),value)}`
const server = await createServer({
  configFile: false, root: readerRoot, envDir: resolve(artifacts, 'empty-env'), cacheDir: resolve(artifacts, 'vite'),
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: 'companion-fixture-diagnostics', enforce: 'pre',
    resolveId(id, importer) {
      if (id === '/companion-fixture.js') return '\0companion-fixture'
      if ((id === '../i18n' || id.endsWith('/i18n')) && importer?.includes('/components/PagewiseCompanion')) return '\0companion-i18n'
    },
    load(id) {
      if (id === '\0companion-fixture') return fixture
      if (id === '\0companion-i18n') return dictionaryAdapter
    },
    transform(_source, id) {
      if (id.endsWith('/components/PagewiseCompanionCard.vue')) return transformed.card
      if (id.endsWith('/services/PagewiseCompanion/cardGeometry.ts')) return transformed.geometry
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/companion-lane.html') { res.setHeader('Content-Type', 'text/html'); res.end(html) }
        else next()
      })
    },
  }, vue()],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [readerRoot, artifacts] } },
})
let browser
let executionStarted = false
try {
  // Transform all fixture entry points before the one browser execution. Import and
  // instrumentation failures here do not consume a failing-condition execution.
  const imports = {}
  for (const url of ['/companion-fixture.js', '/src/components/PagewiseCompanionCard.vue', '/src/components/PagewiseCompanionStatus.vue', '/src/services/PagewiseCompanion/cardGeometry.ts', '/src/styles/main.css']) {
    const output = await server.transformRequest(url)
    assert.ok(output?.code, `Cannot transform ${url}`)
    imports[url] = { hash: sha(output.code), imports: [...output.code.matchAll(/from\s+["']([^"']+)/g)].map(match => match[1]) }
  }
  writeFileSync(resolve(artifacts, 'static-imports.json'), JSON.stringify(imports, null, 2))
  if (staticOnly) console.log('Static fixture/source transforms passed; no browser execution.')
  else {
    writeFileSync(resolve(artifacts, 'receipt-started.json'), JSON.stringify({ run: runLabel, time: new Date().toISOString(), source: 'actual unmodified SFC/helper' }, null, 2), { flag: 'wx' })
    executionStarted = true
    await server.listen()
    const port = server.httpServer.address().port
    const origin = `http://127.0.0.1:${port}`
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
    assert.ok(edge, 'Installed Edge required')
    browser = await chromium.launch({ executablePath: edge, headless: true, args: ['--disable-background-networking', '--no-first-run'] })
    results.browser = browser.version()
    async function newContext(options = {}) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce', ...options })
      context.setDefaultTimeout(3000)
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (results.externalRequests.push(route.request().url()), route.abort()))
      return context
    }
    const context = await newContext()
    const page = await context.newPage()
    page.on('pageerror', error => results.errors.push(String(error)))
    async function fresh(target = page) { await target.goto(`${origin}/companion-lane.html`); await target.waitForFunction(() => Boolean(window.qa)); await target.locator('#frame').evaluate(frame => new Promise(resolve => { if (frame.contentDocument?.readyState === 'complete') resolve(); else frame.addEventListener('load', resolve, { once: true }) })) }
    const settle = (target = page) => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
    const bounds = (selector, target = page) => target.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return { ...r.toJSON(), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } })
    const inViewport = (r, viewport) => assert.ok(r.left >= -.5 && r.top >= -.5 && r.right <= viewport.width + .5 && r.bottom <= viewport.height + .5, JSON.stringify({ r, viewport }))
    async function targets(selector, target = page) {
      const sizes = await target.locator(selector).evaluateAll(elements => elements.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })))
      assert.ok(sizes.length, `No targets: ${selector}`)
      for (const size of sizes) assert.ok(size.width >= 48 && size.height >= 48, JSON.stringify(size))
    }
    async function collect(name, target) {
      const data = await target.evaluate(() => {
        const card = document.querySelector('.dj-card')
        return {
          events: window.qa?.diagnostics.splice(0) ?? [], missingKeys: [...(window.__missingKeys ?? [])],
          dom: card ? { rect: card.getBoundingClientRect().toJSON(), inline: card.style.cssText } : null,
        }
      })
      results.diagnostics.push({ check: name, ...data })
      results.missingKeys = [...new Set([...results.missingKeys, ...data.missingKeys])]
    }
    async function check(name, fn, blocker, target = page) {
      try { await fn(); results.checks.push({ name, blocker, status: 'passed' }) }
      catch (error) { results.checks.push({ name, blocker, status: 'failed', error: String(error) }) }
      finally { await collect(name, target) }
    }

    const focusContext = await newContext({ reducedMotion: 'no-preference' })
    const focusPage = await focusContext.newPage()
    focusPage.on('pageerror', error => results.errors.push(String(error)))
    await fresh(focusPage)
    await check('initial-focus-first-open-without-manual-focus-normal-motion', async () => {
      await focusPage.locator('#origin').click()
      await focusPage.evaluate(() => window.qa.open())
      await settle(focusPage)
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('.dj-card')), true, 'Fresh modal must own focus without a test .focus() call')
      const durations = await focusPage.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, source: getComputedStyle(document.querySelector('#source')).transitionDuration, card: getComputedStyle(document.querySelector('.dj-card')).transitionDuration }))
      assert.equal(durations.reduced, false); assert.equal(durations.source, '0s'); assert.equal(durations.card, '0s')
      await focusPage.keyboard.press('Tab')
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('.dj-card button')), true)
      await focusPage.keyboard.press('Escape'); await settle(focusPage)
      assert.equal(await focusPage.locator('.dj-card').count(), 0)
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('#origin')), true)
      results.metrics.push({ initialFocus: 'top-document', normalMotionComputed: durations })
    }, 'COMP-FOCUS-01', focusPage)
    await focusPage.emulateMedia({ reducedMotion: 'reduce' })
    await fresh(focusPage)
    let iframeScrollBefore
    await check('initial-focus-from-iframe-keyboard-without-manual-focus', async () => {
      await focusPage.evaluate(() => {
        const frame = document.querySelector('#frame'); frame.style.visibility = 'visible'
        const opener = frame.contentDocument.createElement('button'); opener.id = 'frame-opener'; opener.textContent = 'Frame trigger'
        frame.contentDocument.body.append(opener)
      })
      await focusPage.frameLocator('#frame').locator('#frame-opener').click()
      iframeScrollBefore = await focusPage.evaluate(() => ({ hostTop: document.scrollingElement.scrollTop, readingTop: document.querySelector('#reading').scrollTop, frameTop: document.querySelector('#frame').contentDocument.scrollingElement.scrollTop }))
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('#frame')), true, 'Fixture must focus the child document first')
      await focusPage.evaluate(() => window.qa.open({ framed: true }))
      await settle(focusPage)
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('.dj-card')), true, 'Modal must take focus out of the iframe')
      await focusPage.keyboard.press('Tab')
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('.dj-card button')), true)
      await focusPage.keyboard.press('Shift+Tab')
      assert.equal(await focusPage.evaluate(() => document.activeElement === [...document.querySelectorAll('.dj-card button:not(:disabled)')].at(-1)), true)
      await focusPage.keyboard.press('Escape'); await settle(focusPage)
      assert.equal(await focusPage.locator('.dj-card').count(), 0)
      results.metrics.push({ initialFocus: 'iframe', tabWrap: true, escape: true })
    }, 'COMP-FOCUS-01', focusPage)
    await check('iframe-escape-restores-exact-trigger-without-scrolling', async () => {
      assert.equal(await focusPage.evaluate(() => { const frame = document.querySelector('#frame'); return document.activeElement === frame && frame.contentDocument.activeElement.id === 'frame-opener' }), true, 'Escape must return focus to the child-document trigger')
      const after = await focusPage.evaluate(() => ({ hostTop: document.scrollingElement.scrollTop, readingTop: document.querySelector('#reading').scrollTop, frameTop: document.querySelector('#frame').contentDocument.scrollingElement.scrollTop }))
      assert.deepEqual(after, iframeScrollBefore)
      results.metrics.push({ iframeTriggerRestored: true, scrollBefore: iframeScrollBefore, scrollAfter: after })
    }, 'COMP-FOCUS-RETURN-01', focusPage)
    await fresh(focusPage)
    await check('double-closed-shadow-iframe-focus-keyboard-and-exact-return', async () => {
      const click = await focusPage.evaluate(async () => {
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;left:420px;top:100px;width:300px;height:220px;z-index:2'
        document.body.append(host)
        const outer = host.attachShadow({ mode: 'closed' })
        const innerHost = document.createElement('div'); outer.append(innerHost)
        const inner = innerHost.attachShadow({ mode: 'closed' })
        const frame = document.createElement('iframe')
        frame.style.cssText = 'display:block;width:280px;height:160px;border:3px solid;visibility:visible'
        frame.srcdoc = '<p id="closed-text">Closed original synthetic source.</p><button id="closed-origin">Source trigger</button>'
        await new Promise(resolve => { frame.addEventListener('load', resolve, { once: true }); inner.append(frame) })
        const doc = frame.contentDocument, trigger = doc.querySelector('#closed-origin'), range = doc.createRange()
        range.selectNodeContents(doc.querySelector('#closed-text'))
        window.__closedFocus = { host, innerHost, frame, doc, trigger, range }
        const f = frame.getBoundingClientRect(), r = trigger.getBoundingClientRect()
        return { x: f.left + frame.clientLeft + r.left + r.width / 2, y: f.top + frame.clientTop + r.top + r.height / 2 }
      })
      await focusPage.mouse.click(click.x, click.y)
      const proof = await focusPage.evaluate(() => {
        const p = window.__closedFocus
        return { outerClosed: p.host.shadowRoot === null, innerClosed: p.innerHost.shadowRoot === null, retargeted: document.activeElement === p.host, sourceFocused: p.doc.hasFocus(), exactTrigger: p.doc.activeElement === p.trigger, frameKnownFromSource: p.doc.defaultView.frameElement === p.frame }
      })
      assert.deepEqual(proof, { outerClosed: true, innerClosed: true, retargeted: true, sourceFocused: true, exactTrigger: true, frameKnownFromSource: true })
      const scrollBefore = await focusPage.evaluate(() => ({ hostTop: document.scrollingElement.scrollTop, readingTop: document.querySelector('#reading').scrollTop, sourceTop: window.__closedFocus.doc.scrollingElement.scrollTop }))
      await focusPage.evaluate(() => {
        const range = window.__closedFocus.range
        window.qa.dj.card.value = { target: { kind: 'term', section: 0, item: { t: 'term', id: 'closed-focus', block: 0, sentence: 0, start: 0, end: 6, q: 'Closed original', def: 'Synthetic explanation', r: 2 }, range, text: range.toString() } }
      })
      await settle(focusPage)
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('.dj-card')), true)
      await focusPage.keyboard.press('Tab')
      assert.equal(await focusPage.evaluate(() => document.activeElement === document.querySelector('.dj-card button')), true)
      await focusPage.keyboard.press('Shift+Tab')
      assert.equal(await focusPage.evaluate(() => document.activeElement === [...document.querySelectorAll('.dj-card button:not(:disabled)')].at(-1)), true)
      await focusPage.keyboard.press('Escape'); await settle(focusPage)
      assert.equal(await focusPage.locator('.dj-card').count(), 0)
      const restored = await focusPage.evaluate(() => { const p = window.__closedFocus; return { host: document.activeElement === p.host, source: p.doc.hasFocus(), exactTrigger: p.doc.activeElement === p.trigger } })
      assert.deepEqual(restored, { host: true, source: true, exactTrigger: true })
      const scrollAfter = await focusPage.evaluate(() => ({ hostTop: document.scrollingElement.scrollTop, readingTop: document.querySelector('#reading').scrollTop, sourceTop: window.__closedFocus.doc.scrollingElement.scrollTop }))
      assert.deepEqual(scrollAfter, scrollBefore)
      results.metrics.push({ doubleClosedShadowFocus: { proof, restored, scrollBefore, scrollAfter } })
    }, 'COMP-FOCUS-RETURN-01', focusPage)
    await focusContext.close()
    await fresh()
    await check('status-out-of-flex-no-body-shift', async () => {
      const before = await bounds('#reading')
      await page.evaluate(() => window.qa.dj.active.value = false); await settle()
      const after = await bounds('#reading')
      await page.evaluate(() => window.qa.dj.active.value = true); await settle()
      assert.deepEqual(before, after)
    })
    await check('status-48px-static-footer-clearance', async () => {
      await targets('.dj-dot-btn')
      assert.ok((await bounds('.dj-dot-btn')).bottom <= (await bounds('#footer')).top)
      assert.equal(await page.locator('.dj-dot').evaluate(el => getComputedStyle(el).animationName), 'none')
    })
    await page.locator('#origin').focus()
    await page.evaluate(() => window.qa.open()); await settle()
    await check('desktop-live-range-not-saved-rect', async () => {
      const card = await bounds('.dj-card')
      const source = await page.evaluate(() => window.qa.dj.card.value.target.range.getBoundingClientRect().toJSON())
      assert.ok(card.top >= source.bottom && card.top <= source.bottom + 20, JSON.stringify({ card, source }))
    })
    await check('card-48px-controls', () => targets('.dj-card button'))
    await check('late-content-internal-scroll-viewport', async () => {
      await page.evaluate(() => window.qa.late()); await settle()
      inViewport(await bounds('.dj-card'), page.viewportSize())
      const body = await bounds('.dj-card-body'); assert.ok(body.scrollHeight > body.clientHeight)
      await page.locator('.dj-card-body').evaluate(el => el.scrollTop = el.scrollHeight)
      inViewport(await bounds('.dj-card-head'), page.viewportSize()); inViewport(await bounds('.dj-card-actions'), page.viewportSize())
    })
    await check('modal-tab-wrap-and-escape-restores-focus', async () => {
      assert.equal(await page.locator('.dj-card').getAttribute('aria-modal'), 'true')
      const buttons = page.locator('.dj-card button:enabled')
      await buttons.last().focus(); await page.keyboard.press('Tab')
      assert.equal(await buttons.first().evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Shift+Tab'); assert.equal(await buttons.last().evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.dj-card').count(), 0)
      assert.equal(await page.locator('#origin').evaluate(el => el === document.activeElement), true)
    })

    await fresh()
    await page.evaluate(() => window.qa.open()); await settle()
    let before = await bounds('.dj-card'), moved
    await check('live-mutation-scroll-resize:source-mutation', async () => {
      await page.locator('#source').evaluate(el => el.style.marginTop = '200px'); await settle()
      moved = await bounds('.dj-card')
      const range = await page.evaluate(() => window.qa.dj.card.value.target.range.getBoundingClientRect().toJSON())
      results.metrics.push({ condition: 'UI-LAYOUT-MUTATION', before, moved, range, viewport: page.viewportSize() })
      assert.ok(moved.top > before.top + 60, JSON.stringify({ before, moved, range }))
    }, 'UI-LAYOUT-MUTATION')
    await check('live-mutation-scroll-resize:scroll', async () => {
      await page.locator('#reading').evaluate(el => { el.style.height = '500px'; el.style.flex = 'none'; el.querySelector('p').style.marginBottom = '1000px'; el.scrollTop = 40 }); await settle()
      const scrolled = await bounds('.dj-card')
      assert.ok(scrolled.top < moved.top - 30, JSON.stringify({ moved, scrolled }))
    }, 'UI-LAYOUT-MUTATION')
    await check('live-mutation-scroll-resize:resize', async () => {
      await page.setViewportSize({ width: 900, height: 620 }); await settle()
      inViewport(await bounds('.dj-card'), page.viewportSize())
    }, 'UI-LAYOUT-MUTATION')

    await fresh()
    await check('range-helper-frame-offset-and-negative-inputs', async () => {
      const data = await page.evaluate(async () => {
        const { rangeHostRect } = await import('/src/services/PagewiseCompanion/cardGeometry.ts')
        const qa = window.qa, frame = document.querySelector('#frame')
        frame.style.visibility = 'visible'; await qa.open({ framed: true }); frame.style.visibility = 'visible'; if (getComputedStyle(frame).visibility !== 'visible') throw new Error('Positive iframe fixture must be visible')
        const range = qa.dj.card.value.target.range, f = frame.getBoundingClientRect(), local = range.getBoundingClientRect()
        const framePreconditions = { connected: frame.isConnected, visibility: getComputedStyle(frame).visibility, viewport: { width: frame.contentWindow.innerWidth, height: frame.contentWindow.innerHeight }, local: local.toJSON(), frame: f.toJSON() }
        const actual = rangeHostRect(range)
        const collapsed = range.cloneRange(); collapsed.collapse()
        // Evaluate before mutating/removing the original text.
        const collapsedResult = rangeHostRect(collapsed)
        const orphan = frame.contentDocument.createElement('p'); orphan.textContent = 'Disconnected synthetic original'
        const detached = frame.contentDocument.createRange(); detached.selectNodeContents(orphan)
        const detachedPreconditions = { collapsed: detached.collapsed, connected: detached.startContainer.isConnected }
        const detachedResult = rangeHostRect(detached)
        const p = frame.contentDocument.querySelector('p')
        p.style.display = 'none'; const hidden = rangeHostRect(range); p.style.display = ''
        frame.style.visibility = 'hidden'; const hiddenFrame = rangeHostRect(range); frame.style.visibility = 'visible'
        return { actual, framePreconditions, expected: { left: f.left + frame.clientLeft + local.left, top: f.top + frame.clientTop + local.top }, collapsedResult, detachedResult, detachedPreconditions, hidden, hiddenFrame }
      })
      results.metrics.push({ condition: 'UI-FRAME-GEOMETRY', ...data })
      assert.equal(data.detachedPreconditions.collapsed, false); assert.equal(data.detachedPreconditions.connected, false)
      for (const key of ['collapsedResult', 'detachedResult', 'hidden', 'hiddenFrame']) assert.equal(data[key], null, key)
      assert.ok(data.actual, JSON.stringify(data))
      assert.ok(Math.abs(data.actual.left - data.expected.left) < 1); assert.ok(Math.abs(data.actual.top - data.expected.top) < 1)
    }, 'UI-FRAME-GEOMETRY')
    await check('iframe-original-removal-closes-no-navigation', async () => {
      const url = page.url()
      await page.locator('#frame').evaluate(frame => frame.contentDocument.querySelector('p').remove())
      await settle()
      assert.equal(await page.locator('.dj-card').count(), 0)
      assert.equal(page.url(), url)
    }, 'UI-INVALID-RANGE-CLOSE')

    for (const type of ['hidden', 'collapsed', 'removed']) {
      await fresh()
      await page.evaluate(() => window.qa.open()); await settle()
      await check(`hidden-collapsed-detached-close-no-navigation:${type}`, async () => {
        const url = page.url()
        await page.evaluate(type => {
          const range = window.qa.dj.card.value.target.range
          if (type === 'hidden') document.querySelector('#source').style.visibility = 'hidden'
          if (type === 'collapsed') { range.collapse(); document.querySelector('#source').setAttribute('data-change', '1') }
          if (type === 'removed') document.querySelector('#source').remove()
        }, type)
        await settle()
        assert.equal(await page.locator('.dj-card').count(), 0, type); assert.equal(page.url(), url)
      }, 'UI-INVALID-RANGE-CLOSE')
    }

    await fresh()
    await check('status-popover-keyboard-actions', async () => {
      await page.evaluate(() => { window.qa.dj.status.value = 'error'; window.qa.dj.errorCode.value = 'auth' }); await settle()
      await page.locator('.dj-dot-btn').focus(); await page.keyboard.press('Enter'); await targets('.dj-pop button')
      assert.equal(await page.locator('.dj-pop').getAttribute('role'), 'dialog')
      await page.keyboard.press('Tab'); assert.equal(await page.locator('.dj-pop button').first().evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.dj-pop').count(), 0)
      assert.equal(await page.locator('.dj-dot-btn').evaluate(el => el === document.activeElement), true)
      await page.locator('.dj-dot-btn').click(); await page.locator('.dj-pop-actions button').first().click()
      assert.equal(await page.evaluate(() => window.qa.calls.settings), 1)
      await page.locator('.dj-dot-btn').click(); await page.locator('.dj-pop-actions button').last().click()
      assert.equal(await page.evaluate(() => window.qa.calls.basic), 1)
    })
    await check('card-action-and-truthful-partial-error', async () => {
      await page.evaluate(() => window.qa.open()); await settle()
      await page.locator('.dj-card-actions button').nth(2).click(); assert.equal(await page.evaluate(() => window.qa.calls.translate), 1)
      await page.evaluate(() => { const card = window.qa.dj.card.value; window.qa.dj.card.value = { ...card, translation: 'partial', translateError: true } }); await settle()
      assert.match(await page.locator('.dj-card-body').textContent(), /incomplete/)
      assert.equal(await page.locator('.dj-card-actions button').nth(2).isEnabled(), true)
      await page.locator('.dj-card-actions button').first().click(); assert.equal(await page.evaluate(() => window.qa.calls.inspect), 1)
    })

    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
    async function colors(selector, target = page) {
      return target.locator(selector).evaluate(el => { const style = getComputedStyle(el); let background = style.backgroundColor, node = el; while (background === 'rgba(0, 0, 0, 0)' && node.parentElement) { node = node.parentElement; background = getComputedStyle(node).backgroundColor } return { color: style.color, background } })
    }
    for (const viewport of [{ width: 390, height: 700 }, { width: 1100, height: 800 }]) for (const theme of ['dark', 'eink']) {
      await page.setViewportSize(viewport); await fresh()
      await check(`${viewport.width}-${theme}-long-bounds-touch-screenshot`, async () => {
        await page.evaluate(theme => window.qa.mode(theme), theme)
        await page.evaluate(() => { window.qa.dj.status.value = 'error'; window.qa.dj.errorCode.value = 'auth' })
        await page.evaluate(() => window.qa.open({ long: true, kind: 'key' })); await page.evaluate(() => window.qa.late()); await settle()
        const card = await bounds('.dj-card'), body = await bounds('.dj-card-body'), actions = await bounds('.dj-card-actions')
        inViewport(card, viewport); inViewport(actions, viewport); assert.ok(body.scrollHeight > body.clientHeight); await targets('.dj-card button')
        const renderedColors = {}
        for (const selector of ['.dj-card', '.dj-card-kind', '.dj-card-label', '.dj-card-tr', '.dj-card-actions .btn-primary']) {
          const pair = await colors(selector); renderedColors[selector] = { ...pair, ratio: contrast(pair.color, pair.background) }
        }
        const bodyWidth = await page.evaluate(() => document.body.scrollWidth); assert.equal(bodyWidth, viewport.width)
        results.metrics.push({ viewport, theme, card, body, actions, bodyWidth, renderedColors })
        await page.screenshot({ path: resolve(artifacts, `${viewport.width}-${theme}.png`) })
        await page.evaluate(() => window.qa.close()); await page.locator('.dj-dot-btn').click(); await targets('.dj-pop button')
        const popover = await bounds('.dj-pop'); inViewport(popover, viewport)
        const popoverColors = await colors('.dj-pop p')
        results.metrics.push({ viewport, theme, popover, popoverColors: { ...popoverColors, ratio: contrast(popoverColors.color, popoverColors.background) } })
        await page.screenshot({ path: resolve(artifacts, `${viewport.width}-${theme}-status.png`) })
        await page.keyboard.press('Escape')
      })
    }
    await fresh()
    await check('observer-and-listener-teardown', async () => {
      await page.evaluate(() => window.qa.open()); await settle(); await page.evaluate(() => window.qa.close()); await settle()
      const before = await page.evaluate(() => window.qa.calls.close)
      await page.locator('#source').evaluate(el => el.remove()); await page.setViewportSize({ width: 1000, height: 700 }); await page.keyboard.press('Escape'); await settle()
      assert.equal(await page.evaluate(() => window.qa.calls.close), before)
    })
    await context.close()

    const noResize = await newContext({ viewport: { width: 1100, height: 620 } })
    await noResize.addInitScript(() => { window.ResizeObserver = undefined })
    const fallbackPage = await noResize.newPage()
    fallbackPage.on('pageerror', error => results.errors.push(String(error)))
    await fresh(fallbackPage)
    await check('late-content-without-ResizeObserver', async () => {
      await fallbackPage.evaluate(() => window.qa.open()); await settle(fallbackPage)
      await fallbackPage.evaluate(() => window.qa.late()); await settle(fallbackPage)
      const card = await bounds('.dj-card', fallbackPage), body = await bounds('.dj-card-body', fallbackPage), actions = await bounds('.dj-card-actions', fallbackPage)
      inViewport(card, { width: 1100, height: 620 }); inViewport(actions, { width: 1100, height: 620 })
      assert.ok(body.scrollHeight > body.clientHeight && body.clientHeight > 0)
      results.metrics.push({ fallbackResizeObserver: true, card, body, actions })
    }, undefined, fallbackPage)
    await noResize.close()

    const touch = await newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 700 } })
    const touchPage = await touch.newPage()
    touchPage.on('pageerror', error => results.errors.push(String(error)))
    await fresh(touchPage)
    await check('mobile-real-synthetic-taps-status-card-actions-close', async () => {
      const touchInfo = await touchPage.evaluate(() => ({ maxTouchPoints: navigator.maxTouchPoints, coarse: matchMedia('(pointer:coarse)').matches }))
      assert.ok(touchInfo.maxTouchPoints > 0); results.metrics.push({ touchInfo })
      await touchPage.evaluate(() => { window.qa.dj.status.value = 'error'; window.qa.dj.errorCode.value = 'auth' }); await settle(touchPage)
      await touchPage.locator('.dj-dot-btn').tap(); await targets('.dj-pop button', touchPage)
      await touchPage.locator('.dj-pop-actions button').first().tap(); assert.equal(await touchPage.evaluate(() => window.qa.calls.settings), 1)
      await touchPage.evaluate(() => window.qa.open()); await settle(touchPage)
      await targets('.dj-card button', touchPage)
      await touchPage.locator('.dj-card-actions button').nth(2).tap(); assert.equal(await touchPage.evaluate(() => window.qa.calls.translate), 1)
      await touchPage.locator('.dj-card-head button').tap(); assert.equal(await touchPage.locator('.dj-card').count(), 0)
      await touchPage.screenshot({ path: resolve(artifacts, '390-touch-after-close.png') })
    }, undefined, touchPage)
    await touch.close()
    if (results.checks.some(check => check.status === 'failed') || results.errors.length || results.externalRequests.length || results.missingKeys.length) process.exitCode = 1
  }
} catch (error) { results.failure = String(error); process.exitCode = 1 }
finally {
  if (browser) await browser.close()
  await server.close()
  if (executionStarted) {
    results.exitCode = process.exitCode ?? 0
    writeFileSync(resolve(artifacts, 'browser-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(resolve(artifacts, 'receipt-finished.json'), JSON.stringify({ run: runLabel, exitCode: results.exitCode, time: new Date().toISOString(), checks: results.checks.length }, null, 2))
    console.log(JSON.stringify({ ...results, diagnostics: `See ${resolve(artifacts, 'browser-results.json')}` }, null, 2))
  }
}
