import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readNativeReaderEnvironment, readOnyxHardwareProfile, nativePdfPixelBudget } from '../src/services/nativeReaderEnvironment.ts'
import { onyxNativeAccelerator } from '../src/services/onyxNativeAccelerator.ts'
import { pdfRenderTarget, PDF_MAX_RENDER_PIXELS } from '../src/services/pdfRenderBudget.ts'

const environment = (extra = {}) => ({ version: 1, boox: true, lowRam: false, memoryClassMb: 128, ...extra })
const host = value => ({ LightReadInsets: { getReaderEnvironment: () => JSON.stringify(value) } })
const result = extra => readNativeReaderEnvironment(host(environment(extra)))

test('native environment is optional on browsers and older shells', () => {
  for (const value of [undefined, {}, { LightReadInsets: {} }]) assert.equal(readNativeReaderEnvironment(value).status, 'unavailable')
  assert.equal(nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS, { status: 'unavailable' }), PDF_MAX_RENDER_PIXELS)
})

test('strict native schema rejects malformed versions, flags and memory hints', () => {
  assert.deepEqual(result(), { status: 'available', value: environment() })
  for (const value of [null, [], 'bad', environment({ version: 2 }), environment({ boox: 'true' }),
    environment({ lowRam: 0 }), environment({ memoryClassMb: -1 }), environment({ memoryClassMb: 128.1 }),
    environment({ memoryClassMb: '128' }), environment({ memoryClassMb: 16385 })]) {
    assert.equal(readNativeReaderEnvironment(host(value)).status, 'invalid')
  }
})

test('bridge and JSON errors remain observable errors, not missing hardware facts', () => {
  for (const getReaderEnvironment of [() => '{broken', () => { throw new Error('bridge failed') }]) {
    const value = readNativeReaderEnvironment({ LightReadInsets: { getReaderEnvironment } })
    assert.equal(value.status, 'error')
    assert.ok(value.error)
    assert.equal(nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS, value), PDF_MAX_RENDER_PIXELS)
  }
})

test('native memory hints lower the cap but never raise the pre-existing ceiling', () => {
  assert.equal(nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS, result()), 4_194_304)
  assert.equal(nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS, result({ memoryClassMb: 256 })), 8_388_608)
  assert.equal(nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS, result({ memoryClassMb: 1024 })), PDF_MAX_RENDER_PIXELS)
  assert.equal(nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS, result({ lowRam: true })), 2_000_000)
  assert.equal(nativePdfPixelBudget(500_000, result()), 500_000)
})

test('actual PDF target consumes the native cap once and keeps normal DPI and aspect ratio', () => {
  const previous = globalThis.window
  let reads = 0
  globalThis.window = { LightReadInsets: { getReaderEnvironment: () => { reads++; return JSON.stringify(environment()) } } }
  try {
    assert.deepEqual(pdfRenderTarget(600, 800, 2), { width: 1200, height: 1600 })
    const target = pdfRenderTarget(3000, 4000, 3)
    assert.ok(target.width * target.height <= 4_194_304)
    assert.ok(Math.abs(target.width / target.height - 0.75) < 0.001)
    assert.equal(reads, 1, 'page turns must not repeat a synchronous bridge call')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('BOOX native fact is a suggestion, never an automatic saved-mode change', () => {
  const modes = readFileSync(new URL('../src/composables/useReadingModes.ts', import.meta.url), 'utf8')
  const detection = modes.slice(modes.indexOf('const einkDevice ='), modes.indexOf('function dismissEinkSuggestion'))
  assert.match(detection, /environment\.status === 'available' && environment\.value\.boox/)
  assert.match(detection, /looksLikeEinkDevice\(navigator.userAgent/)
  assert.doesNotMatch(detection, /setEink\(|eink\.enabled\s*=/)
})

test('Activity wiring preserves native speech lifecycle and never globally pauses WebView timers', () => {
  const activity = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8')
  assert.match(activity, /override fun onPause\(\) \{\s*readerWindow.pause\(\)\s*applyKeepScreenOn\(false\)\s*super.onPause\(\)/)
  assert.match(activity, /override fun onResume\(\) \{\s*super.onResume\(\)\s*readerWindow.resume\(\)\s*applyReaderWindowState\(\)/)
  assert.match(activity, /hasFocus && readerWindow.resumed/)
  assert.match(activity, /fun getReaderEnvironment\(\): String = readerEnvironmentJson/)
  assert.equal((activity.match(/override fun onDestroy\(/g) ?? []).length, 1)
  assert.doesNotMatch(activity, /pauseTimers|resumeTimers|keepWebViewAlive/)
})

test('SAF never chooses Base64 based on provider-declared size and still checks authorization after copying', () => {
  const source = readFileSync(new URL('../src-tauri/android/MonitoredFolderPlugin.kt', import.meta.url), 'utf8')
  const read = source.slice(source.indexOf('fun read(invoke:'), source.indexOf('private fun writeTempDocument'))
  assert.match(read, /JSObject\(\).put\("path", writeTempDocument\(descriptor, cancellation, deadline\)\)/)
  assert.doesNotMatch(source, /ByteArrayOutputStream|encodeToString|BASE64_MAX_BYTES/)
  assert.match(read, /check\(cancellation, deadline\)\s*authorized\(folder.id\)/)
  assert.match(read, /discard\(result\)/)
})

test('Onyx hardware profile parses DeviceUtils/FrontLightController/EpdController capabilities and derives NoteX3Pro fallback', () => {
  const fallback = readOnyxHardwareProfile(host(environment({ memoryClassMb: 256 })))
  assert.equal(fallback.status, 'available')
  if (fallback.status === 'available') {
    assert.equal(fallback.value.boox, true)
    assert.equal(fallback.value.physicalWidthPx, 1860)
    assert.equal(fallback.value.physicalHeightPx, 2480)
    assert.equal(fallback.value.epdController, true)
    assert.equal(fallback.value.frontLight, true)
    assert.equal(fallback.value.ctmLight, true)
    assert.equal(fallback.value.stylus, true)
  }

  const explicit = readOnyxHardwareProfile({
    LightReadInsets: {
      getOnyxHardwareProfile: () => JSON.stringify({
        version: 1,
        boox: true,
        sdkAvailable: true,
        model: 'TabUltraCPro',
        lowRam: false,
        memoryClassMb: 384,
        physicalWidthPx: 2480,
        physicalHeightPx: 1860,
        densityDpi: 300,
        epdController: true,
        frontLight: true,
        ctmLight: true,
        stylus: true,
        colorEink: true,
      }),
    },
  })
  assert.equal(explicit.status, 'available')
  if (explicit.status === 'available') {
    assert.equal(explicit.value.sdkAvailable, true)
    assert.equal(explicit.value.model, 'TabUltraCPro')
    assert.equal(explicit.value.colorEink, true)
  }
})

test('Stage 1–4 Onyx native accelerator handles hardware page-turn keys, cover-sleep checkpoints, content:// staging, ZipFile EPUB search and PdfRenderer', () => {
  onyxNativeAccelerator.resetForTest()
  const calls = []
  let stagedCheckpoint = null
  const mockHost = {
    LightReadInsets: {
      configureHardwareKeys: (capture, vol) => { calls.push(['keys', capture, vol]); return '{}' },
      stageReadingCheckpoint: (bookId, cfi, progress, seconds) => {
        stagedCheckpoint = { bookId, cfi, progress, readingDeltaSeconds: seconds, updatedAtMs: 1700000000000 }
        return true
      },
      consumeReadingCheckpoint: () => {
        if (!stagedCheckpoint) return '{}'
        const out = JSON.stringify(stagedCheckpoint)
        stagedCheckpoint = null
        return out
      },
      drainExternalOpenQueue: () => JSON.stringify([
        { stagedPath: '/data/user/0/io.pagewise.reader/cache/onyx-ext-1.epub', fileName: 'medical-ai.epub', ext: 'epub', size: 409600 },
      ]),
      commitStagedExternalFile: (src, dst) => { calls.push(['commit', src, dst]); return true },
      searchNativeEpubText: (relPath, query, maxHits) => {
        calls.push(['search', relPath, query, maxHits])
        return JSON.stringify([{ href: 'Text/ch01.xhtml', count: 1, excerpts: ['…文石 Note X3 Pro 原生检索…'] }])
      },
      openNativePdfInfo: relPath => {
        calls.push(['pdfInfo', relPath])
        return JSON.stringify({ supported: true, pageCount: 42, firstPageWidth: 595, firstPageHeight: 842 })
      },
      renderNativePdfPage: (relPath, page, w, h) => {
        calls.push(['pdfRender', relPath, page, w, h])
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
      },
    },
  }

  // Stage 1.1: Hardware page-turn keys
  const turns = []
  const unbind = onyxNativeAccelerator.bindHardwarePageTurn(dir => turns.push(dir), true, mockHost)
  assert.deepEqual(calls.at(-1), ['keys', true, true])
  mockHost.__pagewiseHardwarePageTurn('next')
  mockHost.__pagewiseHardwarePageTurn('prev')
  assert.deepEqual(turns, ['next', 'prev'])
  unbind()
  assert.deepEqual(calls.at(-1), ['keys', false, true])

  // Stage 1.2: Cover-sleep checkpoint
  assert.equal(onyxNativeAccelerator.stageReadingCheckpoint('book-42', 'epubcfi(/6/2)', 0.65, 180, mockHost), true)
  const recovered = onyxNativeAccelerator.consumeReadingCheckpoint(mockHost)
  assert.deepEqual(recovered, {
    bookId: 'book-42',
    cfi: 'epubcfi(/6/2)',
    progress: 0.65,
    readingDeltaSeconds: 180,
    updatedAtMs: 1700000000000,
  })
  assert.equal(onyxNativeAccelerator.consumeReadingCheckpoint(mockHost), null)

  // Stage 2: Android content:// zero-copy external open queue
  const queue = onyxNativeAccelerator.drainExternalOpenQueue(mockHost)
  assert.equal(queue.length, 1)
  assert.equal(queue[0].fileName, 'medical-ai.epub')
  assert.equal(onyxNativeAccelerator.commitStagedExternalFile(queue[0].stagedPath, 'books/book-42.epub', mockHost), true)

  // Stage 3: Native ZipFile EPUB full-text search
  const hits = onyxNativeAccelerator.searchNativeEpubText('books/book-42.epub', 'Note X3', 100, mockHost)
  assert.equal(hits?.length, 1)
  assert.equal(hits?.[0].href, 'Text/ch01.xhtml')

  // Stage 4: Native PdfRenderer page rasterizer
  const pdfInfo = onyxNativeAccelerator.openNativePdfInfo('books/paper.pdf', mockHost)
  assert.equal(pdfInfo?.pageCount, 42)
  const dataUrl = onyxNativeAccelerator.renderNativePdfPage('books/paper.pdf', 1, 1860, 2480, mockHost)
  assert.match(dataUrl, /^data:image\/png;base64,/)
})


