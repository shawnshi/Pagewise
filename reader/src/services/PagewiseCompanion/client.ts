/** 伴读只使用用户配置的服务；未配置时不联网，也不回退到公共中转。 */
import { fetchRemote } from '../net'
import { compatibleChatBody } from '../aiProviders.ts'
import { buildChatBody, planMarkInput, MAX_CHUNK_CHARS, PROMPT_VERSION, type CompanionRequest } from './prompt.ts'
import { NdjsonParser, SseDeltaParser, type RawItem } from './protocol.ts'

export type CompanionErrorCode = 'quota' | 'budget' | 'offline' | 'auth' | 'http' | 'aborted' | 'config' | 'version'

export class CompanionError extends Error {
  code: CompanionErrorCode
  status: number
  constructor(code: CompanionErrorCode, message: string, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface CompanionChannel {
  kind: 'own'
  /** 用户配置的 OpenAI 兼容接口地址。 */
  baseUrl: string
  apiKey?: string
  /** 用户选择的模型名。 */
  model?: string
}

export interface CompanionStreamResult {
  /** 实际使用的模型 (进入缓存键) */
  model: string
  good: number
  bad: number
}

const isSiliconFlow = (url: string) => /siliconflow\.(cn|com)/i.test(url)

/** 把底层错误归类: 网络断开 / 中止 / 其他 */
function classify(e: unknown): CompanionError {
  if (e instanceof CompanionError) return e
  const err = e as { name?: string; message?: string }
  if (err?.name === 'AbortError') return new CompanionError('aborted', 'aborted')
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline || /failed to fetch|network|load failed|connection|timed? ?out/i.test(String(err?.message ?? ''))) {
    return new CompanionError('offline', String(err?.message ?? 'offline'))
  }
  return new CompanionError('http', String(err?.message ?? e))
}

async function readError(res: Response): Promise<CompanionError> {
  const text = (await res.text().catch(() => '')).slice(0, 400)
  let message = text || res.statusText
  let code = ''
  try {
    const j = JSON.parse(text)
    message = j?.error?.message ?? message
    code = j?.error?.code ?? ''
  } catch { /* 非 JSON */ }
  if (res.status === 429) return new CompanionError(code === 'budget' ? 'budget' : 'quota', message, 429)
  if (res.status === 401 || res.status === 403) return new CompanionError('auth', message, res.status)
  return new CompanionError('http', `${res.status} ${message}`, res.status)
}

async function pump(res: Response, onText: (s: string) => void, signal?: AbortSignal) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    onText(await res.text())
    return
  }
  const decoder = new TextDecoder()
  try {
    for (;;) {
      if (signal?.aborted) throw new CompanionError('aborted', 'aborted')
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new CompanionError('aborted', 'aborted')
      if (done) break
      onText(decoder.decode(value, { stream: true }))
    }
    onText(decoder.decode())
  } finally {
    try { await reader.cancel() } catch { /* Cleanup cannot hide the stream failure. */ }
    reader.releaseLock()
  }
}

/**
 * 发一次伴读请求, 逐行回调原始条目 (校验 / 锚定由调用方做)。
 * 失败抛 CompanionError; 中途断流时已回调的条目仍有效, 但调用方不应写缓存。
 */
export async function streamPagewiseCompanion(
  req: Omit<CompanionRequest, 'promptVersion'>,
  channel: CompanionChannel,
  onItem: (raw: RawItem) => void,
  signal?: AbortSignal,
): Promise<CompanionStreamResult> {
  const parser = new NdjsonParser()
  try {
    const text = String(req.text ?? '')
    if (text.length > MAX_CHUNK_CHARS) throw new CompanionError('http', `Reading source exceeds the ${MAX_CHUNK_CHARS}-character limit`)
    const body: CompanionRequest = { ...req, text: req.mode === 'mark' ? planMarkInput(text).text : text, promptVersion: PROMPT_VERSION }
    if (channel.kind !== 'own') throw new CompanionError('config', 'Retired AI channel')
    const base = channel.baseUrl.trim().replace(/\/+$/, '')
    if (!base || !channel.model) throw new CompanionError('config', 'AI not configured')
    const sse = new SseDeltaParser()
    const res = await fetchRemote(base + '/chat/completions', undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
        ...(channel.apiKey?.trim() ? { authorization: `Bearer ${channel.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(compatibleChatBody(buildChatBody(body, channel.model, { thinkingFlag: isSiliconFlow(base) ? undefined : false }))),
      signal,
      raw: true,
    })
    if (!res.ok) throw await readError(res)
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      const j = await res.json()
      const reason = j?.choices?.[0]?.finish_reason
      if (reason && reason !== 'stop') throw new CompanionError('http', `Incomplete output: ${reason}`)
      for (const it of parser.feed(String(j?.choices?.[0]?.message?.content ?? ''))) onItem(it)
    } else {
      await pump(res, s => { for (const it of parser.feed(sse.feed(s))) onItem(it) }, signal)
      for (const it of parser.feed(sse.finish())) onItem(it)
    }
    for (const it of parser.flush()) onItem(it)
    if (parser.bad) throw new CompanionError('http', 'Invalid or incomplete NDJSON output')
    return { model: channel.model, good: parser.good, bad: parser.bad }
  } catch (e) {
    throw classify(e)
  }
}
