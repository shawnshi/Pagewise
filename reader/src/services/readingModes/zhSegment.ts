/**
 * 仿生阅读的中文分词 (纯函数, 无依赖, 不碰 DOM)。调研与评测见 docs/research/zh-segmentation-for-word-guide.md。
 *
 * - splitRuns: 先把文本分成汉字串 / 西文词 / 数字 (含小数点、百分号) / 空白 / 标点, 只有汉字串需要分词。
 * - segmentZh: 汉字串按自带词表做 jieba 式 DAG 最小代价切分 (代价 = ln(名次 + 10), 不做 HMM 新词猜测:
 *   查不到的字落成单字, 单字不上色)。再做「歧义不上色」: 另一个词典词跨过这个词的边界、且代价相差不超过
 *   margin (默认 2) 时, 把这个词标为 unsure (例:「冷风吹」里「冷风」「风吹」交叉, 两个都不上色)。
 * - segmentZhIcu: 词表还没下载下来时的回退: Intl.Segmenter + 三四字常用词合并表 (最长匹配, 至多 4 段)。
 * - parseZhLexicon: 读 scripts/build-zh-lexicon.mjs 生成的 src/data/zh-lexicon.txt (分档 + 前缀压缩)。
 *
 * 下标一律是 UTF-16 下标 (与 DOM Range 一致)。词表只有基本区汉字, 扩展区的字 (代理对) 只会落成「未登录单字」。
 */

export type SegKind = 'han' | 'latin' | 'num' | 'punct' | 'space' | 'other'
export interface Seg {
  /** 在原文中的起点 (UTF-16) */
  index: number
  text: string
  kind: SegKind
  /** 有交叉歧义: 着色时跳过 */
  unsure?: boolean
}
export interface ZhLexicon {
  /** 词 -> 代价 (越常用越小) */
  cost: Map<string, number>
  /** 词表里最长的词 (字数, ≤ 8) */
  maxLen: number
  /** 未登录单字的代价 */
  unk: number
  /** 词数 */
  size: number
}

/** 代价 = ln(名次 + RANK_K): 按名次与按词频算出来的切分几乎一样 (调研 §4), 所以词表只存顺序 */
const RANK_K = 10
const MAX_WORD = 8
/** 歧义不上色的默认阈值 (调研 §5.1) */
export const UNSURE_MARGIN = 2

// 汉字串 / 西文词 / 数字 / 空白 / 标点符号 / 其他单个字符 (西文词只续接西文字母, 「阿Q的名字」不会把「的名字」并进西文词)
const RUN_RE = /(\p{Script=Han}+)|([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}][\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}'’-]*)|(\p{N}+(?:[.,:]\p{N}+)*%?)|(\s+)|([\p{P}\p{S}]+)|([\s\S])/gu
const KINDS: SegKind[] = ['han', 'latin', 'num', 'space', 'punct', 'other']
const PURE_HAN_RE = /^\p{Script=Han}+$/u

export function splitRuns(text: string, base = 0): Seg[] {
  const out: Seg[] = []
  RUN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RUN_RE.exec(text))) {
    let k = 1
    while (m[k] === undefined) k++
    out.push({ index: base + m.index, text: m[0], kind: KINDS[k - 1] })
  }
  return out
}

/** 由「按常用程度排好序」的词构造词表 (名次即顺序; 重复的词取第一次出现的名次) */
export function lexiconFromRanked(words: readonly string[]): ZhLexicon {
  const cost = new Map<string, number>()
  let maxLen = 1
  let rank = 0
  for (const w of words) {
    if (!w || w.length > MAX_WORD || cost.has(w)) continue
    cost.set(w, Math.log(rank + RANK_K))
    rank++
    if (w.length > maxLen) maxLen = w.length
  }
  return { cost, maxLen, unk: Math.log(rank + RANK_K) + 3, size: cost.size }
}

/**
 * 解析词表资源。格式 (zh-lexicon v1):
 * - `#` 开头的行是注释 (版本、来源与许可);
 * - 词按常用程度分档, 档与档之间是一行 `-`; 一档内按字典序排, 每行 = 与上一行共用的前缀长度 (1 位数字) + 其余部分;
 * - 一档内的词名次相同, 代价取该档首尾名次的几何平均: ln(√((R+k)(R+n-1+k)))。
 * 也接受每行一个词、按常用程度排好序的纯文本 (没有数字前缀, 没有 `-`)。
 */
export function parseZhLexicon(text: string): ZhLexicon {
  const lines = text.split('\n')
  const tiers: string[][] = [[]]
  let plain = true
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line || line[0] === '#') continue
    if (line === '-') { plain = false; tiers.push([]); continue }
    const c = line.charCodeAt(0)
    if (c >= 48 && c <= 57) {
      plain = false
      const cur = tiers[tiers.length - 1]
      const prev = cur.length ? cur[cur.length - 1] : ''
      cur.push(prev.slice(0, c - 48) + line.slice(1))
    } else tiers[tiers.length - 1].push(line)
  }
  if (plain) return lexiconFromRanked(tiers[0])
  const cost = new Map<string, number>()
  let maxLen = 1
  let rank = 0
  for (const tier of tiers) {
    if (!tier.length) continue
    const c = 0.5 * (Math.log(rank + RANK_K) + Math.log(rank + tier.length - 1 + RANK_K))
    for (const w of tier) {
      if (!w || w.length > MAX_WORD || cost.has(w)) continue
      cost.set(w, c)
      if (w.length > maxLen) maxLen = w.length
    }
    rank += tier.length
  }
  return { cost, maxLen, unk: Math.log(rank + RANK_K) + 3, size: cost.size }
}

/**
 * 一个汉字串的 DAG 最小代价切分 (从右往左动态规划, 同 jieba 的 calc, 不用 HMM)。
 * 返回各词的终点 (UTF-16 下标, 递增) 与「没把握」标记。
 */
export function cutHan(run: string, lex: ZhLexicon, margin: number | null = UNSURE_MARGIN): { ends: number[]; unsure: boolean[] } {
  const n = run.length
  const L = lex.maxLen
  const best = new Float64Array(n + 1)
  const next = new Int32Array(n + 1)
  // 以 a 开头、≥2 字的词典词: 终点与代价 (歧义检查要用)
  const dagEnd = new Int32Array(n * L)
  const dagCost = new Float64Array(n * L)
  const dagN = new Uint8Array(n)
  const cost = lex.cost
  for (let i = n - 1; i >= 0; i--) {
    // 未登录的字: 一个字一段 (代理对占两个下标, 不拆开)
    const step = (run.charCodeAt(i) & 0xfc00) === 0xd800 && (run.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
    let b = lex.unk + best[i + step]
    let nx = i + step
    const single = step === 1 ? cost.get(run[i]) : undefined
    if (single !== undefined && single + best[i + 1] < b) b = single + best[i + 1]
    const lim = Math.min(n, i + L)
    let k = 0
    for (let j = i + 2; j <= lim; j++) {
      const c = cost.get(run.slice(i, j))
      if (c === undefined) continue
      dagEnd[i * L + k] = j
      dagCost[i * L + k] = c
      k++
      const v = c + best[j]
      if (v < b) { b = v; nx = j }
    }
    dagN[i] = k
    best[i] = b
    next[i] = nx
  }
  const ends: number[] = []
  const unsure: boolean[] = []
  for (let i = 0; i < n; i = next[i]) {
    const j = next[i]
    ends.push(j)
    let u = false
    if (margin !== null && j - i >= 2) {
      const lim = cost.get(run.slice(i, j))! + margin
      // 交叉: 起点在词外、终点在词内, 或起点在词内、终点在词外
      for (let a = Math.max(0, i - L + 1); a < j && !u; a++) {
        if (a === i) continue
        const base = a * L
        for (let k = 0; k < dagN[a]; k++) {
          const e = dagEnd[base + k]
          const crosses = a < i ? e > i && e < j : e > j
          if (crosses && dagCost[base + k] <= lim) { u = true; break }
        }
      }
    }
    unsure.push(u)
  }
  return { ends, unsure }
}

/** 按词表切分整段文本: 非汉字部分按类型原样返回 */
export function segmentZh(text: string, lex: ZhLexicon, opts: { unsureMargin?: number | null } = {}): Seg[] {
  const margin = opts.unsureMargin === undefined ? UNSURE_MARGIN : opts.unsureMargin
  const out: Seg[] = []
  for (const r of splitRuns(text)) {
    if (r.kind !== 'han') { out.push(r); continue }
    if (r.text.length === 1) { out.push(r); continue }
    const { ends, unsure } = cutHan(r.text, lex, margin)
    let p = 0
    for (let k = 0; k < ends.length; k++) {
      const e = ends[k]
      const s: Seg = { index: r.index + p, text: r.text.slice(p, e), kind: 'han' }
      if (unsure[k]) s.unsure = true
      out.push(s)
      p = e
    }
  }
  return out
}

/**
 * 回退: ICU 分词 + 合并表。相邻的纯汉字片段 (至多 4 段, ≤ 6 字) 拼起来若在合并表里, 取最长的那个。
 * segmenter 由调用方传入 (按书的语言创建并缓存); 没有 Intl.Segmenter 时整串当作一个个单字 (都不上色)。
 */
export function segmentZhIcu(text: string, merge: ReadonlySet<string>, segmenter: Intl.Segmenter | null): Seg[] {
  if (!segmenter) {
    return splitRuns(text).flatMap(r => r.kind === 'han'
      ? Array.from(r.text, (ch, i) => ({ index: r.index + i, text: ch, kind: 'han' as const }))
      : [r])
  }
  const raw = Array.from(segmenter.segment(text), s => ({ index: s.index, text: s.segment }))
  const out: Seg[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    if (!PURE_HAN_RE.test(s.text)) {
      for (const r of splitRuns(s.text, s.index)) out.push(r)
      continue
    }
    let best = i
    let str = s.text
    let acc = s.text
    for (let j = i + 1; j < raw.length && j <= i + 3; j++) {
      if (!PURE_HAN_RE.test(raw[j].text)) break
      acc += raw[j].text
      if (acc.length > 6) break
      if (merge.has(acc)) { best = j; str = acc }
    }
    out.push({ index: s.index, text: str, kind: 'han' })
    i = best
  }
  return out
}
