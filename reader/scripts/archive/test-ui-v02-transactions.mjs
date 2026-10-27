import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { createPinia, setActivePinia } from 'pinia'
import { useSettings } from '../src/stores/settings.ts'
import { createDebouncedDraftSaver, loadNoteDraft, saveNoteDraft, MAX_STORED_DRAFTS } from '../src/services/noteDrafts.ts'

function adapter() {
  const data = new Map()
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), keys: () => [...data.keys()] }
}
function storeFixture() {
  const storage = adapter()
  globalThis.localStorage = storage
  setActivePinia(createPinia())
  const settings = useSettings()
  const payload = {
    bookId: 'synthetic-current', language: 'zh', scope: 'book', settings: { ...settings.getEffectiveTypography('synthetic-current', 'zh'), fontSize: 26 },
    readerPatch: { theme: settings.reader.theme, flow: settings.reader.flow, continuousScroll: settings.reader.continuousScroll, maxColumnCount: settings.reader.maxColumnCount, portraitScroll: settings.reader.portraitScroll, progressDisplay: settings.reader.progressDisplay },
    dim: settings.readingMode.eyeCare.dim,
  }
  return { storage, settings, payload }
}
function actualFunction(file, name, collaborators) {
  const { descriptor } = parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'))
  const source = ts.createSourceFile('script.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
  assert.ok(node, `Actual function ${name} must exist`)
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const context = vm.createContext({ ...collaborators })
  vm.runInContext(code, context)
  return context[name]
}
const ref = value => ({ value })

test('language default applies to current override but never overwrites another book', () => {
  const { settings, payload, storage } = storeFixture()
  settings.setBookTypography('synthetic-current', { fontSize: 31 })
  settings.setBookTypography('synthetic-other', { fontSize: 42, fontFamily: 'serif' })
  const other = JSON.stringify(settings.typographyBooks['synthetic-other'])
  settings.commitTypography({ ...payload, scope: 'language' })
  assert.equal(settings.getEffectiveTypography('synthetic-current', 'zh').fontSize, 26)
  assert.equal(settings.getEffectiveTypography('synthetic-new', 'zh').fontSize, 26)
  assert.equal(JSON.stringify(settings.typographyBooks['synthetic-other']), other)
  assert.equal(JSON.parse(storage.data.get('lightread-settings')).typographyLanguages.zh.fontSize, 26)
})

test('failed preference persistence changes neither memory state nor previous stored bytes', () => {
  const { settings, payload, storage } = storeFixture()
  storage.data.set('lightread-settings', 'previous-configuration')
  const before = JSON.stringify(settings.$state)
  storage.setItem = () => { const error = new Error('synthetic quota'); error.name = 'QuotaExceededError'; throw error }
  assert.throws(() => settings.commitTypography(payload), /synthetic quota/)
  assert.equal(JSON.stringify(settings.$state), before)
  assert.equal(storage.data.get('lightread-settings'), 'previous-configuration')
})

test('unknown language cannot modify Chinese defaults', () => {
  const { settings, payload } = storeFixture()
  settings.setLanguageTypography('zh', { fontSize: 24 })
  assert.throws(() => settings.commitTypography({ ...payload, language: '', scope: 'language' }))
  assert.equal(settings.typographyLanguages.zh.fontSize, 24)
})

test('restore-auto removes only the current book override', () => {
  const { settings, payload } = storeFixture()
  settings.setLanguageTypography('zh', { fontSize: 22 })
  settings.setBookTypography(payload.bookId, { fontSize: 40 })
  settings.setBookTypography('synthetic-other', { fontSize: 30 })
  settings.commitTypography({ ...payload, isRestoreAuto: true })
  assert.equal(settings.getEffectiveTypography(payload.bookId, 'zh').fontSize, 22)
  assert.equal(settings.getEffectiveTypography('synthetic-other', 'zh').fontSize, 30)
})

function panelFixture(applyTypography) {
  const { payload } = storeFixture()
  const events = []
  const draft = ref({ ...payload.settings, ...payload.readerPatch, scope: 'book', dim: payload.dim })
  const state = { applying: ref(false), applyError: ref(''), draft, props: { bookId: payload.bookId, applyTypography }, normLang: ref('zh'), initialResolved: ref(payload.settings), isRestoreAutoPreview: ref(false), t: key => key, toast() {}, emit: (...args) => events.push(args) }
  return { state, events, run: actualFunction('../src/components/TypographyPanel.vue', 'onApply', state) }
}

test('actual panel waits for exactly one host acknowledgement, locks duplicates and closes only after success', async () => {
  let calls = 0, release
  const fixture = panelFixture(() => { calls++; return new Promise(resolve => { release = resolve }) })
  const first = fixture.run()
  await fixture.run()
  assert.equal(calls, 1)
  assert.equal(fixture.state.applying.value, true)
  assert.equal(fixture.events.length, 0)
  release({ success: true })
  await first
  assert.equal(fixture.state.applying.value, false)
  assert.deepEqual(fixture.events.map(e => e[0]), ['close'])
})

test('actual panel retains draft and error on rejected host layout', async () => {
  const fixture = panelFixture(async () => ({ success: false, error: 'synthetic font failure' }))
  const before = JSON.stringify(fixture.state.draft.value)
  await fixture.run()
  assert.equal(fixture.state.applyError.value, 'synthetic font failure')
  assert.equal(fixture.state.applying.value, false)
  assert.equal(fixture.events.length, 0)
  assert.equal(JSON.stringify(fixture.state.draft.value), before)
})

test('actual note close flushes the final keystroke instead of cancelling its pending save', () => {
  const storage = adapter()
  const context = { bookId: 'synthetic-book', contextId: 'anno:synthetic-edit' }
  const saver = createDebouncedDraftSaver(context, { env: { storage }, delayMs: 60000 })
  saver.save('last keystroke')
  const preserve = actualFunction('../src/views/NotesView.vue', 'preserveEditing', { isSavingNote: ref(false), activeSaver: saver, editingStatus: ref('saving'), editingErrorMsg: ref('') })
  assert.equal(preserve(), true)
  assert.equal(loadNoteDraft(context, { storage }).draft.text, 'last keystroke')
})

test('actual note close cannot dismiss the only input copy after local write failure', () => {
  const storage = adapter()
  storage.setItem = () => { throw new Error('synthetic storage denied') }
  const saver = createDebouncedDraftSaver({ bookId: 'b', contextId: 'anno:a' }, { env: { storage }, delayMs: 60000 })
  saver.save('only copy')
  const editingStatus = ref('saving'), editingErrorMsg = ref('')
  const preserve = actualFunction('../src/views/NotesView.vue', 'preserveEditing', { isSavingNote: ref(false), activeSaver: saver, editingStatus, editingErrorMsg })
  assert.equal(preserve(), false)
  assert.equal(saver.getRecoverableText(), 'only copy')
  assert.equal(saver.isPending(), true)
  assert.equal(editingStatus.value, 'error')
  saver.cancel()
})

test('draft capacity rejects a new context without silently removing any existing text', () => {
  const storage = adapter()
  for (let i = 0; i < MAX_STORED_DRAFTS; i++) assert.equal(saveNoteDraft({ bookId: 'b', contextId: String(i) }, `text-${i}`, { storage }).success, true)
  const before = JSON.stringify([...storage.data])
  const rejected = saveNoteDraft({ bookId: 'b', contextId: 'new' }, 'new-input', { storage })
  assert.equal(rejected.success, false)
  assert.equal(rejected.error, 'capacity_reached')
  assert.equal(JSON.stringify([...storage.data]), before)
  assert.equal(saveNoteDraft({ bookId: 'b', contextId: '0' }, '', { storage }).success, true)
  assert.equal(loadNoteDraft({ bookId: 'b', contextId: '0' }, { storage }).draft.text, '')
})
