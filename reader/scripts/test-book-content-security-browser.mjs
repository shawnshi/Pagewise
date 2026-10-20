import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { createServer, readerRoot } from './vite-isolated.mjs'

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
const remote = 'https://pw-a01.invalid'
const attack = "parent.__bookExecuted++;parent.__bookRead=localStorage.getItem('PW-A01-fixture')"
const hostile = `<script>${attack}</script><script src="${remote}/script.js"></script>
  <img src="${remote}/image.png" onerror="${attack}"/><img srcset="${remote}/srcset.png 1x"/>
  <link rel="stylesheet" href="${remote}/external.css"/><link rel="prefetch" href="${remote}/prefetch"/>
  <style>@import url('${remote}/import.css'); .probe { background-image:url('${remote}/background.png') }</style>
  <iframe src="${remote}/frame"></iframe><iframe srcdoc="&lt;script&gt;parent.parent.__bookExecuted++&lt;/script&gt;"></iframe>
  <object data="${remote}/object"></object><embed src="${remote}/embed"/>
  <svg xmlns="http://www.w3.org/2000/svg" onload="${attack}"><script>${attack}</script>
    <a href="javascript:${attack}"><text>SVG action</text></a><image href="${remote}/svg-image"/>
    <foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="${remote}/foreign"/></foreignObject>
  </svg><a id="bad-link" href="java&#x09;script:${attack}">Bad link</a>
  <form action="${remote}/form"><button>submit</button></form><p class="probe">Hostile fixture</p>`
const body = `<h1>Fixture</h1><p id="text" class="local-style">Readable synthetic text for selection and CFI.</p><p id="target">Internal destination</p>`
function epub(fixed = false) {
  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'book.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">PW-A01-synthetic</dc:identifier><dc:title>Security fixture</dc:title><dc:language>en</dc:language>${fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest>
      <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      <item id="html" href="chapter.html" media-type="text/html"/>
      <item id="svg" href="chapter.svg" media-type="image/svg+xml"/>
      <item id="style" href="local.css" media-type="text/css"/>
      <item id="image" href="local.png" media-type="image/png"/>
      <item id="font" href="local.woff2" media-type="font/woff2"/>
      </manifest><spine><itemref idref="chapter"/><itemref idref="html"/><itemref idref="svg"/></spine></package>`),
    'chapter.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title><meta name="viewport" content="width=700,height=400"/><link rel="stylesheet" href="local.css"/></head><body>${body}<img id="local-image" src="local.png"/><a id="internal" href="chapter.xhtml#target">Internal</a>${hostile}</body></html>`),
    'chapter.html': strToU8(`<html><head><title>HTML fixture</title><meta name="viewport" content="width=700,height=400"/></head><body>${body}${hostile}</body></html>`),
    'chapter.svg': strToU8(`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="400" viewBox="0 0 700 400" onload="${attack}"><script>${attack}</script><text id="svg-text" x="10" y="40">Readable SVG fixture</text><image href="${remote}/spine-svg"/></svg>`),
    'local.css': strToU8(`@import url('${remote}/nested-import.css'); @font-face {font-family:Fixture;src:url('local.woff2')} .local-style {color:rgb(12, 34, 56);font-family:Fixture}`),
    'local.png': png,
    'local.woff2': new Uint8Array(readFileSync(new URL('../public/fonts/Literata-Regular.woff2', import.meta.url))),
  }
  return zipSync(files)
}
// Minimal, uncompressed MOBI6/PalmDB fixture; all bytes are synthetic.
function mobi() {
  const text = strToU8(`<html><head><title>MOBI</title></head><body>${body}<img id="local-image" recindex="1"/>${hostile}</body></html>`)
  const header = new Uint8Array(280), h = new DataView(header.buffer)
  h.setUint16(0, 1); h.setUint32(4, text.length); h.setUint16(8, 1); h.setUint16(10, 4096)
  header.set(strToU8('MOBI'), 16); h.setUint32(20, 232); h.setUint32(24, 2); h.setUint32(28, 65001); h.setUint32(36, 6)
  h.setUint32(84, 264); h.setUint32(88, 7); h.setUint32(108, 2); h.setUint32(244, 0xffffffff); header.set(strToU8('Fixture'), 264)
  const records = [header, text, png], offset = 78 + 8 * records.length + 2
  const output = new Uint8Array(offset + records.reduce((n, r) => n + r.length, 0)), view = new DataView(output.buffer)
  output.set(strToU8('PW-A01-Fixture')); output.set(strToU8('BOOKMOBI'), 60); view.setUint16(76, records.length)
  let pos = offset
  records.forEach((r, i) => { view.setUint32(78 + 8 * i, pos); output.set(r, pos); pos += r.length })
  return output
}

test('production Foliate opening/display: hostile EPUB/MOBI, local resources, selection and CFI', { timeout: 110000 }, async () => {
  let server, browser
  try {
    server = await createServer({ root: readerRoot, cacheDir: '../.cache/audit-stage1/vite', logLevel: 'error', server: { host: '127.0.0.1', port: 4419, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 930, height: 1240 }, serviceWorkers: 'block' })
    const remoteRequests = [], pageErrors = []
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (/^https?:$/.test(url.protocol) && (url.origin !== 'http://127.0.0.1:4419' || url.pathname.startsWith('/book-probe'))) {
        remoteRequests.push(route.request().url()); return route.abort()
      }
      return route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))
    await page.route('**/security-fixture.html', route => route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/fonts/fonts.css" data-pw-bundled-fonts/><style>html,body{margin:0;width:100%;height:100%}foliate-view{display:block;width:930px;height:1240px}</style><script type="module">
      import {makeFoliateBook} from '/src/services/foliateBook.ts';
      import {secureBookContent} from '/src/services/bookContentSecurity.ts';
      import {injectBundledFontsIntoDoc} from '/src/services/fonts.ts';
      window.injectBundledFontsIntoDoc=injectBundledFontsIntoDoc;
      window.secureBookContent=secureBookContent;
      window.openFixture=makeFoliateBook; window.FoliateView=function(){return document.createElement('foliate-view')}; window.ready=true;
    </script>` }))
    await page.goto('http://127.0.0.1:4419/security-fixture.html'); await page.waitForFunction(() => window.ready)
    const results = []
    for (const [name, bytes] of [['hostile.epub', epub()], ['hostile.mobi', mobi()], ['hostile-fixed.epub', epub(true)]]) {
      const result = await page.evaluate(async ({ name, bytes, baseBody, remote }) => {
        window.__bookExecuted = 0; window.__bookRead = null; localStorage.setItem('PW-A01-fixture', 'synthetic-parent-only')
        const book = await openFixture(new File([new Uint8Array(bytes)], name))
        const view = new FoliateView(), loadedDocs = new Map()
        view.addEventListener('load', event => loadedDocs.set(event.detail.index, event.detail.doc))
        document.body.append(view); await view.open(book)
        const chapters = []
        for (let i = 0; i < book.sections.length; i++) {
          try { await view.renderer.goTo({ index: i }) }
          catch (error) { chapters.push({ loadError: error.message }); continue }
          await new Promise(resolve => setTimeout(resolve, 250))
          const doc = loadedDocs.get(i)
          if (!doc) throw new Error(`Renderer did not load section ${i} of ${name}`)
          const text = doc.getElementById('text') ?? doc.getElementById('svg-text')
          const range = doc.createRange(); range.setStart(text.firstChild, 0); range.setEnd(text.firstChild, text.firstChild.length)
          doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range)
          const selected = doc.getSelection().toString()
          const cfi = view.getCFI(i, range), resolved = await view.resolveNavigation(cfi), restored = resolved.anchor(doc)
          let originalCFI = null, internalResolved = null
          if (i < 2) {
            const original = new DOMParser().parseFromString(`<html><head><title>Fixture</title></head><body>${baseBody}</body></html>`, 'text/html')
            const originalText = original.getElementById('text').firstChild, originalRange = original.createRange()
            originalRange.setStart(originalText, 0); originalRange.setEnd(originalText, originalText.length)
            originalCFI = view.getCFI(i, originalRange) === cfi
          }
          if (doc.getElementById('internal')) {
            let linkHref
            view.addEventListener('link', event => { linkHref = event.detail.href; event.preventDefault() }, { once: true })
            doc.getElementById('internal').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
            internalResolved = book.resolveHref(linkHref).anchor(doc).textContent === 'Internal destination'
          }
          // Deliberate post-sanitization mutations test CSP independently of stripping.
          const script = doc.createElement('script'); script.textContent = 'parent.__bookExecuted++'; doc.body.append(script)
          const probe = doc.createElement('img'); probe.src = `${remote}/csp-only-image`; probe.setAttribute('onerror', 'parent.__bookExecuted++'); doc.body.append(probe)
          const frame = doc.createElement('iframe'); frame.src = `${remote}/csp-only-frame`; doc.body.append(frame)
          const style = doc.createElement('style'); style.textContent = `@import url('${remote}/csp-only-style');`; doc.head.append(style)
          await new Promise(resolve => setTimeout(resolve, 100))
          const img = doc.getElementById('local-image')
          if (img && !img.complete) await Promise.race([new Promise(r => { img.onload = r; img.onerror = r }), new Promise(r => setTimeout(r, 2000))])
          if (i === 0 && name.endsWith('.epub')) await doc.fonts.load('16px Fixture')
          await injectBundledFontsIntoDoc(doc)
          void doc.defaultView.getComputedStyle(doc.body).fontFamily
          await new Promise(resolve => doc.defaultView.requestAnimationFrame(resolve))
          const sameOriginProbe = doc.createElement('style')
          sameOriginProbe.textContent = `@font-face {font-family:Blocked;src:url('${location.origin}/book-probe-font')} body {background-image:url('${location.origin}/book-probe-image')}`
          doc.head.append(sameOriginProbe)
          let blockedFont = false
          try { await doc.fonts.load('16px Blocked', 'Readable') } catch { blockedFont = true }
          await new Promise(resolve => setTimeout(resolve, 50))
          // Exercise javascript: URLs/events after initial load, as well as parser-time execution.
          doc.getElementById('bad-link')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
          const loadedBundled = await doc.fonts.load('16px "PW Literata"', 'Readable')
          chapters.push({ selected, cfiRestored: restored.toString() === selected, originalCFI, internalResolved, imageLoaded: img ? img.naturalWidth === 1 : null,
            color: text ? doc.defaultView.getComputedStyle(text).color : null, fontLoaded: i === 0 && name.endsWith('.epub') ? doc.fonts.check('16px Fixture') : null,
            bundledFont: doc.fonts.check('16px "PW Literata"', 'Readable'), blockedFont,
            bundledFacesLoaded: loadedBundled.length,
            viewport: doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
            internalHref: doc.getElementById('internal')?.getAttribute('href') ?? null,
            csp: !!doc.querySelector('meta[http-equiv="Content-Security-Policy"]') })
        }
        const output = { name, chapters, executed: window.__bookExecuted, parentRead: window.__bookRead }
        view.close(); view.remove(); book.destroy(); localStorage.removeItem('PW-A01-fixture')
        return output
      }, { name, bytes: Array.from(bytes), baseBody: body, remote })
      results.push(result)
    }
    const lifecycle = await page.evaluate(async () => {
      const source = URL.createObjectURL(new Blob(['<html><body><p>Lifecycle</p></body></html>'], { type: 'text/html' }))
      let loads = 0, unloads = 0, destroys = 0
      const nonrenderable = { linear: 'no' }
      const book = secureBookContent({ sections: [nonrenderable, { load: () => { loads++; return source }, unload: () => unloads++,
        createDocument: () => new DOMParser().parseFromString('<html><body onload="bad()"><script>bad()</script><p>Search</p></body></html>', 'text/html') }], destroy: () => destroys++ })
      const section = book.sections[1], first = await section.load(), repeated = await section.load()
      const searchDoc = await section.createDocument()
      section.unload()
      let revoked = false
      try { await fetch(first) } catch (error) { revoked = error instanceof TypeError }
      const second = await section.load()
      book.destroy(); book.destroy()
      let destroyedError, documentError
      try { await section.load() } catch (error) { destroyedError = error.message }
      try { await section.createDocument() } catch (error) { documentError = error.message }
      let release
      const late = secureBookContent({ sections: [{ load: () => new Promise(r => release = r) }] })
      const pending = late.sections[0].load(); late.destroy(); release(source)
      let cancelledError
      try { await pending } catch (error) { cancelledError = error.message }
      const failures = []
      for (const [content, type] of [['<html><broken>', 'application/xhtml+xml'], ['raw', 'application/octet-stream']]) {
        const url = URL.createObjectURL(new Blob([content], { type }))
        const broken = secureBookContent({ sections: [{ load: () => url }] })
        try { await broken.sections[0].load() } catch (error) { failures.push(error.message) }
        broken.destroy(); URL.revokeObjectURL(url)
      }
      const nonlocal = secureBookContent({ sections: [{ load: () => 'https://pw-a01.invalid/not-fetched' }] })
      try { await nonlocal.sections[0].load() } catch (error) { failures.push(error.message) }
      nonlocal.destroy(); URL.revokeObjectURL(source)
      return { nonrenderablePreserved: book.sections[0] === nonrenderable && !nonrenderable.load,
        cached: first === repeated, reloaded: first !== second, revoked, loads, unloads, destroys,
        searchSanitized: !searchDoc.querySelector('script') && !searchDoc.body.hasAttribute('onload'),
        destroyedError, documentError, cancelledError, failures }
    })
    console.log(JSON.stringify({ results, lifecycle, remoteRequests, pageErrors }, null, 2))
    assert.deepEqual(lifecycle, { nonrenderablePreserved: true, cached: true, reloaded: true, revoked: true, loads: 2, unloads: 1, destroys: 1, searchSanitized: true,
      destroyedError: 'Book content already destroyed', documentError: 'Book content already destroyed', cancelledError: 'Book content load cancelled',
      failures: ['Book content XML parsing error', 'Unsupported book content type: application/octet-stream', 'Non-local book document URL'] })
    assert.equal(results.every(x => x.executed === 0 && x.parentRead === null), true, 'book script must not execute or read parent storage')
    assert.deepEqual(remoteRequests, [], 'book parsing/display must not attempt remote resource requests')
    for (const result of results) for (const chapter of result.chapters) {
      assert.equal(chapter.loadError, undefined); assert.equal(chapter.bundledFont, true); assert.equal(chapter.blockedFont, true)
      assert.match(chapter.selected, /Readable/); assert.equal(chapter.cfiRestored, true); assert.equal(chapter.csp, true)
      if (chapter.originalCFI !== null) assert.equal(chapter.originalCFI, true)
      if (chapter.internalResolved !== null) assert.equal(chapter.internalResolved, true)
      if (chapter.imageLoaded !== null) assert.equal(chapter.imageLoaded, true)
    }
    assert.equal(results[0].chapters[0].color, 'rgb(12, 34, 56)'); assert.equal(results[0].chapters[0].fontLoaded, true)
    assert.equal(results[0].chapters[0].internalHref, 'chapter.xhtml#target')
    assert.equal(results[2].chapters[2].viewport, 'width=700,height=400')
    assert.deepEqual(pageErrors, [])
  } finally { await browser?.close(); await server?.close() }
})
