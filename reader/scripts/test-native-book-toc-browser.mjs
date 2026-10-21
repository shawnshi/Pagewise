import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'
const out = resolve(readerRoot, '../.cache/native-pages-20261021/toc-browser')
mkdirSync(out, { recursive: true })
const xml = {
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OPS/package.opf': '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:synthetic:native-toc</dc:identifier><dc:title>Synthetic EPUB</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-21T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
  'OPS/nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>TOC</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章</a><ol><li><a href="one.xhtml#nested">子节</a></li></ol></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>',
  'OPS/one.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>第一章</h1><p id="nested">Synthetic content only.</p></body></html>',
  'OPS/two.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>第二章</h1></body></html>',
}
const epub = zipSync(Object.fromEntries(Object.entries(xml).map(([p, value]) => [p, strToU8(value)])), { level: 0 })
writeFileSync(resolve(out, 'synthetic.epub'), epub)
test('actual secured Foliate opener parses synthetic EPUB bytes and native TOC pagination; malformed bytes propagate', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'native-toc-fixture', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/__toc.html') { res.setHeader('content-type', 'text/html'); res.end('<title>Native TOC test</title>'); return }
      if (req.url === '/__toc.epub') { res.setHeader('content-type', 'application/epub+zip'); res.end(epub); return }
      next()
    })
  } }] })
  let browser
  try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true })
    const context = await browser.newContext({ serviceWorkers: 'block' }), external = []
    try {
      await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(origin + '/') || url.startsWith('blob:' + origin + '/')) return route.continue(); external.push(new URL(url).origin); return route.abort() })
      const page = await context.newPage(); await page.goto(origin + '/__toc.html')
      const result = await page.evaluate(async () => {
        const { createNativeBookTocActions } = await import('/src/services/nativeBookTocAction.ts')
        const bytes = await (await fetch('/__toc.epub')).blob()
        const book = { id: 'synthetic', title: 'Synthetic EPUB', author: 'Synthetic', format: 'epub', fileName: 'synthetic.epub', tags: [], addedAt: 1, hasCover: false }
        // Only canonical book/file IO is synthetic; leave the production secured opener untouched.
        const action = createNativeBookTocActions({ metadata: async () => book, file: async () => bytes }).bookToc
        const first = await action({ bookId: 'synthetic', limit: 2 })
        const second = await action({ bookId: 'synthetic', token: first.token, offset: 2, limit: 2 })
        let malformedRejected = false
        try { await createNativeBookTocActions({ metadata: async () => book, file: async () => new Blob(['malformed']) }).bookToc({ bookId: 'synthetic' }) }
        catch { malformedRejected = true }
        return { total: first.total, first: first.items, second: second.items, malformedRejected }
      })
      assert.equal(result.total, 3)
      assert.deepEqual(result.first, [{ title: '第一章', depth: 0 }, { title: '子节', depth: 1 }])
      assert.deepEqual(result.second, [{ title: '第二章', depth: 0 }]); assert.equal(result.malformedRejected, true); assert.deepEqual(external, [])
      writeFileSync(resolve(out, 'result.json'), JSON.stringify({ actualSecuredOpener: true, syntheticOnly: true, result, externalRequests: 0, androidRuntime: false }, null, 2))
    } finally { await context.close() }
  } finally { await browser?.close(); await server.close() }
})
