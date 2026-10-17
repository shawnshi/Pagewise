/**
 * 点睛阅读「重点词」的离线选词引擎 (纯函数, 无 DOM、无依赖, 可在 Worker 与 node 里跑)。
 * 调研与评测: docs/research/entropy-keyword-highlighting.md (统计算法 V3), docs/research/llm-keyword-selection.md (AI 选词)。
 * 原型: docs/research/prototypes/keyHighlight.ts —— 本文件是它的产品实现, 打分与排布规则保持一致。
 *
 * 词的分数 (nat): S(w) = I + K + 0.5·B
 *   I 背景自信息: 由词表名次按 Zipf 估计 (= 分词代价 ln(名次+10) + ln H); 本书新词按词表末位计
 *   K 本书关键度: ln(1 + G²), G² = 2[f ln(f/E) − (f − E)] (f > E), E = N·p_bg (Dunning 1993)
 *   B 聚集度: Carpena 2009 的 C 值, 截到 [0, 8], 出现次数 < 3 时为 0
 * 参选: 停用词 / 数字 / 单字 / 名次 < 1500 的常用词不参选 (K ≥ 5 且名次 ≥ 200 时例外); 切分有歧义 (unsure) 的不参选。
 * 选词: 每节 (章) 二分查找阈值, 使点亮的词约占本节词数的 density; 每句上限 ⌈句内词数·d·2.5⌉;
 *   点亮的词不相邻; 同一个词一段只亮一次; 第 k 次出现减 ln(1+k); 全书第一次出现用强样式, 之后用弱样式。
 * 本书新词: 2–4 字片段按凝固度 (PMI ≥ 3.5) + 左右邻字熵 + 边界一致性 + 短语过滤挑出 (人名、术语)。
 *   「汉字 + 1–2 个拉丁字母」(阿Q、小D、X射线) 在新词发现与切分里当作一个整体, 否则「阿Q」永远亮不了。
 * 小说: K 与 B 只用读到当前章为止的文本 (limitOrd), 不剧透。
 *
 * AI 词 (智能版, forced): 先在段落里精确定位 (长词优先、不重叠), 其余部分按词表切分;
 *   S = 4r + 2·ln(被选中的块数) + K + 0.5B。少档只用 r≥2; 「多」档 AI 词优先, 再用统计词补满 (统计词一律弱样式)。
 */
import { cutHan, splitRuns, type Seg, type ZhLexicon } from './zhSegment.ts'

// ---------------- 参数 ----------------

export type KwLevel = 'low' | 'normal' | 'high'

/** 基础版三档密度 (占词数): 少 2% / 适中 4% / 多 8% */
export const KW_DENSITY: Record<KwLevel, number> = { low: 0.02, normal: 0.04, high: 0.08 }
/** 智能版: AI 词按内容决定多少, 这个密度只作上限 (「多」档用统计词补到这里) */
export const KW_AI_DENSITY = 0.08

export interface KwParams {
  alpha: number
  beta: number
  gamma: number
  /** 点亮的词占全部词的比例 */
  density: number
  /** 名次小于它的常用词不点亮 */
  minRank: number
  /** 一句里最多 max(1, ceil(句内词数 × density × sentenceFactor)) 个 */
  sentenceFactor: number
  /** 第 k 次出现减 decay·ln(1+k) */
  decay: number
  /** 一个词在一段里最多点亮几次 */
  perParaType: number
  /** 软门槛: 常用词 K ≥ kOverride (且名次 ≥ 200) 时仍可参选 */
  kOverride: number
}

export const KW_DEFAULTS: KwParams = {
  alpha: 1, beta: 1, gamma: 0.5, density: KW_DENSITY.normal, minRank: 1500,
  sentenceFactor: 2.5, decay: 1, perParaType: 1, kOverride: 5,
}

// ---------------- 词表常量 (与原型一致) ----------------

const STOP = new Set(('我们 你们 他们 她们 它们 自己 什么 怎么 这样 那样 这么 那么 这个 那个 这些 那些 这种 那种 这里 那里 哪里 '
  + '因为 所以 但是 然而 而且 并且 或者 如果 虽然 即使 于是 然后 以及 及其 其中 之后 之前 以后 以前 之间 时候 已经 还是 就是 '
  + '可以 可能 应该 需要 能够 没有 不是 一个 一些 一种 一样 一直 一定 一般 通常 非常 十分 比较 更加 这是 那是 所谓 似乎 仿佛 '
  + '便是 却是 只是 也是 都是 只有 还有 不过 并不 并非 不能 不会 不要 起来 出来 下去 进去 上去 过来 东西 事情 地方 情况 问题 '
  + '方面 方法 进行 使用 通过 由于 对于 关于 根据 例如 比如 包括 称为 成为 认为 表示 指出 发现 显示 采用 其它 其他 另外 此外 '
  + '同时 当时 现在 目前 今天 一次 第一 第二 第三 两个 几个 许多 很多 所有 任何 每个 某个 这时 那时 只要 就是 也就 便是').split(' '))
const LATIN_STOP = new Set('the a an and or of to in on for is are be by as at it this that with from not but can if'.split(' '))
const STOP_CHARS = new Set('的了是在和与也都就不一这那他她它我你们着过地得之而及或把被让给对从向于以为所其很又还更最'.split(''))
const PARTICLE_PARTS = new Set('着 过 地 得 些 呀 吗 呢 吧 么'.split(' '))
const COMPLEMENT_TAIL = new Set('完 住 开 进 掉 散 到 起 下去 起来 出来 过来 上来 下来 回来 出去 进去 上去'.split(' '))
const PHRASE_EDGE = new Set('两个 几个 一些 有些 有点 觉得 似乎 好像 已经 正在 一下'.split(' '))
const NUM_RE = /^[一二三四五六七八九十百千万亿两零〇几第半]+$/
const SENT_END_RE = /[。！？；!?;…]/
const HAN_RE = /\p{Script=Han}/u
const HAN_START_RE = /^\p{Script=Han}/u
const ACRONYM_RE = /^[A-Z][A-Z0-9-]{1,7}$/
const RANK_K = 10

// ---------------- 「汉字 + 短西文」: 短西文词映射成一个私用区字符 ----------------

const PUA = 0xe000
const ASCII_LETTER_RE = /^[A-Za-z]{1,2}$/
const letterIdx = (c: number) => (c >= 97 ? c - 97 + 26 : c - 65)

/** 1–2 个 ASCII 字母 → 一个私用区字符 (U+E000 起); 其他返回 null */
function latinCode(s: string): string | null {
  if (!ASCII_LETTER_RE.test(s)) return null
  if (s.length === 1) return String.fromCharCode(PUA + s.charCodeAt(0))
  return String.fromCharCode(PUA + 128 + letterIdx(s.charCodeAt(0)) * 52 + letterIdx(s.charCodeAt(1)))
}

function decodeChar(c: number): string {
  const k = c - PUA
  if (k < 128) return String.fromCharCode(k)
  const j = k - 128
  const a = Math.floor(j / 52)
  const b = j % 52
  const ch = (i: number) => String.fromCharCode(i < 26 ? 65 + i : 97 + i - 26)
  return ch(a) + ch(b)
}

const isPua = (c: number) => c >= PUA && c < PUA + 128 + 52 * 52

/** 私用区编码的串 → 原文写法 */
export function decodeMixed(m: string): string {
  let out = ''
  for (let i = 0; i < m.length; i++) {
    const c = m.charCodeAt(i)
    out += isPua(c) ? decodeChar(c) : m[i]
  }
  return out
}

/** 原文写法 → 私用区编码 (「阿Q」→「阿」); 新词表与切分用 */
export function encodeMixed(w: string): string {
  let out = ''
  for (const r of splitRuns(w)) {
    const code = r.kind === 'latin' ? latinCode(r.text) : null
    out += code ?? r.text
  }
  return out
}

interface MixedRun {
  /** 编码后的串 (汉字原样, 短西文是一个私用区字符) */
  m: string
  /** 纯汉字串时 m 的第 i 个字在原文的 base + i */
  base: number
  /** 含短西文时: m 的第 i 个字在原文中的起点与长度 (纯汉字串为 null) */
  at: number[] | null
  len: number[] | null
  /** 有没有短西文 */
  mixed: boolean
}

const runStart = (r: MixedRun, i: number) => (r.at ? r.at[i] : r.base + i)
const runEnd = (r: MixedRun, i: number) => (r.at ? r.at[i] + r.len![i] : r.base + i + 1)

/**
 * 把一段文本分成「混合串」(相邻的汉字串与 1–2 字母的西文词连成一串) 与其他片段。
 * 只含西文的串不算混合串, 原样作为其他片段返回。
 */
function mixedRuns(text: string, base = 0): Array<MixedRun | Seg> {
  const runs = splitRuns(text, base)
  const out: Array<MixedRun | Seg> = []
  let cur: { segs: Seg[]; han: boolean } | null = null
  const flush = () => {
    if (!cur) return
    if (!cur.han) { out.push(...cur.segs); cur = null; return }
    if (cur.segs.length === 1) {
      const s0 = cur.segs[0]
      out.push({ m: s0.text, base: s0.index, at: null, len: null, mixed: false })
      cur = null
      return
    }
    let m = ''
    const at: number[] = []
    const len: number[] = []
    let mixed = false
    for (const s of cur.segs) {
      if (s.kind === 'han') {
        m += s.text
        for (let i = 0; i < s.text.length; i++) { at.push(s.index + i); len.push(1) }
      } else {
        m += latinCode(s.text)!
        at.push(s.index)
        len.push(s.text.length)
        mixed = true
      }
    }
    out.push({ m, base: 0, at, len, mixed })
    cur = null
  }
  for (const r of runs) {
    const joinable = r.kind === 'han' || (r.kind === 'latin' && latinCode(r.text) !== null)
    if (!joinable) { flush(); out.push(r); continue }
    if (!cur) cur = { segs: [], han: false }
    cur.segs.push(r)
    if (r.kind === 'han') cur.han = true
  }
  flush()
  return out
}

const isMixedRun = (x: MixedRun | Seg): x is MixedRun => (x as MixedRun).m !== undefined

// ---------------- 词表叠加 ----------------

/**
 * 在原词表上加一组额外的词 (本书新词)。复制一份 Map (6.6 万词约 10 ms、5 MB): 切分时每个位置要查 8 次词表,
 * 包一层函数查两张表要慢一倍。原词表不动。
 */
export function overlayLexicon(base: ZhLexicon, extra: ReadonlyMap<string, number>): ZhLexicon {
  if (!extra.size) return base
  let maxLen = base.maxLen
  const cost = new Map(base.cost)
  for (const [w, c] of extra) {
    if (!cost.has(w)) cost.set(w, c)
    if (w.length > maxLen) maxLen = w.length
  }
  return { cost, maxLen, unk: base.unk, size: base.size }
}

/** 新词的切分代价: 「拆开的最优代价」的一半, 封顶在第 3 万名的代价 (原型 withNewWords) */
export function newWordCosts(base: ZhLexicon, words: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>()
  const cap = Math.log(30000 + RANK_K)
  for (const w of words) {
    const { ends } = cutHan(w, base, null)
    let p = 0
    let sum = 0
    for (const e of ends) { sum += base.cost.get(w.slice(p, e)) ?? base.unk; p = e }
    out.set(w, Math.min(cap, sum * 0.5))
  }
  return out
}

function rankOf(lex: ZhLexicon, w: string): number | undefined {
  const c = lex.cost.get(w)
  return c === undefined ? undefined : Math.exp(c) - RANK_K
}

// ---------------- 本书新词发现 ----------------

export interface DiscoverOptions {
  minCount?: number
  minPmi?: number
  minEnt?: number
  /** 只统计前这么多字 (超长的书抽样, 控制内存) */
  maxChars?: number
}

/**
 * 本书新词 (凝固度 + 左右邻字熵 + 边界一致性 + 短语过滤)。返回 编码串 → 出现次数。
 * 输入是段落文本; 「汉字 + 短西文」按混合串统计。
 */
export function discoverNewWords(paras: Iterable<string>, lex: ZhLexicon, opts: DiscoverOptions = {}): Map<string, number> {
  const maxChars = opts.maxChars ?? 400_000
  const runs: string[] = []
  let total = 0
  for (const p of paras) {
    if (total >= maxChars) break
    for (const r of mixedRuns(p)) {
      if (!isMixedRun(r)) continue
      runs.push(r.m)
      total += r.m.length
    }
  }
  const minCount = opts.minCount ?? Math.max(3, Math.round(total / 20000))
  // 片段计数 (先验剪枝): 3、4 字片段只在其前缀够常见时才计数 —— 出现 ≥ minCount 次的片段, 它的任何子串都至少同样多,
  // 所以候选与凝固度要用到的各段计数都不会丢 (原型逐个计数 1–5 字片段, 结果相同, 内存与时间约少一半)
  const cnt = new Map<string, number>()
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]
      cnt.set(a, (cnt.get(a) ?? 0) + 1)
      if (i + 1 < r.length) { const s = r.slice(i, i + 2); cnt.set(s, (cnt.get(s) ?? 0) + 1) }
    }
  }
  for (let L = 3; L <= 4; L++) {
    for (const r of runs) {
      for (let i = 0; i + L <= r.length; i++) {
        if ((cnt.get(r.slice(i, i + L - 1)) ?? 0) < minCount) continue
        const s = r.slice(i, i + L)
        cnt.set(s, (cnt.get(s) ?? 0) + 1)
      }
    }
  }
  const minPmi = opts.minPmi ?? 3.5
  const minEnt = opts.minEnt ?? 0.9
  const cand: string[] = []
  for (const [s, c] of cnt) {
    if (s.length < 2 || s.length > 4 || c < minCount) continue
    if (lex.cost.has(s)) continue
    if (!HAN_RE.test(s)) continue
    if (STOP_CHARS.has(s[0]) || STOP_CHARS.has(s[s.length - 1])) continue
    if (NUM_RE.test(s)) continue
    let pmi = Infinity
    for (let k = 1; k < s.length; k++) {
      const a = cnt.get(s.slice(0, k))!
      const b = cnt.get(s.slice(k))!
      pmi = Math.min(pmi, Math.log((c * total) / (a * b)))
    }
    if (pmi < minPmi) continue
    // 首尾是高频虚字 / 高频词 (有一回、并没有、情况下): 短语碎片
    const { ends } = cutHan(s, lex, null)
    const first = s.slice(0, ends[0])
    const last = s.slice(ends.length > 1 ? ends[ends.length - 2] : 0)
    const common = (w: string) => { const r = rankOf(lex, w); return r !== undefined && r < (w.length === 1 ? 100 : 150) }
    if (common(first) || common(last) || s.includes('的') || s.includes('了')) continue
    // 短语: 中间夹着助词 (张|着|嘴), 以补语收尾 (吃|完), 以虚的词组开头 / 收尾 (两个|字)
    const parts: string[] = []
    { let p0 = 0; for (const e of ends) { parts.push(s.slice(p0, e)); p0 = e } }
    if (parts.some(x => PARTICLE_PARTS.has(x)) || COMPLEMENT_TAIL.has(last) || PHRASE_EDGE.has(first) || PHRASE_EDGE.has(last)) continue
    cand.push(s)
  }
  if (!cand.length) return new Map()
  const want = new Set(cand)
  const left = new Map<string, Map<string, number>>()
  const right = new Map<string, Map<string, number>>()
  const crossN = new Map<string, number>()
  const occN = new Map<string, number>()
  let edge = 0
  for (const r of runs) {
    let crossed: Uint8Array | null = null
    for (let i = 0; i < r.length; i++) {
      for (let L = 2; L <= 4 && i + L <= r.length; L++) {
        const s = r.slice(i, i + L)
        if (!want.has(s)) continue
        if (!crossed) {
          crossed = new Uint8Array(r.length + 1)
          const { ends } = cutHan(r, lex, null)
          let a = 0
          for (const b of ends) { for (let p = a + 1; p < b; p++) crossed[p] = 1; a = b }
        }
        occN.set(s, (occN.get(s) ?? 0) + 1)
        if (crossed[i] || crossed[i + L]) crossN.set(s, (crossN.get(s) ?? 0) + 1)
        const lk = i > 0 ? r[i - 1] : `^${edge++}`
        const rk = i + L < r.length ? r[i + L] : `$${edge++}`
        let lm = left.get(s); if (!lm) left.set(s, lm = new Map())
        let rm = right.get(s); if (!rm) right.set(s, rm = new Map())
        lm.set(lk, (lm.get(lk) ?? 0) + 1)
        rm.set(rk, (rm.get(rk) ?? 0) + 1)
      }
    }
  }
  const ent = (m: Map<string, number> | undefined) => {
    if (!m) return 0
    let n = 0; for (const v of m.values()) n += v
    let h = 0; for (const v of m.values()) h -= (v / n) * Math.log(v / n)
    return h
  }
  const out = new Map<string, number>()
  for (const s of cand) {
    const c = cnt.get(s)!
    const need = Math.min(minEnt, 0.8 * Math.log(c))
    if (Math.min(ent(left.get(s)), ent(right.get(s))) < need) continue
    if ((crossN.get(s) ?? 0) > 0.5 * (occN.get(s) ?? 1)) continue
    out.set(s, c)
  }
  // 去掉被更长新词几乎完全包含的片段 (赵太 ⊂ 赵太爷)
  for (const s of [...out.keys()]) {
    for (const t of out.keys()) {
      if (t !== s && t.length > s.length && t.includes(s) && out.get(t)! >= 0.7 * out.get(s)!) { out.delete(s); break }
    }
  }
  return out
}

// ---------------- 切分 ----------------

export interface KwTok {
  /** 段内 UTF-16 下标与长度 */
  index: number
  len: number
  /** 原文写法; 切分有歧义的词为 '' (不参选, 也不计重复) */
  text: string
  latin: boolean
  /** 段内句序号 (从 0 起) */
  sent: number
  /** 段内词序号 (含单字、数字; 不含标点空白) */
  ord: number
  /** AI 词 (强制定位) */
  forced?: boolean
}

/** AI 词的定位器: 长词优先、先到先得、不重叠 */
export interface ForcedMatcher {
  words: string[]
}

export function forcedMatcher(words: Iterable<string>): ForcedMatcher {
  return { words: [...new Set([...words].filter(w => w.length >= 2))].sort((a, b) => b.length - a.length) }
}

function forcedSpans(p: string, fm: ForcedMatcher): Array<[number, number]> {
  let taken: Uint8Array | null = null
  const spans: Array<[number, number]> = []
  for (const w of fm.words) {
    let i = p.indexOf(w)
    while (i >= 0) {
      taken ??= new Uint8Array(p.length)
      let free = true
      for (let k = i; k < i + w.length; k++) if (taken[k]) { free = false; break }
      if (free) { for (let k = i; k < i + w.length; k++) taken[k] = 1; spans.push([i, i + w.length]) }
      i = p.indexOf(w, i + 1)
    }
  }
  return spans.sort((a, b) => a[0] - b[0])
}

/**
 * 切分一段: 返回词 (汉字词、西文词) 与段内词数 n (含数字)。
 * 数字计入词序号 (ord) 但不返回; 标点里的句末符号推进句序号。
 */
export function tokenizeParaN(p: string, lex: ZhLexicon, fm?: ForcedMatcher | null): { toks: KwTok[]; n: number } {
  const out: KwTok[] = []
  const st = { ord: 0, sent: 0 }
  const push = (text: string, from: number) => {
    for (const r of mixedRuns(text, from)) {
      if (!isMixedRun(r)) {
        if (r.kind === 'punct') { if (SENT_END_RE.test(r.text)) st.sent++; continue }
        if (r.kind === 'space' || r.kind === 'other') continue
        if (r.kind === 'latin') out.push({ index: r.index, len: r.text.length, text: r.text, latin: true, sent: st.sent, ord: st.ord })
        st.ord++
        continue
      }
      if (r.m.length === 1) {
        const a = runStart(r, 0)
        const t = p.slice(a, runEnd(r, 0))
        out.push({ index: a, len: t.length, text: t, latin: r.mixed, sent: st.sent, ord: st.ord++ })
        continue
      }
      const { ends, unsure } = cutHan(r.m, lex)
      let q = 0
      for (let k = 0; k < ends.length; k++) {
        const e = ends[k]
        const a = runStart(r, q)
        const b = runEnd(r, e - 1)
        const latin = e - q === 1 && isPua(r.m.charCodeAt(q))
        out.push({ index: a, len: b - a, text: unsure[k] ? '' : p.slice(a, b), latin, sent: st.sent, ord: st.ord++ })
        q = e
      }
    }
  }
  if (fm && fm.words.length) {
    let at = 0
    for (const [a, b] of forcedSpans(p, fm)) {
      if (a > at) push(p.slice(at, a), at)
      out.push({ index: a, len: b - a, text: p.slice(a, b), latin: false, sent: st.sent, ord: st.ord++, forced: true })
      at = b
    }
    if (at < p.length) push(p.slice(at), at)
  } else push(p, 0)
  return { toks: out, n: st.ord }
}

export function tokenizePara(p: string, lex: ZhLexicon, fm?: ForcedMatcher | null): KwTok[] {
  return tokenizeParaN(p, lex, fm).toks
}

/** 这个词次要不要记位置 (可能参选的词: 多字词、稀见单字、新词、西文词) */
function worthTracking(t: KwTok, lex: ZhLexicon): boolean {
  if (!t.text) return false
  if (t.latin) return t.text.length >= 2
  if (t.len >= 2) return true
  const c = lex.cost.get(t.text)
  return c !== undefined && c >= Math.log(20000)
}

// ---------------- 全书统计 ----------------

export interface KwSection {
  /** 分节序号 (章序) */
  section: number
  paras: string[]
}

export interface KwStats {
  /** 叠加了本书新词的词表 */
  lex: ZhLexicon
  /** 本书新词 (原文写法) */
  newWords: Set<string>
  /** 全书词数 (含单字、数字) */
  N: number
  /** 各节在全书词序里的区间 [start, end) */
  ordStart: Map<number, number>
  ordEnd: Map<number, number>
  /** 词 → 出现位置 (全书词序, 升序) */
  pos: Map<string, Int32Array>
  /** 各节的纯文本 (AI 词不在统计里时, 按原文计数) 与字数 */
  texts: Map<number, string>
  chars: Map<number, number>
}

/** 由若干节 (按节序) 建全书统计: 先发现新词, 再按叠加词表切分并记位置 */
export function buildStats(sections: KwSection[], base: ZhLexicon, opts: { newWords?: boolean } = {}): KwStats {
  const sorted = [...sections].sort((a, b) => a.section - b.section)
  const found = opts.newWords === false ? new Map<string, number>() : discoverNewWords(sorted.flatMap(s => s.paras), base)
  const lex = overlayLexicon(base, newWordCosts(base, found.keys()))
  const newWords = new Set([...found.keys()].map(decodeMixed))
  const posArr = new Map<string, number[]>()
  const ordStart = new Map<number, number>()
  const ordEnd = new Map<number, number>()
  const texts = new Map<number, string>()
  const chars = new Map<number, number>()
  let ord = 0
  for (const s of sorted) {
    ordStart.set(s.section, ord)
    for (const p of s.paras) {
      const { toks, n } = tokenizeParaN(p, lex)
      for (const t of toks) {
        if (!worthTracking(t, lex)) continue
        let a = posArr.get(t.text); if (!a) posArr.set(t.text, a = [])
        a.push(ord + t.ord)
      }
      ord += n
    }
    ordEnd.set(s.section, ord)
    const text = s.paras.join('\n')
    texts.set(s.section, text)
    chars.set(s.section, text.length)
  }
  const pos = new Map<string, Int32Array>()
  for (const [w, a] of posArr) pos.set(w, Int32Array.from(a))
  return { lex, newWords, N: ord, ordStart, ordEnd, pos, texts, chars }
}

// ---------------- 打分 ----------------

export interface KwType {
  word: string
  f: number
  I: number
  K: number
  B: number
  S: number
  eligible: boolean
  isNew: boolean
}

function zipfH(lex: ZhLexicon): number {
  return Math.log((lex.size + RANK_K) / RANK_K) + 0.05
}

export function carpenaC(pos: ArrayLike<number>, n: number, N: number): number {
  if (n < 3 || N <= 0) return 0
  const mean = N / n
  let v = 0
  for (let i = 1; i < n; i++) v += (pos[i] - pos[i - 1] - mean) ** 2
  v += (N - pos[n - 1] + pos[0] - mean) ** 2 // 首尾相接
  const sigma = Math.sqrt(v / n) / mean
  const p = n / N
  if (p >= 1) return 0
  const sNor = sigma / Math.sqrt(1 - p)
  const mu = (2 * n - 1) / (2 * n + 2)
  const sd = 1 / (Math.sqrt(n) * (1 + 2.8 * n ** -0.865))
  return (sNor - mu) / sd
}

/** 升序数组里小于 x 的个数 */
export function countBelow(a: ArrayLike<number>, x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function effectiveMinRank(prm: KwParams): number {
  return prm.density <= 0.08 ? prm.minRank : Math.max(300, prm.minRank * 0.08 / prm.density)
}

/** 单个词的打分 (I 由词表名次、K 与 B 由出现位置算) */
export function scoreWord(w: string, p: ArrayLike<number>, f: number, N: number, stats: Pick<KwStats, 'lex' | 'newWords'>, prm: KwParams): KwType {
  const { lex } = stats
  const lnH = Math.log(zipfH(lex))
  const minI = Math.log(effectiveMinRank(prm) + RANK_K)
  const lexTop = Math.log(lex.size + RANK_K)
  const isNew = stats.newWords.has(w)
  let I: number
  let eligible = true
  let common = false
  if (isNew || HAN_START_RE.test(w)) {
    const c = lex.cost.get(w)
    if (isNew) I = lexTop
    else if (c === undefined) { I = lex.unk; eligible = false }
    else I = c
    if (w.length < 2 && !isNew) eligible = eligible && c !== undefined && c >= Math.log(20000) && !STOP_CHARS.has(w)
    if (STOP.has(w) || NUM_RE.test(w)) eligible = false
    if (I < minI) eligible = false
    common = I < minI && I >= Math.log(200 + RANK_K) && !STOP.has(w) && !NUM_RE.test(w) && w.length >= 2
  } else {
    // 西文: 没有背景词频表, 缩写当术语, 其余按「中等罕见」
    I = ACRONYM_RE.test(w) ? lexTop : Math.log(5000 + RANK_K)
    if (w.length < 2 || LATIN_STOP.has(w.toLowerCase())) eligible = false
  }
  const Ibits = I + lnH
  const E = N * Math.exp(-Ibits)
  const G2 = f > E ? 2 * (f * Math.log(f / E) - (f - E)) : 0
  const K = Math.log(1 + G2)
  if (!eligible && common && K >= prm.kOverride) eligible = true
  const B = Math.max(0, Math.min(8, carpenaC(p, f, N)))
  const S = prm.alpha * Ibits + prm.beta * K + prm.gamma * B
  return { word: w, f, I: Ibits, K, B, S, eligible, isNew }
}

/**
 * 全部词的分数。limitOrd: 只用全书词序 < limitOrd 的部分 (小说: 读到当前章为止); 缺省为全书。
 */
export function scoreTypes(stats: KwStats, prm: KwParams = KW_DEFAULTS, limitOrd = stats.N): Map<string, KwType> {
  const N = Math.max(1, Math.min(limitOrd, stats.N))
  const out = new Map<string, KwType>()
  for (const [w, all] of stats.pos) {
    const f = limitOrd >= stats.N ? all.length : countBelow(all, limitOrd)
    if (!f) continue
    out.set(w, scoreWord(w, all, f, N, stats, prm))
  }
  return out
}

// ---------------- 选词 ----------------

export interface KwPick {
  para: number
  index: number
  len: number
  /** 全书第一次出现 (强样式) */
  strong: boolean
  word: string
  score: number
  /** AI 选的词 (智能版) */
  ai?: boolean
}

export interface AiWord {
  /** 重要度 1–3 */
  r: number
  /** 在几个块里被选中 */
  n: number
}

export interface PickOptions {
  /** 智能版: AI 词表 (原文写法 → 重要度) */
  ai?: ReadonlyMap<string, AiWord> | null
  /** ai: 只亮 AI 词; aiFill: AI 词优先, 再用统计词补满 (统计词弱样式) */
  mode?: 'stat' | 'ai' | 'aiFill'
  /** AI 词的最低重要度 (少档 2) */
  minR?: number
  /** 小说: K 与 B 只用读到本节为止的文本 */
  spoilerSafe?: boolean
}

interface Cand { para: number; t: KwTok; gord: number; s: number; strong: boolean; ai: boolean }
interface Sentence { n: number; cands: Cand[] }

/** 给定阈值做一遍选择: 句内上限、不相邻、一段里同一个词至多 perParaType 次 */
function selectWith(sents: Sentence[], prm: KwParams, theta: number, out: KwPick[]): number {
  out.length = 0
  const lastOrdByPara = new Map<number, number>()
  const perPara = new Map<string, number>()
  for (const { n, cands } of sents) {
    const cap = Math.max(1, Math.ceil(n * prm.density * prm.sentenceFactor))
    const taken: Cand[] = []
    for (const c of cands) {
      if (c.s < theta || taken.length >= cap) break
      if (taken.some(x => Math.abs(x.gord - c.gord) < 2)) continue
      const lo = lastOrdByPara.get(c.para)
      if (lo !== undefined && Math.abs(lo - c.gord) < 2) continue
      const pk = c.para + '|' + c.t.text
      if ((perPara.get(pk) ?? 0) >= prm.perParaType) continue
      perPara.set(pk, (perPara.get(pk) ?? 0) + 1)
      taken.push(c)
    }
    taken.sort((a, b) => a.gord - b.gord)
    for (const c of taken) {
      out.push({ para: c.para, index: c.t.index, len: c.t.len, strong: c.strong, word: c.t.text, score: c.s, ...(c.ai ? { ai: true } : {}) })
      lastOrdByPara.set(c.para, c.gord)
    }
  }
  return out.length
}

/** 不在全书统计里的 AI 词: 按原文出现次数与字位置估 K、B (I 按新词计) */
function textTypeInfo(w: string, stats: KwStats, section: number, spoilerSafe: boolean, prm: KwParams): { type: KwType; prior: number } {
  const pos: number[] = []
  let base = 0
  let prior = 0
  let totalChars = 0
  const secs = [...stats.texts.keys()].sort((a, b) => a - b)
  for (const s of secs) {
    if (spoilerSafe && s > section) break
    const text = stats.texts.get(s)!
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) {
      pos.push(base + i)
      if (s < section) prior++
    }
    base += text.length + 1
    totalChars += text.length + 1
  }
  const wordsPerChar = stats.N / Math.max(1, [...stats.chars.values()].reduce((a, b) => a + b + 1, 0))
  const N = Math.max(1, Math.round(totalChars * wordsPerChar))
  const t = scoreWord(w, pos, pos.length, N, { lex: stats.lex, newWords: new Set([w]) }, prm)
  // B 按字位置算 (尺度无关): 重新用字数作总长
  t.B = Math.max(0, Math.min(8, carpenaC(pos, pos.length, Math.max(1, totalChars))))
  return { type: t, prior }
}

/**
 * 给一节 (章) 选词。paras 是这一节的段落 (与绘制层的段落切分一致); stats 可以只含部分章节 (全书统计还没做完时)。
 * types 是 scoreTypes 的结果 (调用方按 limitOrd 缓存)。
 */
export function pickSection(
  paras: string[],
  section: number,
  stats: KwStats,
  types: ReadonlyMap<string, KwType>,
  prm: KwParams,
  opts: PickOptions = {},
): KwPick[] {
  const mode = opts.mode ?? 'stat'
  const ai = mode === 'stat' ? null : opts.ai ?? null
  const minR = opts.minR ?? 1
  const aiOk = (w: string) => { const a = ai?.get(w); return !!a && a.r >= minR }
  const fm = ai && ai.size ? forcedMatcher([...ai.keys()].filter(aiOk)) : null
  const start = stats.ordStart.get(section)
  const textInfo = new Map<string, { type: KwType; prior: number }>()
  const priorOf = (w: string): number => {
    const p = stats.pos.get(w)
    if (p && start !== undefined) return countBelow(p, start)
    if (!p && ai?.has(w)) {
      let ti = textInfo.get(w)
      if (!ti) textInfo.set(w, ti = textTypeInfo(w, stats, section, !!opts.spoilerSafe, prm))
      return ti.prior
    }
    return 0
  }
  const typeOf = (w: string): KwType | undefined => {
    const t = types.get(w)
    if (t || !ai?.has(w)) return t
    let ti = textInfo.get(w)
    if (!ti) textInfo.set(w, ti = textTypeInfo(w, stats, section, !!opts.spoilerSafe, prm))
    return ti.type
  }
  const seen = new Map<string, number>()
  const sents: Sentence[] = []
  let gbase = 0
  let total = 0
  paras.forEach((p, pi) => {
    const { toks, n } = tokenizeParaN(p, stats.lex, fm)
    let cur: Sentence | null = null
    let curSent = -1
    for (const t of toks) {
      if (t.sent !== curSent) {
        if (cur) sents.push(cur)
        cur = { n: 0, cands: [] }
        curSent = t.sent
      }
      cur!.n++
      if (!t.text) continue
      let rep = seen.get(t.text)
      if (rep === undefined) rep = priorOf(t.text)
      seen.set(t.text, rep + 1)
      const isAi = !!ai && aiOk(t.text)
      let s: number
      if (isAi) {
        const a = ai!.get(t.text)!
        const ty = typeOf(t.text)
        const base = 4 * a.r + 2 * Math.log(Math.max(1, a.n)) + (ty ? ty.K + 0.5 * ty.B : 0)
        s = (mode === 'aiFill' ? 100 : 0) + base
      } else {
        if (mode === 'ai') continue
        const ty = types.get(t.text)
        if (!ty || !ty.eligible) continue
        s = ty.S
      }
      cur!.cands.push({ para: pi, t, gord: gbase + t.ord, s: s - prm.decay * Math.log(1 + rep), strong: rep === 0 && (isAi || mode === 'stat'), ai: isAi })
    }
    if (cur) sents.push(cur)
    // 密度的分母: 汉字词 + 西文词 (与原型一样不含数字)
    total += toks.length
    gbase += n + 1 // 段与段之间留一个空位, 跨段不算相邻
  })
  for (const s of sents) s.cands.sort((a, b) => b.s - a.s)
  const target = prm.density * total
  let lo = -50
  let hi = 200
  let best: KwPick[] | null = null
  const buf: KwPick[] = []
  for (let it = 0; it < 18; it++) {
    const mid = (lo + hi) / 2
    const n = selectWith(sents, prm, mid, buf)
    if (n > target) lo = mid
    else { hi = mid; best = buf.slice() }
  }
  if (!best) { selectWith(sents, prm, hi, buf); best = buf.slice() }
  return best
}

// ---------------- AI 词的规范化 ----------------

/** AI 给的词: NFKC、去书名号引号括号、去中西文之间的空格、去尾部标点 */
export function normTerm(w: string): string {
  let s = String(w ?? '').normalize('NFKC').replace(/[《》〈〉“”‘’「」『』"'（）()【】[\]]/g, '').trim()
  s = s.replace(/(\p{Script=Han})\s+(?=[A-Za-z0-9])/gu, '$1').replace(/([A-Za-z0-9])\s+(?=\p{Script=Han})/gu, '$1')
  s = s.replace(/[，。、；：！？,.;:!?]+$/u, '')
  return s
}

/**
 * 在一块正文里找 AI 词: 先精确, 再按规范化 (NFKC、去空白、忽略大小写) 找回原文写法。找不到返回 null。
 */
export function locateTerm(text: string, q: string): string | null {
  const n = normTerm(q)
  if (n.length < 2 || n.length > 12) return null
  if (text.includes(n)) return n
  // 规范化后的串与原文偏移的映射
  const map: number[] = []
  let norm = ''
  for (let k = 0; k < text.length; k++) {
    const piece = text[k].normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    for (let m = 0; m < piece.length; m++) { norm += piece[m]; map.push(k) }
  }
  const nq = n.replace(/\s+/g, '').toLowerCase()
  const j = norm.indexOf(nq)
  if (j < 0) return null
  return text.slice(map[j], map[j + nq.length - 1] + 1)
}
