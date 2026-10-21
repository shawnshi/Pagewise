// Production composable + real Vue reactivity; all transport/engine data is synthetic.
// node --test scripts/test-companion-lifecycle.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import * as companionCompatibility from '../src/services/PagewiseCompanion/compatibility.ts'
import { isSelectableAiProvider } from '../src/services/aiProviders.ts'

const source = process.env.COMPANION_COMPOSABLE_SOURCE
  ? readFileSync(process.env.COMPANION_COMPOSABLE_SOURCE, 'utf8')
  : readFileSync(new URL('../src/composables/usePagewiseCompanion.ts', import.meta.url), 'utf8')
function load(code, dependencies = {}) {
  const exports = {}
  const compiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(compiled, {
    exports, AbortController, Error,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`)
      return dependencies[id]
    },
  })
  return exports
}
const level = load(readFileSync(new URL('../src/services/PagewiseCompanion/level.ts', import.meta.url), 'utf8'), {
  './compatibility.ts': companionCompatibility,
})

function fixture(t, initial = {}) {
  const settings = vue.reactive({
    language: 'zh', aiProvider: 'deepseek', aiBaseUrl: 'https://synthetic.invalid/v1', aiApiKey: 'synthetic-key', aiModel: 'synthetic',
    pagewiseCompanion: {
      level: 'smart', enabled: true, consentAll: true, perBook: {}, channel: 'own',
      density: 'normal', kinds: { key: true, term: true, note: true }, fiction: {},
    },
  })
  if (initial.disabled) settings.pagewiseCompanion.enabled = false
  if (initial.unconfigured) settings.aiApiKey = ''
  const view = vue.reactive({ isFixedLayout: !!initial.fixed })
  const suppressed = vue.ref(false)
  const calls = []
  class Engine {
    constructor(host) { this.host = host }
    active = false
    sections = new Map()
    starts = 0
    disposals = 0
    start() { this.active = true; this.starts++ }
    stop() { this.active = false }
    dispose() { this.stop(); this.disposals++ }
    attach() {}
    repaint() {}
    refreshFiction() {}
    resetErrors() {}
  }
  const { usePagewiseCompanion } = load(source, {
    vue,
    '../stores/settings': { useSettings: () => settings },
    '../i18n': { t: key => key },
    '../services/toast': { toast: () => {} },
    '../services/ai': { aiConfigured: () => isSelectableAiProvider(settings.aiProvider) && !!settings.aiApiKey && !!settings.aiBaseUrl && !!settings.aiModel },
    '../services/PagewiseCompanion/engine': { PagewiseCompanion: Engine },
    '../services/PagewiseCompanion/client': {
      streamPagewiseCompanion(request, channel, onItem, signal) {
        return new Promise((resolve, reject) => {
          calls.push({ request, channel, signal, emit: onItem,
            finish: () => resolve({ model: 'synthetic', good: 1, bad: 0 }), fail: reject,
          })
        })
      },
    },
    '../services/PagewiseCompanion/theme': { companionColors: () => ({}) },
    '../services/PagewiseCompanion/protocol': {},
    '../services/PagewiseCompanion/cache': { getCompanionCache: () => { throw Error('Cache access forbidden') } },
    '../services/PagewiseCompanion/level': level,
  })
  const scope = vue.effectScope()
  const dj = scope.run(() => usePagewiseCompanion({
    bookId: 'synthetic-book', getView: () => view,
    getMeta: () => ({ title: 'Synthetic source', language: 'en' }),
    getThemeName: () => 'paper', presentationSuppressed: () => suppressed.value,
  }))
  t.after(() => scope.stop())
  const target = () => ({
    section: 0, item: { id: 'synthetic-key', block: 0, sentence: 0 }, text: 'Synthetic sentence.',
    range: { getBoundingClientRect: () => ({ left: 10, top: 20, right: 80, bottom: 40 }), startContainer: {} },
  })
  const open = (value = target()) => { dj.openKeyCard(value); return value }
  return { dj, settings, view, suppressed, calls, scope, open, target }
}
test('retired saved AI providers do not throw or fall through to the trial companion channel', t => {
  const f = fixture(t)
  for (const id of ['trial', 'siliconflow', 'custom', 'unknown']) {
    f.settings.aiProvider = id
    for (const channel of ['own', 'auto', 'builtin']) {
      f.settings.pagewiseCompanion.channel = channel
      assert.equal(f.dj.engine.host.channel(), null)
    }
  }
  assert.equal(f.calls.length, 0)
})

test('legacy builtin consent cannot silently authorize an own-key service, but can be renewed explicitly', async t => {
  const f = fixture(t)
  f.settings.pagewiseCompanion.channel = 'builtin'
  f.settings.pagewiseCompanion.perBook['another-book'] = true
  assert.equal(f.dj.engine.host.channel(), null)
  assert.equal(f.dj.active.value, false)
  assert.equal(f.calls.length, 0)
  f.dj.toggle()
  assert.equal(f.dj.consentOpen.value, true)
  assert.equal(f.settings.pagewiseCompanion.channel, 'builtin')
  f.dj.consent('book')
  assert.equal(f.settings.pagewiseCompanion.channel, 'own')
  assert.equal(f.settings.pagewiseCompanion.consentAll, false)
  assert.equal(f.settings.pagewiseCompanion.perBook['synthetic-book'], true)
  assert.equal(f.settings.pagewiseCompanion.perBook['another-book'], undefined)
  assert.equal(f.dj.engine.host.channel().baseUrl, 'https://synthetic.invalid/v1')
})

test('adding or denying a strict per-book authorization updates the mounted reactive active flag', t => {
  const f = fixture(t, { disabled: true })
  f.settings.pagewiseCompanion.consentAll = false
  assert.equal(f.dj.active.value, false)
  f.settings.pagewiseCompanion.perBook['synthetic-book'] = true
  assert.equal(f.dj.active.value, true)
  f.settings.pagewiseCompanion.perBook['synthetic-book'] = false
  assert.equal(f.dj.active.value, false)
})

const row = text => ({ t: 'tr', s: '1.1', text })
const finish = async (call, pending, text = 'Synthetic translation') => {
  call.emit(row(text)); call.finish(); await pending
}

for (const [name, cancel] of [
  ['close', f => f.dj.closeCard()],
  ['close overlays', f => f.dj.closeOverlays()],
  ['target replacement', f => f.open()],
  ['direct card replacement', f => { f.dj.card.value = { target: f.target(), rect: {} } }],
  ['disable', f => { f.settings.pagewiseCompanion.enabled = false }],
  ['switch to basic', f => f.dj.setLevel('basic')],
  ['presentation suppression', f => { f.suppressed.value = true }],
  ['unsupported', f => { f.dj.supported.value = false }],
  ['scope disposal', f => f.scope.stop()],
  ['explicit disposal', f => f.dj.dispose()],
]) {
  test(`lifecycle: ${name} aborts immediately and ignores late output/failure`, async t => {
    const f = fixture(t)
    f.open()
    const pending = f.dj.translate()
    const call = f.calls[0]
    assert.ok(call.signal instanceof AbortSignal, 'Fourth transport argument must be an AbortSignal')
    assert.equal(call.signal.aborted, false)
    cancel(f)
    assert.equal(call.signal.aborted, true, `${name} must cancel without waiting for a Vue tick`)
    const after = f.dj.card.value
    assert.doesNotThrow(() => call.emit({ t: 'tr', s: '9.9', text: 'Late invalid output' }))
    call.fail(new Error('Synthetic abort rejection'))
    await pending
    await vue.nextTick()
    assert.equal(f.dj.card.value, after, 'Canceled finalizer cannot touch current card')
    assert.notEqual(f.dj.card.value?.translateError, true)
    assert.equal(f.calls.length, 1, 'No automatic retry')
  })
}

test('deduplicates same-tick and later-tick clicks and does not retranslate success', async t => {
  const f = fixture(t); f.open()
  const pending = f.dj.translate()
  await f.dj.translate(); await vue.nextTick(); await f.dj.translate()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].request.text, '[1.1] Synthetic sentence.')
  await finish(f.calls[0], pending)
  assert.equal(f.dj.card.value.translation, 'Synthetic translation')
  assert.equal(f.dj.card.value.translateError, false)
  assert.equal(f.dj.card.value.translating, false)
  await f.dj.translate()
  assert.equal(f.calls.length, 1)
})

for (const outcome of ['resolve', 'reject']) {
  test(`same CardTarget reopened: old ${outcome}/callbacks cannot update newer generation`, async t => {
    const f = fixture(t); const target = f.open()
    const old = f.dj.translate()
    f.dj.closeCard(); f.open(target)
    const current = f.dj.translate()
    const currentCard = f.dj.card.value
    assert.equal(f.calls.length, 2)
    assert.doesNotThrow(() => f.calls[0].emit(row('Obsolete translation')))
    assert.doesNotThrow(() => f.calls[0].emit(row('Obsolete duplicate')))
    if (outcome === 'resolve') f.calls[0].finish()
    else f.calls[0].fail(new Error('Obsolete error'))
    await old
    assert.equal(f.dj.card.value, currentCard)
    assert.equal(f.dj.card.value.translating, true)
    await finish(f.calls[1], current, 'Current generation')
    assert.equal(f.dj.card.value.translation, 'Current generation')
    assert.equal(f.dj.card.value.translateError, false)
  })
}

test('same target reopened without retry remains untouched by old successful finalizer', async t => {
  const f = fixture(t); const target = f.open()
  const old = f.dj.translate()
  f.dj.closeCard(); f.open(target)
  const reopened = f.dj.card.value
  await finish(f.calls[0], old, 'Obsolete')
  assert.equal(f.dj.card.value, reopened)
  assert.equal(f.dj.card.value.translation, undefined)
})

for (const [name, prepare] of [
  ['disabled', f => { f.settings.pagewiseCompanion.enabled = false }],
  ['unsupported', f => { f.dj.supported.value = false }],
  ['fixed layout', f => { f.view.isFixedLayout = true; f.dj.onSectionLoad({ doc: {}, index: 0 }) }],
  ['suppressed', f => { f.suppressed.value = true }],
  ['disposed', f => f.dj.dispose()],
  ['stopped scope', f => f.scope.stop()],
]) {
  test(`blocked calls: ${name} sends nothing`, async t => {
    const f = fixture(t); f.open(); prepare(f)
    // Do not await a potentially erroneous synthetic request before inspecting call count.
    const pending = f.dj.translate()
    assert.equal(f.calls.length, 0)
    await pending
  })
}

test('initial fixed layout and unconfigured own channel send nothing', async t => {
  for (const initial of [{ fixed: true }, { unconfigured: true }]) {
    const f = fixture(t, initial); f.open()
    const pending = f.dj.translate()
    assert.equal(f.calls.length, 0)
    await pending
  }
})

test('disable then re-enable in same tick cancels, sends no automatic retry, allows explicit retry', async t => {
  const f = fixture(t); f.open()
  const old = f.dj.translate()
  f.settings.pagewiseCompanion.enabled = false
  f.settings.pagewiseCompanion.enabled = true
  await vue.nextTick()
  assert.equal(f.calls[0].signal?.aborted, true)
  assert.equal(f.dj.card.value.translating, false)
  assert.equal(f.calls.length, 1)
  const retry = f.dj.translate()
  assert.equal(f.calls.length, 2)
  f.calls[0].fail(new Error('Abort'))
  await old
  assert.equal(f.dj.card.value.translating, true)
  await finish(f.calls[1], retry)
})

for (const [name, rows] of [
  ['invalid reference', [{ t: 'tr', s: '2.1', text: 'Wrong reference' }]],
  ['duplicate', [row('Partial'), row('Duplicate')]],
  ['empty text', [row('   ')]],
  ['non-string text', [row(123)]],
  ['empty result', []],
  ['unrelated rows only', [{ t: 'sum', text: 'Not a translation' }]],
]) {
  test(`validation: ${name} is visible failure and explicit retry succeeds`, async t => {
    const f = fixture(t); f.open()
    const pending = f.dj.translate()
    const call = f.calls[0]
    let error
    try { for (const raw of rows) call.emit(raw) } catch (e) { error = e }
    if (error) call.fail(error)
    else call.finish()
    await pending
    assert.equal(f.dj.card.value.translating, false)
    assert.equal(f.dj.card.value.translateError, true)
    if (error) assert.equal(f.dj.card.value.translateFailure, error)
    if (name === 'duplicate') assert.equal(f.dj.card.value.translation, 'Partial')
    await vue.nextTick()
    assert.equal(f.calls.length, 1)
    const retry = f.dj.translate()
    assert.equal(f.calls.length, 2)
    assert.equal(f.dj.card.value.translateError, false)
    assert.equal(f.dj.card.value.translateFailure, undefined)
    assert.doesNotThrow(() => call.emit({ t: 'tr', s: '9.9', text: 'Late old callback' }))
    await finish(f.calls[1], retry, 'Recovered')
    assert.equal(f.dj.card.value.translation, 'Recovered')
    assert.equal(f.dj.card.value.translateError, false)
  })
}

test('partial output plus real transport error stays visible with exact error and retries', async t => {
  const f = fixture(t); f.open()
  const pending = f.dj.translate()
  const error = new Error('Synthetic broken stream')
  f.calls[0].emit({ t: 'tr', s: '[1.1]', text: '  Partial output  ' })
  f.calls[0].fail(error)
  await pending
  assert.equal(f.dj.card.value.translation, 'Partial output')
  assert.equal(f.dj.card.value.translateError, true)
  assert.equal(f.dj.card.value.translateFailure, error)
  const retry = f.dj.translate()
  assert.equal(f.calls.length, 2)
  await finish(f.calls[1], retry, 'Complete output')
  assert.equal(f.dj.card.value.translation, 'Complete output')
  assert.equal(f.dj.card.value.translateFailure, undefined)
})

for (const partial of [false, true]) {
  test(`real ReaderView source context restores a retryable card after cancellation (partial=${partial})`, async t => {
    const f = fixture(t); f.open()
    const originalError = new Error('Original partial-stream failure')
    if (partial) {
      const first = f.dj.translate()
      f.calls[0].emit(row('Partial source translation'))
      f.calls[0].fail(originalError); await first
    }
    const pending = f.dj.translate()
    const call = f.calls.at(-1)
    const viewSource = readFileSync(new URL('../src/views/ReaderView.vue', import.meta.url), 'utf8')
    const script = viewSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    const tree = ts.createSourceFile('ReaderView.ts', script, ts.ScriptTarget.Latest, true)
    const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sourceContext')
    assert.ok(fn)
    const code = ts.transpileModule(fn.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const context = vm.createContext({ dj: f.dj, panel: vue.ref('none'), panelEl: vue.ref(null), closeOverlays: f.dj.closeOverlays, nextTick: vue.nextTick })
    const saved = vm.runInContext(`${code}\nsourceContext`, context)()
    f.dj.closeOverlays()
    await saved.restore()
    assert.equal(f.dj.card.value.translating, false, 'Inspection return must not restore a request-owned busy flag')
    assert.equal(call.signal.aborted, true)
    if (partial) {
      assert.equal(f.dj.card.value.translation, 'Partial source translation')
      assert.equal(f.dj.card.value.translateError, true, 'Canceled retry must not promote partial text to success')
      assert.equal(f.dj.card.value.translateFailure, originalError)
    }
    call.fail(new Error('Late canceled response')); await pending
    const beforeRetry = f.calls.length
    const retry = f.dj.translate()
    assert.equal(f.calls.length, beforeRetry + 1, 'Restored card remains explicitly retryable')
    await finish(f.calls.at(-1), retry, 'Complete after returning')
  })
}

test('canceling a retry restores the previous partial/error state, not a false success', async t => {
  const f = fixture(t); f.open()
  const first = f.dj.translate(), originalError = new Error('Preserve this real failure')
  f.calls[0].emit(row('Partial output')); f.calls[0].fail(originalError); await first
  const retry = f.dj.translate()
  f.settings.pagewiseCompanion.enabled = false
  assert.equal(f.dj.card.value.translating, false)
  assert.equal(f.dj.card.value.translateError, true)
  assert.equal(f.dj.card.value.translateFailure, originalError)
  f.calls[1].fail(new Error('Canceled retry')); await retry
})

test('retry after ordinary transport rejection and disposal are idempotent', async t => {
  const f = fixture(t); f.open()
  const pending = f.dj.translate()
  const error = new Error('Synthetic offline')
  f.calls[0].fail(error); await pending
  assert.equal(f.dj.card.value.translateError, true)
  assert.equal(f.dj.card.value.translateFailure, error)
  const retry = f.dj.translate()
  await finish(f.calls[1], retry)
  f.dj.dispose(); f.dj.dispose(); f.scope.stop()
  assert.equal(f.dj.engine.disposals, 1)
  const starts = f.dj.engine.starts
  f.settings.pagewiseCompanion.enabled = false; await vue.nextTick()
  f.settings.pagewiseCompanion.enabled = true; await vue.nextTick()
  assert.equal(f.dj.engine.starts, starts, 'Disposed engine cannot restart via live watchers')
  await f.dj.translate()
  assert.equal(f.calls.length, 2)
})
