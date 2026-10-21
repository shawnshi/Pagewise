import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { root, artifact, compile, runJvm, emit } from './native-import-test-tools.mjs'

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
export function epub(overrides = {}) {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OPS/package.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" xml:lang="en" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
      <dc:title id="sub">Subtitle</dc:title><dc:title id="main">Synthetic title</dc:title><meta refines="#main" property="title-type">main</meta>
      <meta refines="#main" property="alternate-script" xml:lang="zh">合成标题</meta>
      <dc:creator id="a" opf:role="aut">Alice</dc:creator><dc:creator opf:role="edt">Editor only</dc:creator><dc:contributor opf:role="aut">Bob</dc:contributor>
      <dc:language>en</dc:language><dc:language>zh-CN</dc:language><dc:publisher>Publisher &amp; Co</dc:publisher>
      <dc:description><![CDATA[<p>Evidence &amp; context</p>]]></dc:description><dc:date opf:event="modification">2026-01</dc:date><dc:date opf:event="publication">2020</dc:date>
      <dc:subject>Geometry</dc:subject><dc:subject>Geometry</dc:subject><dc:subject>儿童</dc:subject>
      </metadata><manifest><item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/></manifest><spine/></package>`),
    'OPS/images/cover.png': png,
    ...overrides,
  }, { level: 6 })
}
export function mobi({ title = 'MOBI 标题', boundary = null, version = 6, author = 'Author &amp; Writer', lang = 'zh-CN', coverOffset = 0, thumbnailOffset } = {}) {
  const header = (title, version, resourceStart, exthBoundary) => {
    const fields = [[100, author], [101, 'Native publisher'], [103, '<p>A &amp; B</p>'], [105, '主题'], [105, '主题'], [106, '1999'], [503, title]]
    if (lang) fields.push([524, lang])
    for (const [type, value] of [[201, coverOffset], [202, thumbnailOffset], [121, exthBoundary]]) if (value !== undefined && value !== null) {
      const b = Buffer.alloc(4); b.writeUInt32BE(value); fields.push([type, b])
    }
    const records = fields.map(([type, text]) => { const b = Buffer.isBuffer(text) ? text : Buffer.from(text); const r = Buffer.alloc(8 + b.length); r.writeUInt32BE(type); r.writeUInt32BE(r.length, 4); b.copy(r, 8); return r })
    const exth = Buffer.concat([Buffer.from('EXTH'), Buffer.alloc(8), ...records]); exth.writeUInt32BE(exth.length, 4); exth.writeUInt32BE(records.length, 8)
    const h = Buffer.alloc(248); h.writeUInt16BE(1); h.writeUInt32BE(32, 4); h.writeUInt16BE(1, 8)
    h.write('MOBI', 16); h.writeUInt32BE(232, 20); h.writeUInt32BE(65001, 28); h.writeUInt32BE(version, 36)
    h[95] = 10; h[94] = 12; h.writeUInt32BE(resourceStart, 108); h.writeUInt32BE(64, 128); h.writeUInt32BE(0xffffffff, 244)
    const rawTitle = Buffer.from(title); h.writeUInt32BE(h.length + exth.length, 84); h.writeUInt32BE(rawTitle.length, 88)
    return Buffer.concat([h, exth, rawTitle])
  }
  const records = boundary === null ? [header(title, version, 2), Buffer.from('<html><body>text</body></html>'), png]
    : [header(title, 6, 3, 2), Buffer.from('<html><body>old</body></html>'), header('KF8 主标题', 8, 3), png]
  const pdb = Buffer.alloc(78 + records.length * 8); pdb.write('BOOKMOBI', 60); pdb.writeUInt16BE(records.length, 76)
  let offset = pdb.length
  records.forEach((r, i) => { pdb.writeUInt32BE(offset, 78 + i * 8); offset += r.length })
  return Buffer.concat([pdb, ...records])
}

test('production native bibliography parsers preserve field/cover contracts and reject malformed input without WebView', { timeout: 100000 }, () => {
  const out = resolve(root, '../.cache/native-import-20261021/metadata-host'), fixtures = join(out, 'synthetic')
  mkdirSync(fixtures, { recursive: true })
  const put = (name, data) => writeFileSync(join(fixtures, name), data)
  put('good.epub', epub())
  put('large-body.epub', epub({ 'OPS/unused.xhtml': new Uint8Array(64 * 1024 * 1024) }))
  put('unsafe.epub', epub({ 'META-INF/container.xml': strToU8('<!DOCTYPE container [<!ENTITY steal SYSTEM "file:///DO_NOT_READ">]><container>&steal;</container>') }))
  put('traversal.epub', epub({ 'META-INF/container.xml': strToU8('<container><rootfile full-path="%2e%2e/private.opf"/></container>') }))
  put('cover-error.epub', epub({ 'OPS/images/cover.png': new Uint8Array(12 * 1024 * 1024 + 1) }))
  put('good.mobi', mobi())
  put('combo.mobi', mobi({ boundary: 2 }))
  put('fallback.mobi', mobi({ lang: '', coverOffset: 0xffffffff, thumbnailOffset: 0 }))
  const broken = mobi(); broken.writeUInt32BE(0x7fffffff, broken.readUInt32BE(78) + 84); put('broken.mobi', broken)
  put('heading.md', '# Title **bold** &amp; `code` [link](https://fixture.invalid)\n\nBody')
  put('preamble.md', 'A paragraph before the title.\n\n# Not the first chapter\n')
  put('html.md', '<!-- ignored -->\n\n<h1>Raw <em>heading</em></h1>\n')
  put('huge.md', '# ' + 'x'.repeat(200000))
  put('empty.txt', '')
  put('not.epub', 'not a zip')
  const encoded = spawnSync('python', ['-c', 'from pathlib import Path;import sys;Path(sys.argv[1]).write_bytes("# 中文标题\\n\\n正文".encode("gb18030"))', join(fixtures, 'gb.md')], { encoding: 'utf8' })
  assert.equal(encoded.status, 0, encoded.stderr)
  const main = emit(out, 'MetadataHost.kt', `package io.pagewise.reader
import java.io.File
fun main(args: Array<String>) {
 val root=File(args[0]);var assertions=0
 fun verify(value: Boolean){assertions++;check(value)}
 fun read(name: String)=NativeBookMetadata.parse(File(root,name),name)
 val epub=read("good.epub")
 verify(epub.title=="Synthetic title, 合成标题");verify(epub.author=="Alice, Bob");verify(epub.tags==listOf("Geometry","儿童"))
 verify(epub.publisher=="Publisher & Co");verify(epub.language=="en, zh-CN");verify(epub.publicationDate=="2020")
 verify(epub.description=="<p>Evidence &amp; context</p>");verify(epub.cover!!.contentEquals(read("large-body.epub").cover!!))
 verify(read("cover-error.epub").cover==null)
 val mobi=read("good.mobi");verify(mobi.title=="MOBI 标题");verify(mobi.author=="Author & Writer");verify(mobi.description=="<p>A & B</p>")
 verify(mobi.publicationDate=="1999");verify(mobi.tags==listOf("主题"));verify(mobi.language=="zh-CN")
 verify(read("combo.mobi").title=="KF8 主标题");verify(read("combo.mobi").cover!!.contentEquals(mobi.cover!!))
 verify(read("fallback.mobi").language=="es");verify(read("fallback.mobi").cover!!.contentEquals(mobi.cover!!))
 verify(read("heading.md").title=="Title bold & code link");verify(read("preamble.md").title=="preamble");verify(read("html.md").title=="Raw heading")
 verify(read("gb.md").title=="中文标题");verify(read("empty.txt").title=="empty")
 for(name in listOf("unsafe.epub","traversal.epub","broken.mobi","not.epub","huge.md")) {val failed=try{read(name);false}catch(e: Exception){true};verify(failed)}
 var stopped=false
 try{NativeBookMetadata.parse(File(root,"good.epub"),"good.epub",true){throw NativeImportFailure("cancelled")}}catch(e: NativeImportFailure){stopped=e.code=="cancelled"};verify(stopped)
 println("PASS metadata assertions="+assertions+"; XML/PalmDOC/Markdown production code; 64MiB unused chapter under 48MiB JVM heap")
}
`)
  const cp = compile(out, [join(root, 'src-tauri/android/NativeBookMetadata.kt'), join(root, 'src-tauri/android/NativeMobiLocales.kt'), main],
    [artifact('org.commonmark', 'commonmark', '0.21.0'), artifact('net.sf.kxml', 'kxml2', '2.3.0')])
  const output = runJvm(out, 'run', ['-Xmx48m', '-cp', cp, 'io.pagewise.reader.MetadataHostKt', fixtures], 30000)
  assert.match(output, /PASS metadata assertions=/)
  console.log(output)
})
