import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { annotationLabelKey, annotationLineStyle, annotationSwatchStyle, EINK_THEMES, HIGHLIGHT_COLORS, getReaderCSS } from '../src/services/readerTheme.ts'
import { dimBackground, inNightWindow, nightScheduleAction } from '../src/services/readingModes/eyeCare.ts'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const reader = parse(read('../src/views/ReaderView.vue')).descriptor.scriptSetup.content
const modes = read('../src/composables/useReadingModes.ts')
const css = read('../src/styles/main.css')
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
function functionBody(source, name) {
  const tree = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true)
  let found
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree)
    if (!found) ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(found, `Real function ${name} exists`)
  return transpile(found)
}
function palette(selector) {
  const start = css.indexOf(selector)
  assert.notEqual(start, -1)
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
}
const day = palette(':root.pagewise-eink, .lr-eink')
const night = { ...day, ...palette('.lr-eink[data-reader-theme="dark"]') }
function luminance(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

for (const [name, p] of [['day', day], ['night', night]]) {
  test(`${name}: actual UI and reader use the approved paper/ink colors`, () => {
    assert.equal(p['--bg'], EINK_THEMES[name === 'day' ? 'light' : 'dark'].bg)
    assert.equal(p['--text'], EINK_THEMES[name === 'day' ? 'light' : 'dark'].fg)
    assert.equal(p['--card'], p['--bg'])
    assert.equal(p['--annotation-bg'], p['--surface-3'])
    assert.equal(p['--shadow'], 'none')
  })
  for (const bg of ['--bg', '--surface-2', '--annotation-bg']) {
    test(`${name}: real text and necessary borders pass on ${bg}`, () => {
      for (const fg of ['--text', '--text-2', '--text-3']) assert.ok(contrast(p[fg], p[bg]) >= 4.5, `${fg}/${bg}`)
      assert.ok(contrast(p['--border'], p[bg]) >= 3)
    })
  }
}
test('negative contracts: border gray is not body text; gray fills are not state indicators', () => {
  assert.ok(contrast(day['--border'], day['--bg']) < 4.5)
  assert.ok(contrast(day['--divider'], day['--bg']) < 3)
  assert.ok(contrast(day['--annotation-bg'], day['--bg']) < 3)
  assert.ok(contrast(night['--annotation-bg'], night['--bg']) < 3)
  assert.match(css, /button:is\(\.active, \.selected, \[aria-pressed="true"\]\)/)
  assert.match(css, /:focus-visible[\s\S]*outline: 2px solid var\(--text\)/)
})
test('annotation colors retain their persisted identities, with four distinct monochrome styles', () => {
  assert.deepEqual(HIGHLIGHT_COLORS, { yellow: '#ffd54d', green: '#7ed99b', blue: '#7cb8ff', red: '#ff8f8f' })
  const keys = Object.keys(HIGHLIGHT_COLORS)
  assert.equal(new Set(keys.map(annotationLineStyle)).size, keys.length)
  for (const key of keys) {
    const style = annotationSwatchStyle(key, true)
    assert.equal(style.color, 'var(--text)')
    assert.equal(style.background, 'var(--annotation-bg)')
    assert.equal(style.textDecorationLine, 'underline')
    assert.equal(annotationSwatchStyle(key, false).background, HIGHLIGHT_COLORS[key])
    for (const lang of [zh, en]) assert.ok(lang[annotationLabelKey(key, true)])
  }
})
test('unknown or malformed annotation keys do not introduce low-contrast monochrome colors', () => {
  for (const key of ['', '__proto__', 'rgba(255,255,255,.1)', '#777777']) {
    assert.equal(annotationLineStyle(key), 'solid')
    assert.equal(annotationLabelKey(key, true), 'reader.highlightLine.yellow')
    assert.equal(annotationSwatchStyle(key, true).background, 'var(--annotation-bg)')
  }
})
test('actual EPUB background registry merges overlaps and clears deleted or replaced ranges', () => {
  const highlights = new Map()
  class Highlight extends Set { constructor(...ranges) { super(ranges) } }
  const doc = { defaultView: { Highlight, CSS: { highlights } } }
  const context = vm.createContext({ annotationRanges: new WeakMap() })
  vm.runInContext(functionBody(reader, 'setAnnotationBackground'), context)
  const update = context.setAnnotationBackground
  const one = {}, replacement = {}, overlap = {}
  update(doc, 'one', one)
  update(doc, 'one', replacement)
  update(doc, 'two', overlap)
  assert.equal(highlights.size, 1)
  assert.equal(highlights.get('lr-annotation').size, 2)
  assert.equal(highlights.get('lr-annotation').has(one), false)
  update(doc, 'one')
  assert.equal(highlights.get('lr-annotation').size, 1)
  update(doc, 'two')
  assert.equal(highlights.size, 0)
})
test('PDF line strokes stay outside the saved glyph box without changing color-mode geometry', () => {
  const source = parse(read('../src/views/PdfReaderView.vue')).descriptor.scriptSetup.content
  const tree = ts.createSourceFile('pdf.ts', source, ts.ScriptTarget.Latest, true)
  let initializer
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'hlStyle') initializer = node.initializer.getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(initializer)
  for (const enabled of [true, false]) {
    const render = vm.runInNewContext(transpile(`const render = ${initializer}; render`), { settings: { readingMode: { eink: { enabled } } }, displaySizeOf: () => ({ sx: 2, sy: 3 }), annotationLineStyle, HIGHLIGHT_COLORS })
    const rect = { x: 10, y: 20, w: 30, h: 40 }
    const actual = render(1, rect, 'green')
    assert.equal(actual.left, '20px'); assert.equal(actual.top, '60px'); assert.equal(actual.width, '60px')
    if (enabled) {
      assert.equal(actual.background, 'transparent')
      assert.equal(actual.opacity, 1)
      assert.ok(parseFloat(actual.top) + parseFloat(actual.height) - parseFloat(actual.borderBottom) >= (rect.y + rect.h) * 3)
    } else {
      assert.equal(actual.background, HIGHLIGHT_COLORS.green)
      assert.equal(actual.height, '120px')
    }
  }
})
test('old WebView without Custom Highlight safely falls back to the separate line renderer', () => {
  const context = vm.createContext({ annotationRanges: new WeakMap() })
  vm.runInContext(functionBody(reader, 'setAnnotationBackground'), context)
  assert.doesNotThrow(() => context.setAnnotationBackground({ defaultView: {} }, 'one', {}))
  assert.doesNotThrow(() => context.setAnnotationBackground({ defaultView: null }, 'one', {}))
})
test('generated EPUB CSS paints annotations behind glyphs and retains explicit links', () => {
  const prefs = { theme: 'light', fontSize: 20, fontFamily: '', lineHeight: 1.6, gap: 5, justify: false, letterSpacing: 0 }
  for (const theme of ['light', 'dark']) {
    const actual = getReaderCSS({ ...prefs, theme }, false, { eink: true })
    const bg = theme === 'light' ? '#e0e0e0' : '#333333'
    assert.match(actual, new RegExp(`::highlight\\(lr-annotation\\) \\{ background-color: ${bg};`))
    assert.match(actual, /text-decoration-thickness: 2px/)
    assert.match(actual, /::selection/)
  }
  assert.doesNotMatch(getReaderCSS(prefs, false, { eink: false }), /::highlight\(lr-annotation\)/)
})
test('actual dimming callback suspends the overlay in e-ink without deleting saved dim levels', () => {
  const tree = ts.createSourceFile('modes.ts', modes, ts.ScriptTarget.Latest, true)
  let initializer
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'dimOverlayStyle') initializer = node.initializer.getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(initializer)
  for (const enabled of [true, false]) {
    const settings = { readingMode: { eink: { enabled } } }
    const before = JSON.stringify(settings)
    const actual = vm.runInNewContext(transpile(`const result = ${initializer}; result`), { settings, computed: fn => fn(), dimBackground, dimLevel: { value: 30 }, opts: {} })
    assert.equal(actual?.background ?? null, enabled ? null : 'rgba(0, 0, 0, 0.30)')
    assert.equal(JSON.stringify(settings), before)
  }
})
test('actual scheduled night logic never overrides a manual e-ink choice', () => {
  for (const enabled of [true, false]) {
    const calls = []
    const context = vm.createContext({ settings: { readingMode: { eink: { enabled }, night: { schedule: true, from: '00:00', to: '23:59' }, presets: {} } }, prevInWindow: null, inNightWindow, minutesOfDay: () => 500, nightScheduleAction, nightOn: { value: false }, setNight: (...args) => calls.push(args), opts: {} })
    vm.runInContext(functionBody(modes, 'checkNight'), context)
    context.checkNight()
    assert.equal(calls.length, enabled ? 0 : 1)
  }
})
