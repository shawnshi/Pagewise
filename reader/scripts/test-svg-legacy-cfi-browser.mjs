import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { createServer, readerRoot } from './vite-isolated.mjs'

const evidence = new URL('../../.cache/audit-stage1/', import.meta.url)
let frozen
try { frozen = JSON.parse(readFileSync(new URL('svg-repair-baseline.json', evidence), 'utf8')) }
catch (error) { throw new Error('Cannot load frozen SVG repair baseline', { cause: error }) }
for (const name of ['view.js', 'epubcfi.js', 'epub.js', 'fixed-layout.js']) {
  const path = `reader/node_modules/foliate-js/${name}`
  const actual = readFileSync(new URL(`../node_modules/foliate-js/${name}`, import.meta.url))
  assert.equal(createHash('sha256').update(actual).digest('hex'), frozen.hashes[path], `frozen runtime drift: ${name}`)
  assert.deepEqual(actual, readFileSync(new URL(`svg-repair-baseline/${name}`, evidence)))
}
function fixture(fixed, identity = 'A') {
  const svg = n => identity === 'blank' ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 1900" width="700" height="1900"><rect width="700" height="1900" fill="white"/></svg>' : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 1900" width="700" height="1900"><script>/* legacy inert fixture */</script><g id="g,[]^()"><text id="quote${n}" x="20" y="40">Alpha <![CDATA[😀 Beta]]> tail <tspan id="span,${n}" x="20" dy="40">Gamma ${identity}${n} end.</tspan></text></g><g><text x="20" y="100">Numeric target ${identity}${n}.</text></g><text x="20" y="1800">Bottom ${identity}${n}</text></svg>`
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'book.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">SVG-${identity}</dc:identifier><dc:title>Legacy SVG fixture ${identity}</dc:title><dc:language>en</dc:language>${fixed ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta>' : ''}</metadata><manifest><item id="a" href="a.svg" media-type="image/svg+xml"/><item id="html" href="middle.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="a"/><itemref idref="html"/><itemref idref="b"/></spine></package>`),
    'a.svg': strToU8(svg(0)), 'b.svg': strToU8(svg(2)),
    'middle.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>HTML</title><meta name="viewport" content="width=700,height=400"/></head><body><p id="ordinary">Ordinary HTML anchor remains identical.</p></body></html>'),
  })
}

// Runs in separate browser realms. The old realm imports only byte-frozen actual
// Foliate View/makeBook (no production service/hook), and displays raw SVG in FXL.
function browserAPI({ View, openBook, openRaw, Overlayer }) {
  const snapshot = range => {
    const endpoint = (node, offset) => {
      const parent = node.nodeType === 1 ? node : node.parentElement
      const prefix = parent.ownerDocument.createRange(); prefix.selectNodeContents(parent); prefix.setEnd(node, offset)
      return { parent: parent.id || parent.localName, offset: prefix.toString().length }
    }
    return { text: range.toString(), collapsed: range.collapsed, start: endpoint(range.startContainer, range.startOffset), end: endpoint(range.endContainer, range.endOffset) }
  }
  const ranges = (doc, index) => {
    if (index === 1) {
      const node = doc.getElementById('ordinary').firstChild, r = doc.createRange(); r.setStart(node, 3); r.setEnd(node, 15)
      return [{ kind: 'html', range: r }]
    }
    const quote = doc.getElementById(`quote${index}`), span = doc.getElementById(`span,${index}`).firstChild
    const numeric = quote.parentElement.nextElementSibling.firstElementChild.firstChild
    const point = doc.createRange(); point.setStart(span, 3); point.collapse(true)
    const short = doc.createRange(); short.setStart(span, 1); short.setEnd(span, 7)
    const multi = doc.createRange(); multi.setStart(quote.firstChild, 2); multi.setEnd(span, 8)
    const unicode = doc.createRange(), unicodeNode = Array.from(quote.childNodes).find(n => n.nodeValue?.includes('😀'))
    const unicodeStart = unicodeNode.nodeValue.indexOf('😀'); unicode.setStart(unicodeNode, unicodeStart); unicode.setEnd(unicodeNode, unicodeStart + 7)
    const numericRange = doc.createRange(); numericRange.setStart(numeric, 2); numericRange.setEnd(numeric, 12)
    const bottom = doc.createRange(), bottomNode = doc.documentElement.localName === 'svg' ? doc.documentElement.lastChild.firstChild : doc.body.firstElementChild.lastChild.firstChild
    bottom.setStart(bottomNode, 1); bottom.setEnd(bottomNode, 8)
    return [{ kind: 'point', range: point }, { kind: 'range', range: short }, { kind: 'multi', range: multi }, { kind: 'unicode', range: unicode }, { kind: 'numeric', range: numericRange }, { kind: 'bottom', range: bottom }]
  }
  const open = async (bytes, raw = false) => {
    const book = await (raw ? openRaw : openBook)(new File([new Uint8Array(bytes)], 'svg.epub'))
    const view = new View(), docs = new Map()
    view.addEventListener('load', e => docs.set(e.detail.index, e.detail.doc))
    document.body.append(view); await view.open(book)
    if (!view.isFixedLayout) view.renderer.setAttribute('flow', 'scrolled')
    return { book, view, docs, close: () => { view.close(); view.remove(); book.destroy() } }
  }
  window.generateLegacy = async bytes => {
    const owner = await open(bytes, true), anchors = []
    for (const index of [0, 1, 2]) {
      await owner.view.renderer.goTo({ index })
      const doc = owner.docs.get(index)
      doc.documentElement.setAttribute('data-pw-svg-root', 'forged-author-marker')
      for (const { kind, range } of ranges(doc, index)) {
        const cfi = owner.view.getCFI(index, range), restored = owner.view.resolveCFI(cfi).anchor(doc)
        anchors.push({ index, kind, cfi, expected: snapshot(restored), generated: snapshot(range), rawSVG: doc.documentElement.localName === 'svg' })
      }
    }
    owner.close(); return anchors
  }
  window.verifySecured = async ({ bytes, legacy, otherBytes }) => {
    window.__svgMarker = 0
    const owner = await open(bytes), checks = [], errors = [], hook = View.prototype.getCFI
    owner.view.addEventListener('draw-annotation', event => { event.detail.draw(Overlayer.highlight, { color: 'yellow' }) })
    for (const index of [0, 1, 2]) {
      await owner.view.renderer.goTo({ index })
      const doc = owner.docs.get(index)
      for (const { kind, range } of ranges(doc, index)) {
        const old = legacy.find(a => a.index === index && a.kind === kind)
        let exact = false, actual, resolutionError
        try { actual = snapshot(owner.view.resolveCFI(old.cfi).anchor(doc)); exact = JSON.stringify(actual) === JSON.stringify(old.expected) } catch (error) { resolutionError = error.message }
        const generated = owner.view.getCFI(index, range)
        checks.push({ index, kind, generated, old: old.cfi, exact, actual, resolutionError })
      }
      // The trust marker is a URL/owner registry, not author-controlled attributes.
      if (index !== 1) doc.body.firstElementChild.setAttribute('data-pw-svg-root', 'forged')
      const script = doc.createElement('script'); script.textContent = 'parent.__svgMarker++'; doc.body.append(script)
      const probe = doc.createElement('img'); probe.src = 'https://svg-compat.invalid/image'; probe.setAttribute('onerror', 'parent.__svgMarker++'); doc.body.append(probe)
      const css = doc.createElement('style'); css.textContent = "@import url('https://svg-compat.invalid/style');"; doc.head.append(css)
    }
    const target = legacy.find(a => a.index === 0 && a.kind === 'range')
    await owner.view.renderer.goTo({ index: 1 })
    let navigation
    try {
      const resolved = owner.view.resolveCFI(target.cfi)
      await owner.view.renderer.goTo(resolved)
      const doc = owner.docs.get(0), range = resolved.anchor(doc)
      navigation = { exact: JSON.stringify(snapshot(range)) === JSON.stringify(target.expected), index: owner.view.isFixedLayout ? owner.view.renderer.index : owner.view.renderer.getContents()[0].index }
      if (!owner.view.isFixedLayout) {
        await owner.view.addAnnotation({ value: target.cfi })
        const entry = owner.view.renderer.getContents().find(x => x.index === 0)
        navigation.annotationRects = entry.overlayer.element.querySelectorAll('rect').length
      } else {
        const overlay = new Overlayer(doc); doc.body.append(overlay.element); overlay.add(target.cfi, range, Overlayer.highlight)
        navigation.actualOverlayerRects = overlay.element.querySelectorAll('rect').length
        navigation.fixedLayoutAnnotationAPI = 'upstream getContents has no index/overlayer; direct real Overlayer geometry only'
        overlay.element.remove()
      }
    } catch (error) { errors.push(`navigation: ${error.message}`) }
    let invalidRejected = false
    try { owner.view.resolveCFI(target.cfi.replace(/:[0-9]+(?=[,)]|\[)/, ':99999')).anchor(owner.docs.get(0)) } catch { invalidRejected = true }
    let idRejected = false
    try { owner.view.resolveCFI(target.cfi.replace('span^,0', 'missing-asserted-id')).anchor(owner.docs.get(0)) } catch { idRejected = true }
    const other = await open(otherBytes)
    await other.view.renderer.goTo({ index: 0 })
    let crossBookRejected = false
    try { owner.view.getCFI(0, ranges(other.docs.get(0), 0)[0].range) } catch { crossBookRejected = true }
    const ownAfterOther = owner.view.getCFI(0, ranges(owner.docs.get(0), 0)[1].range)
    const priorDoc = owner.docs.get(0), priorRange = ranges(priorDoc, 0)[1].range
    owner.close()
    let destroyedRejected = false
    try { owner.view.getCFI(0, priorRange) } catch { destroyedRejected = true }
    const otherStillWorks = other.view.getCFI(0, ranges(other.docs.get(0), 0)[1].range)
    other.close()
    const replacement = await openBook(new File([new Uint8Array(otherBytes)], 'replacement.epub'))
    document.body.append(owner.view); await owner.view.open(replacement)
    if (!owner.view.isFixedLayout) owner.view.renderer.setAttribute('flow', 'scrolled')
    await owner.view.renderer.goTo({ index: 0 })
    const reusedCfi = owner.view.getCFI(0, ranges(owner.docs.get(0), 0)[1].range)
    let staleRangeRejected = false
    try { owner.view.getCFI(0, priorRange) } catch { staleRangeRejected = true }
    owner.view.close(); owner.view.remove(); replacement.destroy()
    const reopened = await open(bytes)
    let reloadExact = false
    try {
      await reopened.view.renderer.goTo(reopened.view.resolveCFI(target.cfi))
      reloadExact = JSON.stringify(snapshot(reopened.view.resolveCFI(target.cfi).anchor(reopened.docs.get(0)))) === JSON.stringify(target.expected)
    } catch (error) { errors.push(`reload: ${error.message}`) }
    const detached = await reopened.book.sections[0].createDocument()
    let detachedExact = false
    try { detachedExact = JSON.stringify(snapshot(reopened.view.resolveCFI(target.cfi).anchor(detached))) === JSON.stringify(target.expected) } catch (error) { errors.push(`detached: ${error.message}`) }
    reopened.close(); await new Promise(r => setTimeout(r, 100))
    return { checks, navigation, errors, invalidRejected, idRejected, crossBookRejected, destroyedRejected, staleRangeRejected, reusedCfi,
      hookIdempotent: hook === View.prototype.getCFI, ownAfterOther, otherStillWorks, reloadExact, detachedExact, marker: window.__svgMarker }
  }
  window.generateSectionLocations = async bytes => {
    const owner = await open(bytes, true), locations = []
    for (const index of [0, 2]) {
      await owner.view.renderer.goTo({ index })
      locations.push({ index, cfi: owner.view.lastLocation.cfi, rangeIsNull: owner.view.lastLocation.range === null })
    }
    owner.close(); return locations
  }
  window.verifySectionLocations = async ({ bytes, locations }) => {
    const owner = await open(bytes), result = []
    for (const location of locations) {
      let error, exact = false
      try {
        const resolved = owner.view.resolveCFI(location.cfi); await owner.view.renderer.goTo(resolved)
        const anchor = resolved.anchor(owner.docs.get(location.index))
        exact = resolved.index === location.index && anchor === 0 && (owner.view.isFixedLayout || owner.view.renderer.start === 0)
      } catch (failure) { error = failure.message }
      result.push({ ...location, exact, error })
    }
    owner.close(); return result
  }
  window.resolveLegacy = async ({ bytes, cfis }) => {
    const owner = await open(bytes, true), result = []
    for (const cfi of cfis) {
      const resolved = owner.view.resolveCFI(cfi); await owner.view.renderer.goTo({ index: resolved.index })
      result.push(snapshot(resolved.anchor(owner.docs.get(resolved.index))))
    }
    owner.close(); return result
  }
  window.verifyAutomatic = async ({ bytes, blankBytes, bottom }) => {
    const owner = await open(bytes), positions = []
    owner.view.addEventListener('relocate', e => positions.push({ cfi: e.detail.cfi, range: snapshot(e.detail.range) }))
    await owner.view.renderer.goTo({ index: 0 })
    const initial = owner.view.lastLocation, initialCount = positions.length, start = owner.view.renderer.start
    await owner.view.renderer.next(300)
    const blankGap = { moved: owner.view.renderer.start > start, noFalsePosition: owner.view.lastLocation === initial, noEvent: positions.length === initialCount }
    await owner.view.renderer.goTo(owner.view.resolveCFI(bottom))
    const reachedBottom = snapshot(owner.view.resolveCFI(bottom).anchor(owner.docs.get(0)))
    const prior = owner.view.lastLocation.cfi
    owner.close()
    const reload = await open(bytes); await reload.view.renderer.goTo(reload.view.resolveCFI(prior)); const reloadRange = snapshot(reload.view.resolveCFI(prior).anchor(reload.docs.get(0))); reload.close()
    const blank = await open(blankBytes), events = []
    blank.view.addEventListener('relocate', e => events.push(e.detail.cfi))
    await blank.view.renderer.goTo({ index: 0 }); const noInitialEmptyCfi = !blank.view.lastLocation && !events.length
    await blank.view.renderer.goTo({ index: 1 }); const verified = blank.view.lastLocation
    await blank.view.renderer.goTo({ index: 0 }); const beforeTurn = events.length
    await blank.view.renderer.next(300)
    const blankPrevious = verified?.cfi, blankCurrent = blank.view.lastLocation?.cfi
    const blankDocument = { noInitialEmptyCfi, retained: !!blankPrevious && blankCurrent === blankPrevious, noEmptyEvent: events.length === beforeTurn, turnSettled: true }
    blank.close(); return { positions, initialCount, blankGap, reachedBottom, prior, reloadRange, blankPrevious, blankCurrent, blankDocument }
  }
  window.ready = true
}

function htmlPaginatorAPI(Paginator) {
  window.runHtml = async () => {
    const p = new Paginator(); p.style.cssText = 'display:block;width:930px;height:1240px'; document.body.append(p)
    const url = URL.createObjectURL(new Blob(['<html><body>' + Array.from({ length: 900 }, (_, i) => `<p>Paragraph ${i} ${'Readable synthetic text '.repeat(25)}</p>`).join('') + '</body></html>'], { type: 'text/html' }))
    try {
      p.open({ sections: [{ load: () => url }], dir: 'ltr' }); await p.goTo({ index: 0 })
      let relocations = 0; p.addEventListener('relocate', () => relocations++)
      const start = performance.now(); for (let i = 0; i < 60; i++) await p.next()
      const turnsMs = performance.now() - start, forward = relocations; await p.prev()
      const backward = relocations > forward, doc = p.getContents()[0].doc, range = doc.createRange()
      range.selectNodeContents(doc.body.firstElementChild); await p.scrollToAnchor(range, true)
      return { forward, backward, selected: doc.getSelection().toString().startsWith('Paragraph'), turnsMs }
    } finally { p.destroy(); p.remove(); URL.revokeObjectURL(url) }
  }
  window.ready = true
}

test('frozen legacy SVG-root CFIs survive secured generation, resolution, navigation, annotations and reload', { timeout: 110000 }, async () => {
  let server, browser
  try {
    const plugin = {
      name: 'svg-legacy-oracle-only',
      resolveId(id) { if (['/svg-old.js', '/svg-secured.js', '/svg-html-old.js', '/svg-html-new.js', '/svg-frozen-paginator.js'].includes(id)) return `\0${id}` },
      load(id) {
        if (id === '\0/svg-frozen-paginator.js') {
          const source = readFileSync(new URL('svg-repair-baseline/paginator.js', evidence), 'utf8')
          assert.equal(createHash('sha256').update(source).digest('hex'), frozen.hashes['reader/src/vendor/foliate/paginator.js'])
          return source
        }
        if (id === '\0/svg-html-old.js' || id === '\0/svg-html-new.js') return `import {Paginator} from '${id.includes('old') ? '/svg-frozen-paginator.js' : '/src/vendor/foliate/paginator.js'}';(${htmlPaginatorAPI.toString()})(Paginator);`
        if (!['\0/svg-old.js', '\0/svg-secured.js'].includes(id)) return
        const secured = id.includes('secured')
        return `import {View,makeBook} from 'foliate-js/view.js';import {Overlayer} from 'foliate-js/overlayer.js';${secured ? "import {makeFoliateBook} from '/src/services/foliateBook.ts';" : ''}(${browserAPI.toString()})({View,openBook:${secured ? 'makeFoliateBook' : 'makeBook'},openRaw:makeBook,Overlayer});`
      },
    }
    server = await createServer({ root: readerRoot, cacheDir: '../.cache/audit-stage1/svg-vite', plugins: [plugin], logLevel: 'error', server: { host: '127.0.0.1', port: 4421, strictPort: true } })
    await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 930, height: 1240 }, serviceWorkers: 'block' }), remote = [], pageErrors = []
    await context.route('**/*', route => { const u = new URL(route.request().url()); if (/^https?:$/.test(u.protocol) && u.origin !== 'http://127.0.0.1:4421') { remote.push(u.href); return route.abort() } return route.continue() })
    const page = async mode => {
      const p = await context.newPage(); p.on('pageerror', e => pageErrors.push(e.stack ?? e.message))
      await p.route(`**/${mode}.html`, route => route.fulfill({ contentType: 'text/html', body: `<style>body{margin:0}foliate-view{display:block;width:930px;height:1240px}</style><script type="module" src="/svg-${mode}.js"></script>` }))
      await p.goto(`http://127.0.0.1:4421/${mode}.html`); await p.waitForFunction(() => window.ready); return p
    }
    const old = await page('old'), secured = await page('secured')
    const sectionLocations = await old.evaluate(bytes => generateSectionLocations(bytes), Array.from(fixture(true))), sectionResults = []
    for (const fixed of [false, true]) sectionResults.push({ fixed, checks: await secured.evaluate(input => verifySectionLocations(input), { bytes: Array.from(fixture(fixed)), locations: sectionLocations }) })
    console.log(JSON.stringify({ sectionLocations, sectionResults }, null, 2))
    assert.equal(sectionLocations.every(x => x.rangeIsNull), true, 'saved reading locations come from actual old FXL relocate')
    assert.equal(sectionResults.every(x => x.checks.every(y => y.exact)), true, 'explicit legacy section positions must restore section start')
    if (process.env.PW_SVG_SECTION_ORACLE === '1') return
    const legacy = await old.evaluate(bytes => generateLegacy(bytes), Array.from(fixture(true)))
    assert.equal(legacy.filter(a => a.index !== 1).every(a => a.rawSVG), true, 'old anchors must be generated by a real raw-SVG renderer')
    assert.equal(legacy.every(a => JSON.stringify(a.expected) === JSON.stringify(a.generated)), true, 'baseline must itself resolve exact boundaries')
    writeFileSync(new URL(process.env.PW_AUDIT_SVG_ORACLE ?? 'svg-legacy-old-anchors.json', evidence), JSON.stringify({ frozenHashes: frozen.hashes, sectionLocations, legacy }, null, 2))
    const results = []
    for (const fixed of [false, true]) results.push({ fixed, ...await secured.evaluate(input => verifySecured(input), { bytes: Array.from(fixture(fixed)), otherBytes: Array.from(fixture(fixed, 'B')), legacy }) })
    const delegation = await secured.evaluate(bytes => generateLegacy(bytes), Array.from(fixture(true)))
    const automatic = await secured.evaluate(input => verifyAutomatic(input), { bytes: Array.from(fixture(false)), blankBytes: Array.from(fixture(false, 'blank')), bottom: legacy.find(x => x.index === 0 && x.kind === 'bottom').cfi })
    const legacyAutomatic = await old.evaluate(input => resolveLegacy(input), { bytes: Array.from(fixture(true)), cfis: automatic.positions.map(x => x.cfi) })
    const htmlBaselinePage = await page('html-old'), htmlCurrentPage = await page('html-new'), htmlTimings = []
    for (let i = 0; i < 3; i++) htmlTimings.push({ baseline: await htmlBaselinePage.evaluate(() => runHtml()), current: await htmlCurrentPage.evaluate(() => runHtml()) })
    console.log(JSON.stringify({ runtime: { node: process.version, browser: browser.version(), viewport: '930x1240' }, workload: '900 HTML paragraphs, 60 forward turns + backward/selection, 3 isolated sequential repeats', legacy, results, delegation, automatic, legacyAutomatic, htmlTimings, remote, pageErrors }, null, 2))
    for (const pair of htmlTimings) for (const item of [pair.baseline, pair.current]) {
      assert.equal(item.forward, 60); assert.equal(item.backward, true); assert.equal(item.selected, true)
    }
    assert.deepEqual(delegation, legacy, 'unprotected raw books delegate unchanged after global hook installation')
    assert.ok(automatic.initialCount > 0)
    assert.deepEqual(automatic.blankGap, { moved: true, noFalsePosition: true, noEvent: true })
    assert.deepEqual(automatic.positions.map(x => x.range), legacyAutomatic, 'automatic positions remain exact in frozen raw SVG documents')
    assert.deepEqual(automatic.reachedBottom, legacy.find(x => x.index === 0 && x.kind === 'bottom').expected)
    assert.deepEqual(automatic.blankDocument, { noInitialEmptyCfi: true, retained: true, noEmptyEvent: true, turnSettled: true })
    assert.deepEqual(automatic.reloadRange, automatic.positions.at(-1).range)
    for (const result of results) {
      assert.deepEqual(result.errors, [])
      for (const check of result.checks) { assert.equal(check.generated, check.old, `${check.kind} canonical CFI`); assert.equal(check.exact, true, `${check.kind} exact old target`) }
      assert.deepEqual([result.invalidRejected, result.idRejected, result.crossBookRejected, result.destroyedRejected, result.staleRangeRejected, result.hookIdempotent, result.reloadExact, result.detachedExact], [true, true, true, true, true, true, true, true])
      assert.equal(result.navigation.exact, true); assert.equal(result.navigation.index, 0)
      assert.ok(result.fixed ? result.navigation.actualOverlayerRects > 0 : result.navigation.annotationRects > 0)
      assert.equal(result.ownAfterOther, legacy.find(x => x.index === 0 && x.kind === 'range').cfi)
      assert.equal(result.otherStillWorks, result.ownAfterOther); assert.equal(result.reusedCfi, result.ownAfterOther)
      assert.equal(result.marker, 0)
    }
    assert.deepEqual(remote, []); assert.deepEqual(pageErrors, [])
  } finally { await browser?.close(); await server?.close() }
})
