import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// Exercise the real backend; no Android, keys or book content are accessed.
const state = { settings: { ttsVoice: 'chosen-offline' }, invoke: null }
globalThis.__systemTtsRuntime = state
const url = new URL('../src/services/systemTts.ts', import.meta.url).href
const modules = {
  vue: 'export const reactive = value => value',
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__systemTtsRuntime.invoke(...args)',
  '../storage': 'export const isTauri = () => false',
  '../stores/settings': 'export const useSettings = () => globalThis.__systemTtsRuntime.settings',
}
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === url && modules[specifier]) return {
      shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`,
    }
    return next(specifier, context)
  },
})
const { createNativeBackend, systemTts, systemVoiceHintKey, systemTtsErrorKey } = await import(url)
hook.deregister()
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness() {
  const calls = []
  state.invoke = (command, args) => {
    const deferred = Promise.withResolvers()
    calls.push({ command, args, ...deferred })
    if (command === 'system_tts_stop') deferred.resolve({ status: 'stopped', index: 0 })
    if (command === 'system_tts_status') deferred.resolve({ index: 1, playing: true })
    return deferred.promise
  }
  return { backend: createNativeBackend(), calls }
}
const byCommand = (calls, command) => calls.filter(call => call.command === command)

test('manual voice is sent and a completed utterance settles exactly once', async () => {
  const { backend, calls } = harness()
  let ends = 0
  backend.speak({ text: 'synthetic', onend: () => ends++ })
  await tick()
  const [speak] = byCommand(calls, 'system_tts_speak')
  assert.equal(speak.args.voice, 'chosen-offline')
  speak.resolve({ status: 'done' })
  await tick()
  assert.equal(ends, 1)
  backend.cancel()
})

test('pause/resume replays current sentence and ignores the old completion', async () => {
  const { backend, calls } = harness()
  let ends = 0
  backend.speak({ text: 'synthetic', onend: () => ends++ })
  await tick()
  const old = byCommand(calls, 'system_tts_speak')[0]
  backend.pause()
  backend.resume()
  await tick()
  const next = byCommand(calls, 'system_tts_speak')[1]
  old.resolve({ status: 'done' })
  await tick()
  assert.equal(ends, 0)
  assert.equal(next.args.text, old.args.text)
  next.resolve({ status: 'done' })
  await tick()
  assert.equal(ends, 1)
  backend.cancel()
})

test('cancel settles single-utterance callers as cancelled, not completed', async () => {
  const { backend, calls } = harness()
  const errors = []
  backend.speak({ text: 'synthetic', onerror: event => errors.push(event.error) })
  await tick()
  backend.cancel()
  byCommand(calls, 'system_tts_speak')[0].resolve({ status: 'done' })
  await tick()
  assert.deepEqual(errors, ['canceled'])
})

test('old cancelled batch cannot resurrect after a new batch starts', async () => {
  const { backend, calls } = harness()
  const old = backend.speakBatch(['old'], 1, '', () => {})
  const oldOutcome = assert.rejects(old, error => error.code === 'canceled')
  await tick()
  backend.cancel()
  const next = backend.speakBatch(['new'], 1, 'manual', () => {})
  await tick()
  const batches = byCommand(calls, 'system_tts_speak_batch')
  batches[0].reject({ code: 'tts_stopped' })
  batches[1].resolve({ status: 'done', index: 1 })
  await oldOutcome
  assert.equal(await next, 1)
  assert.equal(batches[1].args.voice, 'manual')
  assert.equal(byCommand(calls, 'system_tts_speak_batch').length, 2)
  backend.cancel()
})

test('batch pause retains native position and resumes without dropping a sentence', async () => {
  const { backend, calls } = harness()
  const result = backend.speakBatch(['a', 'b', 'c'], 1, '', () => {})
  await tick()
  backend.pause()
  byCommand(calls, 'system_tts_speak_batch')[0].reject({ code: 'tts_stopped' })
  await tick()
  assert.equal(byCommand(calls, 'system_tts_speak_batch').length, 1)
  backend.resume()
  await tick()
  const next = byCommand(calls, 'system_tts_speak_batch')[1]
  assert.deepEqual(next.args.texts, ['b', 'c'])
  next.resolve({ status: 'done', index: 2 })
  assert.equal(await result, 3)
  backend.cancel()
})

test('focus loss pauses a batch and signals UI; only manual resume starts playback', async () => {
  const { backend, calls } = harness()
  const before = systemTts.focusLoss
  const result = backend.speakBatch(['a', 'b'], 1, '', () => {})
  await tick()
  byCommand(calls, 'system_tts_speak_batch')[0].reject({ code: 'audio_focus_lost' })
  await tick()
  assert.equal(systemTts.focusLoss, before + 1)
  assert.equal(byCommand(calls, 'system_tts_speak_batch').length, 1)
  backend.resume()
  await tick()
  byCommand(calls, 'system_tts_speak_batch')[1].resolve({ status: 'done', index: 1 })
  assert.equal(await result, 2)
  backend.cancel()
})

test('missing offline voice rejects the batch with an actionable localization key', async () => {
  const { backend, calls } = harness()
  const result = backend.speakBatch(['a'], 1, '', () => {})
  const outcome = assert.rejects(result, error => systemTtsErrorKey(error) === 'tts.systemNoOffline')
  await tick()
  byCommand(calls, 'system_tts_speak_batch')[0].reject({ code: 'no_offline_voice' })
  await outcome
  backend.cancel()
})

test('an unsuccessful native batch is not counted as read', async () => {
  const { backend, calls } = harness()
  const result = backend.speakBatch(['a', 'b'], 1, '', () => {})
  const outcome = assert.rejects(result, error => error.code === 'tts_error')
  await tick()
  byCommand(calls, 'system_tts_speak_batch')[0].resolve({ status: 'stopped', index: 1 })
  await outcome
  backend.cancel()
})

test('selected online voice cannot inherit an offline promise from another installed voice', () => {
  systemTts.chinese = true
  systemTts.voices = [
    { name: 'local', locale: 'zh-CN', network: false },
    { name: 'remote', locale: 'zh-CN', network: true },
  ]
  assert.equal(systemVoiceHintKey('remote'), 'tts.hintSystemOnline')
  assert.equal(systemVoiceHintKey('local'), 'tts.hintSystem')
  assert.equal(systemVoiceHintKey('removed'), 'tts.systemVoiceMissing')
  systemTts.chinese = false
  assert.equal(systemVoiceHintKey(''), 'tts.systemNoOffline')
})

test('resume waits for the native stop acknowledgement before speaking again', async () => {
  const { backend, calls } = harness()
  let stop
  const original = state.invoke
  state.invoke = (command, args) => {
    if (command === 'system_tts_stop') {
      stop = Promise.withResolvers()
      return stop.promise
    }
    return original(command, args)
  }
  backend.speak({ text: 'a' })
  await tick()
  backend.pause()
  backend.resume()
  await tick()
  assert.equal(byCommand(calls, 'system_tts_speak').length, 1)
  stop.resolve({ status: 'stopped' })
  await tick()
  assert.equal(byCommand(calls, 'system_tts_speak').length, 2)
  backend.cancel()
  stop.resolve({ status: 'stopped' })
})
