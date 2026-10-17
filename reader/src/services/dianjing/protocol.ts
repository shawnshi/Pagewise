/**
 * 点睛阅读的输出协议 (纯函数, docs/dianjing-reading.md §6.3): NDJSON 流式解析、字段校验、
 * 编号与术语锚定到「本节 (段, 句) + 句内偏移」, 以及按密度档过滤。
 */
import { resolveParagraph, resolveSentence, sentenceText, type Chunk } from './chunker.ts'
import { locateTerm } from '../readingModes/keyWords.ts'

export type Density = 'low' | 'normal' | 'high'
export type DjKind = 'key' | 'term' | 'note'

/** 模型输出的原始行 (校验前) */
export type RawItem = Record<string, unknown> & { t?: unknown }

/** 句内位置 */
export interface SentencePos { block: number; sentence: number }

export interface KeyItem extends SentencePos { t: 'key'; id: string; r: 1 | 2 | 3; why: string }
export interface TermItem extends SentencePos { t: 'term'; id: string; r: 1 | 2 | 3; q: string; start: number; end: number; def: string }
export interface NoteItem extends SentencePos { t: 'note'; id: string; q: string; start: number; end: number; text: string; k: string }
export interface TrItem extends SentencePos { t: 'tr'; id: string; text: string }
export interface GistItem { t: 'gist'; id: string; block: number; text: string }
/** 重点词 (dj2): 只用来点亮, 没有位置 (整块里出现的地方都算); q 是正文里的原文写法 */
export interface KwItem { t: 'kw'; id: string; q: string; r: 1 | 2 | 3 }
export interface MetaItem { t: 'meta'; fiction: boolean }
export interface SumItem { t: 'sum'; text: string }
export interface PointItem extends SentencePos { t: 'pt'; text: string }

export type DjItem = KeyItem | TermItem | NoteItem | TrItem | GistItem | KwItem
export type AnyItem = DjItem | MetaItem | SumItem | PointItem

/** 字段长度上限 (字符), 超出截断 —— 比提示词要求略宽, 容忍英文 */
const LIMITS = { why: 60, def: 120, note: 200, gist: 90, tr: 600, q: 40, sum: 400, pt: 90 }

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const rank = (v: unknown): 1 | 2 | 3 => {
  const n = Math.round(Number(v))
  return n >= 3 ? 3 : n <= 1 ? 1 : 2
}

// ---- NDJSON 流式解析 ----

/**
 * 增量 NDJSON 解析器: feed() 喂入任意切片, 返回其中完整的 JSON 对象行。
 * 容忍模型偶尔输出的代码块围栏、空行、行首的 "- " 与行尾逗号; 坏行计入 bad 并跳过。
 */
export class NdjsonParser {
  #buf = ''
  good = 0
  bad = 0

  feed(text: string): RawItem[] {
    this.#buf += text
    const lines = this.#buf.split('\n')
    this.#buf = lines.pop() ?? ''
    return this.#parse(lines)
  }

  /** 流结束: 处理最后一行 (没有换行结尾) */
  flush(): RawItem[] {
    const rest = this.#buf
    this.#buf = ''
    return this.#parse([rest])
  }

  #parse(lines: string[]): RawItem[] {
    const out: RawItem[] = []
    for (const raw of lines) {
      let line = raw.trim()
      if (!line || line.startsWith('```')) continue
      line = line.replace(/^[-*]\s+/, '').replace(/,\s*$/, '')
      const a = line.indexOf('{')
      const b = line.lastIndexOf('}')
      if (a < 0 || b <= a) { this.bad++; continue }
      try {
        const v = JSON.parse(line.slice(a, b + 1))
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          out.push(v as RawItem)
          this.good++
        } else this.bad++
      } catch { this.bad++ }
    }
    return out
  }
}

/** OpenAI 兼容 SSE (data: {...choices[0].delta.content}) → 文本增量。自带密钥直连时用。 */
export class SseDeltaParser {
  #buf = ''
  done = false

  feed(text: string): string {
    this.#buf += text
    const lines = this.#buf.split('\n')
    this.#buf = lines.pop() ?? ''
    let out = ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') { this.done = true; continue }
      try {
        const j = JSON.parse(payload)
        const c = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content
        if (typeof c === 'string') out += c
      } catch { /* 心跳 / 注释 */ }
    }
    return out
  }
}

// ---- 术语锚定 (§6.4) ----

const fold = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase()

/** 两串编辑距离是否 ≤ 1 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/**
 * 在句子里找术语 q, 返回 [start, end) (句子原文的偏移) 或 null。
 * 1) 精确查找; 2) NFKC + 去空白 + 小写后查找, 再映射回原文偏移;
 * 3) 4 字以上允许编辑距离 1 (同长度窗口滑动)。
 */
export function findTermSpan(sentence: string, q: string): [number, number] | null {
  if (!q || !sentence) return null
  const i = sentence.indexOf(q)
  if (i >= 0) return [i, i + q.length]
  // 规范化后的串与原文偏移的映射
  const map: number[] = []
  let norm = ''
  for (let k = 0; k < sentence.length; k++) {
    const piece = fold(sentence[k])
    for (let m = 0; m < piece.length; m++) { norm += piece[m]; map.push(k) }
  }
  const nq = fold(q)
  if (!nq) return null
  const toSpan = (a: number, len: number): [number, number] => [map[a], map[a + len - 1] + 1]
  const j = norm.indexOf(nq)
  if (j >= 0) return toSpan(j, nq.length)
  if (nq.length >= 4) {
    for (const len of [nq.length, nq.length - 1, nq.length + 1]) {
      for (let a = 0; a + len <= norm.length; a++) {
        if (withinOneEdit(norm.slice(a, a + len), nq)) return toSpan(a, len)
      }
    }
  }
  return null
}

// ---- 校验与锚定 ----

export interface ResolveStats {
  dropped: number
  /** 重点词: 收到几行、几个在正文里找不到 (不计入 dropped, 不触发重试) */
  kwLines?: number
  kwMissing?: number
}

/** 一块的纯文本 (重点词定位用): 各段句子拼起来, 段与段之间换行 */
export function chunkPlainText(chunk: Chunk): string {
  return chunk.blocks.map(b => b.sentences.join('')).join('\n')
}

/**
 * 把一行原始输出校验并锚定到本节位置。不合法 (编号不存在、术语找不到) 返回 null 并计数。
 * 术语先在所指句子里找, 找不到再在同段其他句子里找 (模型偶尔把句号报错一位)。
 */
export function resolveItem(raw: RawItem, chunk: Chunk, stats?: ResolveStats): AnyItem | null {
  const drop = () => { if (stats) stats.dropped++; return null }
  const t = raw.t
  if (t === 'meta') return { t: 'meta', fiction: raw.fiction === true || raw.fiction === 'true' }
  if (t === 'sum') {
    const text = str(raw.text, LIMITS.sum)
    return text ? { t: 'sum', text } : drop()
  }
  if (t === 'kw') {
    if (stats) stats.kwLines = (stats.kwLines ?? 0) + 1
    const q = typeof raw.q === 'string' ? locateTerm(chunkPlainText(chunk), raw.q) : null
    if (!q || q.length < 2 || q.length > 12 || /\n/.test(q)) {
      if (stats) stats.kwMissing = (stats.kwMissing ?? 0) + 1
      return null
    }
    return { t: 'kw', id: `${chunk.hash}:kw:${q}`, q, r: rank(raw.r ?? 2) }
  }
  if (t === 'gist') {
    const block = resolveParagraph(chunk, Number(raw.p))
    const text = str(raw.text, LIMITS.gist)
    if (block == null || !text) return drop()
    return { t: 'gist', id: `${chunk.hash}:g:${block}`, block, text }
  }
  const ref = String(raw.s ?? '')
  const pos = resolveSentence(chunk, ref)
  if (!pos) return drop()
  const id = (suffix: string) => `${chunk.hash}:${t}:${pos.block}.${pos.sentence}${suffix}`
  switch (t) {
    case 'key':
      return { t: 'key', id: id(''), ...pos, r: rank(raw.r), why: str(raw.why, LIMITS.why) }
    case 'tr': {
      const text = str(raw.text, LIMITS.tr)
      return text ? { t: 'tr', id: id(''), ...pos, text } : drop()
    }
    case 'pt': {
      const text = str(raw.text, LIMITS.pt)
      return text ? { t: 'pt', ...pos, text } : drop()
    }
    case 'term':
    case 'note': {
      const q = str(raw.q, LIMITS.q)
      if (!q) return drop()
      let at = pos
      let sentence = sentenceText(chunk, ref) ?? ''
      let span = findTermSpan(sentence, q)
      if (!span) {
        // 同段其他句子
        const [p] = ref.split('.')
        const blk = chunk.blocks[Number(p) - 1]
        if (blk) {
          for (let k = 0; k < blk.sentences.length && !span; k++) {
            const found = findTermSpan(blk.sentences[k], q)
            if (found) {
              span = found
              sentence = blk.sentences[k]
              at = resolveSentence(chunk, `${p}.${k + 1}`) ?? pos
            }
          }
        }
      }
      if (!span) return drop()
      const exact = sentence.slice(span[0], span[1])
      const tid = `${chunk.hash}:${t}:${at.block}.${at.sentence}:${exact}`
      if (t === 'term') {
        const def = str(raw.def, LIMITS.def)
        if (!def) return drop()
        return { t: 'term', id: tid, ...at, r: rank(raw.r ?? 2), q: exact, start: span[0], end: span[1], def }
      }
      const text = str(raw.text, LIMITS.note)
      if (!text) return drop()
      return { t: 'note', id: tid, ...at, q: exact, start: span[0], end: span[1], text, k: str(raw.k, 16) || 'culture' }
    }
    default:
      return drop()
  }
}

// ---- 密度 (§2.3 R2) ----

/** 要句按字数占比: 少 5% / 标准 8% / 多 15% */
export const DENSITY_SHARE: Record<Density, number> = { low: 0.05, normal: 0.08, high: 0.15 }
/** 概念的最低重要度: 少只标 r=3, 标准 r≥2, 多全部 */
export const TERM_MIN_RANK: Record<Density, number> = { low: 3, normal: 2, high: 1 }
const MAX_KEYS_PER_BLOCK = 2

/**
 * 按密度挑出要显示的要句 id。在每块内独立计算 (块是流式到达的, 结果不随后续块变化):
 * 重要度高的优先, 同级按原文顺序; 累计字数不超过 share × 本块字数; 每段最多 2 句;
 * 只要本块有要句, 至少保留最重要的 1 句。
 */
export function selectKeys(
  keys: KeyItem[],
  sentenceLength: (k: KeyItem) => number,
  chunkChars: number,
  density: Density,
): Set<string> {
  const budget = DENSITY_SHARE[density] * Math.max(1, chunkChars)
  const sorted = keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => b.k.r - a.k.r || a.i - b.i)
  const chosen = new Set<string>()
  const perBlock = new Map<number, number>()
  let used = 0
  for (const { k } of sorted) {
    if (chosen.has(k.id)) continue
    const len = Math.max(1, sentenceLength(k))
    const n = perBlock.get(k.block) ?? 0
    if (n >= MAX_KEYS_PER_BLOCK) continue
    if (chosen.size > 0 && used + len > budget) continue
    // 少档只留 r≥2 (r=1 的「可标可不标」在少档不出现)
    if (density === 'low' && k.r < 2 && chosen.size > 0) continue
    chosen.add(k.id)
    perBlock.set(k.block, n + 1)
    used += len
  }
  return chosen
}

export function selectTerms(terms: TermItem[], density: Density): TermItem[] {
  return terms.filter(t => t.r >= TERM_MIN_RANK[density])
}

/** 是否为要落到正文上的条目 (排除 meta / sum / pt) */
export function isDjItem(v: AnyItem | null): v is DjItem {
  return !!v && (v.t === 'key' || v.t === 'term' || v.t === 'note' || v.t === 'tr' || v.t === 'gist' || v.t === 'kw')
}

// ---- 重点词 (dj2) ----

/**
 * 一块的重点词能不能用: 小模型会重复、截断或干脆不按要求输出, 这时这一块改用离线结果。
 * - 没有任何重点词 → 不可用 (多半是模型没理会这条要求);
 * - 一半以上在正文里找不到 → 不可用;
 * - 比每 25 字一个还多 → 不可用 (陷入重复循环)。
 */
export function keyWordsUsable(kws: number, missing: number, chunkChars: number): boolean {
  if (kws <= 0) return false
  if (missing > Math.max(2, 0.5 * (kws + missing))) return false
  return kws <= Math.max(6, Math.ceil(chunkChars / 25))
}

/** 中文正文才要 AI 重点词 (英文书暂不支持): 日文 / 韩文不要; 其余看汉字是否占多数 */
export function wantsKeyWords(lang: string | undefined, text: string): boolean {
  if (/^(ja|ko)\b/i.test(lang ?? '')) return false
  const body = String(text ?? '').replace(/\[\d+\.\d+\]\s?/g, '')
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(body)) return false
  const han = body.match(/\p{Script=Han}/gu)?.length ?? 0
  const latin = body.match(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/gu)?.length ?? 0
  return han >= 20 && han >= 0.3 * (han + latin)
}
