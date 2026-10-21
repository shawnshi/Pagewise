import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
const forbid = () => { throw new Error('External IO prohibited') }
globalThis.fetch = forbid
http.request = http.get = https.request = https.get = net.connect = net.createConnection = forbid
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !extname(specifier)) {
    const candidate = fileURLToPath(new URL(specifier + '.ts', context.parentURL))
    if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context)
    const index = fileURLToPath(new URL(specifier + '/index.ts', context.parentURL))
    if (existsSync(index)) return next(pathToFileURL(index).href, context)
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (globalThis.__r3RegistryStorage && url === new URL('../src/storage/index.ts', import.meta.url).href) {
    return { format: 'module', shortCircuit: true, source: 'export async function getStorage() { return globalThis.__r3RegistryStorage }' }
  }
  return next(url, context)
} })
globalThis.localStorage = { getItem: () => null, setItem: () => { /* Synthetic browser boundary only. */ } }
const { createPinia } = await import('pinia')
const { toRaw } = await import('vue')
const { useSettings, settingsDefaults } = await import('../src/stores/settings.ts')
const { getNativeState, initializeNativeState, settingsDiff, stateError } = await import('../src/services/nativeState.ts')
const { applyNativeSettingsEdits, createNativeSettingsActions, NATIVE_SETTINGS_FIELDS } = await import('../src/services/nativeSettingsEditing.ts')
const copy = value => structuredClone(toRaw(value))
const get = (root, path) => path.reduce((object, key) => object[key], root)
function patch(root, path, value) {
  const parent = get(root, path.slice(0, -1)), key = path.at(-1)
  return { path, before: Object.hasOwn(parent, key) ? { present: true, value: copy(parent[key]) } : { present: false }, after: { present: true, value } }
}
function fixture() {
  // Use the real Pinia provider/reset/calibration owner. Persistence and physical metrics alone are injected.
  const store = useSettings(createPinia())
  store.$patch({ aiProvider: 'deepseek', aiApiKey: 'SYNTHETIC-DEEPSEEK', aiProfiles: {
    openai: { baseUrl: 'https://openai.synthetic.invalid/v1', apiKey: 'SYNTHETIC-OPENAI', model: 'synthetic-openai' },
    builtin: { baseUrl: 'https://retired.synthetic.invalid', apiKey: 'INERT-ARCHIVE', model: 'inert' },
  }, pagewiseCompanion: { enabled: false, consentAll: false, channel: 'builtin', perBook: { synthetic: false } } })
  const calls = [], flags = { flushError: null, recovery: { unsavedPaths: [], failedCommits: [] }, patchError: null, probeError: null }
  let current = copy(store.$state), revision = 0, physical = { dpr: 2, textScale: 1 }
  const client = {
    settings: () => copy(current), settingsSnapshot: () => ({ raw: JSON.stringify(current), revision }),
    async patchSettings(patches) {
      calls.push('patch')
      if (flags.patchError) throw flags.patchError
      const next = copy(current)
      for (const p of patches) {
        const object = get(next, p.path.slice(0, -1)), key = p.path.at(-1)
        assert.equal(Object.hasOwn(object, key), p.before.present)
        if (p.before.present) assert.deepEqual(object[key], p.before.value)
        if (p.after.present) object[key] = copy(p.after.value); else delete object[key]
      }
      current = next; revision++
    },
  }
  const owner = {
    async flushNativeSettings() { calls.push('flush'); if (flags.flushError) throw flags.flushError; if (JSON.stringify(current) !== JSON.stringify(store.$state)) { current = copy(store.$state); revision++ } },
    async reloadNativeSettings() { calls.push('reload'); if (!flags.recovery.unsavedPaths.length && !flags.recovery.failedCommits.length) store.$patch(copy(current)); return flags.recovery },
    async commitNativeSettingsEdits(next) { await client.patchSettings(settingsDiff(client.settings(), next)) },
    selectAiProvider(id) { calls.push('select'); store.selectAiProvider(id) },
    resetReader() { calls.push('reset'); store.resetReader() },
    async setTypographyCalibration(value) { calls.push('calibration'); store.setTypographyCalibration(value); await this.flushNativeSettings() },
  }
  return { store, calls, flags, client, owner, actions: createNativeSettingsActions(owner, client, async () => ({ ...physical }), {
    async ai(signal) { calls.push('probe-ai'); signal.throwIfAborted(); if (flags.probeError) throw flags.probeError },
    async proxy(signal) { calls.push('probe-proxy'); signal.throwIfAborted(); if (flags.probeError) throw flags.probeError },
  }), setMetrics: x => { physical = x } }
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code || error.message === code)
for (const [path, value] of [
  [['ttsEngine'], 'bogus'], [['ttsEngine'], null], [['autoReadSeconds'], -1], [['autoReadSeconds'], 0],
  [['reader', 'fontSize'], '24'], [['reader', 'fontSize'], 7], [['reader', 'fontSize'], 65], [['reader', 'fontSize'], 20.5],
  [['reader', 'lineHeight'], Infinity], [['reader', 'theme'], 'arbitrary'], [['reader', 'maxColumnCount'], '2'],
  [['appearance'], 'bogus'], [['language'], 'zz'], [['dailyGoalMinutes'], -1], [['localVoiceId'], 103],
  [['ttsRate'], 2.1], [['aiBaseUrl'], 'javascript:alert(1)'], [['httpProxy'], 'ftp://example.invalid'],
]) test(`reject invalid typed value ${path.join('.')}=${String(value)} before durable patch`, async () => {
  const f = fixture(), before = f.client.settings()
  await rejects(f.actions.settingsPatch({ patches: [patch(before, path, value)] }), 'invalid_setting_value')
  assert.deepEqual(f.client.settings(), before); assert.equal(f.calls.includes('patch'), false)
})
for (const [path, value] of [
  [['customFonts'], [1]], [['customFonts'], { invalid: true }], [['libraryRoot'], '/unapproved'],
  [['aiProvider'], 'openai'], [['aiProfiles'], {}], [['typographyCalibration'], null],
  [['pagewiseCompanion', 'consentAll'], true], [['typographyBooks'], {}], [['unknownLegacy'], {}],
]) test(`preserve structural/owned setting ${path.join('.')} from arbitrary patch`, async () => {
  const f = fixture(), before = f.client.settings()
  await rejects(f.actions.settingsPatch({ patches: [patch(before, path, value)] }), 'protected_setting')
  assert.deepEqual(f.client.settings(), before); assert.equal(f.calls.includes('patch'), false)
})
test('valid exact-type changes persist together and preserve untouched archived/unknown state', async () => {
  const f = fixture(), before = f.client.settings()
  const changes = [patch(before, ['reader', 'fontSize'], 24), patch(before, ['reader', 'maxColumnCount'], 1), patch(before, ['ttsEngine'], 'system')]
  const reply = await f.actions.settingsPatch({ patches: changes })
  assert.equal(reply.ok, true); assert.equal(f.client.settings().reader.fontSize, 24)
  assert.equal(f.store.reader.maxColumnCount, 1); assert.deepEqual(f.client.settings().aiProfiles, before.aiProfiles)
  assert.deepEqual(f.client.settings().pagewiseCompanion, before.pagewiseCompanion)
  const syntheticLegacy = { ...before, futureUnrecognized: { keep: [1, 'two', { key: true }] } }
  assert.deepEqual(applyNativeSettingsEdits(syntheticLegacy, [patch(syntheticLegacy, ['ttsEngine'], 'local')]).futureUnrecognized, syntheticLegacy.futureUnrecognized)
})
test('mixed valid/invalid batch has no partial write or input mutation', async () => {
  const f = fixture(), before = f.client.settings(), input = [patch(before, ['reader', 'fontSize'], 24), patch(before, ['ttsEngine'], 'bad')], original = copy(input)
  await rejects(f.actions.settingsPatch({ patches: input }), 'invalid_setting_value')
  assert.deepEqual(input, original); assert.deepEqual(f.client.settings(), before); assert.equal(f.calls.includes('patch'), false)
})
test('existence/value CAS and duplicate/prototype paths reject', () => {
  const f = fixture(), root = f.client.settings(), stale = patch(root, ['ttsEngine'], 'system')
  stale.before.value = 'not-current'
  assert.throws(() => applyNativeSettingsEdits(root, [stale]), /settings_conflict/)
  const p = patch(root, ['ttsEngine'], 'system')
  assert.throws(() => applyNativeSettingsEdits(root, [p, p]), /invalid_payload/)
  assert.throws(() => applyNativeSettingsEdits(root, [{ ...p, path: ['__proto__', 'polluted'] }]), /invalid_payload/)
  assert.equal({}.polluted, undefined)
})
for (const reason of ['pending', 'unsaved', 'failed']) test(`provider selection blocked by canonical ${reason} barrier without changing profiles`, async () => {
  const f = fixture(), before = copy(f.store.$state)
  if (reason === 'pending') f.flags.flushError = Object.assign(new Error('native_mutation_pending'), { code: 'native_mutation_pending' })
  else f.flags.recovery = reason === 'unsaved' ? { unsavedPaths: [['aiApiKey']], failedCommits: [] } : { unsavedPaths: [], failedCommits: [{ aiModel: 'dirty' }] }
  await rejects(f.actions.selectAiProvider({ provider: 'openai' }), reason === 'pending' ? 'native_mutation_pending' : 'native_settings_unsaved')
  assert.equal(f.calls.includes('select'), false); assert.deepEqual(f.store.$state, before); assert.deepEqual(f.client.settings(), before)
})
test('real provider owner preserves independent own-key profiles and never transfers retired consent/key', async () => {
  const f = fixture(), consent = copy(f.store.pagewiseCompanion), archive = copy(f.store.aiProfiles.builtin)
  assert.equal((await f.actions.selectAiProvider({ provider: 'openai' })).ok, true)
  assert.equal(f.store.aiApiKey, 'SYNTHETIC-OPENAI'); assert.equal(f.client.settings().aiApiKey, 'SYNTHETIC-OPENAI')
  assert.equal(f.store.aiProfiles.deepseek.apiKey, 'SYNTHETIC-DEEPSEEK')
  assert.deepEqual(f.store.pagewiseCompanion, consent); assert.deepEqual(f.store.aiProfiles.builtin, archive)
  await f.actions.selectAiProvider({ provider: 'gemini' }); assert.equal(f.store.aiApiKey, '')
  assert.deepEqual(f.store.pagewiseCompanion, consent)
  const index = f.calls.indexOf('select'); assert.deepEqual(f.calls.slice(0, index), ['flush', 'reload']); assert.equal(f.calls[index + 1], 'flush')
})
for (const provider of ['builtin', 'trial', 'ollama', '', null]) test(`reject non-current provider ${provider}`, async () => {
  const f = fixture(); await rejects(f.actions.selectAiProvider({ provider }), 'invalid_provider'); assert.equal(f.calls.length, 0)
})
test('unknown native commit is not acknowledged and never repeated by settings action', async () => {
  const f = fixture(); f.flags.patchError = Object.assign(new Error('commit_outcome_unknown'), { code: 'commit_outcome_unknown' })
  await rejects(f.actions.settingsPatch({ patches: [patch(f.client.settings(), ['ttsEngine'], 'system')] }), 'commit_outcome_unknown')
  assert.equal(f.calls.filter(x => x === 'patch').length, 1)
})
test('reader reset needs explicit confirmation and awaits owner persistence without resetting other fields', async () => {
  const f = fixture(); f.store.reader.fontSize = 29; await f.owner.flushNativeSettings(); const before = f.client.settings()
  await rejects(f.actions.settingsResetReader({}), 'confirmation_required')
  assert.equal((await f.actions.settingsResetReader({ confirm: true })).ok, true)
  assert.equal(f.store.reader.fontSize, 18); assert.deepEqual(f.client.settings().aiProfiles, before.aiProfiles)
  assert.equal(f.client.settings().aiApiKey, before.aiApiKey)
})
test('physical calibration binds native ruler width to actual web CSS DPR/text scale and durable setter', async () => {
  const f = fixture(), context = await f.actions.settingsCalibrationInfo({})
  assert.equal(context.dpr, 2); assert.equal(context.textScale, 1)
  const reply = await f.actions.settingsCalibrationCommit({ token: context.token, widthCss: 200, measuredMm: 50 })
  assert.equal(reply.ok, true)
  assert.deepEqual(f.client.settings().typographyCalibration, { cssPxPerMm: 4, dpr: 2, textScale: 1, source: 'manual-ruler' })
  await rejects(f.actions.settingsCalibrationCommit({ token: context.token, widthCss: 200, measuredMm: 50 }), 'calibration_context_changed')
  await rejects(f.actions.settingsCalibrationClear({}), 'confirmation_required')
  await f.actions.settingsCalibrationClear({ confirm: true }); assert.equal(f.client.settings().typographyCalibration, null)
})
for (const metrics of [{ dpr: 3, textScale: 1 }, { dpr: 2, textScale: 1.2 }, { dpr: NaN, textScale: 1 }]) test(`reject stale/invalid physical measurement ${JSON.stringify(metrics)}`, async () => {
  const f = fixture(), context = await f.actions.settingsCalibrationInfo({}); f.setMetrics(metrics)
  await rejects(f.actions.settingsCalibrationCommit({ token: context.token, widthCss: 200, measuredMm: 50 }), 'calibration_context_changed')
  assert.equal(f.calls.includes('calibration'), false)
})
test('invalid ruler size and unresolved durable calibration do not return success', async () => {
  const f = fixture(), context = await f.actions.settingsCalibrationInfo({})
  await assert.rejects(f.actions.settingsCalibrationCommit({ token: context.token, widthCss: 1, measuredMm: 50 }), /Invalid ruler measurement/)
  assert.equal(f.calls.includes('calibration'), false)
  f.flags.flushError = new Error('native_mutation_pending')
  await assert.rejects(f.actions.settingsCalibrationCommit({ token: context.token, widthCss: 200, measuredMm: 50 }), /native_mutation_pending/)
})
test('connection probes require a confirmed user action and do not run during schema loading', async () => {
  const f = fixture(); await f.actions.settingsSchema({})
  await rejects(f.actions.settingsTestAi({}), 'confirmation_required'); await rejects(f.actions.settingsTestProxy({}), 'confirmation_required')
  assert.deepEqual(f.calls, [])
  assert.equal((await f.actions.settingsTestAi({ confirm: true })).ok, true)
  assert.equal((await f.actions.settingsTestProxy({ confirm: true })).ok, true)
  assert.deepEqual(f.calls, ['flush', 'reload', 'probe-ai', 'flush', 'reload', 'probe-proxy'])
})
test('connection probes block unresolved settings and propagate actual transport failure', async () => {
  const f = fixture(); f.flags.recovery = { unsavedPaths: [['aiModel']], failedCommits: [] }
  await rejects(f.actions.settingsTestAi({ confirm: true }), 'native_settings_unsaved')
  assert.equal(f.calls.includes('probe-ai'), false)
  f.flags.recovery = { unsavedPaths: [], failedCommits: [] }; f.flags.probeError = new Error('synthetic_transport_failure')
  await assert.rejects(f.actions.settingsTestProxy({ confirm: true }), /synthetic_transport_failure/)
})
test('connection deadline aborts the real probe coordinator and cannot acknowledge a late reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); let entered
  const started = new Promise(resolve => { entered = resolve })
  const hang = signal => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered() })
  const actions = createNativeSettingsActions(f.owner, f.client, async () => ({ dpr: 2, textScale: 1 }), { ai: hang, proxy: hang })
  const pending = actions.settingsTestAi({ confirm: true }); await started
  const rejected = rejects(pending, 'native_probe_timeout')
  t.mock.timers.tick(20_000); await rejected
})
test('an abort-ignoring probe times out without losing its in-flight fence or acknowledging late success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); let entered, release, count = 0
  const started = new Promise(resolve => { entered = resolve })
  const actions = createNativeSettingsActions(f.owner, f.client, async () => ({ dpr: 2, textScale: 1 }), {
    ai: () => { count++; entered(); return new Promise(resolve => { release = resolve }) },
    proxy: async () => { count++ },
  })
  const pending = actions.settingsTestAi({ confirm: true }); await started
  const rejected = rejects(pending, 'native_probe_timeout'); t.mock.timers.tick(20_000); await rejected
  await rejects(actions.settingsTestProxy({ confirm: true }), 'native_probe_in_progress'); assert.equal(count, 1)
  release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal((await actions.settingsTestProxy({ confirm: true })).ok, true); assert.equal(count, 2)
})
test('schema masks both API and embedded proxy credentials and exposes only current providers', async () => {
  const f = fixture(), schema = await f.actions.settingsSchema({})
  assert.deepEqual(schema.providers.map(p => p.id), ['deepseek', 'openai', 'gemini', 'openrouter'])
  assert.equal(NATIVE_SETTINGS_FIELDS.find(f => f.path[0] === 'aiApiKey').secret, true)
  assert.equal(NATIVE_SETTINGS_FIELDS.find(f => f.path[0] === 'httpProxy').secret, true)
  assert.equal(schema.fields.some(f => f.path[0] === 'customFonts'), false)
  const dispatcher = readFileSync(new URL('../src-tauri/android/NativeManagementDispatcher.kt', import.meta.url), 'utf8')
  assert.doesNotMatch(dispatcher, /private fun selectProvider|private val PROVIDERS|action != "action\.selectAiProvider"/)
  assert.match(dispatcher, /"selectAiProvider"/)
})

// Real owner, queue and client; only physical IPC and display metrics are synthetic.
test('production Pinia/nativePersistence recovery protocol', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalStorage = globalThis.localStorage
  const clone = value => structuredClone(value)
  let document, revision = 1, mode = 'ok', receiptMode = 'available', release, pageInvoke
  const receipts = new Map(), calls = [], errors = []
  const snapshot = () => ({ revision, raw: JSON.stringify(document) })
  const at = (root, path) => {
    let node = root
    for (const key of path.slice(0, -1)) { if (!node || typeof node !== 'object') return { present: false }; node = node[key] }
    return node && Object.hasOwn(node, path.at(-1)) ? { present: true, value: node[path.at(-1)] } : { present: false }
  }
  function fresh() {
    document = { ...settingsDefaults(), aiProvider: 'deepseek', aiApiKey: 'SYNTHETIC-ACTIVE-SECRET', aiProfiles: {
      openai: { baseUrl: 'https://openai.synthetic.invalid/v1', apiKey: 'SYNTHETIC-PROFILE-SECRET', model: 'synthetic-model' },
    } }
    revision++; mode = 'ok'; receiptMode = 'available'; receipts.clear(); calls.length = 0
  }
  fresh()
  globalThis.localStorage = { getItem: forbid, setItem: forbid }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    LightReadInsets: { nativeStorageVersion: () => 1 }, __TAURI_INTERNALS__: { async invoke(command, args) {
      if (command === 'native_page' && pageInvoke) return pageInvoke(args)
      assert.equal(command, 'native_state')
      const { action, payload } = args
      calls.push({ action, payload: clone(payload) })
      if (action === 'status') return { state: 'complete', settings: snapshot(), rows: 0 }
      if (action === 'settingsGet') return snapshot()
      if (action === 'readingPage' || action === 'hashesPage') return { rows: [], next: '' }
      if (action === 'receipt') {
        if (receiptMode === 'unavailable') throw stateError('unavailable')
        const result = receipts.get(payload.requestId)
        return result && receiptMode !== 'absent' ? { found: true, fingerprint: 'a'.repeat(64), result: clone(result) } : { found: false }
      }
      assert.equal(action, 'settingsPatch')
      if (mode === 'paused') { await new Promise(resolve => { release = resolve }); mode = 'ok' }
      if (mode === 'reject') throw stateError('database_error')
      if (mode === 'conflict') { mode = 'ok'; document.dailyGoalMinutes = 333; revision++; throw stateError('settings_conflict') }
      if (mode === 'unknown-absent') throw stateError('commit_outcome_unknown')
      const prior = receipts.get(payload.requestId)
      if (prior) return clone(prior)
      for (const p of payload.patches) if (JSON.stringify(at(document, p.path)) !== JSON.stringify(p.before)) throw stateError('settings_conflict')
      const next = clone(document)
      for (const p of payload.patches) {
        let node = next
        for (const key of p.path.slice(0, -1)) node = node[key] ??= {}
        if (p.after.present) node[p.path.at(-1)] = clone(p.after.value); else delete node[p.path.at(-1)]
      }
      document = next; revision++
      const result = snapshot(); receipts.set(payload.requestId, result)
      if (mode === 'unknown-accepted') throw stateError('commit_outcome_unknown')
      return result
    } },
  } })
  t.after(() => { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete globalThis.window; globalThis.localStorage = originalStorage })
  await initializeNativeState()
  const client = getNativeState(), writes = () => calls.filter(c => c.action === 'settingsPatch')
  const noSecrets = value => assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC-(?:ACTIVE|PROFILE|NEW|RETAINED)-SECRET/)
  async function setup() {
    fresh(); await client.refreshSettings()
    const pinia = createPinia(), store = useSettings(pinia), stop = store.persistOnChange(error => errors.push(error)), physical = { dpr: 2, textScale: 1 }
    return { pinia, store, stop, physical, actions: createNativeSettingsActions(store, client, async () => ({ ...physical })) }
  }
  async function inspect(f) { const report = await f.actions.settingsRecoveryInspect({}); noSecrets(report); return report }
  const choose = (f, r, choice = 'retry') => f.actions.settingsRecoveryDecide({ token: r.decision?.token, choice, confirm: true })
  async function subsequent(f) {
    await f.actions.settingsPatch({ patches: [patch(client.settings(), ['ttsRate'], 1.7)] })
    assert.equal(document.ttsRate, 1.7)
  }
  await t.test('R3-01: Statistics rejection -> directly reachable native entry -> production registry inspection/decision -> query and navigation', async () => {
    const f = await setup(), target = new EventTarget(), pending = new Map(), routes = []
    const oldTimers = globalThis.setTimeout
    const { assertNativeStatsRecoveryBindings } = await import('./native-stats-recovery-ui-test-tools.mjs')
    globalThis.__r3RegistryStorage = { listBooks: async () => [] }
    Object.assign(window, {
      addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target),
    })
    window.LightReadInsets.nativePagesVersion = () => 1
    globalThis.setTimeout = (...args) => { const timer = oldTimers(...args); timer.unref?.(); return timer }
    pageInvoke = ({ action, payload }) => {
      if (action === 'ready') {
        assert.ok(payload.handlers.includes('statisticsGet')); assert.ok(payload.handlers.includes('settingsRecoveryInspect')); assert.ok(payload.handlers.includes('settingsRecoveryDecide'))
        return { ready: true, version: 1, session: 'synthetic-r3-registry', visibilityLeaseMs: 30000 }
      }
      assert.equal(action, 'reply'); const resolve = pending.get(payload.requestId); assert.ok(resolve); pending.delete(payload.requestId); resolve(payload); return {}
    }
    const event = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }))
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
    const action = (name, payload = {}) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      pending.set(requestId, reply => reply.error ? reject(stateError(reply.error)) : resolve(reply.result))
      event('pagewise-native-action', { requestId, action: name, payload })
    })
    // Assert both real Kotlin entry bindings before exercising their protected event/registry seam.
    // This is source binding + production JS execution, not an Android rendered-click claim.
    const clickRecoveryEntry = () => { assertNativeStatsRecoveryBindings(); return action('settingsRecoveryInspect') }
    try {
      const { initializeNativePages } = await import('../src/services/nativePages.ts')
      await initializeNativePages({ options: { history: { state: { back: '/library' } } }, push: async path => { routes.push(path) }, back: () => routes.push('@back') }, f.pinia)
      for (const choice of ['retry', 'discard']) {
        fresh(); await f.store.reloadNativeSettings(); routes.length = 0
        const before = document.dailyGoalMinutes
        assert.equal((await action('statisticsGet')).goalBefore, before)
        mode = 'reject'
        await assert.rejects(action('settingsPatch', { patches: [{ path: ['dailyGoalMinutes'], before: { present: true, value: before }, after: { present: true, value: 45 } }] }))
        mode = 'ok'
        event('pagewise-native-navigate', { path: '/settings' }); await settle(); assert.equal(routes.length, 0, 'ordinary navigation remains blocked')
        await assert.rejects(action('statisticsGet'), error => error.code === 'native_settings_unsaved')
        const writesBeforeInspect = writes().length, report = await clickRecoveryEntry()
        assert.equal(report.state, 'decision_required'); assert.equal(writes().length, writesBeforeInspect, 'recovery entry is receipt-only')
        const done = await action('settingsRecoveryDecide', { token: report.decision.token, choice, confirm: true })
        assert.equal(done.state, 'clean')
        const after = await action('statisticsGet'); assert.equal(after.goalBefore, choice === 'retry' ? 45 : before)
        event('pagewise-native-navigate', { path: '/settings' }); await settle(); assert.deepEqual(routes, ['/settings'])
        assert.equal(document.aiApiKey, 'SYNTHETIC-ACTIVE-SECRET'); assert.equal(document.aiProfiles.openai.apiKey, 'SYNTHETIC-PROFILE-SECRET')
      }
      fresh(); await f.store.reloadNativeSettings(); routes.length = 0
      mode = 'unknown-absent'; receiptMode = 'absent'
      await assert.rejects(action('settingsPatch', { patches: [{ path: ['dailyGoalMinutes'], before: { present: true, value: document.dailyGoalMinutes }, after: { present: true, value: 60 } }] }))
      const oldWrites = writes().length, unresolved = await clickRecoveryEntry()
      assert.equal(unresolved.state, 'unresolved'); assert.equal(unresolved.decision, undefined); assert.equal(writes().length, oldWrites)
      await assert.rejects(action('settingsRecoveryDecide', { token: 'missing', choice: 'discard', confirm: true }))
      assert.equal(writes().length, oldWrites, 'no replacement mutation or discard while outcome unresolved')
      event('pagewise-native-navigate', { path: '/settings' }); await settle(); assert.equal(routes.length, 0)
      // A late physical commit publishes the ORIGINAL immutable request receipt; never send a replacement.
      document.dailyGoalMinutes = 60; revision++
      receipts.set(writes().at(-1).payload.requestId, snapshot())
      receiptMode = 'available'; mode = 'ok'; assert.equal((await clickRecoveryEntry()).state, 'clean')
      assert.equal((await action('statisticsGet')).goalBefore, 60); assert.equal(writes().length, oldWrites)
    } finally {
      await settle()
      assert.equal(pending.size, 0, 'all registry operations settle before fixture cleanup')
      pageInvoke = undefined; delete window.LightReadInsets.nativePagesVersion
      delete globalThis.__r3RegistryStorage; globalThis.setTimeout = oldTimers; f.stop()
    }
  })
  await t.test('conflict -> receipt-only inspection -> explicit retry -> subsequent edit preserves unrelated canonical', async () => {
    const f = await setup(); mode = 'conflict'
    await rejects(f.actions.settingsPatch({ patches: [patch(client.settings(), ['dailyGoalMinutes'], 44)] }), 'settings_conflict')
    assert.equal(document.dailyGoalMinutes, 333)
    document.httpProxy = 'https://unrelated.synthetic.invalid'; revision++
    const count = writes().length, r = await inspect(f)
    assert.equal(writes().length, count); assert.equal(r.state, 'decision_required'); assert.equal(r.failedCommits.length, 1)
    await rejects(f.actions.settingsResetReader({ confirm: true }), 'settings_recovery_required')
    assert.equal((await choose(f, r)).state, 'clean')
    assert.equal(document.dailyGoalMinutes, 44); assert.equal(document.httpProxy, 'https://unrelated.synthetic.invalid')
    await subsequent(f); f.stop()
  })
  await t.test('watcher provider rejection recomputes selection using fresh keys/profiles, not snapshots/consent', async () => {
    const f = await setup(); mode = 'reject'
    await rejects(f.actions.selectAiProvider({ provider: 'openai' }), 'database_error')
    assert.equal(f.store.aiProvider, 'openai'); assert.equal(document.aiProvider, 'deepseek')
    mode = 'ok'; document.aiProfiles.openai.apiKey = 'SYNTHETIC-NEW-SECRET'
    document.pagewiseCompanion.consentAll = true; document.aiApiKey = 'SYNTHETIC-RETAINED-SECRET'; revision++
    const r = await inspect(f)
    assert.equal(r.state, 'decision_required'); assert.ok(r.unsavedPaths.length); assert.equal(r.failedCommits.length, 0)
    assert.equal((await choose(f, r)).state, 'clean')
    assert.equal(document.aiProvider, 'openai'); assert.equal(document.aiApiKey, 'SYNTHETIC-NEW-SECRET')
    assert.equal(document.aiProfiles.deepseek.apiKey, 'SYNTHETIC-RETAINED-SECRET'); assert.equal(document.pagewiseCompanion.consentAll, true)
    await subsequent(f); f.stop()
  })
  await t.test('watcher reset rejection resolves without losing book overrides or unrelated fields', async () => {
    const f = await setup(); f.store.reader.fontSize = 31; await f.store.flushNativeSettings()
    mode = 'reject'; await rejects(f.actions.settingsResetReader({ confirm: true }), 'database_error')
    mode = 'ok'; document.typographyBooks['synthetic-other'] = { fontSize: 27 }; document.dailyGoalMinutes = 71; revision++
    const r = await inspect(f); assert.equal(r.state, 'decision_required'); await choose(f, r)
    assert.equal(document.reader.fontSize, settingsDefaults().reader.fontSize)
    assert.equal(document.typographyBooks['synthetic-other'].fontSize, 27); assert.equal(document.dailyGoalMinutes, 71)
    await subsequent(f); f.stop()
  })
  await t.test('failed explicit typography/calibration retained; fresh sparse typography and context-bound calibration', async () => {
    const f = await setup(); mode = 'reject'
    await rejects(f.store.commitTypography({ scope: 'book', bookId: 'synthetic-target', language: 'en', settings: { fontSize: 23 }, dim: 0.2 }), 'database_error')
    assert.equal(f.store.typographyBooks['synthetic-target'], undefined)
    mode = 'ok'; document.typographyBooks['synthetic-other'] = { fontSize: 29 }; document.readingMode.eyeCare.tint = 'synthetic-preserved'; revision++
    let r = await inspect(f); assert.ok(r.failedCommits[0].paths.some(p => p[0] === 'typographyBooks')); await choose(f, r)
    assert.equal(document.typographyBooks['synthetic-target'].fontSize, 23); assert.equal(document.typographyBooks['synthetic-other'].fontSize, 29)
    assert.equal(document.readingMode.eyeCare.tint, 'synthetic-preserved')
    const context = await f.actions.settingsCalibrationInfo({}); mode = 'reject'
    await rejects(f.actions.settingsCalibrationCommit({ token: context.token, widthCss: 200, measuredMm: 25.4 }), 'database_error')
    assert.equal(f.store.typographyCalibration, null)
    mode = 'ok'; r = await inspect(f); assert.deepEqual(r.failedCommits[0].paths, [['typographyCalibration']])
    f.physical.dpr = 3; await rejects(choose(f, r), 'calibration_context_changed'); assert.equal(document.typographyCalibration, null)
    f.physical.dpr = NaN; r = await inspect(f); await rejects(choose(f, r), 'calibration_context_changed')
    f.physical.dpr = 2; r = await inspect(f); await choose(f, r); assert.equal(document.typographyCalibration.dpr, 2)
    mode = 'reject'; await rejects(f.actions.settingsCalibrationClear({ confirm: true }), 'database_error')
    mode = 'ok'; r = await inspect(f); await choose(f, r, 'discard')
    assert.notEqual(document.typographyCalibration, null, 'discard is not rollback of accepted calibration')
    await subsequent(f); f.stop()
  })
  await t.test('unknown/receipt absence admits zero replacement writes or UUIDs; late receipt resolves without replay', async () => {
    const f = await setup(); mode = 'unknown-absent'; receiptMode = 'absent'
    await rejects(f.actions.settingsPatch({ patches: [patch(client.settings(), ['dailyGoalMinutes'], 45)] }), 'commit_outcome_unknown')
    const sent = writes(), count = sent.length
    assert.equal(count, 3); assert.equal(new Set(sent.map(c => c.payload.requestId)).size, 1)
    assert.ok(sent.every(c => JSON.stringify(c.payload) === JSON.stringify(sent[0].payload)), 'immutable envelope')
    let r = await inspect(f); assert.equal(r.state, 'unresolved'); assert.equal(r.decision, undefined)
    await rejects(f.store.resolveNativeSettingsRecovery('invented', 'discard'), 'settings_recovery_stale')
    await rejects(f.actions.selectAiProvider({ provider: 'openai' }), 'settings_recovery_stale'); assert.equal(writes().length, count)
    // Late admission of the original immutable envelope is represented by its eventual receipt.
    const envelope = sent[0].payload
    for (const p of envelope.patches) document[p.path[0]] = clone(p.after.value)
    revision++; receipts.set(envelope.requestId, snapshot()); receiptMode = 'available'; mode = 'ok'
    r = await inspect(f); assert.equal(r.state, 'clean'); assert.equal(writes().length, count); assert.equal(f.store.dailyGoalMinutes, 45)
    await subsequent(f); f.stop()
  })
  await t.test('receipt transport failure stays inspectable and accepted retry receipt clears originals, no replay', async () => {
    const f = await setup(); mode = 'reject'; await rejects(f.actions.selectAiProvider({ provider: 'openai' }), 'database_error')
    mode = 'ok'; let r = await inspect(f)
    mode = 'unknown-accepted'; receiptMode = 'unavailable'; await rejects(choose(f, r), 'unavailable')
    const count = writes().length
    await rejects(choose(f, r, 'discard'), 'unavailable')
    await rejects(choose(f, r, 'retry'), 'unavailable')
    assert.equal(writes().length, count, 'neither explicit choice may replace or cancel unresolved pending work')
    r = await inspect(f); assert.equal(r.state, 'unresolved'); assert.equal(writes().length, count)
    receiptMode = 'available'; mode = 'ok'; r = await inspect(f)
    assert.equal(r.state, 'clean'); assert.equal(writes().length, count); assert.equal(f.store.aiProvider, 'openai')
    await subsequent(f); f.stop()
  })
  await t.test('stale canonical/local/reused tokens reject before writes; explicit discard preserves canonical', async () => {
    const f = await setup(); mode = 'reject'; f.store.aiApiKey = 'SYNTHETIC-RETAINED-SECRET'
    await rejects(f.store.flushNativeSettings(), 'database_error')
    mode = 'ok'; let r = await inspect(f), count = writes().length
    document.ttsVoice = 'synthetic-concurrent'; revision++; await rejects(choose(f, r), 'settings_recovery_stale'); assert.equal(writes().length, count)
    r = await inspect(f); f.store.dailyGoalMinutes = 99
    await rejects(choose(f, r, 'discard'), 'settings_recovery_stale'); assert.equal(writes().length, count)
    r = await inspect(f); const token = r.decision.token
    assert.equal((await choose(f, r, 'discard')).state, 'clean')
    assert.equal(f.store.aiApiKey, document.aiApiKey); assert.equal(f.store.dailyGoalMinutes, document.dailyGoalMinutes); assert.equal(document.ttsVoice, 'synthetic-concurrent')
    await rejects(f.actions.settingsRecoveryDecide({ token, choice: 'retry', confirm: true }), 'settings_recovery_stale'); assert.equal(writes().length, count)
    await inspect(f); await subsequent(f); f.stop()
  })
  await t.test('structural consent cannot shallow replay; switched-provider credential edit requires reentry', async () => {
    const f = await setup(); mode = 'reject'; f.store.pagewiseCompanion.consentAll = true
    await rejects(f.store.flushNativeSettings(), 'database_error')
    mode = 'ok'; let r = await inspect(f), count = writes().length
    assert.equal(r.decision.retryable, false); await rejects(choose(f, r), 'settings_recovery_reentry_required')
    assert.equal(writes().length, count); assert.equal(document.pagewiseCompanion.consentAll, false)
    r = await inspect(f); await choose(f, r, 'discard')
    mode = 'reject'; f.store.aiApiKey = 'SYNTHETIC-RETAINED-SECRET'; await rejects(f.store.flushNativeSettings(), 'database_error')
    mode = 'ok'; document.aiProvider = 'openai'; revision++; r = await inspect(f); count = writes().length
    await rejects(choose(f, r), 'settings_recovery_reentry_required'); assert.equal(writes().length, count)
    r = await inspect(f); await choose(f, r, 'discard'); await subsequent(f); f.stop()
  })
  await t.test('live mutation blocks inspection; native close/back cannot pretend to cancel accepted work', async () => {
    const f = await setup(); mode = 'paused'
    const pending = f.actions.settingsPatch({ patches: [patch(client.settings(), ['dailyGoalMinutes'], 56)] })
    while (!release) await new Promise(resolve => setImmediate(resolve))
    const count = calls.length; await rejects(f.actions.settingsRecoveryInspect({}), 'native_settings_busy'); assert.equal(calls.length, count)
    f.stop() // Detaching a UI watcher is not permission to forget a live owner/envelope.
    release(); release = null; await pending
    assert.equal(document.dailyGoalMinutes, 56); assert.equal((await inspect(f)).state, 'clean')
    mode = 'reject'; f.store.dailyGoalMinutes = 57; await rejects(f.store.flushNativeSettings(), 'database_error')
    f.stop(); mode = 'ok'
    const retained = await inspect(f); assert.equal(retained.state, 'decision_required')
    await choose(f, retained, 'discard'); await subsequent(f); f.stop()
    const ui = readFileSync(new URL('../src-tauri/android/NativeSettingsPanel.kt', import.meta.url), 'utf8')
    assert.match(ui, /settingsRecoveryInspect/); assert.match(ui, /settingsRecoveryDecide/)
    assert.match(ui, /if \(busy\) return true/); assert.match(ui, /fun canLeave\(\) = !busy/)
    assert.match(ui, /val parent = recoveryParent/); assert.match(ui, /parent\?\.dismiss\(\)/)
    const decisionUi = ui.slice(ui.indexOf('fun decide(choice:'), ui.indexOf('form.addView(status)', ui.indexOf('fun decide(choice:')))
    assert.doesNotMatch(decisionUi, /dismiss\(\)|changed\(\)/, 'settling owner drafts must not silently close unsent form input')
    assert.match(ui, /Finish and refresh \(close original input\)/)
  })
})
