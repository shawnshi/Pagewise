import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { EinkStreamAggregator } from '../src/services/einkStreamAggregator.ts'
import { onyxEpd } from '../src/services/onyxEpd.ts'
import { resetNativeEnvironmentCacheForTest } from '../src/services/nativeReaderEnvironment.ts'
import { isEinkHardwareEnvironment } from '../src/stores/settings.ts'
import { compile, emit, groovy, jsonAdapter, runJvm } from './native-import-test-tools.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = rel => readFileSync(join(root, rel), 'utf8')

test('EinkStreamAggregator batches deltas at >=48 chars or sentence boundary (>=24), flushes tail after maxWaitMs, and settles with Regal', async () => {
  onyxEpd.resetForTest()
  const epdCalls = []
  const origEnter = onyxEpd.enterFastMode.bind(onyxEpd)
  const origExit = onyxEpd.exitFastModeNow.bind(onyxEpd)
  const origRepaint = onyxEpd.repaint.bind(onyxEpd)
  onyxEpd.enterFastMode = (scene, mode) => { epdCalls.push(['enter', scene, mode]); return origEnter(scene, mode) }
  onyxEpd.exitFastModeNow = () => { epdCalls.push(['exit']); return origExit() }
  onyxEpd.repaint = mode => { epdCalls.push(['repaint', mode]); return origRepaint(mode) }

  try {
    const flushed = []
    let completed = 0
    const agg = new EinkStreamAggregator({
      einkEnabled: true,
      maxWaitMs: 120,
      onFlush: chunk => flushed.push(chunk),
      onComplete: () => { completed++ },
    })

    // Below 24 chars without sentence boundary: buffered without premature E-Ink repaint
    agg.push('1234567890')
    agg.push('abcdefghij')
    assert.deepEqual(flushed, [])

    // Crossing >=24 chars with sentence boundary flushes cleanly & enters DU once
    agg.push('klmno.')
    assert.deepEqual(flushed, ['1234567890abcdefghijklmno.'])
    assert.deepEqual(epdCalls.filter(c => c[0] === 'enter'), [['enter', 'stream', 'du']])

    // >=48 chars without punctuation also flushes cleanly
    const longToken = 'a'.repeat(48)
    agg.push(longToken)
    assert.equal(flushed.length, 2)

    // Short tail flushes automatically after wait window
    agg.push('tail')
    assert.equal(flushed.length, 2)
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.deepEqual(flushed, ['1234567890abcdefghijklmno.', longToken, 'tail'])

    agg.complete()
    assert.equal(completed, 1)
    assert.deepEqual(epdCalls.slice(-2), [['exit'], ['repaint', 'regal']])
  } finally {
    onyxEpd.enterFastMode = origEnter
    onyxEpd.exitFastModeNow = origExit
    onyxEpd.repaint = origRepaint
  }
})

test('EinkStreamAggregator handles AbortSignal cancellation, empty streams, and pass-through mode safely', async () => {
  onyxEpd.resetForTest()
  const epdCalls = []
  const origEnter = onyxEpd.enterFastMode.bind(onyxEpd)
  const origExit = onyxEpd.exitFastModeNow.bind(onyxEpd)
  const origRepaint = onyxEpd.repaint.bind(onyxEpd)
  onyxEpd.enterFastMode = (scene, mode) => { epdCalls.push(['enter', scene, mode]); return origEnter(scene, mode) }
  onyxEpd.exitFastModeNow = () => { epdCalls.push(['exit']); return origExit() }
  onyxEpd.repaint = mode => { epdCalls.push(['repaint', mode]); return origRepaint(mode) }

  try {
    // Abort stops timers and ignores late tokens
    const controller = new AbortController()
    const abortedChunks = []
    const aggAbort = new EinkStreamAggregator({
      maxWaitMs: 60,
      signal: controller.signal,
      onFlush: chunk => abortedChunks.push(chunk),
    })
    aggAbort.push('123456789012345678901234567890123456789012345678') // enters fast mode once at 48 chars
    aggAbort.push('queued')
    controller.abort()
    aggAbort.push('after-abort')
    await new Promise(resolve => setTimeout(resolve, 90))
    assert.deepEqual(abortedChunks, ['123456789012345678901234567890123456789012345678'])
    assert.ok(epdCalls.some(c => c[0] === 'exit'))
    assert.ok(epdCalls.some(c => c[0] === 'repaint' && c[1] === 'regal'))

    // Empty complete() does not enter fast mode or trigger repaint
    epdCalls.length = 0
    const aggEmpty = new EinkStreamAggregator({ onFlush: () => {} })
    aggEmpty.complete()
    assert.deepEqual(epdCalls, [])

    // Pass-through when E-Ink is disabled
    const direct = []
    const aggOff = new EinkStreamAggregator({ einkEnabled: false, onFlush: chunk => direct.push(chunk) })
    aggOff.push('a')
    aggOff.push('b')
    aggOff.complete()
    assert.deepEqual(direct, ['a', 'b'])
    assert.deepEqual(epdCalls, [])
  } finally {
    onyxEpd.enterFastMode = origEnter
    onyxEpd.exitFastModeNow = origExit
    onyxEpd.repaint = origRepaint
  }
})

test('Android hardware bridge, storage root, speech, and manual source contracts satisfy E-Ink audit invariants', () => {
  const bridge = read('src-tauri/android/OnyxSdkBridge.kt')
  const externalOpen = read('src/services/externalOpen.ts')
  const speech = read('src-tauri/android/NativeSpeechService.kt')
  const windowState = read('src-tauri/android/ReaderWindowState.kt')

  assert.match(bridge, /fun commitStagedExternalFile[\s\S]*context\.dataDir\.canonicalFile/)
  assert.doesNotMatch(bridge.slice(bridge.indexOf('fun resolveUpdateModeEnum'), bridge.indexOf('private fun buildEpdStatusJson')), /constants\.firstOrNull\(\)/)
  assert.doesNotMatch(bridge.slice(bridge.indexOf('fun isBooxHardware'), bridge.indexOf('fun buildHardwareProfileJson')), /deviceClass != null/)
  assert.doesNotMatch(bridge.slice(bridge.indexOf('private fun readFrontLightSnapshot'), bridge.indexOf('private fun queryHasFrontLight')), /\|\|\s*isBooxHardware\(\)/)
  assert.match(bridge, /EpdController\.setWebViewContrastOptimize/)
  assert.match(bridge, /FrontLightController\.setColdLightDeviceValue/)
  assert.match(bridge, /FrontLightController\.setWarmLightDeviceValue/)
  assert.match(bridge, /MediaStore\.Images\.Media\.EXTERNAL_CONTENT_URI/)
  assert.match(externalOpen, /BaseDirectory\.AppData/)
  assert.doesNotMatch(externalOpen, /BaseDirectory\.AppLocalData/)

  const mainActivity = read('src-tauri/android/MainActivity.kt')
  const insetsSlice = mainActivity.slice(mainActivity.indexOf('inner class InsetsBridge'))
  assert.match(insetsSlice, /fun callOnUiThread[\s\S]*CountDownLatch/)
  assert.doesNotMatch(insetsSlice, /bridge\.setScribbleModalSuspended\(null/)

  assert.match(speech, /ACTION_PLAY_PAUSE/)
  assert.match(speech, /fun isActivelySpeaking\(\): Boolean/)
  assert.match(windowState, /KEYCODE_DPAD_UP/)
  assert.match(windowState, /KEYCODE_MEDIA_NEXT/)
  assert.match(windowState, /speechActive: Boolean/)

  const nativeUi = read('src-tauri/android/NativeUi.kt')
  const pagesCtrl = read('src-tauri/android/NativePagesController.kt')
  const manualRenderer = read('src-tauri/android/NativeManualRenderer.kt')
  assert.match(nativeUi, /class NativeEinkDialog/)
  assert.match(nativeUi, /setDimAmount\(0f\)|dimAmount = 0f/)
  assert.match(nativeUi, /setWindowAnimations\(0\)|windowAnimations = 0/)
  assert.match(pagesCtrl, /fun invalidatePreferences\(\)/)
  assert.match(manualRenderer, /data class Table\(/)

  for (const name of ['README.md', '01-读书方法.md', '02-阅读模式.md', '03-声音.md', '04-使用说明.md', '05-伴读.md']) {
    const md = read(`docs/manual/${name}`)
    assert.doesNotMatch(md, /LightRead|轻阅|v1\.7\.0|\.\.\/|\u70b9\u775b|背景音/, name)
  }

  const readerVue = read('src/views/ReaderView.vue')
  const pdfVue = read('src/views/PdfReaderView.vue')
  const inkLayer = read('src/components/OnyxInkLayer.vue')
  assert.match(readerVue, /route\.query\.loc/)
  assert.match(readerVue, /EinkStreamAggregator/)
  assert.match(readerVue, /isComposing[\s\S]*?229/)
  assert.match(readerVue, /epubMediaModal/)
  assert.match(readerVue, /epubFootnote/)
  assert.match(pdfVue, /route\.query\.loc/)
  assert.match(pdfVue, /EinkStreamAggregator/)
  assert.doesNotMatch(pdfVue, /watch\(currentPage,\s*\(\)\s*=>\s*\{\s*if\s*\(pdfAiOpen\.value\)\s*closePdfAssistant\(\)/)
  assert.match(pdfVue, /draftContextId/)
  assert.match(inkLayer, /penDetected/)
  assert.match(inkLayer, /barrelErasing/)
})

test('P0-1: isEinkHardwareEnvironment honors truthful boox bridge flags and strict Onyx UA heuristics', () => {
  const prevWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const runProbe = (envObj, ua) => {
    resetNativeEnvironmentCacheForTest()
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true })
    Object.defineProperty(globalThis, 'window', {
      value: envObj
        ? {
            LightReadInsets: {
              getReaderEnvironment: () => JSON.stringify(envObj),
            },
          }
        : {},
      configurable: true,
    })
    return isEinkHardwareEnvironment()
  }
  try {
    // Non-BOOX Android phone with LightReadInsets bridge must NOT be forced into E-Ink
    assert.equal(
      runProbe({ version: 1, boox: false, lowRam: false, memoryClassMb: 256 }, 'Mozilla/5.0 (Linux; Android 13; SM-N9860 Galaxy Note 20 Ultra) AppleWebKit/537.36'),
      false,
    )
    // True BOOX device via bridge
    assert.equal(
      runProbe({ version: 1, boox: true, lowRam: false, memoryClassMb: 256 }, 'Mozilla/5.0 (Linux; Android 12; NoteX3Pro) AppleWebKit/537.36'),
      true,
    )
    // Browser / fallback UA check without bridge
    assert.equal(runProbe(null, 'Mozilla/5.0 (Linux; Android 12; NoteX3Pro Build/SKQ1) AppleWebKit/537.36'), true)
    assert.equal(runProbe(null, 'Mozilla/5.0 (Linux; Android 11; Samsung Galaxy Note 20) AppleWebKit/537.36'), false)
  } finally {
    resetNativeEnvironmentCacheForTest()
    if (prevWindowDesc) Object.defineProperty(globalThis, 'window', prevWindowDesc)
    else delete globalThis.window
    if (prevNavDesc) Object.defineProperty(globalThis, 'navigator', prevNavDesc)
    else delete globalThis.navigator
  }
})

test('P0-2 & P1-2: actual Kotlin ReaderWindowState preserves suspendedByModal across pause and arbitrates speech vs hardware keys', () => {
  const out = resolve(import.meta.dirname, '../../.cache/test-eink-ux-audit-v251')
  const driver = emit(
    out,
    'Driver.kt',
    `package io.pagewise.reader
fun main() {
    val state = ReaderWindowState()
    state.resume()
    val limit = OnyxRectCss(0f, 0f, 1000f, 1400f)

    state.scribbleState.configure(true, OnyxScribbleState.STROKE_STYLE_FOUNTAIN, 3.5f, limit, emptyList())
    check(state.canEnableRawDrawing()) { "Expected raw drawing enabled after configure" }

    val ch1 = state.scribbleState.setModalSuspended(true)
    check(ch1) { "Expected modal suspend to flip activeRawDrawing" }
    check(!state.canEnableRawDrawing()) { "Expected raw drawing suspended while modal open" }

    state.scribbleState.onLifecyclePause()
    state.pause()
    state.resume()
    check(state.scribbleState.suspendedByModal) { "onLifecyclePause must not clear suspendedByModal" }
    check(!state.canEnableRawDrawing()) { "Expected raw drawing still suspended on resume while modal open" }

    val ch2 = state.scribbleState.setModalSuspended(false)
    check(ch2) { "Expected modal resume to re-enable activeRawDrawing" }
    check(state.canEnableRawDrawing()) { "Expected raw drawing active after closing modal" }

    // Hardware key arbitration
    state.hardwareKeyState.configure(capture = false, volumeEnabled = true)
    check(!state.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_VOLUME_DOWN, OnyxHardwareKeyState.ACTION_DOWN, 0, speechActive = false).intercept)

    state.hardwareKeyState.configure(capture = true, volumeEnabled = true)
    val volWhileTts = state.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_VOLUME_DOWN, OnyxHardwareKeyState.ACTION_DOWN, 0, speechActive = true)
    check(!volWhileTts.intercept && volWhileTts.direction == null) { "Volume keys must yield during active TTS" }

    val mediaWhileTts = state.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_MEDIA_NEXT, OnyxHardwareKeyState.ACTION_DOWN, 0, speechActive = true)
    check(!mediaWhileTts.intercept) { "Media keys must yield during active TTS" }

    val dpadWhileTts = state.evaluateHardwareKey(OnyxHardwareKeyState.KEYCODE_DPAD_DOWN, OnyxHardwareKeyState.ACTION_DOWN, 0, speechActive = true)
    check(dpadWhileTts.intercept && dpadWhileTts.direction == "next") { "DPAD keys still turn pages while captured" }

    println("READER_WINDOW_STATE_JVM_OK")
}
`,
  )
  const jsonKt = emit(out, 'JSONObject.kt', jsonAdapter())
  const cp = compile(
    out,
    [jsonKt, resolve(root, 'src-tauri/android/ReaderWindowState.kt'), driver],
    groovy(),
  )
  const stdout = runJvm(out, 'run', ['-cp', cp, 'io.pagewise.reader.DriverKt'])
  assert.match(stdout, /READER_WINDOW_STATE_JVM_OK/)
})
