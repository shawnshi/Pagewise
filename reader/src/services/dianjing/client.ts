/**
 * 点睛阅读的网络层: 内置通道 (relay `/v1/dianjing`, 提示词在服务端) 或用户自己的密钥直连
 * (OpenAI 兼容接口, 提示词由同一个 prompt.ts 拼装)。两路都是流式, 逐行回调。
 */
import { fetchRemote } from '../net'
import { TRIAL_BASE_URL, trialDeviceId } from '../ai'
import { buildChatBody, DJ_MODEL, PROMPT_VERSION, type DjRequest } from './prompt.ts'
import { NdjsonParser, SseDeltaParser, type RawItem } from './protocol.ts'

export type DjErrorCode = 'quota' | 'budget' | 'offline' | 'auth' | 'http' | 'aborted' | 'config'

export class DjError extends Error {
  code: DjErrorCode
  status: number
  constructor(code: DjErrorCode, message: string, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface DjChannel {
  kind: 'builtin' | 'own'
  /** own: 接口地址 (…/v1); builtin: relay 根 (…/v1) */
  baseUrl: string
  apiKey?: string
  /** own: 模型名; builtin 由服务端决定 (响应头 x-dj-model) */
  model?: string
}

export interface DjStreamResult {
  /** 实际使用的模型 (进入缓存键) */
  model: string
  /** 内置通道: 今日剩余字数 */
  remaining?: number
  good: number
  bad: number
}

export const DJ_ENDPOINT = (base = TRIAL_BASE_URL) => base.replace(/\/+$/, '') + '/dianjing'

const isSiliconFlow = (url: string) => /siliconflow\.(cn|com)/i.test(url)

/** 把底层错误归类: 网络断开 / 中止 / 其他 */
function classify(e: unknown): DjError {
  if (e instanceof DjError) return e
  const err = e as { name?: string; message?: string }
  if (err?.name === 'AbortError') return new DjError('aborted', 'aborted')
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline || /failed to fetch|network|load failed|connection|timed? ?out/i.test(String(err?.message ?? ''))) {
    return new DjError('offline', String(err?.message ?? 'offline'))
  }
  return new DjError('http', String(err?.message ?? e))
}

async function readError(res: Response): Promise<DjError> {
  const text = (await res.text().catch(() => '')).slice(0, 400)
  let message = text || res.statusText
  let code = ''
  try {
    const j = JSON.parse(text)
    message = j?.error?.message ?? message
    code = j?.error?.code ?? ''
  } catch { /* 非 JSON */ }
  if (res.status === 429) return new DjError(code === 'budget' ? 'budget' : 'quota', message, 429)
  if (res.status === 401 || res.status === 403) return new DjError('auth', message, res.status)
  return new DjError('http', `${res.status} ${message}`, res.status)
}

async function pump(res: Response, onText: (s: string) => void, signal?: AbortSignal) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    onText(await res.text())
    return
  }
  const decoder = new TextDecoder()
  for (;;) {
    if (signal?.aborted) {
      try { await reader.cancel() } catch { /* 已关闭 */ }
      throw new DjError('aborted', 'aborted')
    }
    const { done, value } = await reader.read()
    if (done) break
    onText(decoder.decode(value, { stream: true }))
  }
  onText(decoder.decode())
}

/**
 * 发一次点睛请求, 逐行回调原始条目 (校验 / 锚定由调用方做)。
 * 失败抛 DjError; 中途断流时已回调的条目仍有效, 但调用方不应写缓存。
 */
export async function streamDianjing(
  req: Omit<DjRequest, 'promptVersion'>,
  channel: DjChannel,
  onItem: (raw: RawItem) => void,
  signal?: AbortSignal,
): Promise<DjStreamResult> {
  const parser = new NdjsonParser()
  const body: DjRequest = { ...req, promptVersion: PROMPT_VERSION }
  try {
    if (channel.kind === 'builtin') {
      const res = await fetchRemote(DJ_ENDPOINT(channel.baseUrl), undefined, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
          'x-device-id': trialDeviceId(),
        },
        body: JSON.stringify(body),
        signal,
        raw: true,
      })
      if (!res.ok) throw await readError(res)
      const model = res.headers.get('x-dj-model') || DJ_MODEL
      const rem = Number(res.headers.get('x-dj-remaining'))
      await pump(res, s => { for (const it of parser.feed(s)) onItem(it) }, signal)
      for (const it of parser.flush()) onItem(it)
      return { model, remaining: Number.isFinite(rem) ? rem : undefined, good: parser.good, bad: parser.bad }
    }
    const base = channel.baseUrl.trim().replace(/\/+$/, '')
    if (!base || !channel.model) throw new DjError('config', 'AI not configured')
    const sse = new SseDeltaParser()
    const res = await fetchRemote(base + '/chat/completions', undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
        ...(channel.apiKey?.trim() ? { authorization: `Bearer ${channel.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(buildChatBody(body, channel.model, { thinkingFlag: isSiliconFlow(base) ? undefined : false })),
      signal,
      raw: true,
    })
    if (!res.ok) throw await readError(res)
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      const j = await res.json()
      for (const it of parser.feed(String(j?.choices?.[0]?.message?.content ?? ''))) onItem(it)
    } else {
      await pump(res, s => { for (const it of parser.feed(sse.feed(s))) onItem(it) }, signal)
    }
    for (const it of parser.flush()) onItem(it)
    return { model: channel.model, good: parser.good, bad: parser.bad }
  } catch (e) {
    throw classify(e)
  }
}
