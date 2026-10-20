import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { AI_PROVIDERS, AI_MODEL_CATALOG_VERIFIED_AT, aiModelOptions, compatibleChatBody, normalizeAiProfiles, providerById } from '../src/services/aiProviders.ts'
import { useSettings } from '../src/stores/settings.ts'

const latest = { trial: 'deepseek-ai/DeepSeek-V4-Flash', deepseek: 'deepseek-flash', openai: 'gpt-6.1-sol', gemini: 'gemini-4-argon', openrouter: 'openai/gpt-6.1-sol' }

test('exactly five services expose verified model defaults and dropdown choices', () => {
  assert.deepEqual(AI_PROVIDERS.map(p => p.id), Object.keys(latest))
  assert.equal(AI_MODEL_CATALOG_VERIFIED_AT, '2026-10-20')
  for (const p of AI_PROVIDERS) {
    assert.equal(p.defaultModel, latest[p.id])
    assert.equal(p.needsKey, p.id !== 'trial')
    assert.ok(p.models.some(model => model.id === p.defaultModel))
    assert.equal(new Set(p.models.map(model => model.id)).size, p.models.length)
    assert.ok(p.baseUrl.startsWith('https://'))
  }
  for (const retired of ['custom', 'siliconflow', 'zhipu', 'qwen', 'kimi', 'doubao', 'ollama']) assert.throws(() => providerById(retired), /unknown provider/)
  assert.ok(aiModelOptions('openrouter').some(model => model.id === 'openrouter/auto'))
})

test('saved explicit models remain selectable without mutating the provider catalog', () => {
  const original = JSON.stringify(AI_PROVIDERS)
  const options = aiModelOptions('gemini', 'synthetic-explicit-model')
  assert.equal(options.at(-1).id, 'synthetic-explicit-model')
  assert.equal(aiModelOptions('gemini', 'gemini-4-argon').filter(model => model.id === 'gemini-4-argon').length, 1)
  assert.deepEqual(aiModelOptions('custom', 'synthetic-model'), [])
  assert.equal(JSON.stringify(AI_PROVIDERS), original)
})

test('retired profile archives survive normalization without becoming selectable', () => {
  const profile = { baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-retained-key', model: 'synthetic-saved' }
  const normalized = normalizeAiProfiles({ siliconflow: profile, openai: profile, unknown: profile, gemini: { ...profile, apiKey: null } })
  assert.deepEqual(normalized, { siliconflow: profile, openai: profile })
  assert.throws(() => providerById('siliconflow'))
  assert.deepEqual(normalizeAiProfiles(null), {})
  assert.deepEqual(normalizeAiProfiles([]), {})
})

test('real settings provider switches use separate credentials and never activate retired profiles', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const archived = { version: 16, aiProvider: 'siliconflow', aiBaseUrl: 'https://synthetic.invalid/retired', aiModel: 'legacy-model', aiApiKey: 'synthetic-legacy-only', aiProfiles: { siliconflow: { baseUrl: 'https://synthetic.invalid/retired', apiKey: 'synthetic-legacy-only', model: 'legacy-model' } } }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key === 'lightread-settings' ? JSON.stringify(archived) : null } })
  let settings
  try {
    setActivePinia(createPinia())
    settings = useSettings()
    assert.equal(settings.aiProvider, 'siliconflow', 'do not silently switch the user to a different service')
    assert.equal(settings.aiProfiles.siliconflow.apiKey, 'synthetic-legacy-only')
    for (const provider of ['deepseek', 'openai', 'gemini', 'openrouter', 'trial']) {
      settings.selectAiProvider(provider)
      assert.equal(settings.aiApiKey, '')
      assert.equal(settings.aiModel, latest[provider])
      assert.equal(settings.aiBaseUrl, providerById(provider).baseUrl)
      settings.aiApiKey = `synthetic-${provider}-only`
      settings.aiModel = `synthetic-${provider}-saved`
    }
    for (const provider of ['deepseek', 'openai', 'gemini', 'openrouter']) {
      settings.selectAiProvider(provider)
      assert.equal(settings.aiApiKey, `synthetic-${provider}-only`)
      assert.equal(settings.aiModel, `synthetic-${provider}-saved`)
    }
    const state = JSON.stringify(settings.$state)
    assert.throws(() => settings.selectAiProvider('siliconflow'))
    assert.equal(JSON.stringify(settings.$state), state)
    assert.equal(settings.aiProfiles.siliconflow.apiKey, 'synthetic-legacy-only')
  } finally {
    settings?.$dispose()
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})

test('reasoning model requests omit unsupported temperature and use the modern token limit parameter', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'openai/gpt-6.1-sol']) {
    const input = { model, temperature: 0.6, max_tokens: 1200, stream: true }
    const output = compatibleChatBody(input)
    assert.equal(output.temperature, undefined)
    assert.equal(output.max_tokens, undefined)
    assert.equal(output.max_completion_tokens, 1200)
    assert.equal(input.temperature, 0.6)
    assert.equal(input.max_tokens, 1200)
  }
  assert.equal(compatibleChatBody({ model: 'gemini-4-argon', temperature: 0.6 }).temperature, undefined)
  assert.equal(compatibleChatBody({ model: 'google/gemini-4-argon', temperature: 0.6 }).temperature, undefined)
  assert.equal(compatibleChatBody({ model: 'gemini-3.8-flash', temperature: 0.6 }).temperature, 0.6)
  assert.equal(compatibleChatBody({ model: 'deepseek-flash', temperature: 0.6 }).temperature, 0.6)
})
