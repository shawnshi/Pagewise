/**
 * 跨章连续滚动 (docs/continuous-scroll.md) 的浏览器端到端测试。
 *
 * 先构建并起预览 (默认 http://localhost:4173, 用 E2E_BASE 覆盖), 再运行:
 *   npm run build && npx vite preview --port 4173 --strictPort &
 *   npm run e2e:continuous-scroll
 *
 * 生成一本多章 EPUB (含极短章、长章、一个非线性章), 竖屏 960×1378 打开 (轻阅竖屏走滚动),
 * 给 foliate 渲染器加 `continuous` 属性, 用 CDP Input.dispatchTouchEvent 逐帧拖动 + 惯性滚动,
 * 逐帧记录各章 iframe 的位置, 检查:
 *  - 向下连续跨 ≥4 个章界, 没有 >2px 的回跳; relocate 的章序号单调前进
 *  - 章界处没有过长的动画帧 (long-animation-frame); 下一章在到达之前就已预载
 *  - getContents()[0] 与 view.lastLocation.section.current 一致
 *  - 往上滚、上方插入上一章时可见文字不动; 调整窗口宽度后阅读位置不变
 *  - goTo 远处章节正常, goTo 已载入的相邻章节不再发 load
 *  - 横屏 1440×900 强制 flow=scrolled 时同样连续滚动
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const base = process.env.E2E_BASE ?? 'http://localhost:4173'
const title = 'Continuous Scroll Fixture'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- fixture EPUB ----
const words = ('river lantern quiet harbor morning paper window letter garden silver thunder ' +
  'meadow candle forest whisper engine ladder mirror orchard voyage').split(' ')
const paragraph = (ch, p) => {
  const out = []
  for (let i = 0; i < 70; i++) out.push(words[(ch * 7 + p * 3 + i * 5) % words.length])
  return `<p id="c${ch}p${p}">[c${ch}-p${p}] ${out.join(' ')}.</p>`
}
/** Minimal EPUB 3: one XHTML file per chapter, `linear: false` marks a non-linear spine item. */
function makeEpub(plan, { id, title }) {
  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
  }
  const manifest = []
  const spine = []
  const toc = []
  plan.forEach((c, i) => {
    const href = `c${i}.xhtml`
    const body = Array.from({ length: c.paras }, (_, p) => paragraph(i, p)).join('\n')
    files[`OEBPS/${href}`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${c.name}</title></head>
<body><h1 id="c${i}h">Chapter ${i}: ${c.name}</h1>
${body}
</body></html>`)
    manifest.push(`<item id="c${i}" href="${href}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="c${i}"${c.linear === false ? ' linear="no"' : ''}/>`)
    if (c.linear !== false) toc.push(`<li><a href="${href}">${c.name}</a></li>`)
  })
  files['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><h1>Contents</h1><ol>${toc.join('')}</ol></nav></body></html>`)
  files['OEBPS/package.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${id}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>Scroll Tester</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-10-07T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>${spine.join('')}</spine>
</package>`)
  return zipSync(files)
}

// paragraphs per chapter: 1 = very short, 140 = long
const plan = [
  { name: 'Opening', paras: 24 },
  { name: 'Very Short', paras: 1 },
  { name: 'The Long Chapter', paras: 140 },
  { name: 'Notes (non-linear)', paras: 3, linear: false },
  { name: 'Fourth', paras: 22 },
  { name: 'Brief', paras: 4 },
  { name: 'Sixth', paras: 26 },
  { name: 'Seventh', paras: 24 },
  { name: 'Eighth', paras: 28 },
  { name: 'Ninth', paras: 22 },
  { name: 'Tenth', paras: 30 },
]
const epub = makeEpub(plan, { id: 'lightread-continuous-scroll', title })
const LONG = 2
const NON_LINEAR = 3
const LAST = plan.length - 1

// ---- page instrumentation (runs in the page) ----
function instrument() {
  const view = document.querySelector('foliate-view')
  const r = view.renderer
  const cs = window.__cs = {
    relocs: [], rrelocs: [], loads: [], unloads: [], changes: [], loaf: [], samples: [], lastScroll: 0, phase: 'idle',
  }
  view.addEventListener('relocate', e => cs.relocs.push({
    t: performance.now(), index: e.detail.section?.current, phase: cs.phase }))
  view.addEventListener('load', e => cs.loads.push({ t: performance.now(), index: e.detail.index, phase: cs.phase }))
  r.addEventListener('relocate', e => cs.rrelocs.push({
    t: Math.round(performance.now()), index: e.detail.index, reason: e.detail.reason, f: +(e.detail.fraction ?? 0).toFixed(3), phase: cs.phase }))
  r.addEventListener('unload', e => cs.unloads.push({ t: performance.now(), index: e.detail.index }))
  r.addEventListener('section-change', e => cs.changes.push({
    t: performance.now(), index: e.detail.index, previous: e.detail.previous, phase: cs.phase }))
  r.addEventListener('scroll', () => { cs.lastScroll = performance.now() })
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) cs.loaf.push({ t: e.startTime, d: e.duration, phase: cs.phase })
    }).observe({ type: 'long-animation-frame' })
    cs.loafSupported = true
  } catch { cs.loafSupported = false }
  // per-frame positions of every slot's iframe (top-level viewport coordinates)
  const tick = () => {
    const tops = {}
    for (const { index, doc } of r.getContents?.() ?? []) {
      const frame = doc?.defaultView?.frameElement
      if (!frame || getComputedStyle(frame).visibility === 'hidden') continue
      // only what the reader can see: sections far off screen may move when others unload
      const rect = frame.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > innerHeight) continue
      tops[index] = rect.top
    }
    cs.samples.push({ t: performance.now(), phase: cs.phase, tops })
    if (cs.samples.length > 20000) cs.samples.splice(0, 5000)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** Text node at viewport y (top-level coordinates) and its current top. */
function probeAt(y) {
  const view = document.querySelector('foliate-view')
  const rect = view.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  for (const { index, doc } of view.renderer.getContents()) {
    const frame = doc.defaultView.frameElement
    const fr = frame.getBoundingClientRect()
    if (getComputedStyle(frame).visibility === 'hidden' || y < fr.top || y >= fr.bottom) continue
    const range = doc.caretRangeFromPoint(x - fr.left, y - fr.top)
    if (!range) return null
    const node = range.startContainer
    const r = doc.createRange()
    r.selectNodeContents(node)
    const box = [...r.getClientRects()].find(b => b.height > 0) ?? r.getBoundingClientRect()
    window.__probe = { node, frame }
    return { index, text: (node.textContent ?? '').slice(0, 24), top: fr.top + box.top }
  }
  return null
}
function probeAgain() {
  const p = window.__probe
  if (!p?.node?.isConnected) return null
  const doc = p.node.ownerDocument
  const r = doc.createRange()
  r.selectNodeContents(p.node)
  const box = [...r.getClientRects()].find(b => b.height > 0) ?? r.getBoundingClientRect()
  return { text: (p.node.textContent ?? '').slice(0, 24), top: p.frame.getBoundingClientRect().top + box.top }
}

// ---- analysis helpers (node side) ----
/** largest per-frame move against the scroll direction (dir 1 = scrolling down, content moves up) */
function maxBackward(samples, dir) {
  let worst = 0
  let at = null
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].tops
    const b = samples[i].tops
    for (const k of Object.keys(b)) {
      if (!(k in a)) continue
      const delta = (b[k] - a[k]) * dir // > 0 = moved backwards
      if (delta > worst) {
        worst = delta
        at = { index: Number(k), t: samples[i].t, delta: b[k] - a[k] }
      }
    }
  }
  return { worst, at }
}


// ---- device-like scenario (Surface regression, 2026-10-07) ----
// Surface (WebView2 154) with OS-level touch injection showed backward jumps of 8–21k px right
// after batches of unloads above the viewport during long momentum flings, and load/unload
// thrash of the section just below. Reproduce with a throttled CPU, fast flings with short
// random gaps and a long book whose height exceeds the slot cap quickly.
const deviceTitle = 'Continuous Scroll Device Fixture'
const devicePlan = Array.from({ length: 24 }, (_, i) => ({
  name: `Part ${i}`, paras: [120, 8, 30, 160, 1, 45, 25, 140, 12, 60, 3, 150][i % 12] }))
const deviceEpub = makeEpub(devicePlan, { id: 'lightread-continuous-device', title: deviceTitle })

function instrumentDevice() {
  const view = document.querySelector('foliate-view')
  const r = view.renderer
  const dv = window.__dv = { scrolls: [], loads: [], unloads: [], changes: [], loaf: [], maxLoaded: 0, phase: 'down', blank: 0 }
  r.addEventListener('scroll', () => {
    const tops = {}
    const contents = r.getContents()
    dv.maxLoaded = Math.max(dv.maxLoaded, contents.length)
    for (const { index, doc } of contents) {
      const frame = doc?.defaultView?.frameElement
      if (!frame || getComputedStyle(frame).visibility === 'hidden') continue
      const rect = frame.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > innerHeight) continue // only what the reader can see
      tops[index] = Math.round(rect.top * 10) / 10
    }
    // viewport at the end of the loaded content while the book goes on = the reader is stuck
    let bottom = -Infinity
    for (const { doc } of contents) bottom = Math.max(bottom, doc.defaultView.frameElement.getBoundingClientRect().bottom)
    const last = contents.length ? Math.max(...contents.map(c => c.index)) : 0
    if (dv.phase === 'down' && bottom < innerHeight + 60 && last < view.book.sections.length - 1)
      dv.stalls = (dv.stalls ?? 0) + 1
    // nothing loaded at the middle of the screen (a placeholder or the end of the loaded run)
    const mid = innerHeight / 2
    if (!contents.some(({ doc }) => {
      const rect = doc.defaultView.frameElement.getBoundingClientRect()
      return getComputedStyle(doc.defaultView.frameElement).visibility !== 'hidden' && rect.top <= mid && rect.bottom >= mid
    })) dv.blank++
    dv.scrolls.push([performance.now(), tops, view.lastLocation?.section?.current, dv.phase])
  })
  view.addEventListener('load', e => dv.loads.push([performance.now(), e.detail.index]))
  r.addEventListener('unload', e => dv.unloads.push([performance.now(), e.detail.index]))
  r.addEventListener('section-change', e => dv.changes.push([performance.now(), e.detail.index]))
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) dv.loaf.push([e.startTime, e.duration, e.blockingDuration ?? 0])
    }).observe({ type: 'long-animation-frame' })
  } catch { /* unsupported */ }
}

/** Analyse the device run: backward shifts, reload churn, unloads during flings. */
function analyseDevice(dv, phase = 'down', dir = 1) {
  let worst = { px: 0 }
  dv = { ...dv, scrolls: dv.scrolls.filter(x => x[3] === phase) }
  const moving = [] // times at which content actually moved (user / fling scrolling)
  for (let i = 1; i < dv.scrolls.length; i++) {
    const [t, b] = dv.scrolls[i]
    const a = dv.scrolls[i - 1][1]
    let moved = false
    for (const k of Object.keys(b)) {
      if (!(k in a)) continue
      const delta = (b[k] - a[k]) * dir // > 0: content moved against the scroll direction
      if (Math.abs(delta) > 0.5) moved = true
      if (delta > worst.px) worst = { px: delta, t: Math.round(t), index: Number(k) }
    }
    if (moved) moving.push(t)
  }
  const byIndex = new Map()
  for (const [t, index] of dv.loads) byIndex.set(index, [...(byIndex.get(index) ?? []), t])
  const churn = []
  for (const [index, times] of byIndex) for (let i = 2; i < times.length; i++)
    if (times[i] - times[i - 2] < 10_000) churn.push({ index, times: times.slice(i - 2, i + 1).map(Math.round) })
  const unloadsInFling = []
  for (const [t, index] of dv.unloads) {
    const last = moving.filter(m => m <= t).at(-1)
    if (last != null && t - last < 300) unloadsInFling.push({ index, t: Math.round(t), sinceScroll: Math.round(t - last) })
  }
  return {
    maxBackwardPx: +worst.px.toFixed(1), worstAt: worst, churn, unloadsInFling,
    loads: dv.loads.length, unloads: dv.unloads.length, maxLoaded: dv.maxLoaded,
    maxFrameMs: Math.round(Math.max(0, ...dv.loaf.map(f => f[1]))), stalledScrollEvents: dv.stalls ?? 0,
    scrollEvents: dv.scrolls.length,
    sectionsVisited: [...new Set(dv.changes.map(c => c[1]))].length,
  }
}

async function runDevice(browser) {
  const context = await browser.newContext({
    viewport: { width: 960, height: 1377 }, hasTouch: true, serviceWorkers: 'block' })
  await context.route('https://api.github.com/**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tag_name: 'v0.0.0', body: '', published_at: '2026-01-01', assets: [] }) }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.stack || e.message))
  const cdp = await context.newCDPSession(page)
  try {
    await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
    await page.setInputFiles('input[type="file"][multiple]', {
      name: 'continuous-device.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(deviceEpub) })
    const card = page.locator('.book-card').filter({ hasText: deviceTitle })
    await card.waitFor({ state: 'visible', timeout: 15_000 })
    await card.click()
    await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length > 0,
      null, { timeout: 15_000 })
    await page.evaluate(() => document.querySelector('foliate-view').renderer.setAttribute('continuous', ''))
    await page.waitForFunction(() => document.querySelector('foliate-view').renderer.continuous === true)
    await page.evaluate(() => document.querySelector('foliate-view').goTo(0))
    await sleep(1500)
    await page.evaluate(instrumentDevice)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    // fast flings: ~10 moves × 10ms covering 700px, then a random 60–450ms gap (momentum keeps going)
    let seed = 20261007
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    const flings = Number(process.env.DEVICE_FLINGS ?? 45)
    for (let i = 0; i < flings; i++) {
      const y0 = 1150
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 480, y: y0, id: 1 }] })
      for (let k = 1; k <= 10; k++) {
        await sleep(10)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 480, y: y0 - 70 * k, id: 1 }] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(60 + rand() * 390)
    }
    await sleep(3000)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const dv = await page.evaluate(() => window.__dv)
    const result = analyseDevice(dv)
    result.flings = flings
    result.finalSection = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.section?.current)
    console.log('device-like run', JSON.stringify(result))
    assert.ok(result.maxBackwardPx <= 2, `backward content shift ${result.maxBackwardPx}px during downward flings at ${JSON.stringify(result.worstAt)}`)
    assert.deepEqual(result.churn, [], 'a section was loaded more than twice within 10s')
    // unloads during a fling are allowed only as geometry-neutral placeholder swaps under cap
    // pressure (§12); the backward-shift assertion above is what guards the reader
    assert.ok(result.sectionsVisited >= 6, `flings should cross many sections (${result.sectionsVisited})`)
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`)
    console.log('PASS device-like flings', JSON.stringify(result))

    // idle long enough for sections passed > 10s ago to be unloaded (one per idle period,
    // replaced by placeholders above the viewport), then fling back up through them
    await sleep(14_000)
    const idle = await page.evaluate(() => ({
      unloads: window.__dv.unloads.length, loaded: document.querySelector('foliate-view').renderer.getContents().length }))
    await page.evaluate(() => { window.__dv.phase = 'up'; window.__dv.blank = 0 })
    const upFrom = await page.evaluate(() => performance.now())
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    for (let i = 0; i < flings / 3; i++) {
      const y0 = 250
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 480, y: y0, id: 1 }] })
      for (let k = 1; k <= 10; k++) {
        await sleep(10)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 480, y: y0 + 70 * k, id: 1 }] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(60 + rand() * 390)
    }
    await sleep(3000)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const dv2 = await page.evaluate(() => window.__dv)
    const up = analyseDevice(dv2, 'up', -1)
    const unloaded = new Set(dv2.unloads.filter(u => u[0] < upFrom).map(u => u[1]))
    up.refilled = [...new Set(dv2.loads.filter(l => l[0] >= upFrom && unloaded.has(l[1])).map(l => l[1]))]
    up.unloadedWhileIdle = idle.unloads - dv.unloads.length
    up.loadedAfterIdle = idle.loaded
    up.blankScrollEvents = dv2.blank
    up.finalSection = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.section?.current)
    console.log('device-like run back up', JSON.stringify(up))
    // 上限压力下甩动中已即时卸载 (占位块, 不动视口); 空闲开始时若已回到 ≤5 章, 空闲期无需再卸
    assert.ok(up.unloadedWhileIdle >= 1 || up.loadedAfterIdle <= 5, `far sections are trimmed by idle time (${JSON.stringify({ unloadedWhileIdle: up.unloadedWhileIdle, loadedAfterIdle: up.loadedAfterIdle })})`)
    assert.ok(up.refilled.length >= 1, `scrolling back up reloads unloaded sections into their placeholders (${JSON.stringify(up)})`)
    assert.ok(up.maxBackwardPx <= 2, `content shift ${up.maxBackwardPx}px during upward flings at ${JSON.stringify(up.worstAt)}`)
    assert.deepEqual(up.churn.filter(c => c.times[0] >= upFrom), [], 'a section was loaded more than twice within 10s')
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`)
    console.log('PASS device-like flings back up through placeholders', JSON.stringify(up))
    return { down: result, up }
  } catch (e) {
    await page.screenshot({ path: '/tmp/lightread-e2e-continuous-device-fail.png' }).catch(() => {})
    if (errors.length) console.error('page errors:', errors.join('\n'))
    throw e
  } finally {
    await context.close()
  }
}


// ---- sustained scenarios (Surface re-run, 2026-10-07) ----
// Nonstop flinging never leaves a quiet moment; the renderer must still make room (unload far
// sections, geometry-neutral) instead of stalling at the end of the loaded content. Same for
// auto scroll (renderer.scrollBy every frame).
const streamTitle = 'Continuous Scroll Stream Fixture'
const streamPlan = Array.from({ length: 34 }, (_, i) => ({
  name: `Stream ${i}`, paras: [40, 3, 25, 80, 1, 30, 15, 60, 8, 35, 20][i % 11] }))
const streamEpub = makeEpub(streamPlan, { id: 'lightread-continuous-stream', title: streamTitle })

function instrumentStream() {
  const view = document.querySelector('foliate-view')
  const r = view.renderer
  const st = window.__st = { scrolls: [], loads: [], unloads: [], maxLoaded: 0, loadedSeries: [] }
  r.addEventListener('scroll', () => {
    const contents = r.getContents()
    st.maxLoaded = Math.max(st.maxLoaded, contents.length)
    const tops = {}
    for (const { index, doc } of contents) {
      const frame = doc?.defaultView?.frameElement
      if (!frame || getComputedStyle(frame).visibility === 'hidden') continue
      const rect = frame.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > innerHeight) continue
      tops[index] = Math.round(rect.top * 10) / 10
    }
    st.scrolls.push([performance.now(), tops, view.lastLocation?.section?.current, r.atEnd])
  })
  setInterval(() => st.loadedSeries.push([performance.now(), r.getContents().length]), 500)
  view.addEventListener('load', e => st.loads.push([performance.now(), e.detail.index]))
  r.addEventListener('unload', e => st.unloads.push([performance.now(), e.detail.index]))
}

/** stalls: gaps ≥ 600ms between scroll events inside [from, to] while not at the book end */
function analyseStream(st, from, to, dir = 1) {
  const scrolls = st.scrolls.filter(x => x[0] >= from - 1000 && x[0] <= to + 1000)
  let worst = 0
  const stalls = []
  for (let i = 1; i < scrolls.length; i++) {
    const [t, b, , atEnd] = scrolls[i]
    const [t0, a] = scrolls[i - 1]
    for (const k of Object.keys(b)) if (k in a) worst = Math.max(worst, (b[k] - a[k]) * dir)
    if (t0 >= from && t0 <= to && t - t0 >= 600 && !scrolls[i - 1][3] && !atEnd)
      stalls.push({ at: Math.round(t0), ms: Math.round(t - t0), section: scrolls[i - 1][2] })
  }
  const last = scrolls.at(-1)
  if (last && to - last[0] >= 600 && !last[3])
    stalls.push({ at: Math.round(last[0]), ms: Math.round(to - last[0]), section: last[2], tail: true })
  const byIndex = new Map()
  for (const [t, index] of st.loads) byIndex.set(index, [...(byIndex.get(index) ?? []), t])
  const churn = []
  for (const [index, times] of byIndex) for (let i = 2; i < times.length; i++)
    if (times[i] - times[i - 2] < 10_000) churn.push(index)
  const late = st.loadedSeries.filter(x => x[0] >= from + (to - from) / 2).map(x => x[1]).sort((a, b) => a - b)
  return {
    stalls, maxBackwardPx: +worst.toFixed(1), maxLoaded: st.maxLoaded, churn: [...new Set(churn)],
    loads: st.loads.length, unloads: st.unloads.length,
    medianLoadedSecondHalf: late[Math.floor(late.length / 2)] ?? null,
    sections: [...new Set(scrolls.map(x => x[2]))].filter(x => x != null),
  }
}

async function openStream(browser, viewport) {
  const context = await browser.newContext({ viewport, hasTouch: true, serviceWorkers: 'block' })
  await context.route('https://api.github.com/**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tag_name: 'v0.0.0', body: '', published_at: '2026-01-01', assets: [] }) }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.stack || e.message))
  const cdp = await context.newCDPSession(page)
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await page.setInputFiles('input[type="file"][multiple]', {
    name: 'continuous-stream.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(streamEpub) })
  const card = page.locator('.book-card').filter({ hasText: streamTitle })
  await card.waitFor({ state: 'visible', timeout: 15_000 })
  await card.click()
  await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length > 0,
    null, { timeout: 15_000 })
  await page.evaluate(() => document.querySelector('foliate-view').renderer.setAttribute('continuous', ''))
  await page.waitForFunction(() => document.querySelector('foliate-view').renderer.continuous === true)
  await page.evaluate(() => document.querySelector('foliate-view').goTo(0))
  await sleep(1500)
  await page.evaluate(instrumentStream)
  return { context, page, errors, cdp }
}

async function runStreamFlings(browser) {
  const { context, page, errors, cdp } = await openStream(browser, { width: 960, height: 1127 })
  try {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    let seed = 777
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    const flings = Number(process.env.STREAM_FLINGS ?? 80)
    const from = await page.evaluate(() => performance.now())
    for (let i = 0; i < flings; i++) {
      const y0 = 1000
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 480, y: y0, id: 1 }] })
      for (let k = 1; k <= 10; k++) {
        await sleep(10)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 480, y: y0 - 70 * k, id: 1 }] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(60 + rand() * 390) // never a pause longer than 450ms
    }
    const to = await page.evaluate(() => performance.now())
    await sleep(1500)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const res = analyseStream(await page.evaluate(() => window.__st), from, to)
    res.flings = flings
    console.log('stream flings', JSON.stringify(res))
    assert.deepEqual(res.stalls, [], 'stalled while swiping (no scroll events for ≥600ms, not at the book end)')
    assert.ok(res.maxBackwardPx <= 2, `backward content shift ${res.maxBackwardPx}px`)
    assert.ok(res.maxLoaded <= 8, `too many sections loaded: ${res.maxLoaded}`)
    assert.ok(res.sections.length >= 15, `swiped through only ${res.sections.length} sections`)
    assert.deepEqual(res.churn, [], 'a section was loaded more than twice within 10s')
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`)
    console.log('PASS nonstop flings', JSON.stringify(res))
    return res
  } finally {
    await context.close()
  }
}

async function runAutoScroll(browser) {
  const { context, page, errors, cdp } = await openStream(browser, { width: 960, height: 1127 })
  try {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    const seconds = Number(process.env.AUTO_SECONDS ?? 60)
    const from = await page.evaluate(() => performance.now())
    // the app's auto scroll: renderer.scrollBy every frame at 1.5 screens per second
    await page.evaluate(seconds => new Promise(resolve => {
      const r = document.querySelector('foliate-view').renderer
      const end = performance.now() + seconds * 1000
      let last = performance.now()
      const step = now => {
        const dt = Math.min(100, now - last)
        last = now
        r.scrollBy(0, r.size * 1.5 * dt / 1000)
        if (now < end && !r.atEnd) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    }), seconds)
    const to = await page.evaluate(() => performance.now())
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const res = analyseStream(await page.evaluate(() => window.__st), from, to)
    res.seconds = seconds
    console.log('auto scroll', JSON.stringify(res))
    assert.deepEqual(res.stalls, [], 'auto scroll stalled (no scroll events for ≥600ms, not at the book end)')
    assert.ok(res.maxBackwardPx <= 2, `backward content shift ${res.maxBackwardPx}px`)
    assert.ok(res.maxLoaded <= 8, `too many sections loaded: ${res.maxLoaded}`)
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`)
    console.log('PASS auto scroll', JSON.stringify(res))
    return res
  } finally {
    await context.close()
  }
}

const SCENARIO = process.env.SCENARIO ?? 'all' // all | basic | device | stream | auto (comma separated)
const runs = name => SCENARIO === 'all' || SCENARIO.split(',').includes(name)
const browser = await chromium.launch({ headless: true })
try {
if (runs('basic')) {
  const context = await browser.newContext({
    viewport: { width: 960, height: 1378 }, hasTouch: true, serviceWorkers: 'block' })
  await context.route('https://api.github.com/**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tag_name: 'v0.0.0', body: '', published_at: '2026-01-01', assets: [] }) }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.stack || e.message))
  const cdp = await context.newCDPSession(page)

  /** finger drag of `dy` px (negative = finger up = scroll down) followed by native fling */
  async function swipe(dy, { x = 480, steps = 12, interval = 16, y0 } = {}) {
    y0 ??= dy < 0 ? 1150 : 350
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] })
    for (let i = 1; i <= steps; i++) {
      await sleep(interval)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y: y0 + (dy * i) / steps, id: 1 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  /** wait until the container has not scrolled for `quiet` ms */
  async function settle(quiet = 300, max = 6000) {
    const t0 = Date.now()
    await sleep(50)
    while (Date.now() - t0 < max) {
      const idle = await page.evaluate(() => performance.now() - window.__cs.lastScroll)
      if (idle >= quiet) return
      await sleep(Math.max(30, quiet - idle))
    }
  }
  const setPhase = phase => page.evaluate(p => { window.__cs.phase = p }, phase)
  const current = () => page.evaluate(() => document.querySelector('foliate-view').lastLocation?.section?.current)
  const loaded = () => page.evaluate(() => document.querySelector('foliate-view').renderer.getContents().map(c => c.index))
  const results = {}

  try {
    await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
    await page.setInputFiles('input[type="file"][multiple]', {
      name: 'continuous-scroll.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(epub) })
    const card = page.locator('.book-card').filter({ hasText: title })
    await card.waitFor({ state: 'visible', timeout: 15_000 })
    await card.click()
    await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.()
      .some(({ doc }) => doc?.body?.textContent?.includes('[c')), null, { timeout: 15_000 })
    await sleep(800)

    const flow = await page.evaluate(() => document.querySelector('foliate-view').renderer.getAttribute('flow'))
    assert.equal(flow, 'scrolled', 'portrait 960×1378 should open in scrolled flow')
    const fork = await page.evaluate(() => document.querySelector('foliate-view').renderer.constructor.lightreadFork)
    assert.match(String(fork), /lightread-continuous-paginator/, 'renderer is the LightRead fork')

    // turn continuous scrolling on (the app-side setting is wired separately)
    await page.evaluate(() => document.querySelector('foliate-view').renderer.setAttribute('continuous', ''))
    await page.waitForFunction(() => document.querySelector('foliate-view').renderer.continuous === true)
    await page.evaluate(instrument)
    await page.evaluate(() => document.querySelector('foliate-view').goTo(0))
    await page.waitForFunction(() => document.querySelector('foliate-view').lastLocation?.section?.current === 0)
    await sleep(1500) // idle prefetch of the next section
    console.log('PASS open in continuous mode, loaded slots:', await loaded())

    // ---- 1. downward touch scrolling across ≥4 boundaries ----
    await setPhase('down')
    const startIndex = await current()
    let swipes = 0
    while (swipes < 60) {
      await swipe(-560)
      swipes++
      await settle(200)
      const idx = await current()
      if (idx >= startIndex + 6 || idx >= LAST) break
    }
    await settle(400)
    await sleep(400)
    await setPhase('after-down')
    const down = await page.evaluate(() => {
      const cs = window.__cs
      return {
        relocs: cs.relocs.filter(r => r.phase === 'down'),
        changes: cs.changes.filter(r => r.phase === 'down'),
        loads: cs.loads,
        loaf: cs.loaf.filter(r => r.phase === 'down'),
        loafSupported: cs.loafSupported,
        samples: cs.samples.filter(s => s.phase === 'down'),
      }
    })
    const indices = down.relocs.map(r => r.index)
    for (let i = 1; i < indices.length; i++) if (indices[i] < indices[i - 1]) {
      const dump = await page.evaluate(() => ({ rr: window.__cs.rrelocs, ch: window.__cs.changes, loads: window.__cs.loads.map(l => [Math.round(l.t), l.index]), unloads: window.__cs.unloads.map(l => [Math.round(l.t), l.index]) }))
      console.error(JSON.stringify(dump))
      assert.fail(`relocate index went back: ${indices.slice(Math.max(0, i - 3), i + 2)}`)
    }
    const visited = [...new Set(indices)]
    assert.ok(visited.includes(NON_LINEAR) === false, 'non-linear section is skipped')
    const boundaries = visited.length - 1
    assert.ok(boundaries >= 4, `crossed only ${boundaries} boundaries (${visited}) in ${swipes} swipes`)
    const back = maxBackward(down.samples, 1)
    assert.ok(back.worst <= 2, `backward jump ${back.worst.toFixed(1)}px at ${JSON.stringify(back.at)}`)
    // long frames around boundary crossings (skip the first crossing as warm-up)
    const crossings = down.changes.slice(1)
    let boundaryFrame = 0
    for (const c of crossings) for (const f of down.loaf)
      if (f.t <= c.t + 150 && f.t + f.d >= c.t - 150) boundaryFrame = Math.max(boundaryFrame, f.d)
    const maxFrame = Math.max(0, ...down.loaf.map(f => f.d))
    // preload lead: how long before the reader reached a section it had been loaded
    const leads = []
    for (const c of down.changes) {
      const load = down.loads.filter(l => l.index === c.index && l.t <= c.t).at(-1)
      leads.push(load ? Math.round(c.t - load.t) : -1)
    }
    assert.ok(leads.slice(1).every(l => l > 0), `a section was not preloaded before it was reached: ${leads}`)
    assert.ok(boundaryFrame <= 250, `long animation frame of ${boundaryFrame.toFixed(0)}ms at a boundary`)
    results.down = {
      swipes, visited, boundaries, maxBackwardPx: +back.worst.toFixed(2), boundaryFrameMs: Math.round(boundaryFrame),
      maxFrameMs: Math.round(maxFrame), loafSupported: down.loafSupported, preloadLeadMs: leads, frames: down.samples.length,
    }
    console.log('PASS downward touch scroll', JSON.stringify(results.down))

    const consistent = await page.evaluate(() => {
      const view = document.querySelector('foliate-view')
      return [view.renderer.getContents()[0]?.index, view.lastLocation?.section?.current]
    })
    assert.equal(consistent[0], consistent[1], `getContents()[0] ${consistent[0]} ≠ lastLocation ${consistent[1]}`)
    console.log('PASS getContents()[0].index === lastLocation.section.current =', consistent[0])

    // ---- 2. scrolling up into a section inserted above keeps the text still ----
    // jump far away first so that the long chapter is rebuilt alone (its predecessor not loaded)
    await page.evaluate(i => document.querySelector('foliate-view').renderer.goTo({ index: i }), LAST)
    await sleep(300)
    await page.evaluate(i => document.querySelector('foliate-view').renderer.goTo({ index: i, anchor: 0.3 }), LONG)
    await page.waitForFunction(i => document.querySelector('foliate-view').lastLocation?.section?.current === i, LONG)
    await sleep(1500)
    await setPhase('up')
    const upStart = await current()
    const probes = []
    let upSwipes = 0
    while (upSwipes < 30) {
      await swipe(420)
      upSwipes++
      // probe the text right after the fling stops (before the renderer's true idle — ≥400ms
      // without scrolling — lets it insert / unload sections above) and again after it
      await settle(100, 6000)
      const shown = () => page.evaluate(() => document.querySelector('foliate-view').renderer.getContents()
        .filter(c => getComputedStyle(c.doc.defaultView.frameElement).visibility !== 'hidden').map(c => c.index).sort((a, b) => a - b))
      const slotsBefore = await shown()
      const before = await page.evaluate(probeAt, 500)
      await sleep(1600)
      const scrolledSince = await page.evaluate(() => performance.now() - window.__cs.lastScroll)
      const after = await page.evaluate(probeAgain)
      const slotsAfter = await shown()
      if (before) probes.push({ before: before.text, inserted: slotsAfter.filter(i => !slotsBefore.includes(i)),
        removed: slotsBefore.filter(i => !slotsAfter.includes(i)), quietMs: Math.round(scrolledSince),
        shift: after ? +(after.top - before.top).toFixed(2) : null })
      if ((await current()) < upStart) break
    }
    await settle(400)
    await setPhase('after-up')
    const up = await page.evaluate(() => {
      const cs = window.__cs
      return { relocs: cs.relocs.filter(r => r.phase === 'up'), samples: cs.samples.filter(s => s.phase === 'up') }
    })
    const upIdx = up.relocs.map(r => r.index)
    for (let i = 1; i < upIdx.length; i++) assert.ok(upIdx[i] <= upIdx[i - 1], `relocate index went forward while scrolling up: ${upIdx}`)
    assert.ok(upIdx.at(-1) < upStart, `did not cross the boundary upwards (${upIdx})`)
    const upBack = maxBackward(up.samples, -1)
    assert.ok(upBack.worst <= 2, `jump while scrolling up ${upBack.worst.toFixed(1)}px at ${JSON.stringify(upBack.at)}`)
    for (const p of probes) assert.ok(p.shift !== null && Math.abs(p.shift) <= 2, `visible text moved after the fling: ${JSON.stringify(p)}`)
    const insertions = probes.filter(p => p.inserted.length)
    assert.ok(insertions.length >= 1, `no section was inserted above while probing: ${JSON.stringify(probes)}`)
    results.up = { swipes: upSwipes, visited: [...new Set(upIdx)], maxJumpPx: +upBack.worst.toFixed(2),
      insertProbes: insertions.map(p => ({ inserted: p.inserted, shift: p.shift })), maxProbeShiftPx: Math.max(...probes.map(p => Math.abs(p.shift))) }
    console.log('PASS upward scroll with insert above', JSON.stringify(results.up))

    // ---- 3. resize keeps the reading position ----
    await swipe(-300)
    await settle(300)
    await sleep(500)
    const lineY = await page.evaluate(() => {
      const rect = document.querySelector('foliate-view').getBoundingClientRect()
      return rect.top + rect.height * 0.2 + 4
    })
    const beforeResize = await page.evaluate(probeAt, lineY)
    assert.ok(beforeResize, 'probe text before resize')
    await page.setViewportSize({ width: 940, height: 1378 })
    await sleep(1500)
    const afterResize = await page.evaluate(probeAgain)
    assert.ok(afterResize, 'probe text still in the document after resize')
    const resizeShift = afterResize.top - beforeResize.top
    assert.ok(Math.abs(resizeShift) <= 40, `reading position moved ${resizeShift.toFixed(1)}px on resize (${beforeResize.text})`)
    results.resize = { text: beforeResize.text, shiftPx: +resizeShift.toFixed(2) }
    console.log('PASS resize keeps the reading position', JSON.stringify(results.resize))

    // ---- 4. goTo: far section rebuilds, adjacent loaded section just scrolls ----
    await page.evaluate(i => document.querySelector('foliate-view').goTo(i), LAST - 1)
    await page.waitForFunction(i => document.querySelector('foliate-view').lastLocation?.section?.current === i, LAST - 1)
    await sleep(2000)
    const slots = await loaded()
    const adjacent = slots.find(i => Math.abs(i - (LAST - 1)) === 1)
    assert.ok(adjacent != null, `a neighbour of the far section was preloaded (${slots})`)
    const loadsBefore = await page.evaluate(() => window.__cs.loads.length)
    await page.evaluate(i => document.querySelector('foliate-view').goTo(i), adjacent)
    await page.waitForFunction(i => document.querySelector('foliate-view').lastLocation?.section?.current === i, adjacent)
    await sleep(600)
    const newLoads = await page.evaluate(n => window.__cs.loads.slice(n), loadsBefore)
    assert.ok(!newLoads.some(l => l.index === adjacent), `goTo(${adjacent}) reloaded the section: ${JSON.stringify(newLoads)}`)
    results.goTo = { far: LAST - 1, preloaded: slots, adjacent, loadsAfterAdjacentGoTo: newLoads.map(l => l.index) }
    console.log('PASS goTo far / adjacent', JSON.stringify(results.goTo))

    // ---- 5. next / prev / nextSection / prevSection / scrollBy ----
    const api = await page.evaluate(async () => {
      const view = document.querySelector('foliate-view')
      const r = view.renderer
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const cur = () => view.lastLocation.section.current
      const out = {}
      await r.goTo({ index: 5, anchor: 0 }) // "Brief": shorter than a screen
      await wait(800)
      out.start = cur()
      for (let i = 0; i < 4 && cur() === 5; i++) { await r.next(); await wait(100) }
      out.afterNext = cur()
      for (let i = 0; i < 6 && cur() === 6; i++) { await r.prev(); await wait(100) }
      out.afterPrev = cur()
      await r.nextSection()
      await wait(200)
      out.afterNextSection = cur()
      out.startAfterNextSection = Math.round(r.start)
      await r.prevSection()
      await wait(200)
      out.afterPrevSection = cur()
      await wait(300)
      const before = r.start
      r.scrollBy(0, 120)
      out.scrollByDelta = Math.round(r.start - before)
      out.atStartAtEnd = [r.atStart, r.atEnd]
      return out
    })
    assert.equal(api.start, 5)
    assert.equal(api.afterNext, 6, `next() crosses into the next section ${JSON.stringify(api)}`)
    assert.equal(api.afterPrev, 5, `prev() crosses back ${JSON.stringify(api)}`)
    assert.equal(api.afterNextSection, 6, `nextSection() ${JSON.stringify(api)}`)
    assert.ok(Math.abs(api.startAfterNextSection) <= 1, `nextSection() lands on the section top ${JSON.stringify(api)}`)
    assert.equal(api.afterPrevSection, 5, `prevSection() ${JSON.stringify(api)}`)
    assert.equal(api.scrollByDelta, 120, `scrollBy() is a raw scroll ${JSON.stringify(api)}`)
    assert.deepEqual(api.atStartAtEnd, [false, false])
    results.api = api
    console.log('PASS next/prev/nextSection/prevSection/scrollBy', JSON.stringify(api))

    // ---- 6. landscape with flow forced to scrolled ----
    // The app's own flow setting must say "scrolled" as well: with "paginated" the app treats a
    // vertical swipe as a page turn and calls renderer.next() in the middle of the fling.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('lightread-settings') ?? '{}')
      saved.reader = { ...saved.reader, flow: 'scrolled' }
      localStorage.setItem('lightread-settings', JSON.stringify(saved))
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length > 0,
      null, { timeout: 15_000 })
    await page.evaluate(() => {
      const r = document.querySelector('foliate-view').renderer
      r.setAttribute('continuous', '')
      if (r.getAttribute('flow') !== 'scrolled') r.setAttribute('flow', 'scrolled')
    })
    await page.waitForFunction(() => document.querySelector('foliate-view').renderer.continuous === true, null, { timeout: 5000 })
    await page.evaluate(instrument)
    await page.evaluate(() => document.querySelector('foliate-view').goTo(4))
    await page.waitForFunction(() => document.querySelector('foliate-view').lastLocation?.section?.current === 4)
    await sleep(1500)
    await setPhase('landscape')
    let lsSwipes = 0
    while (lsSwipes < 30) {
      await swipe(-380, { x: 720, y0: 760 })
      lsSwipes++
      await settle(200)
      if ((await current()) >= 7) break
    }
    await settle(400)
    await setPhase('after-landscape')
    const ls = await page.evaluate(() => {
      const cs = window.__cs
      return {
        relocs: cs.relocs.filter(r => r.phase === 'landscape'), samples: cs.samples.filter(s => s.phase === 'landscape'),
        flow: document.querySelector('foliate-view').renderer.getAttribute('flow'),
      }
    })
    const lsIdx = ls.relocs.map(r => r.index)
    for (let i = 1; i < lsIdx.length; i++) assert.ok(lsIdx[i] >= lsIdx[i - 1], `landscape relocate went back: ${lsIdx}`)
    assert.ok(new Set(lsIdx).size >= 3, `landscape crossed too few boundaries: ${[...new Set(lsIdx)]}`)
    const lsBack = maxBackward(ls.samples, 1)
    if (lsBack.worst > 2) {
      const t = lsBack.at.t
      const ctx = await page.evaluate(t => ({
        samples: window.__cs.samples.filter(s => Math.abs(s.t - t) < 120).map(s => [Math.round(s.t), s.tops]),
        loads: window.__cs.loads.filter(s => Math.abs(s.t - t) < 1500).map(s => [Math.round(s.t), s.index]),
        unloads: window.__cs.unloads.filter(s => Math.abs(s.t - t) < 1500).map(s => [Math.round(s.t), s.index]),
        changes: window.__cs.changes.filter(s => Math.abs(s.t - t) < 1500).map(s => [Math.round(s.t), s.index]),
        rr: window.__cs.rrelocs.filter(s => Math.abs(s.t - t) < 600),
        lastScroll: window.__cs.lastScroll,
      }), t)
      console.error('landscape jump context', JSON.stringify(lsBack.at), JSON.stringify(ctx))
    }
    assert.ok(lsBack.worst <= 2, `landscape backward jump ${lsBack.worst.toFixed(1)}px`)
    results.landscape = { flow: ls.flow, swipes: lsSwipes, visited: [...new Set(lsIdx)], maxBackwardPx: +lsBack.worst.toFixed(2) }
    console.log('PASS landscape scrolled flow', JSON.stringify(results.landscape))

    // ---- 7. turning continuous off falls back to one section at a time ----
    await page.evaluate(() => document.querySelector('foliate-view').renderer.removeAttribute('continuous'))
    await sleep(500)
    const off = await page.evaluate(() => {
      const view = document.querySelector('foliate-view')
      return { continuous: view.renderer.continuous, contents: view.renderer.getContents().map(c => c.index),
        current: view.lastLocation?.section?.current }
    })
    assert.equal(off.continuous, false)
    assert.deepEqual(off.contents, [off.current], `single mode keeps only the current section (${JSON.stringify(off)})`)
    console.log('PASS continuous off →', JSON.stringify(off))

    // runtime switches: on again (the section on screen is adopted, not reloaded), then paginated and back
    const switches = await page.evaluate(async () => {
      const view = document.querySelector('foliate-view')
      const r = view.renderer
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const loadsBefore = window.__cs.loads.length
      const index = view.lastLocation.section.current
      r.setAttribute('continuous', '')
      await wait(50)
      const on = { continuous: r.continuous, reloadedCurrent: window.__cs.loads.slice(loadsBefore).some(l => l.index === index) }
      await wait(1200)
      on.contents = r.getContents().map(c => c.index)
      r.setAttribute('flow', 'paginated')
      await wait(800)
      const paginated = { continuous: r.continuous, contents: r.getContents().map(c => c.index), pages: r.pages,
        current: view.lastLocation.section.current }
      await r.next()
      await wait(400)
      paginated.pageAfterNext = r.page
      r.setAttribute('flow', 'scrolled')
      await wait(1200)
      const back = { continuous: r.continuous, contents: r.getContents().map(c => c.index), current: view.lastLocation.section.current }
      return { index, on, paginated, back }
    })
    assert.equal(switches.on.continuous, true)
    assert.equal(switches.on.reloadedCurrent, false, 'turning continuous on must not reload the current section')
    assert.ok(switches.on.contents.length > 1, `neighbours preloaded after turning on: ${switches.on.contents}`)
    assert.equal(switches.paginated.continuous, false)
    assert.deepEqual(switches.paginated.contents, [switches.index])
    assert.ok(switches.paginated.pages >= 3, `paginated layout after leaving continuous: ${JSON.stringify(switches.paginated)}`)
    assert.equal(switches.back.continuous, true)
    assert.equal(switches.back.contents[0], switches.back.current)
    results.switches = switches
    console.log('PASS runtime mode switches', JSON.stringify(switches))

    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`)
    console.log('ALL PASS', JSON.stringify(results))
  } catch (e) {
    await page.screenshot({ path: '/tmp/lightread-e2e-continuous-fail.png' }).catch(() => {})
    if (errors.length) console.error('page errors:', errors.join('\n'))
    console.error('partial results:', JSON.stringify(results))
    throw e
  }
}
if (runs('device')) await runDevice(browser)
if (runs('stream')) await runStreamFlings(browser)
if (runs('auto')) await runAutoScroll(browser)
} finally {
  await browser.close()
}

