/**
 * 阅读 AI 助手: 统一走 OpenAI 兼容的 chat/completions 接口。
 *  - 预设见 aiProviders.ts (含 Google Gemini), 不在 provider 之间回退
 *  - 桌面端经 Rust HTTP (支持代理, 无 CORS 限制), Web 端直接 fetch
 *  - SSE 流式输出
 */
import { fetchRemote } from './net'
import { useSettings } from '../stores/settings'
import { AI_PROVIDERS, providerById, TRIAL_BASE_URL } from './aiProviders.ts'

export { AI_PROVIDERS, providerById, TRIAL_BASE_URL } from './aiProviders.ts'
export type { AiProviderPreset, AiProviderProfile } from './aiProviders.ts'

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 匿名设备标识: 首启生成随机 id, 仅用于试用通道按设备限额, 不含任何个人信息 */
export function trialDeviceId(): string {
  try {
    return deviceId()
  } catch {
    return 'noid-' + Math.random().toString(36).slice(2, 12)
  }
}

function deviceId(): string {
  const KEY = 'lightread-device-id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

/** AI 是否已完成必要配置 */
export function aiConfigured(): boolean {
  const s = useSettings()
  if (!AI_PROVIDERS.some(p => p.id === s.aiProvider)) return false
  const preset = providerById(s.aiProvider)
  if (!s.aiBaseUrl.trim() || !s.aiModel.trim()) return false
  if (preset.needsKey && !s.aiApiKey.trim()) return false
  return true
}

/**
 * 流式对话。逐段 yield 增量文本; 非 2xx 时抛出带服务端信息的错误。
 * 服务端不支持流式时回退整段返回。
 */
export async function* chatStream(
  messages: AiMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  signal?.throwIfAborted()
  const s = useSettings()
  const preset = providerById(s.aiProvider)
  if (!s.aiBaseUrl.trim()) throw new Error('AI configuration: base URL is required')
  if (!s.aiModel.trim()) throw new Error('AI configuration: model is required')
  if (preset.needsKey && !s.aiApiKey.trim()) throw new Error('AI configuration: API key is required')
  const url = s.aiBaseUrl.trim().replace(/\/+$/, '') + '/chat/completions'
  const res = await fetchRemote(url, undefined, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...(s.aiApiKey.trim() ? { authorization: `Bearer ${s.aiApiKey.trim()}` } : {}),
      // 试用通道: 携带匿名设备标识用于每日配额
      ...(preset.id === 'trial' && s.aiBaseUrl.trim().replace(/\/+$/, '') === TRIAL_BASE_URL ? { 'x-device-id': deviceId() } : {}),
    },
    body: JSON.stringify({
      model: s.aiModel.trim(),
      messages,
      stream: true,
      temperature: 0.6,
    }),
    signal,
    raw: true,
  })
  signal?.throwIfAborted()
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`${res.status} ${text || res.statusText}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  // 服务端不支持流式 (返回整段 JSON)
  if (contentType.includes('application/json')) {
    const data = await res.json()
    signal?.throwIfAborted()
    const content = data?.choices?.[0]?.message?.content
    if (content) yield String(content)
    return
  }

  const reader = res.body?.getReader?.()
  if (!reader) {
    const data = await res.json()
    signal?.throwIfAborted()
    const content = data?.choices?.[0]?.message?.content
    if (content) yield String(content)
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  // Cancel pending reads even when a transport does not bind its stream to the signal.
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = done ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        signal?.throwIfAborted()
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') return
        let delta: unknown
        try {
          delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
        } catch { continue /* Preserve compatibility with malformed SSE heartbeats. */ }
        if (delta) yield String(delta)
      }
      if (done) break
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Cleanup errors must not hide the original transport/abort failure.
    try { await reader.cancel() } catch { /* Already failed or cancelled. */ }
    reader.releaseLock()
  }
}

/** 阅读场景的系统提示 */
export function readerSystemPrompt(book: { title?: string; author?: string }, chapter: string, lang: 'zh' | 'en'): string {
  const zh = `你是一位博学的阅读助手。用户正在阅读《${book.title ?? ''}》${book.author ? `(${book.author})` : ''}${chapter ? `, 当前章节:「${chapter}」` : ''}。请围绕这本书回答问题, 补充历史背景、人物关系、典故出处等知识。回答简洁准确, 分点或短段落, 不要空话。`
  const en = `You are a knowledgeable reading companion. The user is reading "${book.title ?? ''}"${book.author ? ` by ${book.author}` : ''}${chapter ? `, currently in chapter "${chapter}"` : ''}. Answer questions around this book with background, context and references. Be concise and accurate.`
  return lang === 'en' ? en : zh
}

/** 划词解读的提问模板 */
export function explainPrompt(text: string, lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? `Please explain this passage: its meaning, background, and any allusions or context worth knowing.\n\n"${text}"`
    : `请解读下面这段文字: 含义、历史背景、涉及的人物或典故, 以及值得展开的知识点。\n\n「${text}」`
}
