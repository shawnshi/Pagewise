import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { ref } from 'vue'

const source = readFileSync(new URL('../src/views/PdfReaderView.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const ast = ts.createSourceFile('PdfReaderView.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function compile(node, context) {
  const js = ts.transpileModule(`(${node.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return vm.runInContext(js, context)
}
function fixture(options = {}) {
  const metrics = { saved: [], navigated: [], closed: 0, openCalls: 0, observers: 0, disconnected: 0, viewport: 0, layouts: 0, errors: [], rendered: 0 }
  const stored = { location: '80', progress: .8 }
  const doc = { pages: Array.from({ length: 100 }, () => ({ w: 612, h: 792 })), close: () => { metrics.closed++ } }
  const opened = deferred(), fileRead = deferred(), renderStarted = deferred()
  const timerQueue = new Map(); let timerId = 0
  const context = vm.createContext({
    readerAlive: true, pdfPositionReady: false, nativeBackPending: false,
    bookId: 'synthetic-pdf', backTarget: '/library', bookmarkMutation: null,
    window: { addEventListener() {}, removeEventListener() {}, getSelection: () => null },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    TextDecoder, Blob, Uint8Array, ArrayBuffer,
    console: { error: (...args) => metrics.errors.push(String(args[0])) },
    t: key => key, toast() {}, handleKeydown() {}, onFullscreenChange() {}, isTauri: () => false,
    settings: { pdf: { renderer: 'pdfium', layout: 'original' } },
    PdfiumDoc: { open: async () => { metrics.openCalls++; opened.resolve(); return options.open ?? doc } },
    getStorage: async () => ({
      getBook: async () => ({ format: 'pdf', location: stored.location }),
      listAnnotations: async () => [],
      getBookFile: async () => { fileRead.resolve(); return options.file ?? new Blob(['%PDF-1.7\nsynthetic fixture']) },
    }),
    library: { saveProgress: async (_id, location, progress) => { metrics.saved.push({ location, progress }); Object.assign(stored, { location, progress }) } },
    router: { push: async target => { metrics.navigated.push(target) }, replace() {} },
    isSupportedBookFormat: value => value === 'pdf', decodeLoc: () => true,
    nextTick: async fn => { if (fn) fn() },
    spreadOf: page => [page], fitScale: () => 1, fixedZoomScale: () => 1,
    renderPaged: async () => { metrics.rendered++; renderStarted.resolve(); if (options.render) await options.render },
    markLaidOut: () => { metrics.layouts++ }, buildOutline() {},
    attachScrollListener() {}, scrollGoto() {}, updateViewport() {},
    observeActiveViewport: () => { metrics.viewport++ },
    ResizeObserver: class { constructor() { metrics.observers++ } disconnect() { metrics.disconnected++ } },
    closePdfAssistant() {}, closePdfSearch() {}, closeDrawer() {}, closeSelTr() {},
    stopTTS() {}, stopAutoRead() {}, exitPresentation: async () => {}, setFullscreen: async () => {},
    setTimeout: fn => { const id = ++timerId; timerQueue.set(id, fn); return id },
    clearTimeout: id => timerQueue.delete(id),
    reflowSession: 0, selTrSession: 0, pdfSearchSession: 0, ttsSession: 0,
    fullscreenWindowUnlisten: undefined, resizeObserver: undefined, listenedScroller: undefined,
    thumbnailObserver: null, thumbnailQueue: [], thumbnailQueued: new Set(), thumbnailRendered: new Set(), thumbnailLastUsed: new Map(),
    panDrag: null, onDragMove() {}, onDragUp() {}, onPanMove() {}, onPanUp() {}, onScroll() {},
    pdm: null, sourcePdfBlob: null, nativeSpeechBlob: null,
    rasterClient: null, bitmapCache: { clear() {} }, prefetchQueue: [],
    PdfRasterClient: class { close() {} },
    nativeSpeech: { attached: false, detach() {} }, isNativeSystemTts: () => false, ttsState: ref('stopped'),
    saveTimer: undefined, settleTimer: undefined, resizeTimer: undefined, wheelPageReset: undefined, pdfSearchTimer: undefined,
    progressWrite: Promise.resolve(), progressErrorShown: false, lastSavedProgress: '',
  })
  for (const name of ['activeAnnotation','selection','liveSel','pdfAiOpen','pdfSearchOpen','drawerOpen','moreMenu','propertiesOpen','zoomMenu','typographyOpen','shortcutsOpen','autoPanel','ttsPanel','autoReading','presentationMode','isFullscreen']) context[name] = ref(null)
  Object.assign(context, { meta: ref(null), annotations: ref([]), sourcePdfVersion: ref(''), pageCount: ref(0), pageDims: ref([]), baseDims: ref({}), currentPage: ref(1), loading: ref(true), error: ref(''), pdfLayout: ref('original'), bookPaged: ref(true), zoom: ref('fit-width'), curScale: ref(1) })
  context.nativeBackHost = context.window
  for (const name of ['readerBack','handleNativeReaderBack','onPageSettled','persistProgress','flushProgress','reportProgressError','onVisibilityCheckpoint']) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
    assert.ok(node, `production ${name}`)
    context[name] = compile(node, context)
  }
  const hooks = ast.statements.filter(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)).map(n => ({ name: n.expression.expression.getText(ast), fn: n.expression.arguments[0] })).filter(h => h.fn)
  const init = hooks.find(h => h.name === 'onMounted' && h.fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))
  const owner = hooks.find(h => h.name === 'onMounted' && h.fn.getText(ast).includes('nativeBackHost.__pagewiseReaderBack'))
  const cleanup = hooks.filter(h => h.name === 'onBeforeUnmount' && /readerAlive = false|nativeBackHost\.__pagewiseReaderBack/.test(h.fn.getText(ast))).map(h => compile(h.fn, context))
  assert.ok(init); assert.ok(owner); assert.equal(cleanup.length, 2)
  compile(owner.fn, context)()
  const start = () => compile(init.fn, context)()
  let disposed = false
  const unmount = () => { if (!disposed) { disposed = true; cleanup.forEach(fn => fn()) } }
  return { context, metrics, stored, doc, start, unmount, opened: opened.promise, fileRead: fileRead.promise, renderStarted: renderStarted.promise, flushTimers: () => { const pending = [...timerQueue.values()]; timerQueue.clear(); pending.forEach(fn => fn()) } }
}

test('PDF toolbar return and change-document use the same acknowledged Back entry as Android', () => {
  assert.match(descriptor.template.content, /class="icon-btn document-back"[^>]*@click="handleNativeReaderBack"/)
  assert.match(descriptor.template.content, /class="btn btn-sm change-document"[^>]*@click="handleNativeReaderBack"/)
})

test('MLI-PDF-001: Back during a delayed open never saves the initial page over an existing position', async () => {
  const gate = deferred(), f = fixture({ open: gate.promise })
  const work = f.start(); await f.opened
  await f.context.readerBack(); f.unmount()
  assert.deepEqual(f.metrics.saved, [])
  assert.deepEqual(f.stored, { location: '80', progress: .8 })
  assert.deepEqual(f.metrics.navigated, ['/library'])
  gate.resolve(f.doc); await work
  assert.equal(f.metrics.closed, 1)
  assert.equal(f.metrics.observers, 0); assert.equal(f.metrics.viewport, 0); assert.equal(f.metrics.layouts, 0)
})

test('MLI-PDF-001: a failed open clears loading but still cannot acknowledge a valid reading position', async () => {
  const gate = deferred(), f = fixture({ open: gate.promise })
  const work = f.start(); await f.opened; gate.reject(new Error('synthetic open rejection')); await work
  assert.equal(f.context.loading.value, false); assert.equal(f.context.pdfPositionReady, false)
  assert.match(f.context.error.value, /synthetic open rejection/)
  f.context.onPageSettled(); f.flushTimers()
  await f.context.readerBack(); f.unmount()
  assert.deepEqual(f.stored, { location: '80', progress: .8 }); assert.deepEqual(f.metrics.saved, [])
})

test('MLI-PDF-001: successful restoration and a later page change save the real position on Back', async () => {
  const f = fixture(); await f.start()
  assert.equal(f.context.currentPage.value, 80); assert.equal(f.context.pdfPositionReady, true)
  f.context.currentPage.value = 81
  await f.context.readerBack(); f.unmount()
  assert.deepEqual(f.metrics.saved, [{ location: '81', progress: .81 }])
  assert.deepEqual(f.stored, { location: '81', progress: .81 })
  assert.equal(f.metrics.closed, 1); assert.equal(f.metrics.disconnected, 1)
})

test('MLI-PDF-002: exiting while the file is still being read never starts a late PDF open', async () => {
  const gate = deferred(), f = fixture({ file: gate.promise })
  const work = f.start(); await f.fileRead; f.unmount()
  gate.resolve(new Blob(['%PDF-1.7\nfixture'])); await work
  assert.equal(f.metrics.openCalls, 0); assert.equal(f.metrics.observers, 0)
  assert.deepEqual(f.metrics.saved, [])
})

test('MLI-PDF-002: an adopted document is closed once when exiting during initial rendering', async () => {
  const gate = deferred(), f = fixture({ render: gate.promise })
  const work = f.start(); await f.renderStarted; f.unmount(); gate.resolve(); await work
  assert.equal(f.metrics.closed, 1); assert.equal(f.metrics.observers, 0); assert.equal(f.metrics.viewport, 0)
  assert.equal(f.context.pdfPositionReady, false); assert.deepEqual(f.metrics.saved, [])
})

test('MLI-PDF-001: leaving by any route persists the pending debounced page', async () => {
  const f = fixture(); await f.start()
  f.context.currentPage.value = 82
  f.unmount()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.metrics.saved, [{ location: '82', progress: .82 }])
  assert.deepEqual(f.stored, { location: '82', progress: .82 })
})

test('MLI-PDF-001: going to the background checkpoints the page instead of waiting out the debounce', async () => {
  const f = fixture(); await f.start()
  f.context.currentPage.value = 83
  f.context.document.visibilityState = 'hidden'
  f.context.onVisibilityCheckpoint()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.metrics.saved, [{ location: '83', progress: .83 }])
})
