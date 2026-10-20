import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import vm from 'node:vm'
import ts from 'typescript'
import { useSettings, settingsDefaults } from '../src/stores/settings.ts'
import { companionManualFile, readCompanionPreferences, serializeCompanionSettings } from '../src/services/PagewiseCompanion/compatibility.ts'
import { DB_NAME, createMemoryCache, cacheKey, sectionKey, feedbackKey } from '../src/services/PagewiseCompanion/cache.ts'
import { applyCompanionAction, migrateLevel, smartOnFor } from '../src/services/PagewiseCompanion/level.ts'
import { PROMPT_VERSION } from '../src/services/PagewiseCompanion/prompt.ts'
import relay from '../relay/src/index.js'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'

const file = name => new URL(name, import.meta.url)
function parseFixture(raw) {
  try { return JSON.parse(raw) }
  catch (error) { assert.fail(`Invalid fixture JSON: ${error.message}`) }
}

test('canonical module, composable and components replace internal old paths', () => {
  for (const name of ['Card', 'ChapterCard', 'Consent', 'Outline', 'Skim', 'Status', 'Toggle']) {
    assert.ok(existsSync(file(`../src/components/PagewiseCompanion${name}.vue`)))
    assert.equal(existsSync(file(`../src/components/Dianjing${name}.vue`)), false)
  }
  assert.ok(existsSync(file('../src/composables/usePagewiseCompanion.ts')))
  assert.equal(existsSync(file('../src/composables/useDianjing.ts')), false)
  assert.equal(existsSync(file('../src/services/dianjing')), false)
  assert.match(readFileSync(file('../src/services/PagewiseCompanion/engine.ts'), 'utf8'), /export class PagewiseCompanion\s*\{/)
})

test('existing offline cache namespace, key layout and records survive branding changes', async () => {
  assert.equal(DB_NAME, 'lightread-dianjing')
  assert.equal(PROMPT_VERSION, 'dj3')
  const key = cacheKey('synthetic-book', 2, 'content-hash', 'synthetic-model', 'dj3')
  assert.equal(key, 'synthetic-book:2:content-hash:synthetic-model:dj3')
  assert.equal(sectionKey('synthetic-book', 2, 'dj3'), 'synthetic-book:s2:dj3')
  assert.equal(feedbackKey('synthetic-book', 'item-1'), 'synthetic-book:item-1')
  const cache = createMemoryCache()
  const record = { key, bookId: 'synthetic-book', section: 2, items: [], complete: true, at: 1 }
  await cache.put('chunks', record)
  assert.deepEqual(await cache.get('chunks', key), record)
})

test('legacy serialized smart consent and explicit book opt-out keep their meaning', () => {
  const legacy = { dianjing: { consentAll: true, enabled: true, perBook: { 'synthetic-book': false } } }
  assert.equal(migrateLevel(legacy).level, 'smart')
  assert.equal(smartOnFor(legacy.dianjing, 'another-synthetic-book'), true)
  assert.equal(smartOnFor(legacy.dianjing, 'synthetic-book'), false)
  assert.equal(migrateLevel({ readingMode: { wordGuide: { enabled: true } } }).level, 'basic')
})

test('relay metadata retains the real client handshake field and x-dj header without networking', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External request forbidden') })
  const response = await relay.fetch(new Request('https://synthetic.invalid/v1/models'), {}, {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-dj-prompt-version'), 'dj3')
  const body = await response.json()
  assert.equal(body.dianjingPromptVersion, 'dj3')
  assert.equal(body.companionPromptVersion, undefined)
  for (const name of ['x-dj-model', 'x-dj-remaining', 'x-dj-prompt-version']) {
    assert.ok(response.headers.get('access-control-expose-headers').includes(name))
  }
})

test('legacy POST route still reaches the configuration gate, not an invented new endpoint', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External request forbidden') })
  const response = await relay.fetch(new Request('https://synthetic.invalid/v1/dianjing', { method: 'POST', body: '{}' }), {}, {})
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'config')
})

test('actual dictionaries expose Companion names and source actions, not raw missing keys', () => {
  assert.equal(zh['companion.title'], '伴读')
  assert.equal(en['companion.title'], 'Companion')
  for (const key of Object.keys(zh).filter(key => key.startsWith('companion.'))) {
    assert.equal(typeof en[key], 'string', `English dictionary contains ${key}`)
    assert.equal(/点睛|Spotlight Reading/.test(zh[key] + en[key]), false, key)
  }
  assert.equal(zh['companion.viewSource'], '查看原文')
  assert.equal(en['companion.sourceText'], 'Source excerpt')
})

test('canonical test command and renamed manual preserve old deep-link routing', () => {
  const manifest = parseFixture(readFileSync(file('../package.json'), 'utf8'))
  assert.equal(manifest.scripts['test:companion'], 'node --experimental-strip-types --test scripts/test-companion.mjs scripts/test-companion-boundaries.mjs scripts/test-companion-compat.mjs scripts/test-companion-lifecycle.mjs scripts/test-companion-names.mjs')
  assert.equal(manifest.scripts['test:dianjing'], undefined)
  const manual = readFileSync(file('../docs/manual/05-伴读.md'), 'utf8')
  assert.match(manual, /^# 五、伴读/m)
  assert.equal(manual.includes('画龙伴读'), false)
  assert.equal(companionManualFile('05-点睛阅读.md'), '05-伴读.md')
  assert.equal(companionManualFile('02-阅读模式.md'), '02-阅读模式.md')
})

test('runtime preferences are canonical while the serialized settings contract stays backward compatible', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const records = new Map([['lightread-settings', JSON.stringify({
    version: 16,
    dianjing: { level: 'smart', enabled: true, consentAll: true, density: 'low',
      perBook: { 'synthetic-book': false }, fiction: { 'synthetic-book': 'fiction' } },
  })]])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
  } })
  let settings
  try {
    setActivePinia(createPinia())
    settings = useSettings()
    assert.equal(settings.pagewiseCompanion.level, 'smart')
    assert.equal(settings.pagewiseCompanion.consentAll, true)
    assert.equal(settings.pagewiseCompanion.perBook['synthetic-book'], false)
    assert.equal(settings.pagewiseCompanion.fiction['synthetic-book'], 'fiction')
    assert.equal('dianjing' in settings.$state, false)
    settings.persistOnChange()
    settings.pagewiseCompanion.density = 'high'
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 350))
    const written = parseFixture(records.get('lightread-settings'))
    assert.equal('pagewiseCompanion' in written, false)
    assert.equal(written.dianjing.density, 'high')
    assert.equal(written.dianjing.perBook['synthetic-book'], false)
    assert.equal(written.dianjing.consentAll, true)
  } finally {
    settings?.$dispose()
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})

test('preference decoding accepts canonical input and never invents consent from malformed legacy data', () => {
  const canonical = { enabled: false, consentAll: false, perBook: { synthetic: false } }
  assert.deepEqual(readCompanionPreferences({ pagewiseCompanion: canonical, dianjing: { enabled: true, consentAll: true } }), canonical)
  for (const value of [null, [], false, 'bad']) assert.deepEqual(readCompanionPreferences({ dianjing: value }), {})
  const defaults = settingsDefaults()
  const stored = serializeCompanionSettings(defaults)
  assert.equal(stored.dianjing.consentAll, false)
  assert.equal(stored.dianjing.enabled, false)
  assert.deepEqual(readCompanionPreferences(stored), stored.dianjing)
})

test('malformed nested authorization never enables smart reading through either settings key', () => {
  for (const key of ['dianjing', 'pagewiseCompanion']) {
    for (const invalid of ['false', 'true', 1, [], {}]) {
      const prefs = readCompanionPreferences({ [key]: { level: 'smart', consentAll: invalid, enabled: invalid } })
      assert.equal(smartOnFor(prefs, 'synthetic'), false)
      assert.equal(prefs.consentAll, false)
      assert.equal(prefs.enabled, false)
      const unknownConsent = readCompanionPreferences({ [key]: { level: 'smart', consentAll: false, enabled: false, perBook: { synthetic: invalid } } })
      const toggle = applyCompanionAction({ ...unknownConsent, basicOn: false }, 'synthetic', { kind: 'toggle' })
      assert.equal(toggle.needConsent, true)
      assert.equal(smartOnFor(toggle.state, 'synthetic'), false)
      const perBook = readCompanionPreferences({ [key]: { consentAll: true, enabled: true, perBook: { synthetic: invalid, denied: false, allowed: true } } })
      assert.equal(smartOnFor(perBook, 'synthetic'), false)
      assert.equal(smartOnFor(perBook, 'denied'), false)
      assert.equal(smartOnFor(perBook, 'allowed'), true)
    }
  }
  assert.equal(smartOnFor({ perBook: { synthetic: 'false' }, consentAll: true, enabled: true }, 'synthetic'), false)
  assert.equal(smartOnFor({ perBook: Object.create({ synthetic: true }), consentAll: false, enabled: false }, 'synthetic'), false)
})

test('both library-root actions immediately persist the legacy-readable settings payload without waiting for a watcher', async () => {
  const source = readFileSync(file('../src/views/SettingsView.vue'), 'utf8')
  const script = source.slice(source.indexOf('>', source.indexOf('<script')) + 1, source.indexOf('</script>'))
  const tree = ts.createSourceFile('settings-view.ts', script, ts.ScriptTarget.Latest, true)
  for (const name of ['changeLibraryRoot', 'resetLibraryRoot']) {
    const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.ok(fn, name)
    const state = settingsDefaults()
    state.libraryRoot = '/synthetic/original'
    state.pagewiseCompanion = { ...state.pagewiseCompanion, level: 'smart', consentAll: true, enabled: true, perBook: { denied: false } }
    const settings = { $state: state, get libraryRoot() { return state.libraryRoot }, set libraryRoot(value) { state.libraryRoot = value } }
    const writes = new Map()
    const timers = []
    const context = vm.createContext({ settings, serializeCompanionSettings, confirm: () => true, t: key => key,
      localStorage: { setItem: (key, value) => writes.set(key, value) }, migrating: { value: '' }, toast: () => {},
      location: { reload: () => assert.fail('Do not reload during this test') }, setTimeout: (_fn, delay) => timers.push(delay),
      loadModule: async id => id === '@tauri-apps/plugin-dialog' ? { open: async () => '/synthetic/new' }
        : { hasLibraryAt: async () => true, migrateLibraryTo: async () => assert.fail('No real filesystem migration') },
    })
    const compiled = ts.transpileModule(fn.getText(tree).replace(/\bimport\(/g, 'loadModule('), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    vm.runInContext(compiled, context)
    await context[name]()
    const saved = parseFixture(writes.get('lightread-settings'))
    assert.equal('pagewiseCompanion' in saved, false)
    assert.equal(saved.dianjing.consentAll, true)
    assert.equal(saved.dianjing.perBook.denied, false)
    assert.equal(saved.libraryRoot, name === 'changeLibraryRoot' ? '/synthetic/new' : '')
    assert.equal(timers.length, 1)
  }
})
