import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { onyxEpd } from '../src/services/onyxEpd.ts'

test('new Android shell owns EPD timers and state; the web facade never schedules a second timer', () => {
  const previous = globalThis.window, originalTimer = globalThis.setTimeout
  const calls = []
  const state = { mode: 'regal', defaultMode: 'regal', fastMode: false, scene: '', pageTurnCount: 0, gcIntervalPages: 10 }
  let timers = 0
  onyxEpd.resetForTest()
  globalThis.window = { LightReadInsets: {
    getEpdStatus: () => JSON.stringify(state),
    setEpdFastMode: (enabled, scene, mode) => {
      calls.push(['fast', enabled]); Object.assign(state, { fastMode: enabled, scene: enabled ? scene : '', mode: enabled ? mode : 'regal' })
      return JSON.stringify(state)
    },
    notifyEpdPageTurn: () => { calls.push(['turn']); state.pageTurnCount++; return JSON.stringify(state) },
    scheduleEpdFastExit: delay => calls.push(['exit', delay]),
    scheduleEpdOverlayRepaint: (mode, delay) => calls.push(['overlay', mode, delay]),
  } }
  globalThis.setTimeout = (...args) => { timers++; return originalTimer(...args) }
  try {
    onyxEpd.enterFastMode('scroll', 'a2')
    onyxEpd.scheduleExitFastMode(180)
    onyxEpd.enterFastMode('scroll', 'a2')
    assert.deepEqual(calls.slice(0, 3), [['fast', true], ['exit', 180], ['fast', true]], 'renewed gesture cancels the native pending exit even in the same fast mode')
    onyxEpd.scheduleExitFastMode(NaN)
    onyxEpd.repaintAfterOverlayClose('gc', 999999)
    assert.deepEqual(calls.slice(-2), [['exit', 180], ['overlay', 'gc', 2000]])
    assert.equal(timers, 0)
    // Simulates a native Handler firing while JS was suspended; observation must not retain its old state.
    Object.assign(state, { mode: 'regal', fastMode: false, scene: '' })
    assert.equal(onyxEpd.getStatus().fastMode, false)
    assert.equal(onyxEpd.notifyPageTurn().pageTurnCount, 1)
    assert.deepEqual(calls.at(-1), ['turn'])
  } finally {
    globalThis.setTimeout = originalTimer
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
    onyxEpd.resetForTest()
  }
})

test('old shell returning a pre-UI-thread snapshot still exits fast mode through its JS timer', () => {
  const previous = globalThis.window, originalTimer = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  const ui = [], timers = [], calls = []
  const native = { mode: 'regal', defaultMode: 'regal', fastMode: false, scene: '', pageTurnCount: 0, gcIntervalPages: 10 }
  onyxEpd.resetForTest()
  globalThis.window = { LightReadInsets: {
    setEpdFastMode: (enabled, scene, mode) => {
      calls.push(enabled)
      const before = JSON.stringify(native)
      ui.push(() => Object.assign(native, { fastMode: enabled, mode: enabled ? mode : 'regal', scene: enabled ? scene : '' }))
      return before
    },
  } }
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length }
  globalThis.clearTimeout = () => {}
  try {
    assert.equal(onyxEpd.enterFastMode('scroll', 'a2').fastMode, true, 'old asynchronous ACK must not overwrite pending local intent')
    ui.shift()()
    assert.equal(native.fastMode, true)
    onyxEpd.scheduleExitFastMode(180)
    timers.shift()()
    assert.deepEqual(calls, [true, false], 'exit command must be sent even though enter ACK said false')
    ui.shift()()
    assert.equal(native.fastMode, false)
    assert.equal(onyxEpd.getStatus().fastMode, false)
  } finally {
    globalThis.setTimeout = originalTimer
    globalThis.clearTimeout = originalClear
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
    onyxEpd.resetForTest()
  }
})

test('native lifecycle cancels both delayed jobs; detached and paused windows cannot repaint', () => {
  const source = readFileSync(new URL('../src-tauri/android/OnyxSdkBridge.kt', import.meta.url), 'utf8')
  assert.match(source, /fun onLifecyclePause\(webView: WebView\?\) \{\s*cancelPendingEpdWork\(\)/)
  assert.match(source, /fun onLifecycleDestroy\(webView: WebView\?\) \{\s*cancelPendingEpdWork\(\)/)
  assert.match(source, /if \(windowState.resumed\) setFastMode/)
  assert.match(source, /if \(windowState.resumed\) repaintScreen/)
  assert.match(source, /pendingFastExit\?\.let \{ epdHandler.removeCallbacks\(it\) \}/)
  assert.match(source, /pendingOverlayRepaint\?\.let \{ epdHandler.removeCallbacks\(it\) \}/)
})
