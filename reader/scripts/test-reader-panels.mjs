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
import { annotationIdForDraft, buildDraftKey, saveNoteDraft, loadNoteDraft, listDrafts, removeNoteDraft } from '../src/services/noteDrafts.ts'

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
function noteContext(values) {
  const data = new Map()
  let context
  const env = { storage: {
    keys: () => [...data.keys()], getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (context.failDraftWrite) throw Object.assign(new Error('synthetic quota'), { name: 'QuotaExceededError' }); data.set(key, value) },
    removeItem: key => { if (context.failDraftCleanup) throw new Error('synthetic cleanup failure'); data.delete(key) },
  } }
  context = vm.createContext({
    annotationIdForDraft, crypto: globalThis.crypto, localDraftError: ref(''), noteWriteUnconfirmed: ref(false), annotationRecoveryNotice: ref(''), noteDraftSaver: null, noteSaving: ref(false),
    saveNoteDraft: (ctx, text) => saveNoteDraft(ctx, text, env), loadNoteDraft: ctx => loadNoteDraft(ctx, env),
    listDrafts: bookId => listDrafts(bookId, env), removeNoteDraft: ctx => removeNoteDraft(ctx, env),
    failDraftCleanup: false, draftData: data, captureNoteDraft() {}, ...values,
  })
  if (!context.preserveReaderNote) context.preserveReaderNote = actualFunction('preserveReaderNote', context)
  return context
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

test('PW-02 opening an idea editor does not write or draw a highlight before Save', async () => {
  const writes = []
  const context = noteContext({
    selection: ref({ cfi: 'synthetic-location', text: 'synthetic quotation' }), highlightSaving: false,
    bookId: 'synthetic-book', noteDraft: ref(''), activeAnnotation: ref(null), annotations: ref([]),
    getStorage: async () => ({ addAnnotation: async rec => { writes.push(rec); return 'new-note' } }),
    view: { addAnnotation() { assert.fail('draft must not be drawn as a committed highlight') } },
    t: key => key, toast() {}, Date,
  })
  await actualFunction('addHighlight', context)('yellow', true)
  assert.equal(writes.length, 0)
  assert.equal(context.annotations.value.length, 0)
  assert.equal(context.activeAnnotation.value.cfi, 'synthetic-location')
  assert.equal(context.activeAnnotation.value.id, undefined)
  context.preserveReaderNote = () => true
  assert.equal(actualFunction('closeAnnotation', context)(), true)
  assert.equal(context.activeAnnotation.value, null)
  assert.equal(writes.length, 0, 'closing an unsaved idea must not leave a highlight')
})

test('PW-02 saving a new idea writes the quote and note once, then clears only its selection draft', async () => {
  const writes = [], cleared = [], drawn = []
  const context = noteContext({
    activeAnnotation: ref({ bookId: 'synthetic-book', kind: 'highlight', cfi: 'synthetic-location', text: 'quote', color: 'yellow', createdAt: 1 }),
    bookId: 'synthetic-book', noteDraft: ref('new idea'), noteSaving: ref(false), annotations: ref([]),
    readerContext: createReaderContext(), t: key => key, toast() {},
    getStorage: async () => ({ addAnnotation: async rec => { writes.push(rec); return rec.id }, updateAnnotation: async () => assert.fail('unsaved idea is not an existing annotation') }),
    removeNoteDraft: ctx => { cleared.push(ctx.contextId); return { success: true } },
    view: { addAnnotation: rec => drawn.push(rec) }, captureNoteDraft() {},
  })
  const save = actualFunction('saveNote', context)
  await Promise.all([save(), save()])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].text, 'quote')
  assert.equal(writes[0].note, 'new idea')
  assert.equal(writes[0].id, await annotationIdForDraft({ bookId: 'synthetic-book', contextId: 'sel:synthetic-location' }))
  assert.equal('draftContextId' in writes[0], false, 'editor-only state must not leak into persisted annotations')
  assert.equal(context.annotations.value[0].id, writes[0].id)
  assert.equal(context.activeAnnotation.value, null)
  assert.deepEqual(cleared, ['sel:synthetic-location'])
  assert.equal(drawn.length, 1)
})

test('PW-02 a failed new-idea save preserves the editor, input and uncommitted status', async () => {
  const context = noteContext({
    activeAnnotation: ref({ bookId: 'synthetic-book', kind: 'highlight', cfi: 'synthetic-location', text: 'quote', color: 'yellow', createdAt: 1 }),
    bookId: 'synthetic-book', noteDraft: ref('recoverable input'), noteSaving: ref(false), annotations: ref([]),
    readerContext: createReaderContext(), t: key => key, toast() {},
    getStorage: async () => ({ addAnnotation: async () => { throw new Error('quota') } }),
    removeNoteDraft: () => assert.fail('failed write must not clear its draft'),
  })
  await actualFunction('saveNote', context)()
  assert.equal(context.activeAnnotation.value.id, undefined)
  assert.equal(context.noteDraft.value, 'recoverable input')
  assert.equal(context.annotations.value.length, 0)
  assert.equal(context.noteSaving.value, false)
})

test('actual saveNote retains text/editor on write failure and only closes the committed unchanged draft', async () => {
  const original = { id: 'generated-note', cfi: 'generated-location', note: 'old' }
  const context = noteContext({
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

test('selection draft identities are stable, book-scoped, bounded and reject unsupported contexts', async () => {
  const ctx = { bookId: 'b1', contextId: 'sel:synthetic-token' }
  const id = await annotationIdForDraft(ctx)
  assert.equal(id, await annotationIdForDraft({ ...ctx }))
  assert.notEqual(id, await annotationIdForDraft({ ...ctx, bookId: 'b2' }))
  assert.notEqual(id, await annotationIdForDraft({ ...ctx, contextId: 'sel:another-token' }))
  assert.match(await annotationIdForDraft({ ...ctx, contextId: `sel:${'x'.repeat(4096)}` }), /^draft-note:[a-f0-9]{64}$/)
  await assert.rejects(annotationIdForDraft({ ...ctx, contextId: 'anno:a1' }), /Invalid/)
  await assert.rejects(annotationIdForDraft({ ...ctx, bookId: '' }), /Invalid/)
})

test('PW-02 cleanup failure and subsequent draft recovery never insert a second annotation', async () => {
  const rows = new Map()
  let generated = 0
  const original = { bookId: 'synthetic-book', cfi: 'synthetic-location', text: 'quote', color: 'yellow', createdAt: 1, draftContextId: 'sel:synthetic-token' }
  const context = noteContext({
    bookId: original.bookId, activeAnnotation: ref({ ...original }), noteDraft: ref('thought'), noteSaving: ref(false), annotations: ref([]),
    readerContext: createReaderContext(), t: key => key, toast() {}, view: { addAnnotation() {} },
    getStorage: async () => ({
      addAnnotation: async rec => { const id = rec.id ?? `generated-${++generated}`; rows.set(id, { ...rec, id }); return id },
      updateAnnotation: async (id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
    }),
  })
  context.saveNoteDraft({ bookId: original.bookId, contextId: original.draftContextId, quote: original.text, sourceLoc: original.cfi }, 'thought')
  context.failDraftCleanup = true
  const save = actualFunction('saveNote', context)
  await save()
  assert.equal(rows.size, 1)
  context.activeAnnotation.value = { ...original }
  context.failDraftCleanup = false
  await save()
  assert.equal(rows.size, 1, 'recovered selection draft must update/upsert its acknowledged identity')
  assert.equal([...rows.values()][0].note, 'thought')
  assert.equal(context.draftData.size, 0)
})

test('PW-02 clearing an existing note sends an explicit empty value to native storage', async () => {
  let persisted = 'old thought'
  const context = noteContext({
    bookId: 'synthetic-book', activeAnnotation: ref({ id: 'note-1', cfi: 'synthetic-location', note: persisted }),
    noteDraft: ref(''), noteSaving: ref(false), annotations: ref([]), readerContext: createReaderContext(), t: key => key, toast() {},
    getStorage: async () => ({ updateAnnotation: async (_id, patch) => { if (patch.note !== undefined) persisted = patch.note } }),
  })
  await actualFunction('saveNote', context)()
  assert.equal(persisted, '')
})

test('PW-02 a lost write receipt reuses the persisted draft identity on explicit retry', async () => {
  const rows = new Map()
  let failReceipt = true
  const context = noteContext({
    bookId: 'b1', activeAnnotation: ref({ bookId: 'b1', cfi: 'synthetic-location', text: 'quote', color: 'yellow', createdAt: 1, draftContextId: 'sel:receipt-token' }),
    noteDraft: ref('first input'), noteSaving: ref(false), annotations: ref([]), readerContext: createReaderContext(), t: key => key, toast() {}, view: { addAnnotation() {} },
    getStorage: async () => ({ addAnnotation: async rec => { rows.set(rec.id, { ...rec }); if (failReceipt) { failReceipt = false; throw new Error('synthetic lost receipt') }; return rec.id } }),
  })
  const save = actualFunction('saveNote', context)
  await save()
  assert.equal(rows.size, 1)
  assert.equal(context.noteDraft.value, 'first input')
  assert.equal(context.activeAnnotation.value.id, undefined, 'an error must not be called an acknowledged write')
  assert.equal(context.noteWriteUnconfirmed.value, true)
  assert.equal(context.draftData.size, 1)
  context.noteDraft.value = 'newer input before retry'
  await save()
  assert.equal(rows.size, 1)
  assert.equal([...rows.values()][0].note, 'newer input before retry')
  assert.equal(context.activeAnnotation.value, null)
  assert.equal(context.noteWriteUnconfirmed.value, false)
})

test('PW-02 unavailable draft storage stops an untracked new write and preserves input', async () => {
  const context = noteContext({
    bookId: 'b1', activeAnnotation: ref({ bookId: 'b1', cfi: 'synthetic-location', text: 'quote', color: 'yellow', createdAt: 1, draftContextId: 'sel:quota-token' }),
    noteDraft: ref('recoverable input'), noteSaving: ref(false), annotations: ref([]), readerContext: createReaderContext(), t: key => key, toast() {},
    getStorage: async () => ({ addAnnotation: async () => assert.fail('identity must be recoverable before a new write') }), failDraftWrite: true,
  })
  await actualFunction('saveNote', context)()
  assert.equal(context.noteDraft.value, 'recoverable input')
  assert.equal(context.activeAnnotation.value.id, undefined)
  assert.equal(context.noteSaving.value, false)
  assert.notEqual(context.localDraftError.value, '')
})

test('PW-02 cross-page selection recovery opens the exact draft without selecting text again', async () => {
  const targets = [], errors = []
  const context = noteContext({
    bookId: 'b1', activeAnnotation: ref(null), noteDraft: ref(''), annotations: ref([]), readerContext: createReaderContext(), Date,
    navigateReader: async target => targets.push(target), closeOverlays: () => true, t: key => key, toast: text => errors.push(text),
  })
  const draft = { bookId: 'b1', contextId: 'sel:recovery-token', quote: 'quote', sourceLoc: 'epubcfi(/6/2)' }
  context.saveNoteDraft(draft, 'recover this thought')
  const restore = actualFunction('restoreSelectionDraft', context)
  await restore(draft.contextId)
  assert.equal(context.noteDraft.value, 'recover this thought')
  assert.equal(context.activeAnnotation.value.cfi, draft.sourceLoc)
  assert.equal(context.activeAnnotation.value.id, undefined)
  assert.deepEqual(targets, [draft.sourceLoc])
  const id = await annotationIdForDraft(draft)
  context.annotations.value.push({ id, bookId: 'b1', cfi: draft.sourceLoc, text: draft.quote, note: 'committed', color: 'blue', createdAt: 1 })
  context.activeAnnotation.value = null
  await restore(draft.contextId)
  assert.equal(context.activeAnnotation.value.id, id)
  assert.equal(context.activeAnnotation.value.color, 'blue')
  assert.equal(context.noteDraft.value, 'recover this thought')
  context.activeAnnotation.value = null
  context.bookId = 'b2'
  await restore(draft.contextId)
  assert.equal(context.activeAnnotation.value, null)
  assert.equal(errors.at(-1), 'reader.draftRestoreFailed')
  assert.equal(context.loadNoteDraft(draft).success, true, 'failed or foreign-book restore must retain the original payload')
})

test('PW-02 delayed draft navigation cannot replace a newer editor', async () => {
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const context = noteContext({
    bookId: 'b1', activeAnnotation: ref(null), noteDraft: ref('new editor input'), annotations: ref([]), readerContext: createReaderContext(), Date,
    navigateReader: () => new Promise(resolve => { release = resolve; started() }), closeOverlays: () => assert.fail('newer editor must not close'), t: key => key, toast() {},
  })
  context.saveNoteDraft({ bookId: 'b1', contextId: 'sel:delayed-token', quote: 'quote', sourceLoc: 'epubcfi(/6/2)' }, 'old draft')
  const restoring = actualFunction('restoreSelectionDraft', context)('sel:delayed-token')
  await ready
  context.activeAnnotation.value = { id: 'newer-editor' }
  release()
  await restoring
  assert.equal(context.activeAnnotation.value.id, 'newer-editor')
  assert.equal(context.noteDraft.value, 'new editor input')
})

test('PW-02 a later intentional idea at the same selection retains a distinct identity', async () => {
  const rows = new Map()
  const context = noteContext({
    bookId: 'b1', selection: ref(null), highlightSaving: false, activeAnnotation: ref(null), noteDraft: ref(''), noteSaving: ref(false), annotations: ref([]), readerContext: createReaderContext(), Date,
    t: key => key, toast() {}, view: { addAnnotation() {} },
    getStorage: async () => ({ addAnnotation: async rec => { rows.set(rec.id, { ...rec }); return rec.id } }),
  })
  const add = actualFunction('addHighlight', context), save = actualFunction('saveNote', context)
  const identities = []
  for (const text of ['first thought', 'second thought']) {
    context.selection.value = { cfi: 'synthetic-location', text: 'quote' }
    await add('yellow', true)
    identities.push(context.activeAnnotation.value.draftContextId)
    context.noteDraft.value = text
    await save()
  }
  assert.notEqual(identities[0], identities[1])
  assert.equal(rows.size, 2)
  assert.deepEqual([...rows.values()].map(row => row.note), ['first thought', 'second thought'])
})

test('PW-02 checking saved notes respects the draft checkpoint and never clears input itself', async () => {
  const paths = [], errors = []
  const context = noteContext({
    bookId: 'b1', activeAnnotation: ref({ id: 'note-1' }), noteDraft: ref('recoverable input'),
    preserveReaderNote: () => false, router: { push: async path => paths.push(path) }, t: key => key, toast: message => errors.push(message),
  })
  const inspect = actualFunction('inspectSavedNotes', context)
  await inspect()
  assert.equal(paths.length, 0)
  context.preserveReaderNote = () => true
  await inspect()
  assert.equal(paths[0].path, '/notes')
  assert.equal(paths[0].query.bookId, 'b1')
  context.router.push = async () => { throw new Error('synthetic navigation failure') }
  await inspect()
  assert.equal(errors.at(-1), 'reader.sourceUnavailable')
  assert.equal(context.noteDraft.value, 'recoverable input')
  assert.equal(context.activeAnnotation.value.id, 'note-1')
})

test('PW-02/R4 scoped enumeration never reads another book payload, while local/global failures stay errors', () => {
  const data = new Map(), reads = []
  const storage = { keys: () => [...data.keys()], getItem: key => { reads.push(key); return data.get(key) ?? null }, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  const env = { storage }
  saveNoteDraft({ bookId: 'b1', contextId: 'sel:good' }, 'current draft', env)
  const foreign = buildDraftKey('b2', 'sel:broken')
  data.set(foreign, '{SYNTHETIC BROKEN JSON')
  reads.length = 0
  assert.equal(listDrafts('b1', env)[0].text, 'current draft')
  assert.equal(reads.includes(foreign), false, 'book ownership must be checked before accessing foreign contents')
  assert.throws(() => listDrafts('b2', env), /无法解析/)
  assert.throws(() => listDrafts(undefined, env), /无法解析/)
  assert.throws(() => listDrafts('b1', { storage: { ...storage, getItem: () => { throw new Error('SYNTHETIC READ UNAVAILABLE') } } }), /READ UNAVAILABLE/)
  assert.equal(data.get(foreign), '{SYNTHETIC BROKEN JSON')
})

test('PW-02/R4 enumeration errors are visible and preserve selection/input without allocating a new draft', async () => {
  for (const mode of ['corrupt', 'unavailable']) {
    const errors = []
    let allocated = 0
    const context = noteContext({
      bookId: 'b1', selection: ref({ cfi: 'synthetic-location', text: 'quote' }), highlightSaving: false,
      activeAnnotation: ref(null), noteDraft: ref('previous recoverable input'), annotations: ref([]), Date,
      crypto: { randomUUID: () => { allocated++; return 'unexpected-new-identity' } },
      t: key => key, toast: message => errors.push(message), getStorage: () => assert.fail('enumeration failure must not write'),
    })
    if (mode === 'corrupt') context.draftData.set(buildDraftKey('b1', 'sel:broken'), '{SYNTHETIC BROKEN JSON')
    else context.listDrafts = () => { throw new Error('SYNTHETIC STORAGE UNAVAILABLE') }
    await assert.doesNotReject(actualFunction('addHighlight', context)('yellow', true))
    assert.equal(context.activeAnnotation.value, null)
    assert.equal(context.selection.value.cfi, 'synthetic-location')
    assert.equal(context.noteDraft.value, 'previous recoverable input')
    assert.equal(allocated, 0)
    assert.equal(errors[0], 'reader.ideaDraftUnavailable')
    assert.equal(context.localDraftError.value, errors[0])
  }
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

test('PagewiseCompanion source jumps require a real range/CFI and host inspection, never a direct section fallback', async () => {
  const source = readFileSync(new URL('../src/composables/usePagewiseCompanion.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('usePagewiseCompanion.ts', source, ts.ScriptTarget.Latest, true)
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
  for (const file of ['../src/views/ReaderView.vue', '../src/components/PagewiseCompanionCard.vue']) {
    const { descriptor, errors } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'), { filename: file })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: 'reader-unit-verification' })
    const result = compileTemplate({ source: descriptor.template.content, filename: file, id: 'reader-unit-verification', compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(result.errors, [])
  }
})
