import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'
import { installDevicePerformance } from '../src/services/devicePerformance.ts'

const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const native = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/services/devicePerformance.ts', import.meta.url), 'utf8')
const rect = (x = 0, y = 0, width = 100, height = 100) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height })

function fixture() {
  const saved = new Map()
  const replace = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  class Element {
    isConnected = true
    matches(selector) { return selector === 'foliate-view' && this === view }
    box = rect()
    style = { display: 'block', visibility: 'visible', opacity: '1' }
    getBoundingClientRect() { return this.box }
    closest(selector) { return selector === '.btn-read:not(:disabled)' && this.button ? this : null }
  }
  const listeners = new Map(), raf = new Map(), timers = new Map(), records = []
  const documentListeners = new Map(), contentListeners = new Map(), observers = new Set()
  const eventTarget = callbacks => ({
    addEventListener(name, fn, capture) { assert.equal(capture, true); callbacks.set(name, fn) },
    removeEventListener(name, fn, capture) { assert.equal(capture, true); if (callbacks.get(name) === fn) callbacks.delete(name) },
  })
  let now = 100, serial = 0, engine, reader = false, gate = false, pdfGate = false, canvases = []
  const contentDoc = { ...eventTarget(contentListeners), body: {}, readyState: 'complete', fonts: { status: 'loaded' },
    defaultView: { frameElement: { isConnected: true }, performance: { timeOrigin: 1700000000050 } } }
  const range = { startContainer: { ownerDocument: contentDoc }, endContainer: { ownerDocument: contentDoc }, getBoundingClientRect: () => rect() }
  const view = new Element()
  view.lastLocation = { cfi: 'PRIVATE_CFI_A', section: { current: 3 }, range }
  view.renderer = { getContents: () => [{ index: 3, doc: contentDoc }] }
  const document = {
    ...eventTarget(documentListeners),
    querySelector(selector) {
      if (selector === '.reader > .state') return gate ? {} : null
      if (selector === '.paper-state') return pdfGate ? {} : null
      if (selector === 'foliate-view') return reader && engine === 1 ? view : null
      if (selector === '.reader, .paper') return reader ? {} : null
      throw new Error(`Unexpected selector: ${selector}`)
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.p-holder[data-page] .p-canvas canvas')
      return canvases
    },
  }
  const window = {
    addEventListener(name, fn, capture) { assert.equal(capture, true); listeners.set(name, fn) },
    removeEventListener(name, fn, capture) { assert.equal(capture, true); if (listeners.get(name) === fn) listeners.delete(name) },
  }
  replace('window', window); replace('document', document); replace('Element', Element)
  replace('MutationObserver', class {
    constructor(callback) { this.callback = callback }
    observe() { observers.add(this) }
    disconnect() { observers.delete(this) }
  })
  replace('innerWidth', 1000); replace('innerHeight', 800)
  replace('getComputedStyle', element => element.style)
  replace('performance', { now: () => now, timeOrigin: 1700000000000 })
  replace('requestAnimationFrame', fn => { raf.set(++serial, fn); return serial })
  replace('cancelAnimationFrame', id => raf.delete(id))
  replace('setTimeout', (fn, delay) => { timers.set(++serial, { fn, at: now + delay }); return serial })
  replace('clearTimeout', id => timers.delete(id))
  const bridge = { recordPerformance(...args) { records.push(args); return true } }
  const emit = (name, args = {}) => listeners.get(name)?.({ isTrusted: true, timeStamp: now, ...args })
  return {
    window, document, records, listeners, documentListeners, contentListeners, observers, raf, timers, bridge, view, contentDoc, range,
    install: () => installDevicePerformance(bridge, () => engine),
    engine(value) { engine = value; reader = value !== undefined },
    gate(value) { gate = value }, pdfGate(value) { pdfGate = value },
    clock(value) { now = value },
    frame(step = 16) { now += step; const callbacks = [...raf.values()]; raf.clear(); for (const fn of callbacks) fn(now) },
    expire(step = 5000) {
      now += step
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() }
    },
    click(args = {}) { const button = new Element(); button.button = true; emit('click', { target: button, ...args }) },
    key(args = {}) { emit('keydown', { key: 'ArrowRight', ...args }) },
    contentKey(args = {}) { contentListeners.get('keydown')?.({ isTrusted: true, key: 'ArrowRight', timeStamp: now - 50, ...args }) },
    loaded() { documentListeners.get('load')?.({ target: view, detail: { doc: contentDoc } }) },
    mutate() { for (const observer of observers) observer.callback() },
    canvas(page, x = 0, y = 0, width = 100, height = 100) {
      const canvas = new Element()
      Object.assign(canvas, { width, height, isConnected: true, box: rect(x, y, width, height) })
      const holder = { dataset: { page: String(page) } }
      canvas.closest = selector => { assert.equal(selector, '.p-holder'); return holder }
      canvases.push(canvas)
      return canvas
    },
    clearCanvases() { canvases = [] },
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
}
function scenario(fn) {
  const f = fixture()
  try { fn(f) } finally { f.restore() }
}
function assertRecord(record, action, engine, completed) {
  assert.equal(record.length, 4)
  assert.equal(record[0], action); assert.equal(record[1], engine); assert.equal(record[3], completed)
  assert.equal(typeof record[2], 'number')
  assert.ok(Number.isFinite(record[2]) && record[2] >= 0 && record[2] <= 60000)
  assert.ok(record.every(value => typeof value === 'number' || typeof value === 'boolean'))
}

// Execute the real App script with only its startup dependencies replaced, including its dynamic import.
function appHost(bridge, load) {
  let mounted, unmount, loads = 0
  const noop = () => {}
  const route = { path: '/library', fullPath: '/library' }
  const folder = { status: { value: { generation: 0 } }, start: () => noop, setReadingActive: noop }
  const stubs = {
    useRoute: () => route, useRouter: () => ({}), computed: noop, provide: noop, watch: () => noop,
    onMounted: fn => { mounted = fn }, onBeforeUnmount: fn => { unmount = fn },
    useSettings: () => ({ persistOnChange: noop }), useLibrary: () => ({}), useAppearance: noop,
    useFolderLibrary: () => folder,
    createReaderActivity: () => ({ captureFailure: noop, commit: noop, dispose: noop }),
    isTauri: () => false, initSystemTts: noop, localTtsAvailable: () => false, disposeLibraryCovers: noop,
  }
  const script = app.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports, window: { LightReadInsets: bridge }, console,
    require(path) { if (path === './services/devicePerformance') { loads++; return load() } return stubs },
  })
  return { mount: () => mounted(), unmount: () => unmount(), loads: () => loads }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('App opt-out checks the getter once and registers/imports no probe resources', async () => {
  const f = fixture()
  try {
    let queries = 0
    const host = appHost({ performanceProbeEnabled() { queries++; return false } }, () => assert.fail('disabled import'))
    await host.mount(); await settle()
    assert.equal(queries, 1); assert.equal(host.loads(), 0)
    assert.equal(f.listeners.size + f.documentListeners.size + f.contentListeners.size + f.observers.size + f.raf.size + f.timers.size, 0)
    host.unmount()
  } finally { f.restore() }
})

test('App enabled late import after teardown does nothing; missing/throwing bridge cannot break startup', async () => {
  let resolve, installs = 0
  const host = appHost({ performanceProbeEnabled: () => true }, () => new Promise(r => { resolve = r }))
  await host.mount(); await settle(); host.unmount()
  resolve({ installDevicePerformance() { installs++; return () => {} } }); await settle()
  assert.equal(host.loads(), 1); assert.equal(installs, 0)
  for (const bridge of [undefined, { performanceProbeEnabled() { throw new Error('private native error') } }]) {
    const failed = appHost(bridge, () => assert.fail('unavailable import'))
    await failed.mount(); await settle(); failed.unmount()
    assert.equal(failed.loads(), 0)
  }
})

test('App enabled probe is installed once and disposed on teardown', async () => {
  let installs = 0, stops = 0, queries = 0
  const host = appHost({ performanceProbeEnabled() { queries++; return true } }, () => ({ installDevicePerformance() { installs++; return () => { stops++ } } }))
  await host.mount(); await settle(); host.unmount()
  assert.equal(queries, 1); assert.equal(installs, 1); assert.equal(stops, 1)
})

test('reflow turn requires a changed CFI, current document and two stable RAF, with event timestamp', () => scenario(f => {
  f.engine(1); const stop = f.install()
  assertRecord(f.records[0], 0, 0, true)
  f.key({ timeStamp: 80 }); f.frame(); f.frame()
  assert.equal(f.records.length, 1)
  f.view.lastLocation.cfi = 'PRIVATE_CFI_B'
  f.frame(); assert.equal(f.records.length, 1)
  f.frame(); assertRecord(f.records[1], 2, 1, true)
  assert.equal(f.records[1][2], 84)
  assert.ok(!JSON.stringify(f.records).includes('PRIVATE'))
  assert.equal(f.raf.size + f.timers.size, 0); stop()
}))

test('content capture normalizes iframe time origin; repeated loads do not duplicate and unmount detaches', () => scenario(f => {
  f.engine(1); const stop = f.install()
  assert.equal(f.contentListeners.size, 1)
  f.loaded(); f.loaded(); assert.equal(f.contentListeners.size, 1)
  f.contentKey({ timeStamp: 30 }); f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; f.frame(); f.frame()
  assertRecord(f.records[1], 2, 1, true)
  assert.equal(f.records[1][2], 52, 'iframe stamp 30 + origin difference 50, commit at 132')
  f.view.isConnected = false; f.mutate()
  assert.equal(f.contentListeners.size, 0)
  f.view.isConnected = true; f.loaded(); assert.equal(f.contentListeners.size, 1)
  const staleLoad = f.documentListeners.get('load')
  const staleKey = f.contentListeners.get('keydown')
  stop(); staleLoad({ target: f.view, detail: { doc: f.contentDoc } }); staleKey({ isTrusted: true, key: 'ArrowRight', timeStamp: 30 })
  f.frame(); f.expire()
  assert.equal(f.records.length, 2)
  assert.equal(f.listeners.size + f.documentListeners.size + f.contentListeners.size + f.observers.size + f.raf.size + f.timers.size, 0)
}))

test('reflow gate, foreign range document, incomplete document and zero range cannot pass', () => {
  for (const block of [f => f.gate(true), f => { f.range.startContainer.ownerDocument = {} }, f => { f.contentDoc.readyState = 'loading' }, f => { f.range.getBoundingClientRect = () => rect(0, 0, 0, 0) }, f => { f.contentDoc.fonts.status = 'loading' }]) scenario(f => {
    f.engine(1); f.install(); f.key(); f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; block(f)
    f.frame(); f.frame(); assert.equal(f.records.length, 1)
    f.expire(); assertRecord(f.records[1], 2, 1, false)
  })
})

test('readiness must stay stable across both RAF and unchanged identity times out', () => scenario(f => {
  f.engine(1); f.install(); f.key(); f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; f.frame()
  f.gate(true); f.frame(); f.gate(false); f.frame()
  assert.equal(f.records.length, 1); f.frame(); assertRecord(f.records[1], 2, 1, true)
  f.key(); f.frame(); f.frame(); f.expire()
  assertRecord(f.records[2], 2, 1, false)
}))

test('open waits for reader readiness, uses 15s deadline, invalid epoch timestamp falls back to now', () => scenario(f => {
  f.install(); f.click({ timeStamp: 1700000000000 }); f.frame()
  f.engine(1); f.gate(true); f.frame(); f.gate(false); f.frame()
  assert.equal(f.records.length, 1); f.frame()
  assertRecord(f.records[1], 1, 1, true); assert.equal(f.records[1][2], 64)
  f.click(); f.gate(true); f.expire(14999); assert.equal(f.records.length, 2)
  f.expire(1); assertRecord(f.records[2], 1, 1, false)
}))

test('unclassifiable open records an unavailable probe, not a fabricated engine/success', () => scenario(f => {
  f.install(); f.click(); f.frame(); f.expire(15000)
  assertRecord(f.records[1], 0, 0, false)
}))

test('PDF selects visible raster not offscreen/old canvas or changed page input; requires page change', () => scenario(f => {
  f.engine(2); f.canvas(99, 0, 1000); const old = f.canvas(1)
  f.install(); f.key(); f.frame(); f.frame(); assert.equal(f.records.length, 1)
  f.clearCanvases(); f.canvas(1); f.frame(); f.frame()
  assert.equal(f.records.length, 1, 'replacement of same-page raster is not a turn')
  f.clearCanvases(); const next = f.canvas(2); f.frame(); assert.equal(f.records.length, 1)
  next.box = rect(0, 1); f.frame(); assert.equal(f.records.length, 1, 'moving raster is not stable')
  f.frame(); assertRecord(f.records[1], 2, 2, true)
  assert.notEqual(old, next)
}))

test('PDF loading/error gate, hidden or zero/disconnected raster never succeeds', () => {
  for (const block of [(f, c) => { c.width = 0 }, f => f.pdfGate(true), (f, c) => { c.isConnected = false }, (f, c) => { c.box = rect(0, -200) }, (f, c) => { c.style.visibility = 'hidden' }]) scenario(f => {
    f.engine(2); f.canvas(1); f.install(); f.key(); f.clearCanvases(); const next = f.canvas(2); block(f, next)
    f.frame(); f.frame(); assert.equal(f.records.length, 1); f.expire()
    assertRecord(f.records[1], 2, 2, false)
  })
})

test('overlapping turn fails new input immediately and quarantines the original until deadline', () => scenario(f => {
  f.engine(1); f.install(); f.key(); f.frame(); f.key()
  assertRecord(f.records[1], 2, 1, false); assert.equal(f.raf.size, 0)
  f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; f.key(); f.frame()
  assertRecord(f.records[2], 2, 1, false)
  f.expire(); assertRecord(f.records[3], 2, 1, false)
  assert.equal(f.raf.size + f.timers.size, 0)
}))

test('dispose removes listeners/timers/RAF and stale callbacks cannot emit late success', () => scenario(f => {
  f.engine(1); const stop = f.install(); f.key(); f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; f.frame()
  const staleFrame = [...f.raf.values()][0], staleTimer = [...f.timers.values()][0].fn
  stop(); stop(); staleFrame(); staleTimer(); f.key(); f.click()
  assert.equal(f.records.length, 1); assert.equal(f.listeners.size + f.raf.size + f.timers.size, 0)
}))

test('expired event deadline fails even when timer has not run, and elapsed is bounded', () => scenario(f => {
  f.engine(1); f.install(); f.key(); f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; f.frame()
  f.clock(70000); f.frame()
  assertRecord(f.records[1], 2, 1, false); assert.equal(f.records[1][2], 60000)
}))

test('outside-reader and untrusted events are ignored; sink failure stops with no false success', () => scenario(f => {
  f.install(); f.key(); f.click({ isTrusted: false }); assert.equal(f.records.length, 1)
  f.engine(1); f.key({ isTrusted: false }); assert.equal(f.records.length, 1)
  f.key(); f.bridge.recordPerformance = () => { throw new Error('PRIVATE_SINK_ERROR') }
  f.view.lastLocation.cfi = 'PRIVATE_CFI_B'; f.frame(); f.frame()
  assert.equal(f.records.length, 1); assert.equal(f.listeners.size + f.raf.size + f.timers.size, 0)
}))

test('512 total samples including ready; no resources or additional samples after cap', () => scenario(f => {
  f.engine(1); f.install()
  for (let i = 1; i <= 511; i++) {
    f.key(); f.view.lastLocation.cfi = `PRIVATE_CFI_${i}`; f.frame(); f.frame()
  }
  assert.equal(f.records.length, 512)
  f.key(); f.click(); f.frame(); f.expire(60000)
  assert.equal(f.records.length, 512); assert.equal(f.listeners.size + f.raf.size + f.timers.size, 0)
  f.records.forEach(record => assertRecord(record, record[0], record[1], record[3]))
}))

test('real focused iframe keys are measured for existing and newly loaded sections, then detached', { timeout: 90000 }, async () => {
  let server, browser
  try {
    server = await createServer({ root: readerRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      return /^https?:$/.test(url.protocol) && url.origin !== origin ? route.abort() : route.continue()
    })
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/probe-fixture.html', route => route.fulfill({ contentType: 'text/html', body: `
      <div class="reader"></div><script type="module">
      import { installDevicePerformance } from '/src/services/devicePerformance.ts';
      window.records = [];
      const bridge = { recordPerformance(...args) { records.push(args); return true } };
      window.install = () => window.stop = installDevicePerformance(bridge, () => 1);
      let view, frame, currentDoc, section = 0, turn = 0;
      window.section = async () => {
        if (!view) {
          view = document.createElement('foliate-view');
          view.style.cssText = 'display:block;width:400px;height:200px';
          document.querySelector('.reader').append(view);
          view.attachShadow({ mode: 'open' });
          view.renderer = { getContents: () => currentDoc ? [{ index: section, doc: currentDoc }] : [] };
        }
        frame?.remove();
        frame = document.createElement('iframe');
        frame.srcdoc = '<button>Focus synthetic page</button><p>Page A</p><p>Page B</p>';
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        view.shadowRoot.append(frame); await loaded;
        currentDoc = frame.contentDocument; section++; turn = 0;
        await currentDoc.fonts.ready;
        const commit = () => {
          const range = currentDoc.createRange();
          range.selectNodeContents(currentDoc.querySelectorAll('p')[turn % 2]);
          view.lastLocation = { cfi: section + ':' + turn, section: { current: section }, range };
        };
        commit();
        // This is the supported ReaderView content-document key path; iframe keys never bubble to window.
        currentDoc.addEventListener('keydown', event => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { turn++; commit() }
        });
        view.dispatchEvent(new CustomEvent('load', { detail: { doc: currentDoc, index: section } }));
      };
      window.inspect = () => ({ cfi: view.lastLocation.cfi, records, originDelta: frame.contentWindow.performance.timeOrigin - performance.timeOrigin });
      window.ready = true;
      </script>` }))
    await page.goto(`${origin}/probe-fixture.html`)
    await page.waitForFunction(() => window.ready)
    await page.evaluate(() => window.section())
    await page.evaluate(() => window.install())
    for (let section = 0; section < 3; section++) {
      if (section) await page.evaluate(() => window.section())
      await page.locator('iframe').contentFrame().locator('button').focus()
      const before = await page.evaluate(() => window.inspect())
      await page.keyboard.press(section % 2 ? 'ArrowLeft' : 'ArrowRight')
      await page.waitForFunction(cfi => window.inspect().cfi !== cfi, before.cfi)
      await page.waitForFunction(n => window.records.length === n + 1, before.records.length, { timeout: 1500 })
      const after = await page.evaluate(() => window.inspect())
      assertRecord(after.records.at(-1), 2, 1, true)
      assert.ok(after.records.at(-1)[2] < 1500, 'must not include iframe creation/time-origin gap')
    }
    const beforeStop = await page.evaluate(() => { window.stop(); return window.inspect() })
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(cfi => window.inspect().cfi !== cfi, beforeStop.cfi)
    await page.evaluate(() => window.section())
    await page.locator('iframe').contentFrame().locator('button').focus()
    await page.keyboard.press('ArrowLeft')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await page.evaluate(() => window.records), beforeStop.records)
    assert.deepEqual(errors, [])
    console.log('IFRAME_KEYS_OK: existing + 2 new sections; trusted focused keys; dispose prevents new samples')
  } finally {
    await browser?.close()
    await server?.close()
  }
})

test('native primitive-only, launch-scoped atomic bounds and fixed labels; no persistent/content sinks', () => {
  assert.match(native, /@Volatile\s+private var performanceProbe = false/)
  assert.match(native, /getBooleanExtra\("io\.pagewise\.reader\.PERF_PROBE", false\) \?: false/)
  assert.match(native, /override fun onDestroy\(\)\s*\{\s*synchronized\(performanceRecords\) \{ performanceProbe = false \}/)
  assert.match(native, /private val performanceRecords = AtomicInteger\(0\)/)
  assert.match(native, /@JavascriptInterface\s+fun performanceProbeEnabled\(\): Boolean = performanceProbe/)
  assert.match(native, /fun recordPerformance\(\s*actionCode: Int,\s*engineCode: Int,\s*elapsedMs: Double,\s*completed: Boolean,?\s*\): Boolean =\s+synchronized\(performanceRecords\)/)
  const reporter = native.split('fun recordPerformance(')[1].split('@JavascriptInterface')[0]
  assert.match(reporter, /!performanceProbe \|\| performanceRecords\.get\(\) >= 512/)
  assert.match(reporter, /!elapsedMs\.isFinite\(\) \|\| elapsedMs < 0\.0 \|\| elapsedMs > 60000\.0/)
  assert.match(reporter, /0 -> if \(engineCode == 0\) "ready" else return@synchronized false/)
  for (const [code, label] of [[1, 'open'], [2, 'turn']]) assert.ok(reporter.includes(`${code} -> if (engineCode == 1 || engineCode == 2) "${label}" else return@synchronized false`))
  assert.match(reporter, /else -> return@synchronized false/)
  assert.match(reporter, /performanceRecords\.incrementAndGet\(\)/)
  assert.match(reporter, /Log\.i\(\s*"PagewisePerf",\s*String\.format\(\s*Locale\.US,/)
  assert.ok(reporter.includes('PWPERF action=%s engine=%s completed=%d ms=%.3f'))
  assert.doesNotMatch(native, /setWebContentsDebuggingEnabled|SharedPreferences|putExtra|FileOutputStream/)
  assert.doesNotMatch(service, /textContent|innerHTML|outerHTML|fetch\(|localStorage|sessionStorage|console\.|getImageData/)
  assert.doesNotMatch(reporter, /Throwable|Exception|\.toString\(|insetsJson/)
})
