import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const service = readFileSync(new URL('../src-tauri/android/NativeSpeechService.kt', import.meta.url), 'utf8')
const plugin = readFileSync(new URL('../src-tauri/android/SystemTtsPlugin.kt', import.meta.url), 'utf8')
const body = name => {
  const start = service.indexOf(`fun ${name}(`)
  assert.notEqual(start, -1, name)
  const open = service.indexOf('{', start)
  let depth = 1, end = open + 1
  for (; depth; end++) {
    if (service[end] === '{') depth++
    if (service[end] === '}') depth--
    assert.ok(end < service.length, name)
  }
  return service.slice(open + 1, end - 1)
}

test('native speech has one looper owner, including lifecycle and native callbacks', () => {
  assert.match(service, /HandlerThread\("PagewiseSpeech"\)/)
  assert.doesNotMatch(service, /Executors\.|main\.post|Looper\.getMainLooper/)
  assert.match(body('onCreate'), /postEvent/)
  assert.match(body('onInit'), /postEvent/)
  assert.match(body('onStartCommand'), /postEvent/)
  assert.match(body('onDestroy'), /closing\.set\(true\)[\s\S]*owner\.post/)
  assert.match(service, /setOnAudioFocusChangeListener\(listener, owner\)/)
  assert.match(service, /focusEpoch != epoch/)
  assert.match(service, /if \(matches\(id\)\) fail\("tts_timeout"\)/)
})

test('status never reads the queue; current record is cached at cursor transitions', () => {
  assert.doesNotMatch(body('snapshot'), /\.read\(|File|persist\(/)
  assert.match(service, /private var currentRecord: JSONObject\?/)
  assert.match(service, /currentRecord\?\.optString\("text"\)/)
})

test('transport admission is bounded, timed-out queued commands cannot mutate, replies use main', () => {
  assert.match(body('submit'), /pending\.incrementAndGet\(\) > 64/)
  assert.match(body('submit'), /cancelled\(\)/)
  assert.match(plugin, /owner\.submit\(\{ settled\.get\(\) \|\| destroyed \}/)
  assert.match(plugin, /main\.post \{ invoke\.resolve\(value\) \}/)
  assert.match(body('ready'), /readyCallbacks\.size >= 64/)
  assert.match(plugin, /waiting\.size >= 64/)
})

test('durable queue and atomic checkpoint publication remain before success acknowledgement', () => {
  assert.match(service, /fun sync\(\) \{[\s\S]*?it\.fd\.sync\(\)/)
  assert.match(body('persist'), /out\.fd\.sync\(\)/)
  assert.match(body('persist'), /checkpoint\.finishWrite\(out\)/)
  assert.match(body('persist'), /readBytes\(\)\.contentEquals\(bytes\)/)
  assert.match(body('persist'), /Os\.fsync\(directory\)/)
  const dispatch = body('dispatch')
  assert.ok(dispatch.indexOf('next.sync()') < dispatch.indexOf('old?.file?.delete()'))
  assert.ok(dispatch.indexOf('persist()') < dispatch.lastIndexOf('resolve(snapshot())'))
})
