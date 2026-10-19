import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
const state = { settings: { ttsVoice: '', ttsEngine: 'system', ttsRate: 1 }, invoke: null }
globalThis.__nativeCallerTest = state
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android caller test' } })
const modules = {
  vue: 'export const reactive=value=>value',
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.__nativeCallerTest.invoke(...args)',
  '../storage': 'export const isTauri=()=>true',
  '../stores/settings': 'export const useSettings=()=>globalThis.__nativeCallerTest.settings',
  './tts.ts': 'export const neuralEngine=()=>null;export const pickVoice=async()=>undefined;export const reportNeuralFailure=()=>{}',
}
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/src/services/') && modules[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` }
  return next(specifier, context)
} })
const { ListenPlayer } = await import('../src/services/listenPlayer.ts')
const { NativeSpeechSession } = await import('../src/services/nativeSpeechSession.ts')
hook.deregister()
const tick = () => new Promise(resolve => setImmediate(resolve))
const wait = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 2)) }; throw Error('condition not reached') }
const deferred = () => Promise.withResolvers()
const options = { voice: '', rate: 1, deadline: 0, stopAtSection: false }
const identity = { owner: 'caller-fixture', sourceVersion: 'extract-v1:source' }
const sentenceFeed = () => { let emitted = false; return { next: async () => { if (emitted) return null; emitted = true; return { key: '0:0:0', text: 'synthetic caller fixture' } } } }
const pdf = readFileSync(new URL('../src/views/PdfReaderView.vue', import.meta.url), 'utf8')
const handlers = ['pauseTTS', 'resumeTTS', 'stopTTS'].map(name => {
  const body = pdf.match(new RegExp(`^function ${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0]
  assert.ok(body, `${name} extracted from actual PDF reader source`)
  return body
}).join('\n')
function actor(barrier, entered, stage) {
  const log = []
  let legacy = 0
  const snapshot = { id: '', instance: 'instance', generation: 0, sequence: 0, state: 'idle', committed: false, index: 0, count: 0, key: '', text: '', reason: '', code: '', ...identity, ...options }
  state.invoke = async (command, args = {}) => {
    if (command === 'system_tts_stop') { legacy++; return { status: 'stopped' } }
    if (command !== 'system_tts_session') throw Error(`unexpected ${command}`)
    const { action, payload } = args
    log.push(action)
    if (action === 'begin') {
      Object.assign(snapshot, { id: 'native-session', state: 'preparing', generation: 1, sequence: 1 })
      if (stage === 'begin') { entered.resolve(); await barrier.promise }
    } else if (action === 'append') { snapshot.count += payload.items.length; snapshot.sequence++ }
    else if (action === 'commit') {
      snapshot.state = payload.autoplay ? 'playing' : 'paused'; snapshot.committed = true; snapshot.sequence++; snapshot.generation++
      if (stage === 'commit') { entered.resolve(); await barrier.promise }
    }
    else if (action === 'configure') { Object.assign(snapshot, payload); snapshot.sequence++ }
    else if (action === 'stop' || action === 'discard') { snapshot.state = 'stopped'; snapshot.sequence++; snapshot.generation++ }
    else if (action === 'pause') { snapshot.state = 'paused'; snapshot.sequence++; snapshot.generation++ }
    else if (action === 'resume') {
      snapshot.state = 'playing'; snapshot.sequence++; snapshot.generation++
      if (stage === 'resume' && !snapshot.resumeGated) { snapshot.resumeGated = true; entered.resolve(); await barrier.promise }
    }
    else if (action !== 'status') throw Error(`unexpected ${action}`)
    return structuredClone(snapshot)
  }
  return { snapshot, log, legacy: () => legacy }
}

test('an empty strict native feed is an explicit error, never a completed book', async t => {
  const native = actor(deferred(), deferred(), 'none'), ended = []
  const player = new ListenPlayer({ onSentenceStart() {}, onEnd: (reason, error) => ended.push({ reason, code: error?.code }) }, async () => identity)
  t.after(() => player.stop())
  player.play({ next: async () => null })
  await wait(() => ended.length > 0)
  assert.deepEqual(ended, [{ reason: 'error', code: 'no_readable_text' }])
  assert.equal(native.log.includes('begin'), false)
})

for (const caller of ['epub', 'pdf']) for (const stage of ['identity', 'begin', 'commit', 'resume']) for (const action of ['stop', 'pause', 'pause-resume']) {
  test(`${caller} actual controls ${action} during pending ${stage} never lose native ownership`, async t => {
    const barrier = deferred(), entered = deferred(), native = actor(barrier, entered, stage)
    const getIdentity = async () => { if (stage === 'identity') { entered.resolve(); await barrier.promise }; return identity }
    let client, controls, playback
    if (caller === 'epub') {
      client = new ListenPlayer({ onSentenceStart() {}, onEnd() {} }, getIdentity)
      controls = { stop: () => client.stop(), pause: () => client.pause(), resume: () => client.resume() }
      client.play(sentenceFeed())
      t.after(async () => { client.stop(); for (let i = 0; i < 8; i++) await tick() })
    } else {
      client = new NativeSpeechSession(getIdentity, () => {})
      const ui = { value: 'playing' }
      const actual = new Function('ttsState', 'nativeSpeech', 'pauseSpeech', 'resumeSpeech', 'stopSpeech', 'toast', 't', 'systemTtsErrorKey', 'nativeListening', `let ttsSession=0;${handlers};return {stop:stopTTS,pause:pauseTTS,resume:resumeTTS}`)(
        ui, client, () => { throw Error('wrong legacy pause') }, () => { throw Error('wrong legacy resume') }, () => { throw Error('wrong legacy stop') }, () => {}, key => key, () => 'error', { value: null },
      )
      controls = actual
      playback = client.play(sentenceFeed(), options)
      t.after(() => client.detach())
    }
    await entered.promise
    controls[action === 'pause-resume' ? 'pause' : action]()
    if (action === 'pause-resume') controls.resume()
    barrier.resolve()
    if (action === 'stop') {
      if (playback) assert.equal(await playback, 'stopped')
      for (let i = 0; i < 8; i++) await tick()
      assert.equal(native.log.includes('commit'), ['commit', 'resume'].includes(stage))
      if (stage === 'begin') assert.equal(native.log.includes('discard'), true)
    } else {
      await wait(() => native.snapshot.committed)
      for (let i = 0; i < 8; i++) await tick()
      if (action === 'pause-resume') await wait(() => native.snapshot.state === 'playing')
      assert.equal(native.snapshot.state, action === 'pause' ? 'paused' : 'playing')
      controls.stop()
      if (playback) await playback
      await wait(() => native.snapshot.state === 'stopped')
    }
    assert.equal(native.legacy(), 0)
  })
}
