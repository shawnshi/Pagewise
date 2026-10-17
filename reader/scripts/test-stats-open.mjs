// PW-FEATURE-LIBRARY-r1-01: actual stats handlers and SSR controls, synthetic input only.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as formats from '../src/services/format.ts'
import * as readingStats from '../src/services/readingStats.ts'

const root = new URL('../', import.meta.url)
const read = relative => readFileSync(new URL(relative, root), 'utf8')
const translate = (key, values) => values?.title ? `${key}: ${values.title}` : key
const thumb = { render: () => Vue.h('span', { class: 'test-book-thumb' }) }
const formatting = {
  fmtDuration: seconds => `${seconds}s`,
  durationParts: seconds => [{ n: String(seconds), u: 's' }],
  pct: value => Math.round(value * 100),
}

function evaluate(code, dependencies) {
  const exports = {}
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(js, {
    exports,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.endsWith('.vue')) return thumb
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  return exports
}

const { readerPath } = evaluate(read('src/services/readerRoute.ts'), { './format': formats, './format.ts': formats })

function component(relative, dependencies) {
  const filename = new URL(relative, root).pathname
  const { descriptor, errors } = parse(read(relative), { filename })
  assert.deepEqual(errors, [], relative)
  const script = compileScript(descriptor, { id: relative })
  const options = { vue: Vue, '../../i18n': { t: translate }, '../../services/format': formats, './format': formatting, ...dependencies }
  const result = evaluate(script.content, options).default
  const template = compileTemplate({
    source: descriptor.template.content,
    filename,
    id: relative,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [], relative)
  result.render = evaluate(template.code, options).render
  for (const style of descriptor.styles) {
    assert.deepEqual(compileStyle({ source: style.content, filename, id: relative, scoped: style.scoped }).errors, [], relative)
  }
  return result
}

function statsView(books = [], baseline = false) {
  const paths = []
  const notices = []
  const library = { books, loaded: true }
  const relative = baseline
    ? '../artifacts/feature-trim/p2-r1-01/baseline/reader/src/views/StatsView.vue'
    : 'src/views/StatsView.vue'
  const definition = component(relative, {
    vue: { ...Vue, onMounted() {}, onBeforeUnmount() {} },
    'vue-router': { useRouter: () => ({ push: path => paths.push(path) }) },
    '../stores/library': { useLibrary: () => library },
    '../stores/settings': { useSettings: () => ({ dailyGoalMinutes: 0 }) },
    '../i18n': { t: translate },
    '../services/readerRoute': { readerPath },
    '../services/format': formats,
    '../services/toast': { toast: (...args) => notices.push(args) },
    '../services/readingLog': { localDay: () => '2026-10-16', loadDaily: async () => ({}), onReadingLogChange: () => () => {} },
    '../services/readingStats': readingStats,
  })
  return { state: definition.setup({}, { expose() {} }), paths, notices, library }
}

function book(format, lastReadAt = 10) {
  return Object.freeze({
    id: `synthetic-${format}`, title: `History ${format}`, author: 'Synthetic author',
    format, kind: 'book', addedAt: 1, lastReadAt, readingSeconds: 120,
    progress: 0.5, tags: Object.freeze(['history']), hasCover: false,
  })
}

const retired = ['azw', 'azw3', 'fb2', 'fbz', 'cbz', 'cbr', 'djvu', 'html']

test('frozen pre-fix stats caller reproduces the synchronous route exception', {
  skip: !existsSync(new URL('../artifacts/feature-trim/p2-r1-01/baseline/reader/src/views/StatsView.vue', root)) && 'Review recovery bundle is not included in the standalone fork',
}, () => {
  const view = statsView([], true)
  assert.throws(() => view.state.openBook(book('djvu')), /Unsupported/)
  assert.deepEqual(view.paths, [])
  assert.deepEqual(view.notices, [])
})

for (const format of retired) test(`stats blocks ${format}, gives a notice and preserves its historical record`, () => {
  const record = book(format)
  const before = JSON.stringify(record)
  const view = statsView([record])
  assert.doesNotThrow(() => view.state.openBook(record))
  assert.deepEqual(view.paths, [])
  assert.deepEqual(view.notices, [['library.retiredFormat', 'error']])
  assert.equal(view.library.books[0], record)
  assert.equal(view.state.continueBook.value, record)
  assert.equal(JSON.stringify(record), before)
})

for (const format of ['epub', 'mobi', 'pdf', 'txt', 'md']) test(`stats continues to open active ${format}`, () => {
  const record = book(format)
  const view = statsView([record])
  view.state.openBook(record)
  assert.deepEqual(view.paths, [`${format === 'pdf' ? '/read-pdf/' : '/read/'}${record.id}`])
  assert.deepEqual(view.notices, [])
})

const today = component('src/components/stats/TodayCard.vue')
const rows = component('src/components/stats/StatsBookList.vue')
const todayProps = { today: '2026-10-16', todaySeconds: 120, yesterdaySeconds: 60, goalMinutes: 0, streak: 1, todayActive: true, yesterdayActive: true }

test('continue-reading SSR visibly disables retired formats without hiding title or progress', async () => {
  const html = await renderToString(Vue.h(today, { ...todayProps, continueBook: book('djvu') }))
  const button = html.match(/<button\b[^>]*class="[^"]*continue-btn[^>]*>[\s\S]*?<\/button>/)?.[0]
  assert.ok(button)
  assert.match(button, /\bdisabled(?:="")?(?:\s|>)/)
  assert.match(button, /library\.retiredFormat/)
  assert.match(button, /stats\.formatUnavailable/)
  assert.ok(html.includes('History djvu'))
  assert.ok(html.includes('stats.readTo'))
})

test('continue-reading SSR keeps active format actionable', async () => {
  const html = await renderToString(Vue.h(today, { ...todayProps, continueBook: book('epub') }))
  const button = html.match(/<button\b[^>]*class="[^"]*continue-btn[^>]*>[\s\S]*?<\/button>/)?.[0]
  assert.ok(button)
  assert.doesNotMatch(button, /\bdisabled(?:="")?(?:\s|>)/)
  assert.match(button, /stats\.continueAction/)
})

test('day-detail list SSR distinguishes retired, active and missing books while retaining durations', async () => {
  const data = [
    { key: 'retired', title: 'Historical DjVu', seconds: 120, kind: 'book', book: book('djvu'), share: 0.5 },
    { key: 'active', title: 'Readable EPUB', seconds: 60, kind: 'book', book: book('epub'), share: 0.25 },
    { key: 'missing', title: 'Removed book history', seconds: 60, kind: 'book', share: 0.25 },
  ]
  const before = JSON.stringify(data)
  const html = await renderToString(Vue.h(rows, { rows: data }))
  const items = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g)
  assert.equal(items.length, 3)
  assert.match(items[0], /<button\b[^>]*\bdisabled(?:="")?(?:\s|>)/)
  assert.match(items[0], /stats\.formatUnavailable/)
  assert.ok(items[0].includes('Historical DjVu') && items[0].includes('120s'))
  assert.match(items[1], /<button\b/)
  assert.doesNotMatch(items[1], /\bdisabled(?:="")?(?:\s|>)/)
  assert.ok(items[1].includes('Readable EPUB') && items[1].includes('60s'))
  assert.doesNotMatch(items[2], /<button\b/)
  assert.match(items[2], /stats\.bookMissing/)
  assert.ok(items[2].includes('Removed book history') && items[2].includes('60s'))
  assert.equal(JSON.stringify(data), before)
})
