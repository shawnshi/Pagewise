// SiliconFlow OpenAI 兼容客户端: 磁盘缓存 + 退避重试 + 并发限制 + 用量日志
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const CACHE = ROOT + 'cache/'
mkdirSync(CACHE, { recursive: true })
const KEY = readFileSync(homedir() + '/.config/tokenssh-ai/siliconflow.key', 'utf8').trim()
const BASE = 'https://api.siliconflow.cn/v1'

let active = 0
const waiters = []
const MAXC = Number(process.env.SF_CONC || 3)
async function slot() { if (active < MAXC) { active++; return } await new Promise(r => waiters.push(r)); active++ }
function release() { active--; const w = waiters.shift(); if (w) w() }
const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function chat(model, messages, opts = {}) {
  const body = { model, messages, stream: false, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 2048 }
  if (opts.thinking === false) body.enable_thinking = false
  if (opts.json) body.response_format = { type: 'json_object' }
  const key = createHash('sha256').update(JSON.stringify(body) + (opts.tag ?? '')).digest('hex').slice(0, 32)
  const file = CACHE + key + '.json'
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true }
  await slot()
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const t0 = Date.now()
      let res
      try {
        res = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeout ?? 240000) })
      } catch (e) { await sleep(2000 * 2 ** attempt); continue }
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * 2 ** attempt); continue }
      const j = await res.json()
      if (!res.ok) throw new Error(`${model} ${res.status} ${JSON.stringify(j).slice(0, 300)}`)
      const out = { model, content: j.choices?.[0]?.message?.content ?? '', reasoning: j.choices?.[0]?.message?.reasoning_content ?? '', usage: j.usage, ms: Date.now() - t0, finish: j.choices?.[0]?.finish_reason }
      writeFileSync(file, JSON.stringify(out))
      appendFileSync(ROOT + 'usage.jsonl', JSON.stringify({ at: new Date().toISOString(), model, tag: opts.tag, usage: j.usage, ms: out.ms }) + '\n')
      return out
    }
    throw new Error(model + ' retries exhausted')
  } finally { release() }
}

export async function embed(model, input) {
  const key = createHash('sha256').update(model + JSON.stringify(input)).digest('hex').slice(0, 32)
  const file = CACHE + 'e-' + key + '.json'
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  await slot()
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(BASE + '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ model, input }) }).catch(() => null)
      if (!res || res.status === 429 || res.status >= 500) { await sleep(3000 * 2 ** attempt); continue }
      const j = await res.json()
      if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300))
      const vecs = j.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
      writeFileSync(file, JSON.stringify(vecs))
      return vecs
    }
    throw new Error('embed retries exhausted')
  } finally { release() }
}

/** 从模型输出里抠 JSON (容忍代码块、前后废话、think 标签) */
export function parseJsonLoose(s) {
  s = String(s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1]
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  const a2 = s.indexOf('['), b2 = s.lastIndexOf(']')
  for (const [x, y] of [[a, b], [a2, b2]]) {
    if (x >= 0 && y > x) { try { return JSON.parse(s.slice(x, y + 1)) } catch {} }
  }
  return null
}

/** 宽松提取 {"w":"…","r":n} 列表 (容忍截断、重复循环); 去重保序 */
export function extractTerms(s, field = 'w') {
  s = String(s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '')
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]{1,40})"(?:\\s*,\\s*"r"\\s*:\\s*"?(\\d))?`, 'g')
  const seen = new Map()
  for (const m of s.matchAll(re)) {
    const w = m[1].trim()
    if (!w) continue
    const r = Number(m[2]) || 1
    if (!seen.has(w)) seen.set(w, r); else seen.set(w, Math.max(seen.get(w), r))
  }
  return [...seen].map(([w, r]) => ({ w, r }))
}
