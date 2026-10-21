import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { AI_PROVIDERS, isSelectableAiProvider, normalizeAiProfiles, providerById } from '../src/services/aiProviders.ts'

const source = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')

test('only own-key services are selectable; retired trial profiles remain archived, not runnable', () => {
  assert.deepEqual(AI_PROVIDERS.map(p => p.id), ['deepseek', 'openai', 'gemini', 'openrouter'])
  assert.ok(AI_PROVIDERS.every(p => p.needsKey))
  assert.equal(isSelectableAiProvider('trial'), false)
  assert.throws(() => providerById('trial'), /unknown provider/)
  const profile = { baseUrl: 'https://synthetic.invalid/private', apiKey: 'synthetic-retained-key', model: 'saved-custom-model' }
  assert.deepEqual(normalizeAiProfiles({ trial: profile, openai: profile, custom: profile }), { trial: profile, openai: profile, custom: profile })
})

test('runtime AI closure contains no built-in endpoint, device-quota identifier or relay transport', () => {
  for (const path of ['services/ai.ts', 'services/aiProviders.ts', 'services/PagewiseCompanion/client.ts', 'composables/usePagewiseCompanion.ts']) {
    assert.doesNotMatch(source(path), /lightread-ai\.jiangshu\.ai|TRIAL_BASE_URL|trialDeviceId|x-device-id|COMPANION_ENDPOINT|\/dianjing/)
  }
  assert.doesNotMatch(source('services/PagewiseCompanion/engine.ts'), /COMPANION_MODEL|COMPANION_FALLBACK_MODEL|\.remaining/)
})

test('reading AI setup has only the own-service settings action and all changed Vue templates parse', () => {
  const reader = source('views/ReaderView.vue')
  assert.doesNotMatch(reader, /useTrialAi|openRegister|ai\.useTrial|ai\.register/)
  const setup = reader.slice(reader.indexOf('class="ai-setup-actions"'), reader.indexOf('class="ai-setup-alt"'))
  assert.equal((setup.match(/<button\b/g) ?? []).length, 1)
  assert.match(setup, /router\.push\('\/settings'\)/)
  for (const path of ['views/ReaderView.vue', 'views/SettingsView.vue', 'components/AiProviderSelector.vue', 'components/AiModelSelector.vue', 'components/PagewiseCompanionConsent.vue', 'components/PagewiseCompanionToggle.vue']) {
    assert.deepEqual(parse(source(path)).errors, [], path)
  }
  assert.match(source('components/PagewiseCompanionConsent.vue'), /:disabled="!own"/)
  for (const locale of ['zh', 'en']) assert.doesNotMatch(source(`i18n/${locale}.ts`), /ai\.useTrial|ai\.register|settings\.aiTrialTag|companion\.remaining|companion\.channelBuiltin/)
})
