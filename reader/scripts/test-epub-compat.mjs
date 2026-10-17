import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { BlobReader, ZipReader, TextWriter, configure } from 'foliate-js/vendor/zip.js'
import { openBookWithFileFallback } from '../src/services/foliateBook.ts'

test('old WebViews get both EPUB groupBy APIs with safe keys and iterable semantics', async () => {
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object, 'groupBy')
  const mapDescriptor = Object.getOwnPropertyDescriptor(Map, 'groupBy')
  try {
    delete Object.groupBy
    delete Map.groupBy
    await import('../src/polyfills.ts?legacy-webview')
    const symbol = Symbol('group')
    const result = Object.groupBy(new Set(['a', 'b', 'c']), (_, index) => ['__proto__', 'constructor', symbol][index])
    assert.equal(Object.getPrototypeOf(result), null)
    assert.deepEqual(result.__proto__, ['a'])
    assert.deepEqual(result.constructor, ['b'])
    assert.deepEqual(result[symbol], ['c'])
    const symbolObject = { [Symbol.toPrimitive]: () => symbol }
    assert.deepEqual(Object.groupBy([1], () => symbolObject)[symbol], [1])
    const key = {}
    const groups = Map.groupBy([1, 2, 3], (_, index) => index < 2 ? key : null)
    assert.deepEqual(groups.get(key), [1, 2])
    assert.deepEqual(groups.get(null), [3])
    assert.deepEqual(Map.groupBy([NaN, NaN], value => value).get(NaN), [NaN, NaN])
    assert.equal(Object.getOwnPropertyDescriptor(Object, 'groupBy').enumerable, false)
    assert.equal(Object.getOwnPropertyDescriptor(Map, 'groupBy').enumerable, false)
    assert.throws(() => Object.groupBy([], null), TypeError)
    assert.throws(() => Map.groupBy([], null), TypeError)
    let closed = false
    function* values() { try { yield 1 } finally { closed = true } }
    assert.throws(() => Object.groupBy(values(), () => { throw new Error('callback') }), /callback/)
    assert.equal(closed, true)
  } finally {
    if (objectDescriptor) Object.defineProperty(Object, 'groupBy', objectDescriptor)
    else delete Object.groupBy
    if (mapDescriptor) Object.defineProperty(Map, 'groupBy', mapDescriptor)
    else delete Map.groupBy
  }
})

test('native grouping functions remain untouched', async () => {
  const objectGroupBy = Object.groupBy
  const mapGroupBy = Map.groupBy
  await import('../src/polyfills.ts?native-webview')
  assert.equal(Object.groupBy, objectGroupBy)
  assert.equal(Map.groupBy, mapGroupBy)
})

const archive = zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<container><rootfiles/></container>'),
  'OEBPS/chapter.xhtml': strToU8('<html><body>Readable chapter 中文</body></html>'),
  // Larger than foliate's extended 1 MiB tail scan: it must slice the provider File.
  'OEBPS/padding.bin': [new Uint8Array(1_100_000), { level: 0 }],
})

configure({ useWebWorkers: false })
async function readChapter(file) {
  const reader = new ZipReader(new BlobReader(file))
  try {
    const entries = await reader.getEntries()
    const chapter = entries.find(entry => entry.filename === 'OEBPS/chapter.xhtml')
    assert.ok(chapter)
    return await chapter.getData(new TextWriter())
  } finally {
    await reader.close()
  }
}

test('ZIP fallback reads real compressed entries when a provider returns bad file slices', async () => {
  const file = new File([archive], '书.epub', { type: 'application/epub+zip', lastModified: 123 })
  file.slice = function (start, end) { return new Blob([new Uint8Array(Math.max(0, (end ?? this.size) - (start ?? 0)))]) }
  await assert.rejects(readChapter(file), /End of central directory not found/)
  let attempts = 0
  const chapter = await openBookWithFileFallback(file, async candidate => {
    attempts++
    assert.equal(candidate.name, file.name)
    assert.equal(candidate.type, file.type)
    assert.equal(candidate.lastModified, file.lastModified)
    return readChapter(candidate)
  })
  assert.equal(attempts, 2)
  assert.match(chapter, /Readable chapter 中文/)
})

test('healthy files stay on the lazy path without a full copy', async () => {
  const file = new File([archive], 'normal.epub')
  file.arrayBuffer = () => { throw new Error('unexpected full read') }
  assert.match(await openBookWithFileFallback(file, readChapter), /Readable chapter/)
})

test('truncated archives still fail after one bounded retry', async () => {
  const file = new File([archive.slice(0, -30)], 'truncated.epub')
  let attempts = 0
  await assert.rejects(openBookWithFileFallback(file, candidate => {
    attempts++
    return readChapter(candidate)
  }), /End of central directory not found/)
  assert.equal(attempts, 2)
})

test('unrelated EPUB errors do not trigger a second parse', async () => {
  const failure = new Error('Invalid EPUB package')
  let attempts = 0
  await assert.rejects(openBookWithFileFallback(new File([archive], 'book.epub'), async () => {
    attempts++
    throw failure
  }), error => error === failure)
  assert.equal(attempts, 1)
})

test('a short full-file read is not passed to the parser again', async () => {
  const file = new File([archive], 'short-read.epub')
  file.arrayBuffer = async () => new ArrayBuffer(0)
  const failure = new Error('End of central directory not found')
  let attempts = 0
  await assert.rejects(openBookWithFileFallback(file, async () => {
    attempts++
    throw failure
  }), error => error === failure)
  assert.equal(attempts, 1)
})
