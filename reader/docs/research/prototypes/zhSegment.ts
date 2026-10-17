/**
 * 仿生阅读中文分词原型 (纯函数, 无依赖)。
 * - lexiconFromRanked: 按词频降序的词表 -> 代价表 (Zipf: cost = ln(rank + k)); lexiconFromFreq: 带词频的版本
 * - segmentDag: jieba 式 DAG + 最小代价路径 (不做 HMM 新词识别: 未登录字保持单字, 着色时留白, 宁缺毋错);
 *   unsureMargin 打开交叉歧义标记, dropUnsure 把没把握的词拆成单字 (= 不着色)
 * - segmentIcu: Intl.Segmenter + 词表最长匹配合并 (现方案的推广)
 * - chunk: 词块层, 只把「的了着过地得们 / 吗呢吧啊」和方位后缀并到前面的多字词上
 * 评测与数据见 docs/research/zh-segmentation-for-word-guide.md; 词表由 build-zh-lexicon.py 生成 (不入库)。
 */
export type Kind = 'han' | 'latin' | 'num' | 'punct' | 'space' | 'other'
export interface Seg { index: number; text: string; kind: Kind; /** 有交叉歧义, 着色时跳过 */ unsure?: boolean }
export interface Lexicon { cost: Map<string, number>; maxLen: number; unk: number }

const HAN = /\p{Script=Han}/u
// 文字串切成 run: 汉字串 / 西文词 / 数字 (含小数点、百分号) / 标点 / 空白
const RUN_RE = /(\p{Script=Han}+)|([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}][\p{L}\p{M}'’\-]*)|(\p{N}+(?:[.,:]\p{N}+)*%?)|(\s+)|([\p{P}\p{S}]+)|(.)/gsu

export function lexiconFromRanked(words: string[], opts: { k?: number; maxLen?: number } = {}): Lexicon {
  const k = opts.k ?? 10
  const cost = new Map<string, number>()
  let maxLen = 1
  words.forEach((w, r) => {
    if (!w || cost.has(w)) return
    const L = [...w].length
    if (L > (opts.maxLen ?? 8)) return
    cost.set(w, Math.log(r + k))
    if (L > maxLen) maxLen = L
  })
  return { cost, maxLen, unk: Math.log(words.length + k) + 3 }
}

export function lexiconFromFreq(entries: Array<[string, number]>, opts: { maxLen?: number } = {}): Lexicon {
  let total = 0
  for (const [, f] of entries) total += f
  const lt = Math.log(total)
  const cost = new Map<string, number>()
  let maxLen = 1
  let minF = Infinity
  for (const [w, f] of entries) {
    const L = [...w].length
    if (L > (opts.maxLen ?? 8)) continue
    cost.set(w, lt - Math.log(f))
    if (f < minF) minF = f
    if (L > maxLen) maxLen = L
  }
  return { cost, maxLen, unk: lt - Math.log(Math.max(1, minF)) + 1 }
}

export function runs(text: string): Seg[] {
  const out: Seg[] = []
  for (const m of text.matchAll(RUN_RE)) {
    const kind: Kind = m[1] ? 'han' : m[2] ? 'latin' : m[3] ? 'num' : m[4] ? 'space' : m[5] ? 'punct' : 'other'
    out.push({ index: m.index!, text: m[0], kind })
  }
  return out
}

/** 汉字串的 DAG 最小代价切分 (从右往左 DP, 同 jieba calc) */
export function cutHan(run: string, lex: Lexicon): string[] {
  const n = run.length // 按 UTF-16 下标; 扩展区 B 以后的字 (代理对) 不在词表里, 只会落到未登录单字
  const best = new Float64Array(n + 1)
  const next = new Int32Array(n + 1)
  best[n] = 0
  for (let i = n - 1; i >= 0; i--) {
    let b = lex.unk + best[i + 1]
    let nx = i + 1
    const lim = Math.min(n, i + lex.maxLen)
    for (let j = i + 1; j <= lim; j++) {
      const c = lex.cost.get(run.slice(i, j))
      if (c === undefined) continue
      const v = c + best[j]
      if (v < b) { b = v; nx = j }
    }
    best[i] = b
    next[i] = nx
  }
  const out: string[] = []
  for (let i = 0; i < n; i = next[i]) out.push(run.slice(i, next[i]))
  return out
}

/**
 * 交叉歧义: 有另一个词典词 (≥2 字) 跨过这个词的边界 (一半在词内、一半在词外), 且代价不比本词高出 margin。
 * 例:「研究生命」里「研究生」与「生命」交叉。读者自己在这类地方也会分歧 (Tsang 2024: 约 85% 的句子
 * 至少有一处歧义边界), 而标错边界的代价大于标对的收益 (Pan 2024, Tsang 2026), 所以这类词不着色。
 */
function markUnsure(run: string, words: string[], lex: Lexicon, margin: number): boolean[] {
  const flags: boolean[] = []
  let i = 0
  for (const w of words) {
    const j = i + w.length
    let unsure = false
    if (w.length >= 2) {
      const cw = lex.cost.get(w) ?? lex.unk
      // 起点在 (i-maxLen, j) 内、终点在 (i, j+maxLen) 内且与 [i,j) 部分重叠的候选
      for (let a = Math.max(0, i - lex.maxLen + 1); a < j && !unsure; a++) {
        for (let b = Math.max(a + 2, i + 1); b <= Math.min(run.length, a + lex.maxLen); b++) {
          const crosses = (a < i && b > i && b < j) || (a > i && a < j && b > j)
          if (!crosses) continue
          const c = lex.cost.get(run.slice(a, b))
          if (c !== undefined && c <= cw + margin) { unsure = true; break }
        }
      }
    }
    flags.push(unsure)
    i = j
  }
  return flags
}

export function segmentDag(text: string, lex: Lexicon, opts: { unsureMargin?: number } = {}): Seg[] {
  const out: Seg[] = []
  for (const r of runs(text)) {
    if (r.kind !== 'han') { out.push(r); continue }
    let p = r.index
    const words = cutHan(r.text, lex)
    const flags = opts.unsureMargin === undefined ? null : markUnsure(r.text, words, lex, opts.unsureMargin)
    words.forEach((w, k) => {
      out.push(flags?.[k] ? { index: p, text: w, kind: 'han', unsure: true } : { index: p, text: w, kind: 'han' })
      p += w.length
    })
  }
  return out
}

/** 评测用: 把 unsure 的词拆成单字 (单字不着色, 等价于「这个词不上色」) */
export function dropUnsure(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    if (!s.unsure) { out.push(s); continue }
    let p = s.index
    for (const ch of s.text) { out.push({ index: p, text: ch, kind: 'han' }); p += ch.length }
  }
  return out
}

let icu: Intl.Segmenter | null = null
/** ICU 分词 + 词表合并: 相邻汉字片段拼接 (至多 4 段, ≤ maxLen 字) 若在 merge 中则取最长的那个 */
export function segmentIcu(text: string, merge?: ReadonlySet<string>, maxLen = 6): Seg[] {
  icu ??= new Intl.Segmenter('zh', { granularity: 'word' })
  const raw = Array.from(icu.segment(text), s => ({ index: s.index, text: s.segment }))
  const out: Seg[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    if (!HAN.test(s.text)) { for (const r of runs(s.text)) out.push({ ...r, index: s.index + r.index }); continue }
    let best = i
    let str = s.text
    if (merge) {
      let acc = s.text
      for (let j = i + 1; j < raw.length && j <= i + 3; j++) {
        if (!/^\p{Script=Han}+$/u.test(raw[j].text)) break
        acc += raw[j].text
        if (acc.length > maxLen) break
        if (merge.has(acc)) { best = j; str = acc }
      }
    }
    out.push({ index: s.index, text: str, kind: 'han' })
    i = best
  }
  return out
}

/* ---------------- 意群 (词块) 层 ---------------- */
/** 只往左并的虚词: 结构助词、动态助词、语气词、复数后缀 (这些字几乎不会单独开头一个意群) */
const PARTICLES = new Set(['的', '地', '得', '了', '着', '过', '们', '吗', '呢', '吧', '啊', '呀', '嘛', '啦', '似的'])
/** 方位后缀: 前一个是 ≥2 字词时并到左边 (「船舱中」「基础上」) */
const LOCALIZERS = new Set(['上', '中', '里', '内', '外', '下', '前', '后', '时'])

export interface ChunkOpts { maxChars?: number }
/**
 * 意群 (词块): 在已分好的词序列上做保守归并, 只在同一汉字串内 (标点、空白、西文、数字处断开)。
 * 只做「实词 + 后附虚词」: 「图书馆|的」→「图书馆的」, 「走进|了」→「走进了」, 「船舱|中」→「船舱中」。
 * 不往右并介词/副词: 右并依赖后一个词切得对, 一旦切错会把错误放大成更长的错块。
 * 块长上限默认 6 字。
 */
export function chunk(segs: Seg[], opts: ChunkOpts = {}): Seg[] {
  const maxChars = opts.maxChars ?? 6
  const out: Seg[] = []
  for (const s of segs) {
    const prev = out[out.length - 1]
    const adjacent = prev && prev.kind === 'han' && s.kind === 'han' && prev.index + prev.text.length === s.index
    // 只并到「多字词」上: 单字常是切分没把握的残片 (未登录词被拆成单字), 给它挂上虚词会把错块染上色
    if (adjacent && !prev.unsure && prev.text.length >= 2 && prev.text.length + s.text.length <= maxChars && (
      PARTICLES.has(s.text) || LOCALIZERS.has(s.text)
    )) {
      out[out.length - 1] = { ...prev, text: prev.text + s.text }
    } else out.push(s)
  }
  return out
}

/** 只给词表确认过的词着色: 不在词表里的多字片段拆成单字 (单字不着色) */
export function confirmOnly(segs: Seg[], lex: { has(w: string): boolean }): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    if (s.kind !== 'han' || s.text.length < 2 || lex.has(s.text)) { out.push(s); continue }
    let p = s.index
    for (const ch of s.text) { out.push({ index: p, text: ch, kind: 'han' }); p += ch.length }
  }
  return out
}
