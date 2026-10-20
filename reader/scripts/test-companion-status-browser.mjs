import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import vue from '@vitejs/plugin-vue'
import { createServer, readerRoot } from './vite-isolated.mjs'

const artifacts = resolve(readerRoot, '../.cache/companion-20261020/browser')
mkdirSync(artifacts, { recursive: true })
const fixture = `
import { createApp, h, ref, shallowRef, nextTick } from 'vue';
import Status from '/src/components/PagewiseCompanionStatus.vue';
import Card from '/src/components/PagewiseCompanionCard.vue';
import '/src/styles/main.css';
const calls = { basic:0, settings:0, inspect:0, close:0 };
const card = shallowRef(null);
const dj = { active:ref(false), status:ref('loading'), errorCode:ref(null), progress:ref(.4), card,
 closeCard(){ card.value=null; calls.close++ }, switchToBasic(){ calls.basic++ },
 translate(){}, expand(){}, dismiss(){ card.value=null }, adopt(){} };
createApp({setup:()=>()=>h('div',{class:'reader bars-on'},[
 h('button',{id:'origin'},'Synthetic context'),
 h('main',{id:'reading'},[h('p',{id:'source'},'Synthetic original source excerpt')]),
 h(Status,{dj,'onOpen-settings':()=>calls.settings++}),h('footer',{id:'footer'},'Synthetic footer'),
 card.value?h(Card,{dj,onInspect:()=>calls.inspect++}):null
])}).mount('#app');
window.qa={dj,calls,nextTick,async openCard(kind='term'){
 const node=document.querySelector('#source').firstChild, range=document.createRange();
 range.setStart(node,0);range.setEnd(node,8);
 const r=range.getBoundingClientRect();
 card.value={target:{kind,section:0,range,text:'Synthetic',item:{t:kind,q:'Synthetic',def:'Short synthetic explanation.',why:'Short synthetic key reason.',block:0,sentence:0}},rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
 await nextTick();
}};
`
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body,#app{margin:0;width:100%;height:100%}.reader{--footer-h:68px;--lr-safe-top:8px;--lr-safe-bottom:12px;--lr-safe-left:8px;--lr-safe-right:8px;height:100%;position:relative;display:flex;flex-direction:column;overflow:hidden}#origin{height:48px;flex-shrink:0}#reading{flex:1;min-height:0;padding-top:120px}#source{margin:0 40px}#footer{position:absolute;bottom:0;height:80px;width:100%;background:var(--card)}
</style></head><body><div id="app"></div><script type="module" src="/companion-subset.js"></script></body></html>`
const adapter = `import zh from '/src/i18n/zh.ts';import en from '/src/i18n/en.ts';export function t(key,vars={}){let text=(window.fixtureLanguage==='en'?en:zh)[key]??key;for(const [name,value]of Object.entries(vars))text=text.replaceAll('{'+name+'}',String(value));return text}`
const fixturePlugin = {
  name: 'companion-synthetic-subset', enforce: 'pre',
  resolveId(id) {
    if (id === '/companion-subset.js') return '\0companion-subset-fixture'
    if (/(?:^|\/)i18n$/.test(id)) return '\0companion-fixture-i18n'
  },
  load(id) {
    if (id === '\0companion-subset-fixture') return fixture
    if (id === '\0companion-fixture-i18n') return adapter
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] === '/companion-subset') { res.setHeader('content-type', 'text/html'); res.end(html); return }
      next()
    })
  },
}
const server = await createServer({ root: readerRoot, configFile: false, plugins: [fixturePlugin, vue()], cacheDir: resolve(artifacts, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
assert.ok(executablePath, 'Installed Edge required; no browser download permitted')
const results = { cases: [], externalRequests: [], pageErrors: [], limits: 'Actual final Status and short-card touch/source-label slices only; no dynamic Range, long-card, full ReaderView, real AI or BOOX claim' }
const contrast = (foreground, background) => {
  const luminance = color => {
    assert.match(color, /^rgb/)
    const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}
results.primaryContrast = []
const checkPrimary = async (page, selector, spec) => {
  const colors = await page.locator(selector).evaluate(el => { const style = getComputedStyle(el); return { foreground: style.color, background: style.backgroundColor } })
  const ratio = contrast(colors.foreground, colors.background)
  const record = { ...spec, selector, ...colors, ratio, threshold: 4.5 }
  results.primaryContrast.push(record)
  assert.ok(ratio >= 4.5, JSON.stringify(record))
  const button = page.locator(selector)
  await button.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  const focus = await button.evaluate(el => {
    const style = getComputedStyle(el), offset = parseFloat(style.outlineOffset)
    // Outside outlines contrast with the card surface, inset outlines with the button.
    const adjacent = offset >= 0 ? getComputedStyle(el.closest('.dj-pop, .dj-card')).backgroundColor : style.backgroundColor
    return { focused: document.activeElement === el, color: style.outlineColor, background: style.backgroundColor, adjacent, offset, width: parseFloat(style.outlineWidth), style: style.outlineStyle }
  })
  record.focus = { ...focus, ratio: contrast(focus.color, focus.adjacent) }
  assert.equal(focus.focused, true)
  assert.ok(focus.width >= 2 && focus.style !== 'none' && record.focus.ratio >= 3, JSON.stringify(record))
}
let browser
try {
  browser = await chromium.launch({ executablePath, headless: true })
  results.browser = browser.version()
  for (const spec of [{ width: 1100, height: 800, mode: 'light', lang: 'zh' }, { width: 390, height: 700, mode: 'eink', lang: 'zh' }, { width: 390, height: 700, mode: 'dark', lang: 'en' }]) {
    const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, reducedMotion: 'reduce', hasTouch: spec.width < 600, isMobile: spec.width < 600 })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith(origin + '/') || /^(data|blob):/.test(url)) return route.continue()
      results.externalRequests.push(url); return route.abort()
    })
    await context.addInitScript(({ mode, lang }) => {
      window.fixtureLanguage = lang
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.theme = mode === 'dark' ? 'dark' : 'light'
        document.documentElement.classList.toggle('pagewise-eink', mode === 'eink')
      })
    }, spec)
    const page = await context.newPage()
    page.on('pageerror', error => results.pageErrors.push(String(error)))
    await page.goto(origin + '/companion-subset')
    await page.waitForFunction(() => !!window.qa)
    const rect = selector => page.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right } })
    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const inViewport = r => { assert.ok(r.x >= -1 && r.y >= -1 && r.right <= spec.width + 1 && r.bottom <= spec.height + 1, JSON.stringify(r)) }
    const before = await rect('#reading')
    await page.evaluate(async () => { window.qa.dj.active.value = true; await window.qa.nextTick() })
    await settle()
    assert.deepEqual(await rect('#reading'), before, 'Status must not reserve reader layout height')
    const trigger = await rect('.dj-dot-btn'), footer = await rect('#footer')
    assert.ok(trigger.width >= 48 && trigger.height >= 48)
    assert.ok(trigger.bottom <= footer.y)
    assert.equal(await page.locator('.dj-dot').evaluate(el => getComputedStyle(el).animationName), 'none')
    await page.evaluate(async () => { window.qa.dj.status.value='quota'; window.qa.dj.errorCode.value='budget'; await window.qa.nextTick() })
    await page.locator('.dj-dot-btn').click()
    await page.locator('.dj-pop').waitFor({ state: 'visible' })
    inViewport(await rect('.dj-pop'))
    const controls = await page.locator('.dj-pop button').evaluateAll(nodes => nodes.map(el => ({ text:el.textContent.trim(), width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height })))
    assert.equal(controls.length, 3)
    for (const c of controls) assert.ok(c.width >= 48 && c.height >= 48, JSON.stringify(c))
    await checkPrimary(page, '.dj-pop .btn-primary', spec)
    const stem = `${spec.width}-${spec.lang}-${spec.mode}`
    await page.screenshot({ path: resolve(artifacts, `${stem}-status.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.dj-pop').count(), 0)
    assert.equal(await page.locator('.dj-dot-btn').evaluate(el => document.activeElement === el), true)
    await page.locator('.dj-dot-btn').click()
    await page.locator('.dj-pop-actions button').last().click()
    assert.equal(await page.evaluate(() => window.qa.calls.basic), 1)
    await page.locator('.dj-dot-btn').click()
    await page.locator('#source').click()
    assert.equal(await page.locator('.dj-pop').count(), 0)
    await page.evaluate(() => window.qa.openCard())
    await page.locator('.dj-card').waitFor({ state: 'visible' })
    await settle()
    const cardControls = await page.locator('.dj-card button').evaluateAll(nodes => nodes.map(el => ({ text:el.textContent.trim(), width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height })))
    for (const c of cardControls) assert.ok(c.width >= 48 && c.height >= 48, JSON.stringify(c))
    const label = spec.lang === 'en' ? 'View source' : '查看原文'
    await page.getByRole('button', { name: label, exact: true }).click()
    assert.equal(await page.evaluate(() => window.qa.calls.inspect), 1)
    const sourceText = await page.locator('.dj-card').innerText()
    assert.equal(/companion\.|reader\.viewSource|reader\.analysisAvailable|伴读|Spotlight Reading/.test(sourceText), false)
    await page.screenshot({ path: resolve(artifacts, `${stem}-short-card.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.dj-card').count(), 0)
    await page.evaluate(() => window.qa.openCard('key'))
    await page.locator('.dj-card .btn-primary').waitFor({ state: 'visible' })
    await checkPrimary(page, '.dj-card .btn-primary', spec)
    if (spec.width < 600) {
      assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches), true)
      await page.getByRole('button', { name: label, exact: true }).tap()
      assert.equal(await page.evaluate(() => window.qa.calls.inspect), 2)
    }
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.dj-card').count(), 0)
    results.cases.push({ ...spec, passed: true, beforeReading: before, afterReading: await rect('#reading'), statusTrigger: trigger, footer, popoverControls: controls, cardControls })
    await context.close()
  }
  assert.deepEqual(results.externalRequests, [])
  assert.deepEqual(results.pageErrors, [])
} catch (error) {
  results.failure = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
  writeFileSync(resolve(artifacts, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ cases: results.cases.length, failed: !!results.failure, externalRequests: results.externalRequests.length, pageErrors: results.pageErrors.length, failure: results.failure }))
}
