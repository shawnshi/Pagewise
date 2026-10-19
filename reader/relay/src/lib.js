/**
 * relay 的纯函数 (可在 node 下测试): 限流、计数日、SSE → NDJSON 转换。
 * Worker 入口 (index.js) 只能有 default 导出 (具名导出会被当成 handler), 辅助函数放这里。
 */

/** 试用通道对外的模型名; 旧客户端的智谱 Flash 名字映射到它 */
export const CHAT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash'
export const LEGACY_MODELS = new Set(['glm-4.7-flash', 'glm-4.5-flash', 'glm-4-flash'])

const WINDOW_MS = 60_000

/** isolate 内存滑动窗口限流 (第一道闸, 拦掉高频轰击, 减少 D1 写入) */
const buckets = new Map()
export function rateLimited(key, max, now = Date.now()) {
  const recent = (buckets.get(key) ?? []).filter(t => now - t < WINDOW_MS)
  if (recent.length >= max) {
    buckets.set(key, recent)
    return true
  }
  recent.push(now)
  buckets.set(key, recent)
  if (buckets.size > 5000) buckets.clear()
  return false
}

/** 计数日: 北京时间 (UTC+8) 零点重置 */
export function quotaDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

/**
 * 上游 SSE → NDJSON，返回累计文本；onText 在失败前也能记录已产生的用量。
 * 完成信号缺失、长度截断、坏 JSON 或下游写入失败必须穿透为错误。
 */
export async function sseToNdjson(readable, write, onText) {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  let sse = '', line = '', output = '', completed = false, finishReason = null
  const emitLine = part => {
    const t = part.trim().replace(/^-\s*/, '').replace(/,$/, '')
    if (!t || t.startsWith('```')) return
    let value
    try { value = JSON.parse(t) } catch (cause) { throw new Error('Invalid NDJSON frame', { cause }) }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid NDJSON object')
    write(t + '\n')
  }
  const emit = text => {
    output += text
    onText?.(text)
    line += text
    const parts = line.split('\n')
    line = parts.pop() ?? ''
    parts.forEach(emitLine)
  }
  const feed = text => {
    sse += text
    const events = sse.split('\n')
    sse = events.pop() ?? ''
    for (const ev of events) {
      const t = ev.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') { completed = true; continue }
      if (!payload) continue
      let value
      try { value = JSON.parse(payload) } catch (cause) { throw new Error('Invalid SSE JSON frame', { cause }) }
      if (value?.error) throw new Error('Provider stream returned an error')
      const choice = value?.choices?.[0]
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
      const c = choice?.delta?.content ?? choice?.message?.content
      if (typeof c === 'string' && c) emit(c)
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      feed(decoder.decode(value, { stream: true }))
    }
    feed(decoder.decode() + '\n')
    if (finishReason && finishReason !== 'stop') throw new Error(`Incomplete SSE output: ${finishReason}`)
    if (!completed && finishReason !== 'stop') throw new Error('Incomplete SSE output: truncated before completion')
    emitLine(line)
    return output
  } finally {
    try { await reader.cancel() } catch { /* Cleanup cannot hide the original stream failure. */ }
    reader.releaseLock()
  }
}
