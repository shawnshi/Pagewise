/**
 * 仿生阅读 (实验, 默认关) 的区间计算, 纯函数 (docs/reading-modes.md §3.3 §5.6)。
 *
 * - 西文「词首强调」: 不加粗 (::highlight 不能改字重, 改字重也会重排), 而是词首约 40% 的字母保持正文色,
 *   其余字母降到正文色的 70% (对比度样式)。这里只返回要降色的「词尾」区间。
 * - 中文「分词交替着色」(调研见 docs/research/zh-segmentation-for-word-guide.md):
 *   有词表时按词表切分 (zhSegment.segmentZh: DAG 最短路径, 不猜新词), 跨词歧义的地方不上色;
 *   词表还没下载下来时回退到 Intl.Segmenter + 三四字常用词合并表。
 *   只给 ≥2 字的词着色, 相邻着色词在正文色 / 混合色之间交替 (这里只返回混合色那一半);
 *   单字、数字、标点、夹在中文里的西文词都保持原样, 也不占交替序号。交替序号每段从头开始 (同一段结果固定, 可缓存)。
 *   日文、韩文 (书的语言或文本里有假名、谚文) 仍走 ICU。
 *
 * 研究显示这两种做法都不能让大多数人读得更快 (reading-modes.md §2.2), 界面上如实说明。
 */
import { segmentZh, segmentZhIcu, type Seg, type ZhLexicon } from './zhSegment.ts'
import { ZH_MERGE_LIST } from './zhMergeWords.ts'

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const HAN_RE = /\p{Script=Han}/u
const HAN_G_RE = /\p{Script=Han}/gu
const KANA_HANGUL_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LATIN_LETTER_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u
const LATIN_LETTER_G_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/gu

/**
 * 词表下载完之前的回退合并表: 2,617 个三四字常用词 (jieba 词典 ∩ DeepSeek-R1 词元), 由 scripts/build-zh-lexicon.mjs 生成。
 * ICU 常把「图书馆」「新能源」「公交车」切开, 相邻片段拼起来正好是表里的词就合并。
 */
export const ZH_MERGE_WORDS: ReadonlySet<string> = new Set(ZH_MERGE_LIST.split(' '))

/** 词首保留几个字母 (参照常见注视长度表): 1–3 个字母保留 1 个, 更长的保留约 40% */
export function headLength(letters: number): number {
  if (letters <= 0) return 0
  if (letters <= 3) return 1
  return Math.ceil(letters * 0.4)
}

const segCache = new Map<string, Intl.Segmenter | null>()
function segmenter(lang: string, granularity: 'word' | 'grapheme'): Intl.Segmenter | null {
  const key = `${granularity}|${lang}`
  let s = segCache.get(key)
  if (s === undefined) {
    try { s = new Intl.Segmenter(lang || 'zh', { granularity }) } catch { s = null }
    segCache.set(key, s)
  }
  return s
}

/** 西文词 (偏移 base 处的字符串) 的词尾区间: 词首 headLength 个字素之后到词尾 */
function tailOf(word: string, base: number, graph: Intl.Segmenter | null): [number, number] | null {
  const gs = graph ? Array.from(graph.segment(word), g => ({ i: g.index, s: g.segment })) : Array.from(word, (s, i) => ({ i, s }))
  const letterIdx = gs.filter(g => /[\p{L}\p{N}]/u.test(g.s))
  if (letterIdx.length < 2) return null
  const head = headLength(letterIdx.length)
  if (head >= letterIdx.length) return null
  const cut = letterIdx[head].i
  return [base + cut, base + word.length]
}

export interface GuideSpans {
  /** 中文着色词 (混合色那一半) */
  alt: Array<[number, number]>
  /** 西文词尾 (降到 70%) */
  tail: Array<[number, number]>
}

export interface GuideOptions {
  style?: 'auto' | 'alternate' | 'fixation'
  /** 回退用的合并表 (默认 ZH_MERGE_WORDS) */
  merge?: ReadonlySet<string>
  /** 中文词表: 有就按词表切分并做歧义检查, 没有 (还在下载 / 下载失败) 就用 ICU + 合并表 */
  lexicon?: ZhLexicon | null
  /** 交替序号的起点 (默认 0: 每段从头开始); 返回值 parity 为下一次的起点 */
  parityStart?: number
}

/** 日文 / 韩文: 中文词表不适用, 仍按 ICU 分词 */
function isJaKo(lang: string, text: string): boolean {
  return /^(ja|ko)\b/i.test(lang) || KANA_HANGUL_RE.test(text)
}

/** 至少两个字 (一个扩展区汉字占两个 UTF-16 下标, 仍算一个字) */
function multiChar(t: string): boolean {
  return t.length > 2 || (t.length === 2 && (t.charCodeAt(0) & 0xfc00) !== 0xd800)
}

/** 这段文字要不要用中文词表 (有汉字、不是日文 / 韩文) */
export function usesZhLexicon(text: string, lang = 'zh'): boolean {
  return HAN_RE.test(text) && !isJaKo(lang, text)
}

/** 中文段落: 按词表 (或回退) 切分后着色 */
function chineseSpans(text: string, lang: string, style: 'auto' | 'alternate' | 'fixation', opts: GuideOptions, parity: number) {
  const out: GuideSpans = { alt: [], tail: [] }
  const segs: Seg[] = opts.lexicon
    ? segmentZh(text, opts.lexicon)
    : segmentZhIcu(text, opts.merge ?? ZH_MERGE_WORDS, segmenter(lang || 'zh', 'word'))
  // 西文词尾淡化只在西文为主的段落里做; 夹在中文里的西文词整体保持原样
  const latinTails = style === 'fixation'
    || (style === 'auto' && (text.match(LATIN_LETTER_G_RE)?.length ?? 0) > (text.match(HAN_G_RE)?.length ?? 0))
  const graph = latinTails ? segmenter(lang, 'grapheme') : null
  for (const s of segs) {
    if (s.kind === 'han') {
      if (style === 'fixation' || s.unsure || !multiChar(s.text)) continue
      if (parity % 2 === 1) out.alt.push([s.index, s.index + s.text.length])
      parity++
    } else if (s.kind === 'latin' && latinTails) {
      const tail = tailOf(s.text, s.index, graph)
      if (tail) out.tail.push(tail)
    }
  }
  return { ...out, parity }
}

/** 西文、日文、韩文段落: ICU 分词 (日韩文着色时仍用合并表做最长匹配) */
function icuSpans(text: string, lang: string, style: 'auto' | 'alternate' | 'fixation', merge: ReadonlySet<string>, parity: number) {
  const out: GuideSpans = { alt: [], tail: [] }
  const word = segmenter(lang, 'word')
  const graph = segmenter(lang, 'grapheme')
  if (!word) return { ...out, parity }
  const segs = Array.from(word.segment(text), s => ({ index: s.index, segment: s.segment, isWordLike: !!s.isWordLike }))
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg.isWordLike) continue
    if (CJK_RE.test(seg.segment)) {
      if (style === 'fixation') continue
      let str = seg.segment
      let best = i
      let acc = seg.segment
      for (let j = i + 1; j < segs.length && j <= i + 3; j++) {
        if (!segs[j].isWordLike || !CJK_RE.test(segs[j].segment)) break
        acc += segs[j].segment
        if ([...acc].length > 7) break
        if (merge.has(acc)) {
          best = j
          str = acc
        }
      }
      i = best
      if ([...str].length < 2) continue
      if (parity % 2 === 1) out.alt.push([seg.index, seg.index + str.length])
      parity++
    } else if (LATIN_LETTER_RE.test(seg.segment)) {
      if (style === 'alternate') continue
      const tail = tailOf(seg.segment, seg.index, graph)
      if (tail) out.tail.push(tail)
    }
  }
  return { ...out, parity }
}

/**
 * 计算一段文本 (一个段落) 的着色区间。style: auto 按每个片段的文字类型选规则; alternate 只做中文; fixation 只做西文。
 * 结果只取决于 (文本, 语言, 样式, 是否有词表), 调用方可按段落缓存。
 */
export function guideSpans(text: string, lang = 'zh', opts: GuideOptions = {}): GuideSpans & { parity: number } {
  const style = opts.style ?? 'auto'
  const parity = opts.parityStart ?? 0
  if (usesZhLexicon(text, lang)) return chineseSpans(text, lang, style, opts, parity)
  return icuSpans(text, lang, style, opts.merge ?? ZH_MERGE_WORDS, parity)
}
