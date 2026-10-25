import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { isReaderInteractive } from '../src/services/readerSession.ts'

const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  cacheDir: fileURLToPath(new URL('../../.cache/ui-ux-20261022/ssr-vite', import.meta.url)),
  server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' })
after(() => server.close())
const { decodeText, convertToEpubLocal, TEXT_EPUB_LAYOUT } = await server.ssrLoadModule('/src/services/textToEpub.ts')

test('PW-09 plain SVG/image covers are page-turn surfaces, while links and image maps remain interactive', () => {
  const element = tag => ({ closest: selector => selector.split(',').map(s => s.trim()).includes(tag) ? {} : null })
  assert.equal(isReaderInteractive(element('svg')), false)
  assert.equal(isReaderInteractive(element('img')), false)
  assert.equal(isReaderInteractive(element('a[href]')), true)
  assert.equal(isReaderInteractive(element('img[usemap]')), true)
  assert.equal(isReaderInteractive(element('button')), true)
})

test('PW-12 UTF-8 BOM and GB18030 decode without replacing characters', async () => {
  assert.equal(await decodeText(new Blob(['\uFEFF中文 test'])), '中文 test')
  assert.equal(await decodeText(new Blob([new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])])), '中文')
  await assert.rejects(() => decodeText(new Blob([new Uint8Array([0x81])])), TypeError)
})

test('PW-12 generated TXT EPUB does not falsely declare Chinese or invalidate existing layout anchors', async () => {
  const text = 'Chapter 1\n\nThis is an English fixture with a stable position and no private material.\n\nChapter 2\n\nThe second chapter preserves order and escapes <markup> & content.'
  const converted = await convertToEpubLocal(new Blob([text]), 'fixture.txt', 'txt')
  const files = unzipSync(new Uint8Array(await converted.epub.arrayBuffer()))
  assert.match(strFromU8(files['OEBPS/content.opf']), /<dc:language>und<\/dc:language>/)
  const body = Object.entries(files).filter(([name]) => /OEBPS\/s\d+\.xhtml/.test(name)).map(([, value]) => strFromU8(value)).join('')
  assert.ok(body.indexOf('Chapter 1') < body.indexOf('Chapter 2'))
  assert.match(body, /&lt;markup&gt; &amp; content/)
  assert.match(body, /id="c0"/)
  assert.equal(TEXT_EPUB_LAYOUT, '2', 'metadata-only correction must not invalidate saved CFIs')
})

test('PW-12 empty TXT is rejected before constructing an unreadable EPUB', async () => {
  await assert.rejects(() => convertToEpubLocal(new Blob(['  \r\n']), 'empty.txt', 'txt'), /empty/i)
})
