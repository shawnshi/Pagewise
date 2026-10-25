import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, delimiter } from 'node:path'
import { compile, runJvm, root, emit } from './native-import-test-tools.mjs'
import { chromium } from 'playwright'

const kinds = ['library','currently-reading','notes','reading-history','settings','table-of-contents','annotations','bookmarks','read-aloud','reading-assistant','search-in-book','reading-modes','typography','search-library','singlePage','facingPages','folder','refresh','info','back','fullscreen','fullscreenExit','more','next','thumbnails','zoomIn','zoomOut','print','slideshow','close','delete','pin','reading','history','stats','toc','search','searchInBook','ai','audio','readingModes','bookmark','bookmarkBorder','menu','recovery']
const aliases = { reading: 'currently-reading', history: 'reading-history', stats: 'reading-history', toc: 'table-of-contents', search: 'search-library', searchInBook: 'search-in-book', ai: 'reading-assistant', audio: 'read-aloud', readingModes: 'reading-modes', bookmarkBorder: 'bookmarks', recovery: 'reading-history' }
const ui = readFileSync(resolve(root, 'src-tauri/android/NativeUi.kt'), 'utf8')
const start = ui.indexOf('internal fun nativeIconVectorXml('), end = ui.indexOf('private class NativeUiIcon', start)
assert.ok(start > 0 && end > start)
const out = resolve(root, '../.cache/eink-ui-s1-20261023/host', `${Date.now()}-${process.pid}`)
mkdirSync(out, { recursive: true })
const jdk = 'C:/Program Files/Java/jdk-21.0.12.1'
process.env.JAVA_HOME = jdk
process.env.PATH = resolve(jdk, 'bin') + delimiter + process.env.PATH

test('production Kotlin grayscale roles and density-compensated icon strokes; render every preserved native icon', { timeout: 90000 }, async () => {
  const icons = emit(out, 'Icons.kt', 'package io.pagewise.reader\n' + ui.slice(start, end))
  const harness = emit(out, 'EinkHarness.kt', `package io.pagewise.reader
import java.util.Base64
fun main() {
 val light=nativeEinkPalette(0xFFFFFFFF.toInt());val dark=nativeEinkPalette(0xFF000000.toInt())
 fun values(p:NativeEinkPalette)=listOf(p.background,p.surface,p.outline,p.divider,p.primary,p.secondary,p.disabled,p.highlight)
 check(values(light)==listOf(0xFFFFFFFF,0xFFFAFAFA,0xFF000000,0xFFD4D4D4,0xFF000000,0xFF4A4A4A,0xFF8C8C8C,0xFFDCDCDC).map{it.toInt()})
 for(p in listOf(light,dark)) for(c in values(p)) {check(c ushr 24==255);check((c ushr 16 and 255)==(c ushr 8 and 255));check((c ushr 8 and 255)==(c and 255))}
 check(dark.primary!=dark.background && dark.outline!=dark.background)
 var metrics=0
 for(density in listOf(1f,1.875f,2f,3f)) for(size in listOf(18f,20f,24f,32f)) for(stroke in listOf(1.5f,2f)) {
  val scale=size*density/24f
  check(kotlin.math.abs(nativeIconStrokeWidth(stroke,density,scale)*scale-stroke*density)<0.0001f);metrics++
 }
 for(invalid in listOf(0f,-1f,Float.NaN,Float.POSITIVE_INFINITY)) {
  check(runCatching{nativeIconStrokeWidth(1.5f,1f,invalid)}.isFailure)
  check(runCatching{nativeIconStrokeWidth(1.5f,invalid,1f)}.isFailure)
 }
 check(runCatching{nativeIconStrokeWidth(2.25f,1f,1f)}.isFailure)
 println("METRICS|"+metrics)
 for((name,palette) in listOf("light" to light,"dark" to dark)) println("PALETTE|"+name+"|"+values(palette).joinToString(","){java.lang.Integer.toUnsignedString(it,16)})
 for(kind in listOf(${[...kinds, 'unknown-kind'].map(s => JSON.stringify(s)).join(',')})) for(emphasis in listOf(false,true)) {
  val xml=nativeIconVectorXml(kind,emphasis)
  println("ICON|"+kind+"|"+emphasis+"|"+Base64.getEncoder().encodeToString(xml.toByteArray()))
 }
}
`)
  const cp = compile(out, [resolve(root, 'src-tauri/android/NativeUiMetrics.kt'), icons, harness])
  const output = runJvm(out, 'eink', ['-cp', cp, 'io.pagewise.reader.EinkHarnessKt'])
  assert.match(output, /METRICS\|32/)
  const vectors = output.split(/\r?\n/).filter(s => s.startsWith('ICON|')).map(s => { const [, kind, emphasis, data] = s.split('|'); return { kind, emphasis: emphasis === 'true', xml: Buffer.from(data, 'base64').toString('utf8') } })
  assert.equal(vectors.length, (kinds.length + 1) * 2)
  for (const vector of vectors) {
    assert.doesNotMatch(vector.xml, /(?:gradient|fillColor="#(?!00000000))/)
    assert.ok(vector.xml.includes('strokeWidth="' + (vector.emphasis ? '2' : '1.5') + '"'))
  }
  const normal = Object.fromEntries(vectors.filter(v => !v.emphasis).map(v => [v.kind, v.xml]))
  for (const [name, target] of Object.entries(aliases)) assert.equal(normal[name], normal[target], name)
  assert.equal(normal['unknown-kind'], normal.info)
  assert.notEqual(normal.bookmark, normal.bookmarkBorder, 'Bookmarked state must not disappear during the outline conversion')
  assert.match(ui, /nativeEinkPalette\(background\)\.outline/)
  assert.match(ui, /nativeIconStrokeWidth\(segment.width, density, scale\)/)
  assert.match(ui, /if \(scale <= 0f\) return/)
  assert.equal((ui.match(/scaleType = ImageView\.ScaleType\.FIT_XY/g) ?? []).length, 2, 'Both production image factories must let the drawable own aspect and stroke scaling')
  assert.doesNotMatch(ui.slice(end), /Paint\.Style\.FILL/)
  let browser
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1, serviceWorkers: 'block' })
    await page.route('**/*', route => route.abort())
    for (const dark of [false, true]) {
      const result = await page.evaluate(({ vectors, dark }) => {
        const ns = 'http://www.w3.org/2000/svg', android = 'http://schemas.android.com/apk/res/android'
        document.body.replaceChildren();document.body.style.cssText = `margin:0;padding:24px;box-sizing:border-box;background:${dark ? '#000' : '#fff'};color:${dark ? '#fff' : '#000'};font:14px system-ui`
        const heading = document.createElement('h1');heading.textContent = 'Native outline glyph preview — SVG simulation, not device rendering';heading.style.fontSize = '20px';document.body.append(heading)
        const grid = document.createElement('div');grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px';document.body.append(grid)
        let count = 0
        for (const v of vectors) {
          const xml = new DOMParser().parseFromString(v.xml, 'application/xml')
          if (xml.querySelector('parsererror')) throw new Error('Invalid XML: ' + v.kind)
          const paths = [...xml.querySelectorAll('path')]
          if (!paths.length) throw new Error('Empty icon: ' + v.kind)
          for (const p of paths) {
            if (p.getAttributeNS(android, 'fillColor') !== '#00000000') throw new Error('Filled icon: ' + v.kind)
            new Path2D(p.getAttributeNS(android, 'pathData'))
            count++
          }
          if (v.emphasis || Object.hasOwn({ reading:1, history:1, stats:1, toc:1, search:1, searchInBook:1, ai:1, audio:1, readingModes:1, bookmarkBorder:1, recovery:1 }, v.kind)) continue
          const card = document.createElement('section');card.style.cssText = 'border:1px solid currentColor;padding:12px;min-height:140px;box-sizing:border-box'
          const label = document.createElement('div');label.textContent = v.kind;label.style.marginBottom = '16px';card.append(label)
          const row = document.createElement('div');row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';card.append(row)
          for (const [size, emphasis] of [[18,false],[24,false],[32,true]]) {
            const actual = vectors.find(p => p.kind === v.kind && p.emphasis === emphasis)
            const parsed = new DOMParser().parseFromString(actual.xml, 'application/xml')
            const svg = document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.style.width = svg.style.height = size * 1.875 + 'px';svg.style.flexShrink = '0'
            for (const p of parsed.querySelectorAll('path')) {
              const path = document.createElementNS(ns,'path');path.setAttribute('d',p.getAttributeNS(android,'pathData'));path.setAttribute('fill','none');path.setAttribute('stroke',dark ? '#fff' : '#000');path.setAttribute('stroke-width',Number(p.getAttributeNS(android,'strokeWidth'))*1.875);path.setAttribute('vector-effect','non-scaling-stroke');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');svg.append(path)
            }
            row.append(svg)
          }
          grid.append(card)
        }
        return { parsedPathCount: count, overflow: document.documentElement.scrollWidth > innerWidth }
      }, { vectors, dark })
      assert.equal(result.overflow, false)
      await page.screenshot({ path: resolve(out, `icons-${dark ? 'dark' : 'light'}.png`), fullPage: true })
    }
    writeFileSync(resolve(out, 'result.json'), JSON.stringify({ passed: true, existingIconNames: kinds.length, vectorsExecuted: vectors.length, strokeMetricCases: 32, grayscaleRoles: true, aliasAndBookmarkChecks: true, rendered: 'browser SVG from production Kotlin vectors; not Android/EPD', physicalCalibrationClaimed: false }, null, 2))
    writeFileSync(resolve(root, '../.cache/eink-ui-s1-20261023/latest-host.json'), JSON.stringify({ path: out, result: resolve(out, 'result.json') }, null, 2))
  } finally { await browser?.close() }
})
