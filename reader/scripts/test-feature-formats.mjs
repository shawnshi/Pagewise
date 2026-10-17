// Pure format-boundary tests; no books, storage, browser, or installed dependencies.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import * as format from '../src/services/format.ts'

const formatUrl = new URL('../src/services/format.ts', import.meta.url).href
async function loadBoundary(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const js = stripTypeScriptTypes(source).replaceAll("'./format'", JSON.stringify(formatUrl))
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const retired = ['azw', 'azw3', 'fb2', 'fbz', 'fb2.zip', 'cbz', 'cbr', 'djvu', 'djv', 'html', 'htm', 'xhtml']
const active = { epub: 'epub', mobi: 'mobi', pdf: 'pdf', txt: 'txt', md: 'md', markdown: 'md' }

for (const ext of retired) test(`retired extension rejected: ${ext}`, () => {
  assert.equal(format.detectFormat(`book.${ext}`), null)
  assert.equal(format.detectFormat(`BOOK.${ext.toUpperCase()}`), null)
  assert.equal(format.isSupportedBookFormat(ext), false)
  assert.equal(format.canConvertToEpub(ext), false)
  assert.equal(format.isFoliateNative(ext), false)
  assert.equal(format.isTextLike(ext), false)
  assert.ok(!format.ACCEPT.split(',').includes(`.${ext}`))
})
for (const [ext, stored] of Object.entries(active)) test(`active extension retained: ${ext}`, () => {
  assert.equal(format.detectFormat(`book.${ext}`), stored)
  assert.equal(format.detectFormat(`BOOK.${ext.toUpperCase()}`), stored)
  assert.equal(format.isSupportedBookFormat(stored), true)
  assert.ok(format.ACCEPT.split(',').includes(`.${ext}`))
})
test('supported values reject malformed metadata and unknown extensions', () => {
  for (const value of [null, undefined, '', {}, [], 0, true, 'EPUB', '.epub', 'markdown']) {
    assert.equal(format.isSupportedBookFormat(value), false)
  }
  for (const name of ['book', 'book.zip', 'book.kfx', 'book.epub.exe', 'book.constructor', 'book.__proto__']) {
    assert.equal(format.detectFormat(name), null)
  }
  assert.deepEqual(format.SUPPORTED_EXTS, Object.keys(active))
  assert.deepEqual(format.EPUB_CONVERTIBLE, ['mobi', 'txt', 'md'])
})
test('legacy metadata has labels but cannot produce reader routes', async () => {
  const { readerPath } = await loadBoundary('../src/services/readerRoute.ts')
  for (const value of ['azw', 'azw3', 'fb2', 'fbz', 'cbz', 'cbr', 'djvu', 'html']) {
    assert.equal(typeof format.FORMAT_LABELS[value], 'string')
    assert.throws(() => readerPath({ id: 'legacy', format: value }), /Unsupported/)
  }
  assert.equal(readerPath({ id: 'paper', format: 'pdf' }), '/read-paper/paper')
  for (const value of ['epub', 'mobi', 'txt', 'md']) {
    assert.equal(readerPath({ id: 'active', format: value }), '/read/active')
  }
})
test('native parser rejects retired formats before loading foliate', async () => {
  const { makeFoliateBook } = await import('../src/services/foliateBook.ts')
  for (const ext of [...retired, 'txt', 'md', 'markdown', 'pdf']) {
    await assert.rejects(makeFoliateBook(new File(['not a book'], `book.${ext}`)), /Unsupported/)
  }
})
test('shared XHTML writer and Markdown HTML conversion remain in source', async () => {
  const text = await readFile(new URL('../src/services/textToEpub.ts', import.meta.url), 'utf8')
  const writer = await readFile(new URL('../src/services/bookToEpub.ts', import.meta.url), 'utf8')
  assert.match(text, /marked\.parse\(md/)
  assert.match(text, /toWellFormedBody\(html\)/)
  assert.match(text, /application\/xhtml\+xml/)
  assert.match(text, /format !== 'txt' && format !== 'md'/)
  assert.doesNotMatch(text, /htmlTitle|format: 'txt' \| 'md' \| 'html'/)
  assert.match(writer, /new DOMParser/)
  assert.match(writer, /parseDoc\(/)
})
