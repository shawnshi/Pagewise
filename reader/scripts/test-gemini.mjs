import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

// Only synthetic in-memory settings; every transport path is intercepted.
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
}
const transport = { calls: [], respond: () => { throw new Error('Unconfigured mock') } }
globalThis.__geminiTransport = transport
const aiUrl = new URL('../src/services/ai.ts', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === aiUrl && /^\.\/net(?:\.ts)?$/.test(specifier)) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
        export async function fetchRemote(...args) {
          const mock = globalThis.__geminiTransport;
          mock.calls.push(args);
          return mock.respond(...args);
        }`) }
    }
    if (context.parentURL === aiUrl && specifier === '../stores/settings') {
      return { shortCircuit: true, url: new URL('../src/stores/settings.ts', import.meta.url).href }
    }
    return nextResolve(specifier, context)
  },
})
const { AI_PROVIDERS, providerById, chatStream, aiConfigured } = await import(aiUrl)
const { useSettings } = await import('../src/stores/settings.ts')
hook.deregister()
const KEY = 'lightread-settings'
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'
const messages = [{ role: 'user', content: 'Synthetic test only' }]
function reset(data) {
  saved.clear()
  if (data) saved.set(KEY, JSON.stringify(data))
  setActivePinia(createPinia())
  transport.calls.length = 0
  transport.respond = () => Response.json({ choices: [{ message: { content: 'OK' } }] })
  return useSettings()
}
function gemini() {
  const s = reset()
  s.selectAiProvider('gemini')
  s.aiApiKey = 'synthetic-gemini-key'
  return s
}
async function collect(signal) {
  const chunks = []
  for await (const text of chatStream(messages, signal)) chunks.push(text)
  return chunks
}
function sse(chunks, closed = true) {
  let cancelled = 0
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      if (closed) controller.close()
    },
    cancel() { cancelled++ },
  })
  transport.respond = () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  return { stream, cancelled: () => cancelled }
}

test('Gemini preset uses exact stable model and official OpenAI-compatible endpoint', () => {
  const preset = AI_PROVIDERS.find(p => p.id === 'gemini')
  assert.ok(preset)
  assert.equal(preset.defaultModel, 'gemini-4-argon')
  assert.equal(preset.baseUrl, GEMINI_URL)
  assert.equal(preset.needsKey, true)
  assert.throws(() => providerById('not-a-provider'), /config|provider/i)
})

test('switching isolates credentials and restores every saved configuration', async () => {
  const s = reset({ version: 14, aiProvider: 'deepseek', aiBaseUrl: 'https://synthetic.invalid/v1', aiApiKey: 'synthetic-old-key', aiModel: 'custom-old-model' })
  s.selectAiProvider('gemini')
  assert.equal(s.aiApiKey, '')
  assert.equal(s.aiBaseUrl, GEMINI_URL)
  assert.equal(s.aiModel, 'gemini-4-argon')
  assert.equal(aiConfigured(), false)
  await assert.rejects(collect(), /config|key/i)
  assert.equal(transport.calls.length, 0)
  s.aiApiKey = 'synthetic-new-key'
  s.aiModel = 'custom-gemini-model'
  s.selectAiProvider('deepseek')
  assert.equal(s.aiApiKey, 'synthetic-old-key')
  assert.equal(s.aiBaseUrl, 'https://synthetic.invalid/v1')
  assert.equal(s.aiModel, 'custom-old-model')
  s.selectAiProvider('gemini')
  assert.equal(s.aiApiKey, 'synthetic-new-key')
  assert.equal(s.aiModel, 'custom-gemini-model')
  s.selectAiProvider('gemini')
  assert.equal(s.aiModel, 'custom-gemini-model', 'same-provider selection is a no-op')
})

test('legacy settings never silently migrate active provider/model/URL/key', () => {
  for (const data of [
    { aiProvider: 'siliconflow', aiBaseUrl: 'https://old.invalid/v1', aiApiKey: '', aiModel: 'my-model' },
    { version: 1, aiProvider: 'trial', aiBaseUrl: 'https://old-trial.invalid/v1', aiApiKey: '', aiModel: 'legacy-model' },
    { version: 14, aiProvider: 'custom', aiBaseUrl: 'https://custom.invalid/v2', aiApiKey: 'synthetic-custom', aiModel: 'custom' },
  ]) {
    const s = reset(data)
    for (const field of ['aiProvider', 'aiBaseUrl', 'aiApiKey', 'aiModel']) assert.equal(s[field], data[field], field)
    if (data.aiProvider !== 'trial') assert.equal(aiConfigured(), false)
    s.selectAiProvider('gemini')
    assert.equal(s.aiApiKey, '')
    if (data.aiProvider === 'trial') {
      s.selectAiProvider(data.aiProvider)
      for (const field of ['aiProvider', 'aiBaseUrl', 'aiApiKey', 'aiModel']) assert.equal(s[field], data[field], field)
    } else {
      assert.equal(s.aiProfiles[data.aiProvider].apiKey, data.aiApiKey)
      assert.throws(() => s.selectAiProvider(data.aiProvider), /unknown provider/)
      assert.equal(s.aiProvider, 'gemini')
      assert.equal(s.aiApiKey, '')
    }
  }
})

test('profiles persist via the real settings watcher and survive fresh store load', async () => {
  const s = gemini()
  s.persistOnChange()
  s.aiModel = 'persisted-gemini-model'
  s.selectAiProvider('openai')
  s.aiBaseUrl = 'https://synthetic.invalid/api'
  s.aiApiKey = 'synthetic-custom-key'
  s.aiModel = 'persisted-custom-model'
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 360))
  const data = await new Response(saved.get(KEY)).json()
  setActivePinia(createPinia())
  const restored = useSettings()
  assert.equal(restored.aiProvider, 'openai')
  restored.selectAiProvider('gemini')
  assert.equal(restored.aiApiKey, 'synthetic-gemini-key')
  assert.equal(restored.aiModel, 'persisted-gemini-model')
  restored.selectAiProvider('openai')
  assert.equal(restored.aiBaseUrl, data.aiBaseUrl)
  assert.equal(restored.aiApiKey, 'synthetic-custom-key')
})

test('malformed profiles cannot overwrite active fields or inject credentials', () => {
  for (const aiProfiles of [null, [], 'invalid', { gemini: { baseUrl: GEMINI_URL, model: 17, apiKey: 'synthetic-must-not-use' } }]) {
    const s = reset({ version: 14, aiProvider: 'custom', aiBaseUrl: 'https://synthetic.invalid', aiModel: 'old', aiApiKey: 'synthetic-old', aiProfiles })
    assert.equal(s.aiApiKey, 'synthetic-old')
    s.selectAiProvider('gemini')
    assert.equal(s.aiApiKey, '')
  }
})

test('JSON request joins endpoint once and preserves default/custom model identifiers', async () => {
  const s = gemini()
  for (const [base, model] of [[GEMINI_URL, 'gemini-4-argon'], [GEMINI_URL, 'gemini-3.8-flash'], [GEMINI_URL.replace(/\/$/, ''), 'custom-gemini-id'], ['https://synthetic.invalid/proxy///', 'other-model']]) {
    s.aiBaseUrl = base
    s.aiModel = model
    assert.deepEqual(await collect(), ['OK'])
    const [url, auth, init] = transport.calls.at(-1)
    assert.equal(url, base.replace(/\/+$/, '') + '/chat/completions')
    assert.equal(auth, undefined)
    assert.equal(init.headers.authorization, 'Bearer synthetic-gemini-key')
    assert.equal(init.headers['x-device-id'], undefined)
    const body = await new Response(init.body).json()
    assert.deepEqual(body, { model, messages, stream: true, ...(model === 'gemini-4-argon' ? {} : { temperature: 0.6 }) })
    assert.equal(init.raw, true)
  }
})

test('blank key, URL, model and unknown provider reject with zero transport calls', async () => {
  for (const field of ['aiApiKey', 'aiBaseUrl', 'aiModel', 'aiProvider']) {
    const s = gemini()
    s[field] = field === 'aiProvider' ? 'not-a-provider' : '   '
    assert.equal(aiConfigured(), false)
    await assert.rejects(collect(), /config|provider|key|model|URL/i)
    assert.equal(transport.calls.length, 0)
  }
})

test('unknown selection leaves active state unchanged', () => {
  const s = gemini()
  const before = JSON.stringify(s.$state)
  assert.throws(() => s.selectAiProvider('unknown'), /config|provider/i)
  assert.equal(JSON.stringify(s.$state), before)
})

for (const [status, message] of [[401, 'invalid_api_key'], [403, 'permission_denied'], [429, 'rate_limit_exceeded'], [404, 'model_not_found'], [500, 'upstream_failed']]) {
  test(`HTTP ${status} remains an explicit dependency error, without retry/fallback`, async () => {
    gemini()
    transport.respond = () => Response.json({ error: { message } }, { status })
    await assert.rejects(collect(), error => error.message.includes(String(status)) && error.message.includes(message))
    assert.equal(transport.calls.length, 1)
  })
}

test('transport failure propagates without fallback', async () => {
  gemini()
  const failure = new TypeError('synthetic transport unavailable')
  transport.respond = () => { throw failure }
  await assert.rejects(collect(), error => error === failure)
  assert.equal(transport.calls.length, 1)
})

test('SSE spans chunks/UTF-8 and accepts final event without trailing newline', async () => {
  gemini()
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n')
  const source = sse([': heartbeat\n', bytes.slice(0, 43), bytes.slice(43, 44), bytes.slice(44), 'data: {"choices":[', '{"delta":{"content":" tail"},"finish_reason":"stop"}]}'])
  assert.deepEqual(await collect(), ['你好', ' tail'])
  assert.equal(source.stream.locked, false)
})

test('a closed stream without a completion reason remains an explicit incomplete-output error', async () => {
  gemini()
  sse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n'])
  await assert.rejects(collect(), /Incomplete AI output/)
})

test('current OpenAI/OpenRouter model requests omit unsupported sampling without switching endpoints', async () => {
  for (const provider of ['openai', 'openrouter']) {
    const s = reset()
    s.selectAiProvider(provider)
    s.aiApiKey = `synthetic-${provider}-only`
    assert.deepEqual(await collect(), ['OK'])
    const [url, , init] = transport.calls.at(-1)
    const body = await new Response(init.body).json()
    assert.equal(url, providerById(provider).baseUrl + '/chat/completions')
    assert.equal(body.model, providerById(provider).defaultModel)
    assert.equal(body.temperature, undefined)
    assert.equal(init.headers.authorization, `Bearer synthetic-${provider}-only`)
    assert.equal(transport.calls.length, 1)
  }
})

test('built-in trial never forwards a user API key', async () => {
  const s = reset()
  s.aiApiKey = 'synthetic-must-not-reach-trial'
  assert.deepEqual(await collect(), ['OK'])
  assert.equal(transport.calls[0][2].headers.authorization, undefined)
})

test('DONE and early consumer exit cancel unread stream and release lock', async () => {
  gemini()
  let source = sse(['data: {"choices":[{"delta":{"content":"one"}}]}\n', 'data: [DONE]\n', 'data: {"choices":[{"delta":{"content":"never"}}]}\n'], false)
  assert.deepEqual(await collect(), ['one'])
  assert.equal(source.cancelled(), 1)
  assert.equal(source.stream.locked, false)
  source = sse(['data: {"choices":[{"delta":{"content":"one"}}]}\n'], false)
  const iterator = chatStream(messages)
  assert.equal((await iterator.next()).value, 'one')
  await iterator.return()
  assert.equal(source.cancelled(), 1)
  assert.equal(source.stream.locked, false)
})

test('pre-aborted request never reaches transport', async () => {
  gemini()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(collect(controller.signal), { name: 'AbortError' })
  assert.equal(transport.calls.length, 0)
})

test('abort suppresses buffered output and cancels a pending read', async () => {
  gemini()
  let source = sse(['data: {"choices":[{"delta":{"content":"one"}}]}\ndata: {"choices":[{"delta":{"content":"never"}}]}\n'], false)
  let controller = new AbortController()
  let iterator = chatStream(messages, controller.signal)
  assert.equal((await iterator.next()).value, 'one')
  controller.abort()
  await assert.rejects(iterator.next(), { name: 'AbortError' })
  assert.equal(source.cancelled(), 1)
  assert.equal(source.stream.locked, false)
  source = sse([], false)
  controller = new AbortController()
  iterator = chatStream(messages, controller.signal)
  const pending = iterator.next()
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(source.cancelled(), 1)
  assert.equal(source.stream.locked, false)
})

test('stream read error releases lock and remains an error', async () => {
  gemini()
  const failure = new Error('synthetic stream failure')
  const stream = new ReadableStream({ start(c) { c.error(failure) } })
  transport.respond = () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(collect(), error => error === failure)
  assert.equal(stream.locked, false)
})
