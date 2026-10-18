import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { ref, computed } from 'vue'
import { blocksReaderTurn, isReaderInteractive, createReaderContext, readerBackTarget } from '../src/services/readerSession.ts'
import { restorableView } from '../src/services/navigationSession.ts'
import { prepareTypographyDocument, UNKNOWN_TYPOGRAPHY_CONTEXT } from '../src/services/readerTypographyContext.ts'
import { applyTypographyDocumentMode } from '../src/services/readerTypographyDocument.ts'

const filename = new URL('../src/views/ReaderView.vue', import.meta.url)
const source = readFileSync(filename, 'utf8')
const { descriptor } = parse(source)
const ast = ts.createSourceFile('ReaderView.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
function actualFunction(name, context) {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name)
  assert.ok(fn, `${name} exists in actual ReaderView setup`)
  const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText
  return vm.runInContext(`${code}\n${name}`, context)
}
function eventDocument() {
  const listeners = new Map()
  const selected = { isCollapsed: true, toString: () => '', getRangeAt: () => ({ cloneRange: () => ({}) }) }
  return {
    selected,
    documentElement: { lang: '', style: { setProperty() {} } },
    querySelectorAll: () => [],
    getSelection: () => selected,
    addEventListener(type, listener, options) {
      const entries = listeners.get(type) ?? []
      entries.push({ listener, capture: options === true || options?.capture === true })
      listeners.set(type, entries)
    },
    dispatch(type, properties = {}) {
      let stopped = false
      const event = { target: { closest: () => null }, ...properties, stopImmediatePropagation: () => { stopped = true }, preventDefault() {} }
      for (const entry of [...(listeners.get(type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
        entry.listener(event)
        if (stopped) break
      }
      return stopped
    },
  }
}
function gestureFixture() {
  const doc = eventDocument()
  const calls = { engine: 0, clicks: 0, turns: 0 }
  const context = vm.createContext({
    readerContext: createReaderContext(), readerSession: { inspecting: false, navigating: false },
    applyTypographyDocumentMode, effectiveReader: ref({ displayMode: 'publisher' }),
    prepareTypographyDocument, bookTypographyContext: ref(UNKNOWN_TYPOGRAPHY_CONTEXT), effectiveTypography: ref({ profile: 'original' }),
    modes: { onSectionLoad() {} }, dj: { onSectionLoad() {}, onSelection() {} },
    bookVertical: true, selectedCustomFont: () => null, sectionLoadResolvers: [], selection: ref(null), selectionRange: null,
    view: { getCFI: () => 'synthetic-selection' }, blocksReaderTurn, isReaderInteractive,
    anyOverlayOpen: () => false, closeOverlays() {}, overlayDismissed: false,
    suppressClickUntil: 0, pointerTs: 0, autoReading: ref(false), Date,
    beginTouch: () => ({ t: Date.now(), moved: 0 }),
    trackTouch: () => ({ dx: 0, dy: 0 }),
    crossSectionBySwipe() {}, effectiveFlow: ref('paginated'),
    turnPage: () => { calls.turns++ }, onContentClick: () => { calls.clicks++ },
    noteReaderSteer() {}, handleKeydown() {},
  })
  actualFunction('onSectionLoad', context)({ detail: { doc, index: 0 } })
  // foliate registers bubble touch handlers before emitting load; capture ordering wins regardless.
  for (const type of ['touchstart', 'touchmove', 'touchend']) doc.addEventListener(type, () => { calls.engine++ })
  return { doc, calls, context }
}

test('actual foliate document bindings stop long selection mouseup from becoming a page click', () => {
  const { doc, calls } = gestureFixture()
  doc.dispatch('mousedown')
  doc.selected.isCollapsed = false
  doc.selected.toString = () => 'synthetic quotation'
  doc.dispatch('selectionchange')
  doc.dispatch('mouseup')
  // Some WebViews collapse native selection before the synthetic click.
  doc.selected.isCollapsed = true
  doc.dispatch('click')
  assert.deepEqual(calls, { engine: 0, clicks: 0, turns: 0 })
})

test('actual iframe touch surfaces give native links and selections priority over renderer touch handlers', () => {
  for (const kind of ['link', 'selection', 'panel']) {
    const { doc, calls, context } = gestureFixture()
    const target = { closest: () => kind === 'link' ? {} : null }
    if (kind === 'selection') doc.selected.isCollapsed = false
    if (kind === 'panel') context.anyOverlayOpen = () => true
    const touch = { clientX: 20, clientY: 20 }
    for (const type of ['touchstart', 'touchmove', 'touchend']) doc.dispatch(type, { target, changedTouches: [touch] })
    assert.equal(calls.engine, 0, kind)
    assert.equal(calls.turns, 0, kind)
    assert.equal(calls.clicks, 0, kind)
  }
})

test('ordinary short iframe tap is handled once and its synthetic click is suppressed', () => {
  const { doc, calls } = gestureFixture()
  const event = { changedTouches: [{ clientX: 250, clientY: 300 }] }
  doc.dispatch('touchstart', event)
  doc.dispatch('touchend', event)
  doc.dispatch('click')
  assert.equal(calls.clicks, 1)
})

test('primary panel setters replace one another instead of stacking independent booleans', () => {
  const context = vm.createContext({ primaryPanel: ref('none'), computed, modes: { closePanel() {} }, dj: { closeOverlays() {} } })
  actualFunction('setPrimaryPanel', context)
  const toggle = actualFunction('primaryToggle', context)
  const settings = toggle('settings')
  const listen = toggle('tts')
  settings.value = true
  assert.equal(settings.value, true)
  listen.value = true
  assert.equal(settings.value, false)
  assert.equal(listen.value, true)
  settings.value = false
  assert.equal(listen.value, true, 'closing inactive settings cannot close listen')
})

test('Back retains legacy stop-auto/fullscreen controls before hiding toolbar or leaving', async () => {
  const actions = []
  const backOwner = () => true
  const context = vm.createContext({
    readerBackTarget, typographyApplying: ref(false), activeAnnotation: ref(null), selection: ref(null), noteDraft: ref(''),
    readerSession: { inspecting: false, flush: async () => {} }, anyOverlayOpen: () => false,
    nativeBackAlive: true, nativeBackHost: { __pagewiseReaderBack: backOwner }, handleNativeReaderBack: backOwner,
    autoReading: ref(true), isFullscreen: ref(true), barsVisible: ref(true),
    stopAutoRead: () => { context.autoReading.value = false; actions.push('stop') },
    toggleFullscreen: async () => { context.isFullscreen.value = false; actions.push('fullscreen') },
    restorableView, window: { history: { state: { back: null } } }, route: { path: '/read/synthetic' },
    router: { back: () => actions.push('history'), replace: async path => actions.push(path) },
  })
  const back = actualFunction('readerBack', context)
  await back()
  await back()
  assert.deepEqual(actions, ['stop', 'fullscreen'])
  await back()
  assert.equal(context.barsVisible.value, false)
  await back()
  assert.deepEqual(actions, ['stop', 'fullscreen', '/library'])
  context.window.history.state.back = '/notes'
  await back()
  assert.equal(actions.at(-1), 'history')
  context.window.history.state.back = '//untrusted.invalid/path'
  await back()
  assert.equal(actions.at(-1), '/library')
})

test('actual saveNote retains text/editor on write failure and only closes the committed unchanged draft', async () => {
  const original = { id: 'generated-note', cfi: 'generated-location', note: 'old' }
  const context = vm.createContext({
    activeAnnotation: ref({ ...original }), noteDraft: ref('new unsaved text'), noteSaving: ref(false),
    annotations: ref([{ ...original }]), readerContext: createReaderContext(), t: key => key,
    bookId: 'generated-book', removeNoteDraft: () => ({ success: true }),
    toast() {}, getStorage: async () => ({ updateAnnotation: async () => { throw new Error('quota') } }),
  })
  const save = actualFunction('saveNote', context)
  await save()
  assert.equal(context.noteDraft.value, 'new unsaved text')
  assert.equal(context.activeAnnotation.value.id, original.id)
  assert.equal(context.annotations.value[0].note, 'old')
  let release
  let started
  const writeStarted = new Promise(resolve => { started = resolve })
  context.getStorage = async () => ({ updateAnnotation: () => new Promise(resolve => { release = resolve; started() }) })
  const saving = save()
  await writeStarted
  context.noteDraft.value = 'newer text typed while saving'
  release()
  await saving
  assert.equal(context.activeAnnotation.value.id, original.id)
  assert.equal(context.annotations.value[0].note, 'new unsaved text')
  context.getStorage = async () => ({ updateAnnotation: async () => {} })
  await save()
  assert.equal(context.activeAnnotation.value, null)
  assert.equal(context.annotations.value[0].note, 'newer text typed while saving')
})

test('actual navigation rejects unknown sources, missing fragments and renderer failures without masking them', async () => {
  let anchor = () => null
  const doc = {}
  const context = vm.createContext({ view: {
    resolveNavigation: () => ({ index: 0, anchor }), book: { sections: [{}] },
    renderer: { goTo: async () => {}, getContents: () => [{ index: 0, doc }] },
  }, focusFlow: () => false })
  const navigate = actualFunction('navigateReader', context)
  await assert.rejects(navigate('missing-fragment'), /anchor unavailable/)
  anchor = () => 0 // EPUB chapter start is valid, not a missing anchor.
  await navigate('chapter-start')
  context.view.renderer.goTo = async () => { throw new Error('renderer failed') }
  await assert.rejects(navigate('source'), /renderer failed/)
  context.view.resolveNavigation = () => undefined
  await assert.rejects(navigate('unknown-source'), /Source unavailable/)
})

test('Dianjing source jumps require a real range/CFI and host inspection, never a direct section fallback', async () => {
  const source = readFileSync(new URL('../src/composables/useDianjing.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('useDianjing.ts', source, ts.ScriptTarget.Latest, true)
  let fn
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'goTo') fn = node
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(fn)
  const errors = []
  const targets = []
  let range = null
  let direct = 0
  const view = { getCFI: () => 'epubcfi(valid)', goTo: () => { direct++ } }
  const context = vm.createContext({
    view: () => view, engine: { rangeFor: async () => range },
    opts: { goToText: async target => { targets.push(target) } }, pendingFlash: null,
    t: key => key, toast: message => errors.push(message), Error,
  })
  const code = ts.transpileModule(fn.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText
  const goTo = vm.runInContext(`${code}\ngoTo`, context)
  const pos = { section: 0, block: 1, sentence: 1 }
  await goTo(pos)
  assert.equal(direct, 0)
  assert.equal(targets.length, 0)
  assert.deepEqual(errors, ['reader.cantGoto'])
  range = {}
  await goTo(pos)
  assert.deepEqual(targets, ['epubcfi(valid)'])
  context.opts.goToText = async () => { throw new Error('original unavailable') }
  await goTo(pos)
  assert.equal(errors.at(-1), 'original unavailable')
  assert.equal(context.pendingFlash, null)
  context.opts.goToText = undefined
  await goTo(pos)
  assert.equal(direct, 0)
  assert.equal(errors.at(-1), 'reader.cantGoto')
  view.getCFI = () => ''
  context.opts.goToText = async target => targets.push(target)
  await goTo(pos)
  assert.equal(targets.length, 1)
})

test('changed Vue SFC scripts and templates compile entirely in memory, without build/cache writes', () => {
  for (const file of ['../src/views/ReaderView.vue', '../src/components/DianjingCard.vue']) {
    const { descriptor, errors } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'), { filename: file })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: 'reader-unit-verification' })
    const result = compileTemplate({ source: descriptor.template.content, filename: file, id: 'reader-unit-verification', compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(result.errors, [])
  }
})
