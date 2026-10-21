export interface AiModelOption { id: string; label: string }

export interface AiProviderPreset {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  models: readonly AiModelOption[]
  needsKey: boolean
  docsUrl?: string
}

/** Public provider documentation and OpenRouter catalog checked on this date; not a paid API probe. */
export const AI_MODEL_CATALOG_VERIFIED_AT = '2026-10-20'

export interface AiProviderProfile {
  baseUrl: string
  apiKey: string
  model: string
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash', needsKey: true,
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
  {
    id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol', needsKey: true,
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
    docsUrl: 'https://developers.openai.com/api/docs/models',
  },
  {
    id: 'gemini', label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-4-argon', needsKey: true,
    models: [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    ],
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-6.1-sol', needsKey: true,
    models: [
      { id: 'openai/gpt-6.1-sol', label: 'OpenAI · GPT-6.1 Sol' },
      { id: 'openai/gpt-6-astra', label: 'OpenAI · GPT-6 Astra' },
      { id: 'google/gemini-4-argon', label: 'Google · Gemini 4 Argon' },
      { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek · V4.1 Flash' },
      { id: 'openrouter/auto', label: 'OpenRouter Auto' },
    ],
    docsUrl: 'https://openrouter.ai/docs/guides/overview/models',
  },
]

/** Old profiles remain inert archives; they are not selectable or eligible for requests. */
const LEGACY_AI_PROVIDER_IDS = new Set(['trial', 'siliconflow', 'zhipu', 'qwen', 'kimi', 'doubao', 'ollama', 'custom'])

export function isSelectableAiProvider(id: string): boolean {
  return AI_PROVIDERS.some(provider => provider.id === id)
}

export function aiModelOptions(providerId: string, savedModel = ''): AiModelOption[] {
  if (!isSelectableAiProvider(providerId)) return []
  const models = [...providerById(providerId).models]
  // Existing explicit model choices remain visible and are never silently overwritten.
  if (savedModel.trim() && !models.some(model => model.id === savedModel)) models.push({ id: savedModel, label: savedModel })
  return models
}

/** Avoid unsupported sampling/token parameters on the current reasoning models. */
export function compatibleChatBody<T extends { model: string; temperature?: number; max_tokens?: number }>(body: T): T & { max_completion_tokens?: number } {
  const result = { ...body } as T & { max_completion_tokens?: number }
  const name = body.model.replace(/^(openai|google)\//, '')
  if (/^gpt-[56](?:[.-]|$)/.test(name)) {
    delete result.temperature
    if (result.max_tokens !== undefined) {
      result.max_completion_tokens = result.max_tokens
      delete result.max_tokens
    }
  }
  if (/^gemini-4(?:[.-]|$)/.test(name)) delete result.temperature
  return result
}

export function providerById(id: string): AiProviderPreset {
  const preset = AI_PROVIDERS.find(p => p.id === id)
  if (!preset) throw new Error('AI configuration: unknown provider')
  return preset
}

export function normalizeAiProfiles(raw: unknown): Record<string, AiProviderProfile> {
  const profiles: Record<string, AiProviderProfile> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return profiles
  for (const [id, value] of Object.entries(raw)) {
    if (!isSelectableAiProvider(id) && !LEGACY_AI_PROVIDER_IDS.has(id)) continue
    const p: unknown = value
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue
    if (!('baseUrl' in p) || typeof p.baseUrl !== 'string'
      || !('apiKey' in p) || typeof p.apiKey !== 'string'
      || !('model' in p) || typeof p.model !== 'string') continue
    profiles[id] = { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }
  }
  return profiles
}
