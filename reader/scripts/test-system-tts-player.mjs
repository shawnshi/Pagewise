import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const state = { settings: { ttsVoice: '', ttsEngine: 'system', ttsRate: 1 }, invoke: null }
globalThis.__nativePlayerTest = state
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android test' } })
const modules = {
  vue: 'export const reactive = value => value',
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__nativePlayerTest.invoke(...args)',
  '../storage': 'export const isTauri = () => true',
  '../stores/settings': 'export const useSettings = () => globalThis.__nativePlayerTest.settings',
  './tts.ts': 'export const neuralEngine=()=>null; export const pickVoice=async()=>undefined; export const reportNeuralFailure=()=>{}',
}
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/src/services/') && modules[specifier]) return {
      shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`,
    }
    return next(specifier, context)
  },
})
const { ListenPlayer } = await import('../src/services/listenPlayer.ts')
hook.deregister()
const tick = () => new Promise(resolve => setImmediate(resolve))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const feed = values => ({ next: async () => values.length ? { key: values[0], text: values.shift() } : null })
function harness() {
  const batches = []
  let stops = 0
  state.invoke = (command, args) => {
    if (command === 'system_tts_stop') { stops++; return Promise.resolve({ status: 'stopped' }) }
    if (command === 'system_tts_status') return Promise.resolve({ playing: true, index: 1 })
    if (command === 'system_tts_speak_batch') {
      const deferred = Promise.withResolvers()
      batches.push({ args, ...deferred })
      return deferred.promise
    }
    throw new Error(`Unexpected command ${command}`)
  }
  const ends = []
  const marks = []
  const player = new ListenPlayer({ onSentenceStart: key => marks.push(key), onEnd: reason => ends.push(reason) })
  return { player, batches, ends, marks, stops: () => stops }
}

test('changing native settings returns unread sentences to the real source', async () => {
  const { player, batches, marks, ends } = harness()
  player.play(feed(['a', 'b', 'c']))
  await tick()
  assert.deepEqual(batches[0].args.texts, ['a', 'b', 'c'])
  await pause(390)
  assert.deepEqual(marks, ['b'])
  player.invalidate()
  batches[0].reject({ code: 'tts_stopped' })
  await tick()
  assert.deepEqual(batches[1].args.texts, ['b', 'c'])
  batches[1].resolve({ status: 'done', index: 2 })
  await tick()
  assert.deepEqual(ends, ['finished'])
})

test('a late result from a stopped player cannot stop the next native session', async () => {
  const { player, batches, ends, stops } = harness()
  player.play(feed(['old']))
  await tick()
  player.play(feed(['new']))
  await tick()
  const before = stops()
  batches[0].reject({ code: 'tts_stopped' })
  await tick()
  assert.equal(stops(), before, 'old cleanup must not cancel the current native session')
  assert.deepEqual(batches[1].args.texts, ['new'])
  assert.deepEqual(ends, [])
  batches[1].resolve({ status: 'done', index: 1 })
  await tick()
  assert.deepEqual(ends, ['finished'])
})

test('changing voice while paused never starts a new batch until Resume', async () => {
  const { player, batches } = harness()
  player.play(feed(['a', 'b']))
  await tick()
  player.pause()
  batches[0].reject({ code: 'tts_stopped' })
  await tick()
  player.invalidate()
  await tick()
  assert.equal(batches.length, 1)
  assert.equal(player.state, 'paused')
  player.resume()
  await tick()
  assert.equal(batches.length, 2)
  batches[1].resolve({ status: 'done', index: batches[1].args.texts.length })
  await tick()
})
