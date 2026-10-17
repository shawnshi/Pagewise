// 格式转换 (→ EPUB) 的纯函数契约: OPF / nav / NCX / container 生成, XML 转义,
// 资源嗅探与相对路径改写, 文件名清洗, OCF 打包 (mimetype 首位且不压缩).
// 运行: npm run test:convert-epub
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unzipSync, strFromU8 } from 'fflate'
import {
  baseNameOf, buildContainerXml, buildCoverXhtml, buildNav, buildNcx, buildOpf, escapeXml, extensionFor,
  folderFor, isCompressedMedia, isXmlName, normalizeDate, normalizeIsbn, normalizeLanguage, normalizeMediaType,
  relativeHref, rewriteCssUrls, sanitizeFileName, sniffMediaType, stripInvalidXmlChars, tocDepth, zipEpub,
  BLOB_URL_RE, ELEMENT_ATTRS, GLOBAL_ATTRS, cssLength, crc32, legacyAttrStyle,
} from '../src/services/epubWriter.ts'
import { canConvertToEpub, EPUB_CONVERTIBLE } from '../src/services/format.ts'

/** 极简 XML 良构检查: 标签配对, 属性引号, 文本里没有裸 < 与非法 & */
function assertWellFormed(xml, label = 'xml') {
  let s = xml.replace(/^﻿/, '')
  assert.match(s, /^<\?xml version="1.0" encoding="utf-8"\?>/, `${label}: XML 声明`)
  s = s.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '')
  const stack = []
  const re = /<[^>]*>/g
  let last = 0
  let m
  let roots = 0
  const checkText = (text) => {
    assert.ok(!text.includes('<'), `${label}: 文本含裸 <`)
    const amp = text.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/)
    assert.ok(!amp, `${label}: 非法 & 于 ${JSON.stringify(text.slice(0, 60))}`)
  }
  while ((m = re.exec(s))) {
    checkText(s.slice(last, m.index))
    last = re.lastIndex
    const tag = m[0]
    const close = tag.match(/^<\/([\w:.-]+)\s*>$/)
    if (close) {
      assert.equal(stack.pop(), close[1], `${label}: 结束标签不匹配 ${tag}`)
      continue
    }
    const open = tag.match(/^<([\w:.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>$/)
    assert.ok(open, `${label}: 无法解析的标签 ${tag}`)
    for (const [, value] of open[2].matchAll(/="([^"]*)"/g)) checkText(value)
    if (!stack.length) roots++
    if (!open[3]) stack.push(open[1])
  }
  checkText(s.slice(last).trim())
  assert.equal(stack.length, 0, `${label}: 未闭合 ${stack.join(',')}`)
  assert.equal(roots, 1, `${label}: 必须只有一个根元素`)
}

test('escapeXml escapes markup and strips characters XML 1.0 forbids', () => {
  assert.equal(escapeXml(`a & b < c > "d" 'e'`), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;')
  assert.equal(escapeXml('x\u0000y\u0008z\u000Bw'), 'xyzw')
  assert.equal(escapeXml('tab\tnl\ncr\r'), 'tab\tnl\ncr\r')
  assert.equal(escapeXml('中文《书名》'), '中文《书名》')
  // 合法代理对保留, 落单代理项去掉
  assert.equal(stripInvalidXmlChars('😀'), '😀')
  assert.equal(stripInvalidXmlChars('a\uD800b\uDC00c'), 'abc')
  assert.equal(stripInvalidXmlChars('￾￿!'), '!')
})

test('isXmlName rejects MOBI-style prefixed and malformed names', () => {
  assert.ok(isXmlName('p'))
  assert.ok(isXmlName('data-x'))
  assert.ok(!isXmlName('mbp:nu'))
  assert.ok(!isXmlName('1abc'))
  assert.ok(!isXmlName('a b'))
  assert.ok(!isXmlName(''))
})

test('sanitizeFileName keeps the name readable and safe', () => {
  assert.equal(sanitizeFileName('Alice in Wonderland'), 'Alice in Wonderland.epub')
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j.epub')
  assert.equal(sanitizeFileName('  ..hidden..  '), 'hidden.epub')
  assert.equal(sanitizeFileName(''), 'book.epub')
  assert.equal(sanitizeFileName('CON'), '_CON.epub')
  assert.equal(sanitizeFileName('三体：黑暗森林'), '三体：黑暗森林.epub')
  assert.equal(sanitizeFileName('x\u0000y\nz'), 'x y z.epub')
  const long = sanitizeFileName('长'.repeat(300))
  assert.equal(Array.from(long).length, 120 + '.epub'.length)
  // 不能截断代理对
  const emoji = sanitizeFileName('😀'.repeat(200), 'epub', 10)
  assert.equal(emoji, '😀'.repeat(10) + '.epub')
  assert.equal(baseNameOf('book.fb2.zip'), 'book')
  assert.equal(baseNameOf('my.book.azw3'), 'my.book')
  assert.equal(baseNameOf('noext'), 'noext')
})

test('sniffMediaType recognises images, fonts and SVG by magic bytes', () => {
  const u8 = (...b) => new Uint8Array([...b, ...new Array(32).fill(0)])
  const txt = s => new TextEncoder().encode(s)
  assert.equal(sniffMediaType(u8(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
  assert.equal(sniffMediaType(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png')
  assert.equal(sniffMediaType(txt('GIF89a......')), 'image/gif')
  assert.equal(sniffMediaType(txt('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
  assert.equal(sniffMediaType(u8(0x00, 0x01, 0x00, 0x00)), 'font/ttf')
  assert.equal(sniffMediaType(txt('OTTO....')), 'font/otf')
  assert.equal(sniffMediaType(txt('wOFF....')), 'font/woff')
  assert.equal(sniffMediaType(txt('wOF2....')), 'font/woff2')
  assert.equal(sniffMediaType(txt('﻿<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml')
  assert.equal(sniffMediaType(txt('  <svg viewBox="0 0 1 1"></svg>')), 'image/svg+xml')
  assert.equal(sniffMediaType(txt('hello'), 'application/octet-stream'), 'application/octet-stream')
  assert.equal(normalizeMediaType('image/jpg'), 'image/jpeg')
  assert.equal(normalizeMediaType('application/x-font-ttf'), 'font/ttf')
  assert.equal(normalizeMediaType('application/vnd.ms-opentype'), 'font/otf')
  assert.equal(normalizeMediaType('text/css; charset=utf-8'), 'text/css')
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('font/woff2'), 'woff2')
  assert.equal(extensionFor('application/x-unknown'), 'bin')
  assert.equal(folderFor('image/png'), 'Images')
  assert.equal(folderFor('font/ttf'), 'Fonts')
  assert.equal(folderFor('text/css'), 'Styles')
  assert.equal(folderFor('audio/mpeg'), 'Media')
  assert.ok(isCompressedMedia('image/jpeg'))
  assert.ok(!isCompressedMedia('image/svg+xml'))
  assert.ok(!isCompressedMedia('font/ttf'))
})

test('relativeHref rewrites resource paths between package folders', () => {
  assert.equal(relativeHref('Text/s0001.xhtml', 'Images/r1.jpg'), '../Images/r1.jpg')
  assert.equal(relativeHref('Text/s0001.xhtml', 'Text/s0002.xhtml'), 's0002.xhtml')
  assert.equal(relativeHref('Styles/r2.css', 'Fonts/r3.ttf'), '../Fonts/r3.ttf')
  assert.equal(relativeHref('Styles/r2.css', 'Styles/r4.css'), 'r4.css')
  assert.equal(relativeHref('nav.xhtml', 'Text/s0001.xhtml'), 'Text/s0001.xhtml')
  assert.equal(relativeHref('Text/cover.xhtml', 'Images/cover.jpg'), '../Images/cover.jpg')
  assert.equal(relativeHref('Text/a b.xhtml', 'Images/图 1.png'), '../Images/%E5%9B%BE%201.png')
})

test('rewriteCssUrls rewrites url() and @import, leaving unknown references alone', () => {
  const css = `@font-face { src: url(blob:http://x/1) format("truetype"), url('blob:http://x/2'); }
body { background: url( "blob:http://x/3" ); }
@import "blob:http://x/4";
.keep { background: url(#frag); }`
  const map = { 'blob:http://x/1': '../Fonts/r1.ttf', 'blob:http://x/2': '../Fonts/r2.otf', 'blob:http://x/3': '../Images/r3.png', 'blob:http://x/4': 'r4.css' }
  const out = rewriteCssUrls(css, u => map[u] ?? null)
  assert.match(out, /url\("\.\.\/Fonts\/r1\.ttf"\) format\("truetype"\)/)
  assert.match(out, /url\("\.\.\/Fonts\/r2\.otf"\)/)
  assert.match(out, /background: url\("\.\.\/Images\/r3\.png"\)/)
  assert.match(out, /@import "r4\.css"/)
  assert.match(out, /url\(#frag\)/)
  assert.deepEqual('a blob:http://localhost:4173/1f-2a b url(blob:null/xyz)'.match(BLOB_URL_RE),
    ['blob:http://localhost:4173/1f-2a', 'blob:null/xyz'])
})

test('metadata normalisers', () => {
  assert.equal(normalizeDate('2009-10-01T00:00:00+00:00'), '2009-10-01')
  assert.equal(normalizeDate('1865'), '1865')
  assert.equal(normalizeDate('2001-07'), '2001-07')
  assert.equal(normalizeDate('Oct 2001'), undefined)
  assert.equal(normalizeIsbn('978-7-5366-9293-0'), '9787536692930')
  assert.equal(normalizeIsbn('urn:isbn:0-306-40615-x'), '030640615X')
  assert.equal(normalizeIsbn('12345'), undefined)
  assert.equal(normalizeLanguage('zh_CN'), 'zh-CN')
  assert.equal(normalizeLanguage('en'), 'en')
  assert.equal(normalizeLanguage(''), 'und')
  assert.equal(normalizeLanguage('english language'), 'und')
})

const toc = [
  { label: 'Chapter 1 & <Intro>', href: 'Text/s0001.xhtml', children: [
    { label: '1.1', href: 'Text/s0001.xhtml#lr-a1' },
    { label: '', href: 'Text/s0002.xhtml#x' },
  ] },
  { label: '第二章', href: 'Text/s0003.xhtml' },
]

test('buildOpf writes EPUB 3 metadata, manifest, spine with NCX and cover fallbacks', () => {
  const opf = buildOpf({
    metadata: {
      identifier: 'urn:uuid:1234', title: 'Alice & Bob', authors: ['Lewis Carroll', '佚名'], language: 'en',
      publisher: 'Pub <X>', description: 'Line "one"\nLine two', isbn: '9787536692930', date: '1865-11-26T00:00:00Z',
      subjects: ['Fiction', ''], rights: 'Public domain', modified: '2026-10-05T00:00:00Z',
    },
    manifest: [
      { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
      { id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' },
      { id: 's1', href: 'Text/s0001.xhtml', mediaType: 'application/xhtml+xml', properties: 'svg' },
      { id: 'r1', href: 'Images/r1.jpg', mediaType: 'image/jpeg', properties: 'cover-image' },
    ],
    spine: [{ idref: 's1' }, { idref: 's2', linear: false }],
    ncxId: 'ncx', coverId: 'r1', direction: 'rtl',
  })
  assertWellFormed(opf, 'opf')
  assert.match(opf, /<package xmlns="http:\/\/www.idpf.org\/2007\/opf" version="3.0" unique-identifier="uid" xml:lang="en">/)
  assert.match(opf, /<dc:identifier id="uid">urn:uuid:1234<\/dc:identifier>/)
  assert.match(opf, /<dc:identifier id="isbn">urn:isbn:9787536692930<\/dc:identifier>/)
  assert.match(opf, /<dc:title>Alice &amp; Bob<\/dc:title>/)
  assert.match(opf, /<dc:creator id="creator1">Lewis Carroll<\/dc:creator>/)
  assert.match(opf, /<dc:creator id="creator2">佚名<\/dc:creator>/)
  assert.match(opf, /<meta refines="#creator1" property="role" scheme="marc:relators">aut<\/meta>/)
  assert.match(opf, /<dc:language>en<\/dc:language>/)
  assert.match(opf, /<dc:publisher>Pub &lt;X&gt;<\/dc:publisher>/)
  assert.match(opf, /<dc:date>1865-11-26<\/dc:date>/)
  assert.match(opf, /<dc:description>Line &quot;one&quot;\nLine two<\/dc:description>/)
  assert.equal(opf.match(/<dc:subject>/g).length, 1)
  assert.match(opf, /<meta property="dcterms:modified">2026-10-05T00:00:00Z<\/meta>/)
  assert.match(opf, /<meta name="cover" content="r1"\/>/)
  assert.match(opf, /<item id="r1" href="Images\/r1.jpg" media-type="image\/jpeg" properties="cover-image"\/>/)
  assert.match(opf, /<item id="nav" href="nav.xhtml" media-type="application\/xhtml\+xml" properties="nav"\/>/)
  assert.match(opf, /<spine toc="ncx" page-progression-direction="rtl">/)
  assert.match(opf, /<itemref idref="s1"\/>/)
  assert.match(opf, /<itemref idref="s2" linear="no"\/>/)
  assert.doesNotMatch(opf, /rendition:layout/)

  const fixed = buildOpf({
    metadata: { identifier: 'u', title: '', authors: [], modified: '2026-01-01T00:00:00Z' },
    manifest: [], spine: [], fixedLayout: true,
  })
  assertWellFormed(fixed, 'opf-fixed')
  assert.match(fixed, /prefix="rendition: http:\/\/www.idpf.org\/vocab\/rendition\/#"/)
  assert.match(fixed, /<meta property="rendition:layout">pre-paginated<\/meta>/)
  assert.match(fixed, /<dc:title>Untitled<\/dc:title>/)
  assert.match(fixed, /<dc:language>und<\/dc:language>/)
  assert.doesNotMatch(fixed, /dc:creator/)
})

test('buildContainerXml points at the package document', () => {
  const xml = buildContainerXml()
  assertWellFormed(xml, 'container')
  assert.match(xml, /<rootfile full-path="OEBPS\/content.opf" media-type="application\/oebps-package\+xml"\/>/)
})

test('buildNav renders a nested, escaped toc with label fallbacks and hidden landmarks', () => {
  const nav = buildNav(toc, { title: 'Alice', language: 'zh', tocTitle: '目录', landmarks: [{ type: 'bodymatter', href: 'Text/s0001.xhtml', label: 'Start' }] })
  assertWellFormed(nav, 'nav')
  assert.match(nav, /xmlns:epub="http:\/\/www.idpf.org\/2007\/ops" lang="zh" xml:lang="zh"/)
  assert.match(nav, /<nav epub:type="toc" id="toc">/)
  assert.match(nav, /<a href="Text\/s0001.xhtml">Chapter 1 &amp; &lt;Intro&gt;<\/a>/)
  assert.match(nav, /<a href="Text\/s0001.xhtml#lr-a1">1.1<\/a>/)
  // 空标签兜底为序号
  assert.match(nav, /<a href="Text\/s0002.xhtml#x">2<\/a>/)
  assert.equal(nav.match(/<ol>/g).length, 3) // toc 两层 + landmarks
  assert.match(nav, /<nav epub:type="landmarks" id="landmarks" hidden="hidden">/)
  // 没有目录时至少有一项
  const empty = buildNav([], { title: 'Only' })
  assertWellFormed(empty, 'nav-empty')
  assert.match(empty, /<li><a href="">Only<\/a><\/li>/)
})

test('buildNcx mirrors the toc with sequential playOrder and depth', () => {
  const ncx = buildNcx(toc, { identifier: 'urn:uuid:1', title: 'A & B' })
  assertWellFormed(ncx, 'ncx')
  assert.equal(tocDepth(toc), 2)
  assert.match(ncx, /<meta name="dtb:uid" content="urn:uuid:1"\/>/)
  assert.match(ncx, /<meta name="dtb:depth" content="2"\/>/)
  assert.match(ncx, /<docTitle><text>A &amp; B<\/text><\/docTitle>/)
  const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map(m => Number(m[1]))
  assert.deepEqual(orders, [1, 2, 3, 4])
  assert.match(ncx, /<content src="Text\/s0001.xhtml#lr-a1"\/>/)
  // 父节点在子节点之前开始, 子节点嵌套在父节点里
  assert.ok(ncx.indexOf('id="np1"') < ncx.indexOf('id="np2"'))
  assert.ok(ncx.indexOf('id="np3"') < ncx.indexOf('</navPoint>\n    <navPoint id="np4"'))
})

test('buildCoverXhtml is a well-formed XHTML cover page', () => {
  const xhtml = buildCoverXhtml('../Images/cover.jpg', { title: 'T & "Q"', language: 'en' })
  assertWellFormed(xhtml, 'cover')
  assert.match(xhtml, /<img src="..\/Images\/cover.jpg" alt="T &amp; &quot;Q&quot;"\/>/)
  assert.match(xhtml, /<body epub:type="cover">/)
})

test('zipEpub writes mimetype first, stored and without extra field; media stored, text deflated', async () => {
  const jpeg = new Uint8Array(4096).map((_, i) => (i * 7) & 0xff)
  let yields = 0
  const zip = await zipEpub([
    { path: 'META-INF/container.xml', data: buildContainerXml() },
    { path: 'OEBPS/content.opf', data: '<?xml version="1.0" encoding="utf-8"?><package/>' },
    { path: 'OEBPS/Text/s0001.xhtml', data: '<p>'.repeat(500) },
    { path: 'OEBPS/Images/r1.jpg', data: jpeg, store: true },
    { path: 'mimetype', data: 'ignored' },
    { path: 'OEBPS/Text/中文 名.xhtml', data: '<p>中文</p>' },
  ], () => { yields++ })
  assert.ok(yields >= 5, 'yields between files')
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  assert.equal(view.getUint32(0, true), 0x04034b50, 'local file header signature')
  assert.equal(view.getUint16(6, true) & 0x08, 0, 'no data descriptor')
  assert.equal(view.getUint16(8, true), 0, 'mimetype stored')
  const nameLen = view.getUint16(26, true)
  assert.equal(view.getUint16(28, true), 0, 'no extra field')
  assert.equal(strFromU8(zip.subarray(30, 30 + nameLen)), 'mimetype')
  assert.equal(strFromU8(zip.subarray(30 + nameLen, 30 + nameLen + 20)), 'application/epub+zip')

  const methods = {}
  const files = unzipSync(zip, { filter: f => { methods[f.name] = f.compression; return true } })
  assert.deepEqual(Object.keys(files), ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/Text/s0001.xhtml', 'OEBPS/Images/r1.jpg', 'OEBPS/Text/中文 名.xhtml'])
  assert.equal(strFromU8(files['OEBPS/Text/中文 名.xhtml']), '<p>中文</p>')
  assert.equal(strFromU8(files['OEBPS/Text/s0001.xhtml']), '<p>'.repeat(500))
  assert.equal(strFromU8(files.mimetype), 'application/epub+zip')
  assert.equal(methods['OEBPS/Images/r1.jpg'], 0)
  assert.equal(methods['OEBPS/Text/s0001.xhtml'], 8)
  assert.deepEqual(files['OEBPS/Images/r1.jpg'], jpeg)
})

test('only reflowable non-EPUB formats are offered for conversion', () => {
  for (const f of ['mobi', 'azw', 'azw3', 'fb2', 'fbz', 'txt', 'md', 'html']) assert.ok(canConvertToEpub(f), f)
  for (const f of ['epub', 'pdf', 'djvu', 'cbz', 'cbr', null, undefined]) assert.ok(!canConvertToEpub(f), String(f))
  assert.equal(EPUB_CONVERTIBLE.length, 8)
})

test('crc32 matches the zip standard check value and can be chained', () => {
  const data = new TextEncoder().encode('123456789')
  assert.equal(crc32(data), 0xcbf43926)
  assert.equal(crc32(data.subarray(4), crc32(data.subarray(0, 4))), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('legacy presentational attributes become CSS (MOBI 6 width/height = indent/spacing)', () => {
  assert.equal(cssLength('12'), '12px')
  assert.equal(cssLength('0'), '0')
  assert.equal(cssLength('-19pt'), '-19pt')
  assert.equal(cssLength('50%'), '50%')
  assert.equal(cssLength('1.5em'), '1.5em')
  assert.equal(cssLength('auto'), null)
  assert.equal(legacyAttrStyle('p', 'p', 'width', '-19pt'), 'text-indent: -19pt')
  assert.equal(legacyAttrStyle('p', 'p', 'height', '1em'), 'margin-top: 1em')
  assert.equal(legacyAttrStyle('td', 'td', 'width', '120'), 'width: 120px')
  assert.equal(legacyAttrStyle('table', 'table', 'width', '80%'), 'width: 80%')
  assert.equal(legacyAttrStyle('span', 'span', 'width', '3'), '')
  assert.equal(legacyAttrStyle('p', 'p', 'align', 'CENTER'), 'text-align: center')
  assert.equal(legacyAttrStyle('td', 'td', 'align', 'right'), 'text-align: right')
  assert.equal(legacyAttrStyle('img', 'img', 'align', 'left'), 'float: left')
  assert.equal(legacyAttrStyle('img', 'img', 'align', 'middle'), 'vertical-align: middle')
  assert.equal(legacyAttrStyle('table', 'table', 'align', 'center'), 'margin-left: auto; margin-right: auto')
  assert.equal(legacyAttrStyle('td', 'td', 'valign', 'TOP'), 'vertical-align: top')
  assert.equal(legacyAttrStyle('font', 'span', 'size', '+2'), 'font-size: x-large')
  assert.equal(legacyAttrStyle('font', 'span', 'size', '7'), 'font-size: xxx-large')
  assert.equal(legacyAttrStyle('font', 'span', 'size', '-5'), 'font-size: x-small')
  assert.equal(legacyAttrStyle('font', 'span', 'color', '#f00'), 'color: #f00')
  assert.equal(legacyAttrStyle('font', 'span', 'face', 'serif'), 'font-family: serif')
  assert.equal(legacyAttrStyle('p', 'p', 'color', 'red'), '')
  assert.equal(legacyAttrStyle('table', 'table', 'cellspacing', '0'), 'border-spacing: 0')
  assert.equal(legacyAttrStyle('td', 'td', 'nowrap', ''), 'white-space: nowrap')
  assert.equal(legacyAttrStyle('ul', 'ul', 'type', 'square'), 'list-style-type: square')
  assert.equal(legacyAttrStyle('a', 'a', 'name', 'x'), 'id')
  assert.equal(legacyAttrStyle('a', 'a', 'name', 'x', true), '')
  assert.equal(legacyAttrStyle('p', 'p', 'tag', 'whatever'), '')
  // 白名单: EPUB 3 允许的属性原样保留
  assert.ok(GLOBAL_ATTRS.has('class') && GLOBAL_ATTRS.has('lang'))
  assert.ok(ELEMENT_ATTRS.img.includes('alt') && ELEMENT_ATTRS.td.includes('colspan'))
  assert.ok(!ELEMENT_ATTRS.p)
})
