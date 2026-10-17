/**
 * 点睛阅读·基础版「点亮重点词」原型 (纯函数, 只依赖 src/services/readingModes/zhSegment.ts)。
 * 调研与评测见 docs/research/entropy-keyword-highlighting.md。
 *
 * 词的分数 (单位: nat):
 *   S(w) = α·I(w) + β·K(w) + γ·B(w) − 惩罚
 *   I(w) 背景自信息 = −ln p_bg(w), p_bg 由词表名次按 Zipf 估计 (= 分词代价 ln(名次+10) + ln H)
 *   K(w) 本书关键度 = ln(1 + G²), G² = 2[f ln(f/E) − (f − E)] (f > E 时; E = N·p_bg, Dunning 1993 的泊松形式)
 *   B(w) 聚集度: Carpena 2009 的 C 值 (相邻出现间距的归一化标准差, 按出现次数校正), 或分块分布熵 (Herrera & Pury 2008)
 * 选词: 每章二分查找阈值, 使点亮的词约占全部词的 density; 句内上限 + 不相邻; 首次出现「强」, 之后「弱」并按 ln(1+k) 衰减。
 * 参选门槛: 停用词 / 数字 / 单字 (生僻字除外) 不参选; 名次 < minRank 的常用词只有 K ≥ kOverride 才参选 (软门槛)。
 * 可选「本书新词」: 2–4 字片段按凝固度 (最小切分点互信息) + 左右邻字熵挑出, 再过边界一致性与短语过滤, 加进本书词表 (人名、术语)。
 */
import { segmentZh, cutHan, type Seg, type ZhLexicon } from '../../../src/services/readingModes/zhSegment.ts'

export interface Params {
  alpha: number
  beta: number
  gamma: number
  /** 聚集度算法: carpena = 间距标准差 C 值; entropy = 分块分布熵 */
  burst: 'carpena' | 'entropy'
  /** 点亮的词占全部词的比例 */
  density: number
  /** 背景名次小于它的词不点亮 (最常用的虚词、代词、副词) */
  minRank: number
  /** 一句里最多点亮 max(1, ceil(句内词数 × density × sentenceFactor)) 个 */
  sentenceFactor: number
  /** 重复出现的衰减: 第 k 次重复减 decay·ln(1+k) */
  decay: number
  /** 一个词在一段里最多点亮几次 */
  perParaType: number
  /** 是否先做本书新词发现 */
  newWords: boolean
  /** 软门槛: 名次低于 minRank 的常用词, 若本书关键度 K ≥ kOverride (且名次 ≥ 200) 仍可参选 (例: 黑洞一文里的「质量」); Infinity = 硬门槛 */
  kOverride: number
}

export const DEFAULTS: Params = {
  alpha: 1, beta: 1, gamma: 0.5, burst: 'carpena', density: 0.08, minRank: 1500,
  sentenceFactor: 2.5, decay: 1.0, perParaType: 1, newWords: true, kOverride: 5,
}

export interface Tok {
  para: number
  /** 段内 UTF-16 下标 */
  index: number
  text: string
  latin: boolean
  /** 全书词序号 (含单字、数字) */
  ord: number
  sent: number
}

export interface Picked { para: number; index: number; len: number; strong: boolean; word: string; score: number }

export interface TypeInfo { word: string; f: number; I: number; K: number; B: number; S: number; eligible: boolean; isNew: boolean }

// 显式停用词 (名次已过滤掉大部分, 这里补上名次靠后但没有信息量的)
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
const HAN_RUN_RE = /\p{Script=Han}+/gu
const ACRONYM_RE = /^[A-Z][A-Z0-9-]{1,7}$/

/** 词表名次 (由代价反推; 分档存储时是档内几何平均名次) */
export function rankOf(lex: ZhLexicon, w: string): number | undefined {
  const c = lex.cost.get(w)
  return c === undefined ? undefined : Math.exp(c) - 10
}

/** Zipf 归一化常数 H = Σ 1/(r+10) ≈ ln((R+10)/10) + 0.05 */
function zipfH(lex: ZhLexicon): number {
  return Math.log((lex.size + 10) / 10) + 0.05
}

// ---------------- 本书新词发现 (凝固度 + 左右邻字熵) ----------------

export function discoverNewWords(paras: string[], lex: ZhLexicon, opts: { minCount?: number; minPmi?: number; minEnt?: number } = {}): Map<string, number> {
  const runs: string[] = []
  for (const p of paras) for (const m of p.matchAll(HAN_RUN_RE)) runs.push(m[0])
  let total = 0
  const cnt = new Map<string, number>()
  for (const r of runs) {
    total += r.length
    for (let i = 0; i < r.length; i++) {
      for (let L = 1; L <= 5 && i + L <= r.length; L++) {
        const s = r.slice(i, i + L)
        cnt.set(s, (cnt.get(s) ?? 0) + 1)
      }
    }
  }
  const minCount = opts.minCount ?? Math.max(3, Math.round(total / 20000))
  const minPmi = opts.minPmi ?? 3.5
  const minEnt = opts.minEnt ?? 0.9
  // 候选 2–4 字
  const cand: string[] = []
  for (const [s, c] of cnt) {
    if (s.length < 2 || s.length > 4 || c < minCount) continue
    if (lex.cost.has(s)) continue
    if (STOP_CHARS.has(s[0]) || STOP_CHARS.has(s[s.length - 1])) continue
    if (NUM_RE.test(s)) continue
    let pmi = Infinity
    for (let k = 1; k < s.length; k++) {
      const a = cnt.get(s.slice(0, k))!, b = cnt.get(s.slice(k))!
      pmi = Math.min(pmi, Math.log((c * total) / (a * b)))
    }
    if (pmi < minPmi) continue
    // 首尾是高频虚字 / 高频词 (有一回、并没有、情况下、另一个): 是短语碎片, 不是新词
    const { ends } = cutHan(s, lex, null)
    const first = s.slice(0, ends[0])
    const last = s.slice(ends.length > 1 ? ends[ends.length - 2] : 0)
    const common = (w: string) => { const r = rankOf(lex, w); return r !== undefined && r < (w.length === 1 ? 100 : 150) }
    if (common(first) || common(last) || s.includes('的') || s.includes('了')) continue
    // 短语而不是词: 中间夹着助词 (张|着|嘴、读|过|书、慢慢|地|走), 以补语收尾 (吃|完、拖|下去),
    // 或以虚的词组开头/收尾 (两个|字、觉得|有些)
    const parts: string[] = []
    { let p0 = 0; for (const e of ends) { parts.push(s.slice(p0, e)); p0 = e } }
    if (parts.some(x => PARTICLE_PARTS.has(x)) || COMPLEMENT_TAIL.has(last) || PHRASE_EDGE.has(first) || PHRASE_EDGE.has(last)) continue
    cand.push(s)
  }
  if (!cand.length) return new Map()
  // 左右邻字熵: 段首段尾、标点每次都算一个不同的邻居
  // 边界一致性: 原词表切分里有多字词跨过候选的左/右边界 (「无法逃|逸」里的「逃逸」、「相对|论预测」里的「相对论」),
  // 说明候选只是两个词各取一半的碎片; 超过一半的出现都这样就丢掉
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

/** 把新词并进一个本书词表 (原词表不动): 代价取「拆开的最优代价」的一半, 封顶在第 3 万名的代价 */
export function withNewWords(lex: ZhLexicon, words: Iterable<string>): ZhLexicon {
  const cost = new Map(lex.cost)
  let maxLen = lex.maxLen
  const cap = Math.log(30000 + 10)
  for (const w of words) {
    const { ends } = cutHan(w, lex, null)
    let p = 0, sum = 0
    for (const e of ends) { sum += lex.cost.get(w.slice(p, e)) ?? lex.unk; p = e }
    cost.set(w, Math.min(cap, sum * 0.5))
    if (w.length > maxLen) maxLen = w.length
  }
  return { cost, maxLen, unk: lex.unk, size: lex.size }
}

// ---------------- 切分 + 统计 ----------------

export interface Book {
  paras: string[]
  toks: Tok[]
  /** 全书词数 (含单字、数字, 不含标点空白) */
  N: number
  newWords: Set<string>
  lex: ZhLexicon
  /** 各章第一段的段号 (升序, 第一个是 0); 选词的阈值按章定 */
  chapters: number[]
}

/**
 * zhSegment.splitRuns 的西文正则 `[拉丁字母][\p{L}…]*` 会把紧跟的汉字也吞进西文词 (「阿Q的名字」→「阿」+「Q的名字」),
 * 这里把西文词在第一个非西文字母处截断, 剩下的部分再切一遍。(src 里的分词也有这个问题, 见调研文档 §7)
 */
const LATIN_HEAD_RE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}][\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}'’-]*/u
function segmentFixed(text: string, lex: ZhLexicon, base = 0): Seg[] {
  const out: Seg[] = []
  for (const s of segmentZh(text, lex)) {
    if (s.kind === 'latin') {
      const head = LATIN_HEAD_RE.exec(s.text)![0]
      if (head.length < s.text.length) {
        out.push({ index: base + s.index, text: head, kind: 'latin' })
        out.push(...segmentFixed(s.text.slice(head.length), lex, base + s.index + head.length))
        continue
      }
    }
    out.push(base ? { ...s, index: base + s.index } : s)
  }
  return out
}

export function prepareBook(paras: string[], baseLex: ZhLexicon, newWords: boolean, chapters: number[] = [0]): Book {
  const found = newWords ? discoverNewWords(paras, baseLex) : new Map<string, number>()
  const lex = found.size ? withNewWords(baseLex, found.keys()) : baseLex
  const toks: Tok[] = []
  let ord = 0
  let sent = 0
  paras.forEach((p, pi) => {
    const segs: Seg[] = segmentFixed(p, lex)
    for (const s of segs) {
      if (s.kind === 'punct') { if (SENT_END_RE.test(s.text)) sent++; continue }
      if (s.kind === 'space' || s.kind === 'other') continue
      if (s.kind === 'han' || s.kind === 'latin') {
        // unsure (交叉歧义) 的词不点亮: 记一个占位, 不进候选
        toks.push({ para: pi, index: s.index, text: s.unsure ? '' : s.text, latin: s.kind === 'latin', ord, sent })
      }
      ord++
    }
    sent++
  })
  return { paras, toks, N: ord, newWords: new Set(found.keys()), lex, chapters }
}

function carpenaC(pos: number[], N: number): number {
  const n = pos.length
  if (n < 3) return 0
  const d: number[] = []
  for (let i = 1; i < n; i++) d.push(pos[i] - pos[i - 1])
  d.push(N - pos[n - 1] + pos[0]) // 首尾相接
  const mean = N / n
  let v = 0
  for (const x of d) v += (x - mean) ** 2
  const sigma = Math.sqrt(v / n) / mean
  const p = n / N
  const sNor = sigma / Math.sqrt(1 - p)
  const mu = (2 * n - 1) / (2 * n + 2)
  const sd = 1 / (Math.sqrt(n) * (1 + 2.8 * n ** -0.865))
  return (sNor - mu) / sd
}

/** 分块分布熵: 全书分成 P 块, 1 − H/H_rand (越大越聚集); H_rand 用同频率随机撒点的期望近似 */
function entropyBurst(pos: number[], N: number, P = 20): number {
  const n = pos.length
  if (n < 3) return 0
  const bins = new Array(P).fill(0)
  for (const x of pos) bins[Math.min(P - 1, Math.floor((x / N) * P))]++
  let h = 0
  for (const b of bins) if (b) h -= (b / n) * Math.log(b / n)
  // 随机撒 n 个点的期望熵 (Miller–Madow 风格近似): ln(min(n,P)) − (min(n,P) − 1)/(2n)
  const k = Math.min(n, P)
  const hr = Math.log(k) - (k - 1) / (2 * n)
  if (hr <= 0) return 0
  return Math.max(0, (hr - h) / hr) * 10 // 放大到与 C 值相近的量级
}

export function effectiveMinRank(prm: Params): number {
  return prm.density <= 0.08 ? prm.minRank : Math.max(300, prm.minRank * 0.08 / prm.density)
}

export function scoreTypes(book: Book, prm: Params): Map<string, TypeInfo> {
  const { lex, toks, N } = book
  const H = zipfH(lex)
  const lnH = Math.log(H)
  const pos = new Map<string, number[]>()
  for (const t of toks) {
    if (!t.text) continue
    let a = pos.get(t.text); if (!a) pos.set(t.text, a = [])
    a.push(t.ord)
  }
  // 密度调高时放宽「太常用」的门槛, 否则 30% 档点不满 (8% 及以下保持 minRank; 30% 时约 400)
  const minI = Math.log(effectiveMinRank(prm) + 10)
  const lexTop = Math.log(lex.size + 10)
  const out = new Map<string, TypeInfo>()
  for (const [w, p] of pos) {
    const f = p.length
    const isNew = book.newWords.has(w)
    let I: number
    let eligible = true
    let common = false
    if (/^\p{Script=Han}/u.test(w)) {
      const c = lex.cost.get(w)
      if (isNew) I = lexTop
      else if (c === undefined) { I = lex.unk; eligible = false } // 未登录单字: 不点亮
      else I = c
      if (w.length < 2 && !isNew) eligible = eligible && c !== undefined && c >= Math.log(20000) && !STOP_CHARS.has(w) // 单字只点稀见字
      if (STOP.has(w) || NUM_RE.test(w)) eligible = false
      if (I < minI) eligible = false
      common = I < minI && I >= Math.log(200 + 10) && !STOP.has(w) && !NUM_RE.test(w) && w.length >= 2
    } else {
      // 西文: 没有背景词频表时, 缩写当作术语, 其余按「中等罕见」处理
      I = ACRONYM_RE.test(w) ? lexTop : Math.log(5000 + 10)
      if (w.length < 2 || LATIN_STOP.has(w.toLowerCase())) eligible = false
    }
    const Ibits = I + lnH // −ln p_bg
    const E = N * Math.exp(-Ibits)
    const G2 = f > E ? 2 * (f * Math.log(f / E) - (f - E)) : 0
    const K = Math.log(1 + G2)
    if (!eligible && common && K >= prm.kOverride) eligible = true
    const B = Math.max(0, Math.min(8, prm.burst === 'carpena' ? carpenaC(p, N) : entropyBurst(p, N)))
    const S = prm.alpha * Ibits + prm.beta * K + prm.gamma * B
    out.set(w, { word: w, f, I: Ibits, K, B, S, eligible, isNew })
  }
  return out
}

// ---------------- 选词 ----------------

interface Cand { t: Tok; s: number; strong: boolean }
interface Sentence { n: number; cands: Cand[]; para: number }

/**
 * 预先算好每个词次的分数: 第 k 次出现 (k 从 0 起) 的分数 = S(w) − decay·ln(1+k), 与阈值无关;
 * 「出现过」不论是否点亮都算 (读者已经见过它)。
 */
function sentences(book: Book, types: Map<string, TypeInfo>, prm: Params): Sentence[] {
  const { toks } = book
  const seen = new Map<string, number>()
  const out: Sentence[] = []
  let i = 0
  while (i < toks.length) {
    let j = i
    while (j < toks.length && toks[j].sent === toks[i].sent) j++
    const cands: Cand[] = []
    for (let k = i; k < j; k++) {
      const t = toks[k]
      if (!t.text) continue
      const rep = seen.get(t.text) ?? 0
      seen.set(t.text, rep + 1)
      const ty = types.get(t.text)
      if (!ty || !ty.eligible) continue
      cands.push({ t, s: ty.S - prm.decay * Math.log(1 + rep), strong: rep === 0 })
    }
    cands.sort((a, b) => b.s - a.s)
    out.push({ n: j - i, cands, para: toks[i].para })
    i = j
  }
  return out
}

/** 给定阈值做一遍选择: 句内上限、不相邻、一段里同一个词至多 perParaType 次 */
function selectWith(sents: Sentence[], prm: Params, theta: number): Picked[] {
  const out: Picked[] = []
  const lastOrdByPara = new Map<number, number>()
  const perPara = new Map<string, number>()
  for (const { n, cands } of sents) {
    const cap = Math.max(1, Math.ceil(n * prm.density * prm.sentenceFactor))
    const taken: Cand[] = []
    for (const c of cands) {
      if (c.s < theta || taken.length >= cap) break
      if (taken.some(x => Math.abs(x.t.ord - c.t.ord) < 2)) continue
      const lo = lastOrdByPara.get(c.t.para)
      if (lo !== undefined && Math.abs(lo - c.t.ord) < 2) continue
      const pk = c.t.para + '|' + c.t.text
      if ((perPara.get(pk) ?? 0) >= prm.perParaType) continue
      perPara.set(pk, (perPara.get(pk) ?? 0) + 1)
      taken.push(c)
    }
    taken.sort((a, b) => a.t.ord - b.t.ord)
    for (const c of taken) {
      out.push({ para: c.t.para, index: c.t.index, len: c.t.text.length, strong: c.strong, word: c.t.text, score: c.s })
      lastOrdByPara.set(c.t.para, c.t.ord)
    }
  }
  return out
}

/** 二分阈值, 让每章点亮的词数 ≈ density × 本章词数 (阈值按章定: 一章内同一个词标准一致) */
export function selectBook(book: Book, types: Map<string, TypeInfo>, prm: Params): Picked[] {
  const sents = sentences(book, types, prm)
  const ch = book.chapters.length ? book.chapters : [0]
  const chapOf = (para: number) => { let k = 0; while (k + 1 < ch.length && ch[k + 1] <= para) k++; return k }
  const groups: Sentence[][] = ch.map(() => [])
  for (const s of sents) groups[chapOf(s.para)].push(s)
  const out: Picked[] = []
  for (const g of groups) {
    if (!g.length) continue
    const target = prm.density * g.reduce((a, s) => a + s.n, 0)
    let lo = -50, hi = 80
    let best: Picked[] | null = null
    for (let it = 0; it < 16; it++) {
      const mid = (lo + hi) / 2
      const r = selectWith(g, prm, mid)
      if (r.length > target) lo = mid
      else { hi = mid; best = r }
    }
    out.push(...(best ?? selectWith(g, prm, hi)))
  }
  return out
}

export function highlight(paras: string[], baseLex: ZhLexicon, prm: Params = DEFAULTS) {
  const book = prepareBook(paras, baseLex, prm.newWords)
  const types = scoreTypes(book, prm)
  const picked = selectBook(book, types, prm)
  return { book, types, picked }
}
