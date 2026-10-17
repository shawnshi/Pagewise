export interface AiProviderPreset {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  needsKey: boolean
  docsUrl?: string
}

export interface AiProviderProfile {
  baseUrl: string
  apiKey: string
  model: string
}

/** 内置试用通道的密钥仅保留在服务端。 */
export const TRIAL_BASE_URL = 'https://lightread-ai.jiangshu.ai/v1'

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: 'trial', label: '内置试用通道', baseUrl: TRIAL_BASE_URL,
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash', needsKey: false,
  },
  {
    id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash', needsKey: true,
    docsUrl: 'https://cloud.siliconflow.cn/i/TxUlXG3u',
  },
  {
    id: 'gemini', label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-3.8-flash', needsKey: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash', needsKey: true,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'qwen', label: '阿里云千问 (百炼)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus', needsKey: true,
    docsUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'kimi', label: 'Kimi (月之暗面)', baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k', needsKey: true,
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'doubao', label: '豆包 (火山方舟)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '', needsKey: true,
    docsUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'ollama', label: '本地模型 (Ollama)', baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b', needsKey: false,
  },
  { id: 'custom', label: 'OpenAI 兼容自定义', baseUrl: '', defaultModel: '', needsKey: false },
]

export function providerById(id: string): AiProviderPreset {
  const preset = AI_PROVIDERS.find(p => p.id === id)
  if (!preset) throw new Error('AI configuration: unknown provider')
  return preset
}

export function normalizeAiProfiles(raw: unknown): Record<string, AiProviderProfile> {
  const profiles: Record<string, AiProviderProfile> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return profiles
  for (const [id, value] of Object.entries(raw)) {
    if (!AI_PROVIDERS.some(p => p.id === id)) continue
    const p: unknown = value
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue
    if (!('baseUrl' in p) || typeof p.baseUrl !== 'string'
      || !('apiKey' in p) || typeof p.apiKey !== 'string'
      || !('model' in p) || typeof p.model !== 'string') continue
    profiles[id] = { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }
  }
  return profiles
}
