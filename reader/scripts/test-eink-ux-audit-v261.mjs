import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8')

test('P0-A: real Onyx BOOX SDK integration, manifest hygiene, and strict hardware gating', () => {
  const gradle = read('src-tauri/android/native-import.gradle.kts')
  assert.match(gradle, /onyxsdk-device:1\.3\.7/)
  assert.match(gradle, /onyxsdk-pen:1\.5\.9/)
  assert.match(gradle, /hiddenapibypass:4\.3/)
  assert.match(gradle, /libc\+\+_shared\.so/)

  const prep = read('scripts/prepare-android-project.mjs')
  for (const perm of ['SYSTEM_ALERT_WINDOW', 'WRITE_EXTERNAL_STORAGE', 'READ_EXTERNAL_STORAGE', 'DUMP', 'BLUETOOTH', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_STATE']) {
    assert.ok(prep.includes(perm), `Manifest sanitizer must strip ${perm}`)
  }
  assert.match(prep, /tools:node="remove"/)
  assert.match(prep, /android\.intent\.action\.PROCESS_TEXT/)

  const bridge = read('src-tauri/android/OnyxSdkBridge.kt')
  assert.match(bridge, /EpdController\./)
  assert.match(bridge, /FrontLightController\./)
  assert.match(bridge, /TouchHelper\.create/)
  assert.match(bridge, /RawInputCallback/)
  assert.doesNotMatch(bridge, /epdClassPresent/)
  assert.doesNotMatch(bridge, /epdAvailable\s*\|\|/)

  const envTs = read('src/services/nativeReaderEnvironment.ts')
  assert.doesNotMatch(envTs, /NoteX3Pro|1860\s*\*\s*2480|hasFrontLight:\s*true|maxTouchPressure:\s*4096/)
})

test('P0-B / P0-C / P0-D: PDF portrait scroll unlock, scrollByScreen, scribble guards, IDB persistence & undo/clear', () => {
  const layout = read('src/services/portraitLayout.ts')
  assert.match(layout, /einkActive\??:\s*boolean/)

  const pdfView = read('src/views/PdfReaderView.vue')
  assert.match(pdfView, /einkActive:\s*einkRuntime\.value/)
  assert.match(pdfView, /if\s*\(\s*scribbleEnabled\.value\s*\)\s*return/)
  assert.match(pdfView, /v-if="n === currentPage \|\| mountedPageSet\.has\(n\)"/)
  assert.match(pdfView, /id="pw-pdf-scan-darken"/)
  assert.match(pdfView, /activeAnnotation\.value = \{ \.\.\.hit\.a \}/)
  assert.match(pdfView, /scrollByScreen\(-1\)/)
  assert.match(pdfView, /scrollByScreen\(1\)/)

  const scribble = read('src/services/onyxScribble.ts')
  assert.match(scribble, /pagewise-ink-v1/)
  assert.match(scribble, /decimateStrokePoints/)
  assert.match(scribble, /savePageStrokesAsync/)
  assert.match(scribble, /deleteBookInkStrokes/)
  assert.match(scribble, /isNativeActive/)

  const inkLayer = read('src/components/OnyxInkLayer.vue')
  assert.match(inkLayer, /@pointerdown\.stop=/)
  assert.match(inkLayer, /@click\.stop/)
  assert.match(inkLayer, /undoLastInk/)
  assert.match(inkLayer, /confirmClear/)
  assert.match(inkLayer, /vector-effect="non-scaling-stroke"/)
  assert.match(inkLayer, /registerGeometryListener/)

  const archive = read('src/services/boundedArchive.ts')
  assert.match(archive, /ink-strokes\.json/)
})

test('R1-R7 & K1-K5: unified EPD orchestration, silent background web actions, physical keys & smooth scroll removal', () => {
  const bridge = read('src-tauri/android/OnyxSdkBridge.kt')
  const keyFn = bridge.split('fun handleHardwareKeyEvent(')[1].split('fun stageReadingCheckpoint(')[0]
  assert.doesNotMatch(keyFn, /notifyPageTurn/)

  const host = read('src-tauri/android/NativeManagementHost.kt')
  assert.match(host, /SILENT_BACKGROUND_ACTIONS/)

  const ui = read('src-tauri/android/NativeUi.kt')
  assert.match(ui, /configureEinkScroll/)
  assert.match(ui, /stepScroll/)
  assert.match(ui, /KEYCODE_PAGE_DOWN/)
  assert.doesNotMatch(ui, /KEYCODE_DPAD_UP/)

  const ctrl = read('src-tauri/android/NativePagesController.kt')
  assert.match(ctrl, /showTransitionCount\s*>=\s*10/)
  assert.match(ctrl, /scheduleOverlayRepaint/)

  const stream = read('src/services/einkStreamAggregator.ts')
  assert.match(stream, /48/)
  assert.match(stream, /1200/)
  assert.match(stream, /'du'/)

  const pdfAi = read('src/components/PdfReadingAssistant.vue')
  assert.doesNotMatch(pdfAi, /EINK_FLUSH_CHARS|EINK_FLUSH_INTERVAL/)
  assert.match(pdfAi, /!settings\.readingMode\.eink\.enabled/)
})

test('T1-T7 & S1-S4: tap zones, swipes, highlight bar, typography floor, WakeLock, external intents & sleep cover', () => {
  const reader = read('src/views/ReaderView.vue')
  assert.match(reader, /resolveTapAction\(/)
  assert.match(reader, /if\s*\(\s*action === 'bars'\s*&&\s*handleEpubRichMediaTap\(target\)\s*\)/)
  assert.match(reader, /eink-reduced-motion/)
  assert.match(reader, /isBookmarkAtCurrentPage/)
  assert.match(reader, /clearFlashMark/)
  assert.match(reader, /syncKeepScreenOn/)
  assert.match(reader, /syncSleepCoverIfEnabled/)
  assert.match(reader, /settings\.readingMode\.eink\.sleepCover/)
  assert.match(reader, /consumeReadingCheckpoint/)

  const typo = read('src/services/readerTypographyProfiles.ts')
  assert.match(typo, /einkDevice\??:\s*boolean/)
  assert.match(typo, /Math\.max\(18/)
  assert.match(typo, /Math\.max\(1\.65/)

  const bridge = read('src-tauri/android/OnyxSdkBridge.kt')
  assert.match(bridge, /ioExecutor/)
  assert.match(bridge, /ACTION_SEND_MULTIPLE/)
  assert.match(bridge, /ActivityNotFoundException/)
  assert.match(bridge, /sleep_cover_uri/)
  assert.doesNotMatch(bridge, /\bThread\s*\{/)
})

test('M1-M8: batch SQL, cover cache, SAF >500 export, 4-level geometric heatmap, table wrap & English i18n', () => {
  const repo = read('src-tauri/android/NativeLibraryRepository.kt')
  assert.match(repo, /fun booksByIds\(/)

  const libPanel = read('src-tauri/android/NativeLibraryPanel.kt')
  assert.match(libPanel, /library\.booksByIds/)
  assert.doesNotMatch(libPanel, /metadataQueue/)

  const ui = read('src-tauri/android/NativeUi.kt')
  assert.match(ui, /LruCache/)
  assert.match(ui, /cachedCoverBitmap/)

  const stats = read('src-tauri/android/NativeStatsPanel.kt')
  assert.match(stats, /goalSec > 0\.0/)
  assert.match(stats, /seconds < 900\.0/)
  assert.match(stats, /drawCircle/)
  assert.match(stats, /calendarViewShown = false/)

  const manual = read('src-tauri/android/NativeManualRenderer.kt')
  assert.match(manual, /TableLayout/)
  assert.match(manual, /colCount <= 4/)

  const noteEd = read('src-tauri/android/NativeNoteEditor.kt')
  assert.match(noteEd, /private val english: Boolean = false/)
  assert.match(noteEd, /Edit note/)

  const clsEd = read('src-tauri/android/NativeClassificationEditor.kt')
  assert.match(clsEd, /private val english: Boolean = false/)
  assert.match(clsEd, /Classification & Tags/)

  const ctrl = read('src-tauri/android/NativePagesController.kt')
  assert.match(ctrl, /exportBusy/)
  assert.match(ctrl, /launchCreateMarkdownDocument/)
  assert.match(ctrl, /Export notes/)
  assert.doesNotMatch(ctrl, /text\("最近留下的标注/)
})

test('Runtime behavior: onyxScribble IDB caching, sync guard, idMap safety & failure propagation', async () => {
  const { onyxScribble, importAllInkStrokes, closeInkDbForTest } = await import('../src/services/onyxScribble.ts')
  const origIdb = globalThis.indexedDB
  const origStorage = globalThis.localStorage
  const storeData = new Map()
  let openCount = 0
  let closeCount = 0
  let failWrites = false

  function makeMockIdb() {
    const db = {
      objectStoreNames: { contains: name => name === 'ink_strokes' },
      createObjectStore: () => ({}),
      onversionchange: null,
      onclose: null,
      close() {
        closeCount++
        this.onclose?.()
      },
      transaction(_storeName, _mode) {
        const tx = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          objectStore() {
            const objStore = {
              get(id) {
                const req = { onsuccess: null, onerror: null, result: storeData.get(id) }
                queueMicrotask(() => req.onsuccess?.())
                return req
              },
              getAll() {
                const req = { onsuccess: null, onerror: null, result: [...storeData.values()] }
                queueMicrotask(() => req.onsuccess?.())
                return req
              },
              put(record) {
                queueMicrotask(() => {
                  if (failWrites) {
                    tx.error = new Error('Simulated IDB disk full')
                    tx.onerror?.()
                  } else {
                    storeData.set(record.id, record)
                    tx.oncomplete?.()
                  }
                })
              },
              delete(id) {
                queueMicrotask(() => {
                  if (failWrites) {
                    tx.error = new Error('Simulated IDB delete fail')
                    tx.onerror?.()
                  } else {
                    storeData.delete(id)
                    tx.oncomplete?.()
                  }
                })
              },
            }
            return objStore
          },
        }
        return tx
      },
    }
    return {
      open() {
        openCount++
        const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
        queueMicrotask(() => {
          req.onupgradeneeded?.()
          req.onsuccess?.()
        })
        return req
      },
    }
  }

  globalThis.indexedDB = makeMockIdb()
  const ls = new Map()
  globalThis.localStorage = {
    get length() { return ls.size },
    key: i => [...ls.keys()][i] ?? null,
    getItem: k => ls.get(k) ?? null,
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: k => ls.delete(k),
  }

  try {
    onyxScribble.resetForTest()
    const syncRes = onyxScribble.savePageStrokes('b1', 'pdf:1', [{
      id: 'st-0', tool: 'fountain', width: 2, points: [{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.2, y: 0.2, p: 0.5 }], createdAt: 1730000000000,
    }])
    assert.equal(syncRes.ok, false)

    const sampleStroke = {
      id: 'st-1', tool: 'fountain', width: 3, points: [{ x: 0.1, y: 0.2, p: 0.5 }, { x: 0.4, y: 0.5, p: 0.6 }], createdAt: 1730000000001,
    }
    const entries = [
      { bookId: 'old-mapped', pageKey: 'pdf:1', strokes: [sampleStroke] },
      { bookId: 'unmapped-book', pageKey: 'pdf:2', strokes: [{ ...sampleStroke, id: 'st-unmapped' }] },
    ]
    const importedCount = await importAllInkStrokes(entries, new Map([['old-mapped', 'new-mapped']]))
    assert.equal(importedCount, 1)
    assert.ok(storeData.has('new-mapped::pdf:1'))
    assert.equal(storeData.has('unmapped-book::pdf:2'), false)
    assert.equal(openCount, 1)

    failWrites = true
    await assert.rejects(
      importAllInkStrokes([{ bookId: 'old-mapped', pageKey: 'pdf:3', strokes: [{ ...sampleStroke, id: 'st-fail' }] }], new Map([['old-mapped', 'new-mapped']])),
      /Simulated IDB disk full/,
    )

    await closeInkDbForTest()
    assert.equal(closeCount, 1)
  } finally {
    await closeInkDbForTest()
    if (origIdb === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = origIdb
    if (origStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = origStorage
  }
})

test('C-REVIEW-01 contracts: native i18n coverage, routeStateKey annotations, AndroidManifest text/plain & OnyxSdkBridge', () => {
  const ctrl = read('src-tauri/android/NativePagesController.kt')
  const mapPart = ctrl.slice(ctrl.indexOf('private fun label(zh: String)'), ctrl.indexOf('private fun text('))
  const mapped = new Set([...mapPart.matchAll(/"([^"]+)"\s+to\s+"/g)].map(m => m[1]))
  for (const fn of ['label', 'button', 'confirm', 'dialog']) {
    for (const m of ctrl.matchAll(new RegExp(`\\b${fn}\\(\\s*"([^"]*[\\u4e00-\\u9fff][^"]*)"`, 'g'))) {
      assert.ok(mapped.has(m[1]), `Missing label() English entry for ${fn}("${m[1]}")`)
    }
  }
  assert.ok(mapped.has('搜索书名、作者、笔记'))
  assert.match(ctrl, /pageName == "annotations" \|\| pageName == "notes"/)

  const host = read('src-tauri/android/NativeManagementHost.kt')
  assert.match(host, /"noteDraftSave"/)

  const bridge = read('src-tauri/android/OnyxSdkBridge.kt')
  assert.doesNotMatch(bridge, /appApplied \|\| webView != null/)
  assert.doesNotMatch(bridge, /cleared \|\| webView != null/)
  assert.match(bridge, /frontLightLock/)
  assert.match(bridge, /RejectedExecutionException/)

  const manifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml')
  const txtFilterBlock = (manifest.match(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g) ?? [])
    .find(block => block.includes('android:mimeType="text/plain"'))
  assert.ok(txtFilterBlock, 'Expected text/plain intent-filter')
  assert.doesNotMatch(txtFilterBlock, /android\.intent\.action\.SEND/)
  assert.match(txtFilterBlock, /android\.intent\.action\.VIEW/)
})

test('Library visible category tabs do not spawn a redundant 3rd active-filter chip row', () => {
  const nativeLibrary = read('src-tauri/android/NativeLibraryPanel.kt')
  assert.match(nativeLibrary, /val visibleCategoryValues = categories\.map \{ it\.getString\("value"\) \}\.toSet\(\)/)
  assert.match(nativeLibrary, /collectActiveFilterChips\(visibleCategoryValues\)/)
  assert.match(nativeLibrary, /private fun collectActiveFilterChips\(visibleCategoryValues: Set<String> = emptySet\(\)\)/)
  assert.match(nativeLibrary, /if \(cat\.isNotBlank\(\) && cat !in visibleCategoryValues\)/)

  const webLibrary = read('src/views/LibraryView.vue')
  assert.match(webLibrary, /const hasOrphanCategoryFilter = computed\(/)
  assert.match(webLibrary, /const hasActiveFilters = computed\(/)
  assert.match(webLibrary, /const hasActiveChips = computed\(/)
  assert.match(webLibrary, /hasActiveFilters\.value \? undefined/)
  assert.match(webLibrary, /hasActiveFilters \? ' · ' \+ query\.total : ''/)
  assert.match(webLibrary, /<span v-if="hasOrphanCategoryFilter" class="chip">/)
})
