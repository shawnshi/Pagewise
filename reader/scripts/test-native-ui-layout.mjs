import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile, runJvm, root, emit } from './native-import-test-tools.mjs'

test('native measured flow stays within available width, preserves order and avoids overlap across 1.4 viewport/text scales', () => {
  const out = resolve(root, '../.cache/native-ui-layout-host', `${Date.now()}-${process.pid}`)
  mkdirSync(out, { recursive: true })
  const harness = emit(out, 'LayoutHarness.kt', `package io.pagewise.reader
private var count=0
private fun ok(value:Boolean){count++;check(value)}
fun main(){
 ok(nativeBottomPages==listOf("library","reading","annotations","stats","settings"))
 for(width in listOf(0,1,272,342,552,752,1152)) for(scale in listOf(1,2,3)) {
  val sizes=(0..47).map{NativeFlowSize((48+it%9*23)*scale,(48+it%3*16)*scale)}
  val rects=nativeFlowRects(width,sizes,6)
  ok(rects.size==sizes.size)
  for(i in rects.indices){val r=rects[i];ok(r.left>=0&&r.right<=width);ok(r.right-r.left==minOf(width,sizes[i].width));ok(r.bottom-r.top==sizes[i].height)
   for(j in 0 until i){val old=rects[j];ok(r.left>=old.right||old.left>=r.right||r.top>=old.bottom||old.top>=r.bottom)}
  }
 }
 for(width in listOf(800,320,800)) {
  ok(nativeStackForWidth(width,1f,1f,520)==(width<520))
  ok(nativeStackForWidth(width,1f,1f,640)==(width<640))
  val columns=if(nativeStackForWidth(width,1f,1f,700))1 else 2
  val grid=nativeMetadataRects(width,listOf(20,55,35,75,30),columns,12)
  ok(grid.size==5)
  for(i in grid.indices){val r=grid[i];ok(r.left>=0&&r.right<=width)
   for(j in 0 until i){val old=grid[j];ok(r.left>=old.right||old.left>=r.right||r.top>=old.bottom||old.top>=r.bottom)}
  }
 }
 ok(nativeStackForWidth(800,1f,2f,640))
 ok(nativeStackForWidth(1000,2f,.85f,640))
 ok(nativeFlowRects(320,emptyList(),6).isEmpty())
 ok(nativeContentWidth(1440,1200)==1200);ok(nativeContentWidth(320,1200)==320)
 try{nativeFlowRects(-1,emptyList(),6);error("invalid width accepted")}catch(_:IllegalArgumentException){}
 println("layout_assertions="+count)
}
`)
  const classes = compile(out, [resolve(root, 'src-tauri/android/NativeUiMetrics.kt'), harness], [])
  const output = runJvm(out, 'geometry', ['-cp', classes, 'io.pagewise.reader.LayoutHarnessKt'])
  assert.match(output, /layout_assertions=/)
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ output: output.trim(), syntheticGeometryOnly: true, androidRendered: false }, null, 2))
})

test('1.4 bottom navigation/chrome proportions restored without a route, draft or recovery bypass', () => {
  const controller = readFileSync(resolve(root, 'src-tauri/android/NativePagesController.kt'), 'utf8')
  const ui = readFileSync(resolve(root, 'src-tauri/android/NativeUi.kt'), 'utf8')
  const library = readFileSync(resolve(root, 'src-tauri/android/NativeLibraryPanel.kt'), 'utf8')
  const settings = readFileSync(resolve(root, 'src-tauri/android/NativeSettingsPanel.kt'), 'utf8')
  assert.match(controller, /for \(key in nativeBottomPages\)/)
  assert.match(controller, /navigate\(pathFor\(key\)\)/)
  assert.match(controller, /private val body = NativeContentColumn\(activity\)/)
  assert.match(controller, /val coverWidth = if \(reading\) 72 else 58/)
  assert.match(controller, /val coverHeight = if \(reading\) 101 else 78/)
  assert.match(controller, /LinearLayout\.LayoutParams\(dp\(coverWidth\), dp\(coverHeight\)\)/)
  assert.match(controller, /NativeActionFlow\(activity\)/)
  assert.match(library, /private fun tabs\(/)
  assert.match(library, /val row = NativeActionFlow\(activity\)/)
  assert.match(library, /fun menuActions\(/)
  assert.match(controller, /page in listOf\("library", "reading"\)\) libraryPanel\?\.menuActions\(\)/)
  assert.match(controller, /libraryPanel\?\.menuActions\(\)/)
  assert.match(library, /owner == epoch && canAct\(\)/)
  assert.match(controller, /!disposed && owner == generation/)
  assert.doesNotMatch(library, /button\(tr\("筛选与管理"/)
  assert.match(settings, /ui\.settingRow\(/)
  assert.match(settings, /if \(!busy && !closed\)/)
  assert.match(controller, /settingsPanel\?\.canLeave\(\) == false/)
  assert.match(controller, /editor\.flushForLeave\(reply\)/)
  assert.match(ui, /LAYOUT_DIRECTION_RTL/)
  assert.match(ui, /resources\.configuration\.fontScale/)
  assert.match(controller, /NativeBookActions\(activity\)/)
  assert.match(controller, /NativeBookHero\(activity\)/)
  assert.match(controller, /NativeMetadataGrid\(activity\)/)
  assert.doesNotMatch(controller, /screenWidthDp/, 'layout choices must follow measured width, not a construction-time configuration snapshot')
  assert.match(ui, /class NativeBookHero[\s\S]*?override fun onMeasure[\s\S]*?nativeStackForWidth/)
  assert.match(ui, /class NativeMetadataGrid[\s\S]*?override fun onMeasure[\s\S]*?nativeStackForWidth/)
  const reference = readFileSync(resolve(root, 'src/App.vue'), 'utf8')
  assert.match(reference, /flex-direction: column/)
  assert.match(reference, /\.sidebar \{[\s\S]*?flex: none;[\s\S]*?position: relative;/)
  assert.match(reference, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/)
})

function luminance(hex) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]
}
test('actual Pagewise neutral text and control-outline pairs meet their scoped contrast thresholds', () => {
  for (const [a, b, minimum] of [['#000000', '#ffffff', 4.5], ['#ffffff', '#000000', 4.5], ['#000000', '#fafafa', 4.5], ['#ffffff', '#111111', 4.5], ['#000000', '#ffffff', 3], ['#ffffff', '#000000', 3], ['#4a4a4a', '#ffffff', 4.5], ['#d4d4d4', '#000000', 4.5]]) {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
    assert.ok((values[0] + .05) / (values[1] + .05) >= minimum, a + '/' + b)
  }
})
