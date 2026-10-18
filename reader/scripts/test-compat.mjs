/**
 * 旧 WebView 兼容契约 (node --test):
 *  1. src/polyfills.ts 在删除原生实现后补齐的 API 行为正确, 原生存在时不覆盖;
 *  2. vite.legacy.ts 的 CSS 回退与正则改写;
 *  3. 源码不使用目标内核缺失且未补齐的 API;
 *  4. 构建产物 (默认 dist/, 或 COMPAT_DIST=<目录>) 不含超出构建目标的语法, 且 polyfill 块最先执行。
 * 产物检查需要先 `npm run build`; 目录不存在时跳过。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseAst } from 'vite'
import { BROWSER_TARGET, legacyCssValue } from '../vite.legacy.ts'

const root = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------- polyfills

const typedProto = Object.getPrototypeOf(Int8Array.prototype)
const CryptoProto = Object.getPrototypeOf(globalThis.crypto)
const removable = [
  [Array.prototype, 'at'], [String.prototype, 'at'], [typedProto, 'at'],
  [Array.prototype, 'findLast'], [Array.prototype, 'findLastIndex'],
  [typedProto, 'findLast'], [typedProto, 'findLastIndex'],
  [globalThis, 'structuredClone'], [AbortSignal, 'timeout'], [CryptoProto, 'randomUUID'],
  [Object, 'hasOwn'],
]

async function withoutNatives(run) {
  const saved = removable.map(([obj, key]) => [obj, key, Object.getOwnPropertyDescriptor(obj, key)])
  for (const [obj, key] of removable) delete obj[key]
  try {
    for (const [obj, key] of removable) assert.equal(typeof obj[key], 'undefined', `native ${key} should be removed`)
    assert.equal(typeof crypto.randomUUID, 'undefined')
    await import(`../src/polyfills.ts?legacy-${Math.random()}`)
    await run()
  } finally {
    for (const [obj, key, desc] of saved) {
      delete obj[key]
      if (desc) Object.defineProperty(obj, key, desc)
    }
    delete globalThis.crypto.randomUUID
  }
}

test('Object.hasOwn works on Chrome 89 fallback without accepting inherited keys', async () => {
  await withoutNatives(() => {
    const symbol = Symbol('owned')
    const value = Object.assign(Object.create({ inherited: 1 }), { own: 0, hasOwnProperty: null, [symbol]: 2 })
    assert.equal(Object.hasOwn(value, 'own'), true)
    assert.equal(Object.hasOwn(value, 'inherited'), false)
    assert.equal(Object.hasOwn(value, symbol), true)
    assert.equal(Object.hasOwn('text', 0), true)
    assert.throws(() => Object.hasOwn(null, 'x'), TypeError)
    assert.throws(() => Object.hasOwn(undefined, 'x'), TypeError)
    assert.equal(Object.getOwnPropertyDescriptor(Object, 'hasOwn').enumerable, false)
  })
})

test('polyfills restore .at / findLast / findLastIndex with spec semantics', async () => {
  await withoutNatives(() => {
    for (const [obj, key] of removable.slice(0, 7)) {
      const desc = Object.getOwnPropertyDescriptor(obj, key)
      assert.equal(typeof desc?.value, 'function', key)
      assert.equal(desc.enumerable, false, `${key} must be non-enumerable`)
    }
    const arr = [1, 2, 3]
    assert.equal(arr.at(-1), 3)
    assert.equal(arr.at(0), 1)
    assert.equal(arr.at(1.7), 2)
    assert.equal(arr.at('-2'), 2)
    assert.equal(arr.at(NaN), 1)
    assert.equal(arr.at(3), undefined)
    assert.equal(arr.at(-4), undefined)
    assert.equal([].at(-1), undefined)
    assert.equal('中文ab'.at(-1), 'b')
    assert.equal('中文ab'.at(0), '中')
    assert.equal(''.at(0), undefined)
    assert.equal(new Uint8Array([7, 8]).at(-1), 8)
    assert.equal(Array.prototype.at.call({ length: 2, 0: 'a', 1: 'b' }, -1), 'b')
    assert.throws(() => Array.prototype.at.call(null, 0), TypeError)
    // for…in 不能看到补丁 (旧代码常用 for…in 遍历数组)
    const seen = []
    for (const k in arr) seen.push(k)
    assert.deepEqual(seen, ['0', '1', '2'])

    const items = [{ id: 1, ok: true }, { id: 2, ok: false }, { id: 3, ok: true }]
    assert.equal(items.findLast(x => x.ok).id, 3)
    assert.equal(items.findLastIndex(x => x.ok), 2)
    assert.equal(items.findLastIndex(x => x.id > 5), -1)
    assert.equal(items.findLast(x => x.id > 5), undefined)
    const visits = []
    ;[5, , 7].findLastIndex((v, i) => { visits.push([v, i]); return false })
    assert.deepEqual(visits, [[7, 2], [undefined, 1], [5, 0]])
    const ctx = { limit: 1 }
    assert.equal([0, 1, 2].findLast(function (v) { return v <= this.limit }, ctx), 1)
    assert.equal(new Float32Array([1, 2, 3]).findLastIndex(v => v < 3), 1)
    assert.throws(() => [].findLast(null), TypeError)
  })
})

test('structuredClone polyfill deep-copies the data shapes the app stores', async () => {
  await withoutNatives(() => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')
    assert.equal(desc.enumerable, false)
    const date = new Date(1_700_000_000_000)
    const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3)
    const source = {
      n: 1, s: '书', b: false, u: undefined, nil: null, big: 10n,
      nested: { list: [1, { deep: true }], sparse: [1, , 3] },
      date, re: /a+b/gi, map: new Map([[{ k: 1 }, new Set(['x'])]]), bytes,
      boxed: new String('box'),
      err: new RangeError('bad range'),
    }
    source.self = source
    const copy = structuredClone(source)
    assert.notEqual(copy, source)
    assert.deepEqual(copy.nested, source.nested)
    assert.notEqual(copy.nested.list[1], source.nested.list[1])
    assert.equal(copy.self, copy, 'cycles preserved')
    assert.ok('u' in copy)
    assert.equal(copy.big, 10n)
    assert.ok(copy.date instanceof Date && copy.date !== date && copy.date.getTime() === date.getTime())
    assert.ok(copy.re instanceof RegExp && copy.re.source === 'a+b' && copy.re.flags === 'gi')
    const [[k, v]] = copy.map
    assert.deepEqual(k, { k: 1 })
    assert.ok(v instanceof Set && v.has('x'))
    assert.ok(copy.bytes instanceof Uint8Array)
    assert.deepEqual([...copy.bytes], [2, 3])
    assert.notEqual(copy.bytes.buffer, bytes.buffer)
    assert.equal(copy.boxed.valueOf(), 'box')
    assert.ok(copy.err instanceof RangeError && copy.err.message === 'bad range')
    class Settings { constructor() { this.theme = 'auto' } get computed() { return 1 } }
    const plain = structuredClone(new Settings())
    assert.equal(Object.getPrototypeOf(plain), Object.prototype)
    assert.deepEqual(plain, { theme: 'auto' })
    assert.equal(structuredClone(5), 5)
    assert.throws(() => structuredClone({ fn() {} }), err => err.name === 'DataCloneError')
    assert.throws(() => structuredClone(Symbol('x')), err => err.name === 'DataCloneError')
  })
})

test('AbortSignal.timeout and crypto.randomUUID polyfills', async () => {
  await withoutNatives(async () => {
    const signal = AbortSignal.timeout(5)
    assert.equal(signal.aborted, false)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(signal.aborted, true)
    assert.equal(signal.reason?.name, 'TimeoutError')
    assert.throws(() => AbortSignal.timeout(-1), TypeError)

    const ids = new Set()
    for (let i = 0; i < 200; i++) {
      const id = crypto.randomUUID()
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      ids.add(id)
    }
    assert.equal(ids.size, 200)
    assert.equal(Object.getOwnPropertyDescriptor(crypto, 'randomUUID').enumerable, false)
  })
})

test('native implementations are never replaced', async () => {
  const before = removable.map(([obj, key]) => obj[key])
  const clone = globalThis.structuredClone
  await import(`../src/polyfills.ts?native-${Math.random()}`)
  assert.deepEqual(removable.map(([obj, key]) => obj[key]), before)
  assert.equal(globalThis.structuredClone, clone)
  assert.equal(Object.getOwnPropertyDescriptor(crypto, 'randomUUID'), undefined)
})

// ---------------------------------------------------------------- build helpers

test('CSS fallbacks: color-mix picks the dominant colour and dvh becomes vh', () => {
  assert.equal(legacyCssValue('color-mix(in srgb, var(--card) 86%, transparent)'), 'var(--card)')
  assert.equal(legacyCssValue('1px solid color-mix(in srgb, var(--border) 60%, transparent)'), '1px solid var(--border)')
  assert.equal(legacyCssValue('color-mix(in srgb, var(--brand) 30%, var(--border))'), 'var(--border)')
  assert.equal(legacyCssValue('color-mix(in srgb, var(--brand) 12%, transparent)'), 'var(--brand-soft)')
  assert.equal(legacyCssValue('color-mix(in srgb, var(--danger, #d54941) 35%, var(--border))'), 'var(--border)')
  assert.equal(legacyCssValue('color-mix(in srgb, var(--text) 6%, transparent)'), 'transparent')
  assert.equal(
    legacyCssValue('0 0 0 2px color-mix(in srgb, var(--brand) 16%, transparent), 0 3px 10px rgba(34, 45, 61, 0.14)'),
    '0 0 0 2px var(--brand-soft), 0 3px 10px rgba(34, 45, 61, 0.14)',
  )
  assert.equal(
    legacyCssValue('linear-gradient(110deg, color-mix(in srgb, var(--brand-light) 55%, transparent), transparent 52%)'),
    'linear-gradient(110deg, var(--brand-light), transparent 52%)',
  )
  assert.equal(legacyCssValue('min(720px, calc(100dvh - 48px))'), 'min(720px, calc(100vh - 48px))')
  assert.equal(legacyCssValue('100svh'), '100vh')
  assert.equal(legacyCssValue('var(--card)'), null)
})

test('build target keeps the top-level-await floor required by mupdf', () => {
  assert.ok(readFileSync(join(root, 'node_modules/mupdf/dist/mupdf.js'), 'utf8').includes('\nconst libmupdf = await '),
    'mupdf still uses top-level await; if this changed, BROWSER_TARGET can be revisited')
  const floor = { chrome: 89, edge: 89, firefox: 89, safari: 15, ios: 15 }
  for (const entry of BROWSER_TARGET) {
    const [, name, version] = /^([a-z]+)(\d+(?:\.\d+)?)$/.exec(entry)
    assert.ok(Number(version) >= floor[name], `${entry} is below the top-level await floor`)
  }
  const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
  assert.match(config, /target:\s*BROWSER_TARGET/)
  assert.doesNotMatch(config, /target:\s*['"]esnext['"]/)
})

// ---------------------------------------------------------------- source API guard

// 目标内核 (Chrome 89 / Safari 15) 缺失且 polyfills.ts 未补齐的 API。需要时先在 polyfills.ts 补上再用。
const UNPOLYFILLED = [
  [/\.toSorted\(|\.toReversed\(|\.toSpliced\(/, 'change-array-by-copy (Chrome 110 / Safari 16)'],
  [/\bPromise\.(withResolvers|try)\b/, 'Promise.withResolvers/try'],
  [/\bArray\.fromAsync\b/, 'Array.fromAsync'],
  [/\.(isWellFormed|toWellFormed)\(/, 'String well-formed helpers'],
  [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(new Set|\bSet\.prototype\.(union|intersection)/, 'Set methods'],
  [/\bIterator\.from\b|\.(values|keys|entries)\(\)\.(map|filter|take|drop|flatMap|reduce|toArray|some|every|find)\(/, 'Iterator helpers'],
  [/\bAbortSignal\.any\b/, 'AbortSignal.any'],
  [/\bURL\.(canParse|parse)\(/, 'URL.canParse/parse'],
  [/\.bytes\(\)/, 'Blob/Response.bytes()'],
  [/(?<![\w.])requestIdleCallback\(/, 'requestIdleCallback (never in Safari ≤ 17) — feature-detect via window.requestIdleCallback?.'],
  [/\bnew\s+(CompressionStream|DecompressionStream)\(\s*['"]deflate-raw/, 'deflate-raw streams (Chrome 103 / Safari 16.4)'],
  [/\bnew\s+OffscreenCanvas\b/, 'OffscreenCanvas (Safari 16.4) — feature-detect first'],
]

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { if (name !== 'vendor') yield* sourceFiles(path) }
    else if (/\.(ts|vue|js)$/.test(name) && !name.endsWith('.d.ts')) yield path
  }
}

test('app sources avoid runtime APIs that the build target lacks and polyfills.ts does not provide', () => {
  const hits = []
  for (const file of sourceFiles(join(root, 'src'))) {
    if (file.endsWith('polyfills.ts')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      for (const [re, what] of UNPOLYFILLED) if (re.test(line)) hits.push(`${file.slice(root.length + 1)}:${i + 1} ${what}`)
    })
  }
  assert.deepEqual(hits, [], `add a polyfill in src/polyfills.ts or avoid:\n${hits.join('\n')}`)
})

// ---------------------------------------------------------------- build output

const dist = resolve(root, process.env.COMPAT_DIST ?? 'dist')
const hasDist = existsSync(join(dist, 'index.html')) && existsSync(join(dist, 'assets'))

function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key in node) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    const value = node[key]
    if (Array.isArray(value)) { for (const child of value) if (child && typeof child === 'object') walk(child, visit, node) }
    else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit, node)
  }
}

/** 返回超出 BROWSER_TARGET (Chrome/Edge 89, Firefox 89, Safari 15) 的语法 */
function syntaxViolations(code, file) {
  const ast = parseAst(code, { lang: 'js', sourceType: 'module' }, file)
  const out = []
  const at = node => `${file}@${node.start}`
  walk(ast, node => {
    switch (node.type) {
      case 'StaticBlock': out.push(`${at(node)} class static block (Chrome 94 / Safari 16.4)`); break
      case 'BinaryExpression':
        if (node.operator === 'in' && node.left?.type === 'PrivateIdentifier') out.push(`${at(node)} #x in obj (Chrome 91)`)
        break
      case 'MethodDefinition':
        if (node.key?.type === 'PrivateIdentifier') out.push(`${at(node)} private method (Firefox 90)`)
        break
      case 'VariableDeclaration':
        if (node.kind === 'using' || node.kind === 'await using') out.push(`${at(node)} using declaration`)
        break
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.attributes?.length) out.push(`${at(node)} import attributes (Chrome 123)`)
        break
      case 'ImportExpression':
        if (node.options) out.push(`${at(node)} import() options (Chrome 123)`)
        break
      case 'Literal':
        if (node.regex) {
          const { pattern, flags } = node.regex
          if (/[dv]/.test(flags)) out.push(`${at(node)} regex flag /${flags} (d: Chrome 90, v: Chrome 112)`)
          if (/(^|[^\\])\(\?<[=!]/.test(pattern)) out.push(`${at(node)} regex lookbehind /${pattern}/ (Safari 16.4)`)
          if (/(^|[^\\])\(\?[ims]*-?[ims]+:/.test(pattern)) out.push(`${at(node)} regex modifiers (Chrome 125)`)
        }
        break
    }
    if (node.decorators?.length) out.push(`${at(node)} decorators`)
  })
  return out
}

test('syntax checker flags constructs above the target (self-test)', () => {
  const bad = 'class A { static { x } #m(){} has(o){ return #m in o } }; const r = /(?<=a)b/d; using x = y; import j from "./a.json" with { type: "json" }'
  const found = syntaxViolations(bad, 'self-test.js').join('\n')
  for (const word of ['static block', '#x in obj', 'private method', 'regex flag', 'lookbehind', 'using declaration', 'import attributes']) {
    assert.ok(found.includes(word), `self-test should flag ${word}`)
  }
  assert.deepEqual(syntaxViolations('const a = b?.c ?? d; a ||= 1; class B { #x = 1; static y = 2; get x() { return this.#x } }; await 0; new RegExp("(?<=a)b")', 'ok.js'), [])
  // 未经构建的 foliate-js 源码确实超出目标: 构建降级 + 正则改写是必要的
  const raw = syntaxViolations(readFileSync(join(root, 'node_modules/foliate-js/paginator.js'), 'utf8'), 'paginator.js').join('\n')
  assert.match(raw, /lookbehind/)
  assert.match(raw, /private method/)
})

test('built chunks contain no syntax above the build target', { skip: !hasDist && `no build at ${dist} (run npm run build first)` }, () => {
  const files = readdirSync(join(dist, 'assets')).filter(f => f.endsWith('.js'))
  assert.ok(files.length > 10)
  const violations = files.flatMap(f => syntaxViolations(readFileSync(join(dist, 'assets', f), 'utf8'), f))
  assert.deepEqual(violations, [])
})

function firstStaticImport(code) {
  const ast = parseAst(code, { lang: 'js', sourceType: 'module' }, 'entry.js')
  return ast.body.find(node => node.type === 'ImportDeclaration')?.source.value
}

test('entry import oracle ignores Vite dependency-map statements but catches wrong import order', () => {
  assert.equal(firstStaticImport('const map = []; import "./polyfills-test.js"; import "./app.js";'), './polyfills-test.js')
  assert.equal(firstStaticImport('import "./app.js"; import "./polyfills-test.js";'), './app.js')
  assert.equal(firstStaticImport('const map = [];'), undefined)
})

test('polyfill chunk is the first module evaluated by the entry', { skip: !hasDist && `no build at ${dist}` }, () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const entries = [...html.matchAll(/<script type="module"[^>]*src="\/?([^"]+)"/g)].map(m => m[1])
  assert.equal(entries.length, 1, 'single module entry')
  const entry = readFileSync(join(dist, entries[0]), 'utf8')
  const firstImport = firstStaticImport(entry)
  assert.ok(firstImport, 'entry contains a static import')
  assert.match(firstImport, /^\.\/polyfills-[\w-]+\.js$/, `first evaluated dependency must be polyfills, got ${firstImport}`)
  const polyfills = readFileSync(join(dist, 'assets', firstImport), 'utf8')
  assert.doesNotMatch(polyfills, /^import\b/m, 'polyfill chunk must not depend on other chunks')
  for (const api of ['findLastIndex', 'structuredClone', 'randomUUID', 'adoptedStyleSheets', 'groupBy']) {
    assert.ok(polyfills.includes(api), `polyfill chunk includes ${api}`)
  }
})

test('built CSS keeps old-engine fallbacks before color-mix() and dvh', { skip: !hasDist && `no build at ${dist}` }, () => {
  const css = readdirSync(join(dist, 'assets')).filter(f => f.endsWith('.css'))
    .map(f => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n')
  assert.match(css, /border:1px solid var\(--border\);border:1px solid color-mix\(/, '.card border fallback')
  assert.match(css, /@supports not \(color:\s*color-mix\(/, 'token fallbacks for custom properties')
  // 每条使用 dvh 的声明前都有同属性的 vh 回退
  for (const m of css.matchAll(/([{;])([a-z-]+):([^;{}]*\d+dvh[^;{}]*)/g)) {
    const before = css.slice(Math.max(0, m.index - 400), m.index + 1)
    assert.ok(before.includes(`${m[2]}:${m[3].replace(/(\d)dvh/g, '$1vh')}`), `missing vh fallback for ${m[2]}:${m[3]}`)
  }
})
