import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { normalizeRetiredLyricSettings } from '../src/services/readingModes/retiredSettings.ts'
import { engagePreset, releasePreset } from '../src/services/readingModes/presets.ts'
import * as levels from '../src/services/PagewiseCompanion/level.ts'
import { DIM_MAX } from '../src/services/readingModes/eyeCare.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const sfc = require('@vue/compiler-sfc')
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const base = () => ({ version: 14, reader: { flow: 'paginated', fontSize: 18, lineHeight: 1.8, theme: 'green', gap: 5 }, readingMode: { presets: {}, typewriter: { cpm: 360 }, wordGuide: { enabled: true }, eyeCare: { dim: 0.3 }, lyric: { enabled: true, driver: 'tts' }, tab: 'lyric', panelTab: 'lyric' }, autoReadSeconds: 20, edgeVoice: 'custom-voice', features: {} })
const read = state => key => state.reader[key.slice(7)]
const apply = (state, writes) => { for (const [key, value] of Object.entries(writes)) state.reader[key.slice(7)] = value }
function engage(state, id, values) {
  const result = engagePreset(state.readingMode.presets, id, values, read(state))
  state.readingMode.presets = result.records
  apply(state, result.writes)
}
function release(state, id) {
  const result = releasePreset(state.readingMode.presets, id, read(state))
  state.readingMode.presets = result.records
  apply(state, result.writes)
}
const lyricValues = { 'reader.flow': 'scrolled', 'reader.fontSize': 22, 'reader.lineHeight': 2 }

test('retired snapshot restores untouched typography/flow and only removes retired preferences', () => {
  const state = base()
  engage(state, 'lyric', lyricValues)
  normalizeRetiredLyricSettings(state)
  assert.deepEqual(state.reader, base().reader)
  assert.deepEqual(state.readingMode.presets, {})
  assert.equal('lyric' in state.readingMode, false)
  assert.equal(state.readingMode.tab, 'normal')
  assert.equal(state.readingMode.panelTab, 'normal')
  assert.equal(state.readingMode.wordGuide.enabled, true)
  assert.equal(state.readingMode.typewriter.cpm, 360)
  assert.equal(state.edgeVoice, 'custom-voice')
  const once = structuredClone(state)
  normalizeRetiredLyricSettings(state)
  assert.deepEqual(state, once)
})
test('manual typography and flow choices are not replaced by snapshot values', () => {
  const state = base()
  engage(state, 'lyric', lyricValues)
  state.reader.fontSize = 27
  state.reader.lineHeight = 2.4
  state.reader.flow = 'paginated'
  const reader = structuredClone(state.reader)
  normalizeRetiredLyricSettings(state)
  assert.deepEqual(state.reader, reader)
})
test('removing an upper retired layer preserves the lower large-text preset and restores it normally', () => {
  const state = base()
  engage(state, 'largeText', { 'reader.fontSize': 24, 'reader.lineHeight': 2 })
  engage(state, 'lyric', { ...lyricValues, 'reader.fontSize': 29 })
  const lower = structuredClone(state.readingMode.presets.largeText)
  normalizeRetiredLyricSettings(state)
  assert.equal(state.reader.fontSize, 24)
  assert.deepEqual(state.readingMode.presets.largeText, lower)
  release(state, 'largeText')
  assert.deepEqual(state.reader, base().reader)
})
test('removing a lower retired layer transfers baseline through the nearest upper preset', () => {
  const state = base()
  engage(state, 'lyric', lyricValues)
  engage(state, 'largeText', { 'reader.fontSize': 24, 'reader.lineHeight': 2 })
  engage(state, 'other', { 'reader.fontSize': 30 })
  normalizeRetiredLyricSettings(state)
  assert.equal(state.reader.fontSize, 30)
  assert.equal(state.readingMode.presets.largeText.before['reader.fontSize'], 18)
  assert.equal(state.readingMode.presets.other.before['reader.fontSize'], 24)
  release(state, 'other')
  release(state, 'largeText')
  assert.deepEqual(state.reader, base().reader)
})
test('manual changes captured before a later preset remain its restoration baseline', () => {
  const state = base()
  engage(state, 'lyric', lyricValues)
  state.reader.fontSize = 27
  engage(state, 'largeText', { 'reader.fontSize': 30 })
  normalizeRetiredLyricSettings(state)
  assert.equal(state.readingMode.presets.largeText.before['reader.fontSize'], 27)
  release(state, 'largeText')
  assert.equal(state.reader.fontSize, 27)
})
test('malformed or missing retired snapshots never reset unrelated reader preferences', () => {
  for (const record of [undefined, null, [], {}, { before: {}, applied: {}, order: 1 }, { before: { 'reader.fontSize': 18 }, applied: { 'reader.fontSize': 22 }, order: 'bad' }, { before: { 'reader.flow': 'bad', 'reader.theme': 'dark' }, applied: { 'reader.flow': 'scrolled', 'reader.theme': 'green' }, order: 1 }]) {
    const state = base()
    state.readingMode.presets = { lyric: record, night: { before: {}, applied: {}, order: 3 } }
    const reader = structuredClone(state.reader)
    normalizeRetiredLyricSettings(state)
    assert.deepEqual(state.reader, reader)
    assert.deepEqual(state.readingMode.presets, { night: { before: {}, applied: {}, order: 3 } })
  }
  for (const value of [null, [], {}, { readingMode: [] }]) assert.doesNotThrow(() => normalizeRetiredLyricSettings(value))
})

test('actual settings load applies migration before merging defaults using synthetic storage only', async () => {
  const state = base()
  engage(state, 'lyric', lyricValues)
  let reads = 0
  const output = ts.transpileModule(source('src/stores/settings.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const imports = {
    pinia: { defineStore: (_id, options) => options },
    vue: { watch: () => { throw new Error('Persistence must not run') } },
    '../storage/types.ts': { isTauri: () => false },
    '../services/PagewiseCompanion/level.ts': levels,
    '../services/readingModes/eyeCare.ts': { DIM_MAX },
    '../services/readingModes/retiredSettings.ts': { normalizeRetiredLyricSettings },
    '../services/aiProviders.ts': await import('../src/services/aiProviders.ts'),
    '../services/readerTypographyProfiles.ts': await import('../src/services/readerTypographyProfiles.ts'),
  }
  vm.runInNewContext(output, {
    exports, require: id => { assert.ok(id in imports, `unexpected import ${id}`); return imports[id] },
    structuredClone, console,
    localStorage: { getItem: key => { assert.equal(key, 'lightread-settings'); reads++; return JSON.stringify(state) }, setItem: () => { throw new Error('Unexpected write') } },
  })
  const loaded = exports.useSettings.state()
  assert.equal(reads, 1)
  assert.equal(loaded.reader.flow, 'paginated')
  assert.equal(loaded.reader.fontSize, 18)
  assert.equal(loaded.reader.lineHeight, 1.8)
  assert.equal(loaded.reader.theme, 'green')
  assert.equal(loaded.readingMode.lyric, undefined)
  assert.equal(loaded.readingMode.presets.lyric, undefined)
  assert.equal(loaded.readingMode.typewriter.cpm, 360)
  assert.equal(loaded.edgeVoice, 'custom-voice')
  assert.equal(loaded.autoReadSeconds, 20)
})

test('lyric-only modules, APIs, choices, shortcuts and component styles are absent', () => {
  for (const path of ['src/composables/useReadingModes.ts', 'src/components/ReadingModePanel.vue', 'src/components/ReadingModeMini.vue', 'src/components/ReadingModeLayer.vue', 'src/services/readingModes/presets.ts', 'src/services/readingModes/revealLayer.ts']) {
    assert.doesNotMatch(source(path), /lyric|歌词|followRange|setFollowPaused|ly-panel|rm-back|rm-indent/i, path)
  }
  for (const path of ['src/services/readingModes/lyric.ts', 'src/services/readingModes/lyricController.ts']) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false)
  }
  const modes = source('src/composables/useReadingModes.ts')
  for (const api of ['toggleTypewriter', 'stopForExternal', 'setEyeCare', 'setEink', 'setLargeText', 'toggleImmersive', 'setWordGuide', 'onSectionChange']) assert.match(modes, new RegExp(`\\b${api}\\b`))
})

test('all three edited Vue SFC scripts, templates and styles compile', () => {
  for (const name of ['ReadingModePanel', 'ReadingModeMini', 'ReadingModeLayer']) {
    const filename = `src/components/${name}.vue`
    const { descriptor, errors } = sfc.parse(source(filename), { filename })
    assert.deepEqual(errors, [])
    sfc.compileScript(descriptor, { id: name })
    const template = sfc.compileTemplate({ source: descriptor.template.content, filename, id: name })
    assert.deepEqual(template.errors, [], filename)
    for (const style of descriptor.styles) assert.deepEqual(sfc.compileStyle({ source: style.content, filename, id: name, scoped: style.scoped }).errors, [])
  }
})
test('migration and preset engine pass strict TypeScript checking', () => {
  const paths = ['src/services/readingModes/retiredSettings.ts', 'src/services/readingModes/presets.ts'].map(path => new URL(`../${path}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const program = ts.createProgram(paths, { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true })
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
})
