/**
 * 评测底座: 把「候选词集合 + 分数」变成按点亮规则选出的词次, 并计算指标。
 * 统计算法直接复用 docs/research/prototypes/keyHighlight.ts (V3)。
 * LLM 给的词作为「强制词」: 先在段落里精确定位 (长词优先, 不重叠), 缺口再按词表切分。
 */
import { readFileSync } from 'node:fs'
import { parseZhLexicon, segmentZh, type Seg, type ZhLexicon } from '../../../../src/services/readingModes/zhSegment.ts'
import { DEFAULTS, discoverNewWords, withNewWords, scoreTypes, selectBook, type Book, type Tok, type TypeInfo, type Params, type Picked } from '../keyHighlight.ts'

export const LEX: ZhLexicon = parseZhLexicon(readFileSync(new URL('../../../../src/data/zh-lexicon.txt', import.meta.url), 'utf8'))
export { DEFAULTS, scoreTypes, selectBook }
export type { Book, TypeInfo, Picked, Params }

const SENT_END_RE = /[。！？；!?;…]/
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
    out.push({ ...s, index: base + s.index })
  }
  return out
}

/** LLM 词的简单规范化: NFKC、去书名号引号、去中西文之间的空格 */
export function normTerm(w: string): string {
  let s = w.normalize('NFKC').replace(/[《》〈〉“”‘’「」『』"'（）()【】\[\]]/g, '').trim()
  s = s.replace(/(?<=\p{Script=Han})\s+(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])\s+(?=\p{Script=Han})/gu, '')
  s = s.replace(/[，。、；：！？,.;:!?]+$/u, '')
  return s
}

/** 在段落里定位强制词: 长词优先、先到先得、不重叠 */
function forcedSpans(p: string, forcedSorted: string[]): Array<[number, number]> {
  const taken = new Uint8Array(p.length)
  const spans: Array<[number, number]> = []
  for (const w of forcedSorted) {
    let i = p.indexOf(w)
    while (i >= 0) {
      let free = true
      for (let k = i; k < i + w.length; k++) if (taken[k]) { free = false; break }
      if (free) { for (let k = i; k < i + w.length; k++) taken[k] = 1; spans.push([i, i + w.length]) }
      i = p.indexOf(w, i + 1)
    }
  }
  return spans.sort((a, b) => a[0] - b[0])
}

export function prepare(paras: string[], chapters: number[], forced: Iterable<string> = [], newWords = true): Book {
  const found = newWords ? discoverNewWords(paras, LEX) : new Map<string, number>()
  const forcedSet = new Set([...forced].filter(w => w.length >= 2))
  const lex = withNewWords(LEX, [...found.keys()].filter(w => !forcedSet.has(w)))
  const forcedSorted = [...forcedSet].sort((a, b) => b.length - a.length)
  const toks: Tok[] = []
  let ord = 0, sent = 0
  const push = (segs: Seg[], pi: number) => {
    for (const s of segs) {
      if (s.kind === 'punct') { if (SENT_END_RE.test(s.text)) sent++; continue }
      if (s.kind === 'space' || s.kind === 'other') continue
      if (s.kind === 'han' || s.kind === 'latin') toks.push({ para: pi, index: s.index, text: s.unsure ? '' : s.text, latin: s.kind === 'latin', ord, sent })
      ord++
    }
  }
  paras.forEach((p, pi) => {
    const spans = forcedSorted.length ? forcedSpans(p, forcedSorted) : []
    let at = 0
    for (const [a, b] of spans) {
      if (a > at) push(segmentFixed(p.slice(at, a), lex, at), pi)
      toks.push({ para: pi, index: a, text: p.slice(a, b), latin: false, ord, sent }); ord++
      at = b
    }
    if (at < p.length) push(segmentFixed(p.slice(at), lex, at), pi)
    sent++
  })
  const nw = new Set([...found.keys(), ...forcedSet])
  const book: any = { paras, toks, N: ord, newWords: nw, lex, chapters }
  book.found = new Set([...found.keys()].filter(w => !forcedSet.has(w)))
  return book
}

export type Labels = Map<string, number>

export function rankTypes(types: Map<string, TypeInfo>): string[] {
  return [...types.values()].filter(x => x.eligible && /[\p{Script=Han}A-Za-z]/u.test(x.word)).sort((a, b) => b.S - a.S).map(x => x.word)
}

export function metrics(book: Book, types: Map<string, TypeInfo>, picked: Picked[], lab: Labels, oldGold: string[] = []) {
  const top = rankTypes(types).slice(0, 50)
  const L = (w: string) => lab.get(w)
  const p50 = top.filter(w => (L(w) ?? 0) >= 1).length / 50
  const p50s = top.filter(w => L(w) === 2).length / 50
  const lit = picked
  const judged = lit.filter(p => L(p.word) !== undefined)
  const hit = lit.filter(p => (L(p.word) ?? 0) >= 1).length / Math.max(1, lit.length)
  const hitS = lit.filter(p => L(p.word) === 2).length / Math.max(1, lit.length)
  const litTypes = new Set(lit.map(p => p.word))
  const typeP = [...litTypes].filter(w => (L(w) ?? 0) >= 1).length / Math.max(1, litTypes.size)
  const present = new Set(book.toks.map(t => t.text))
  // 召回: 核心词 (判 2 且在文中出现) 至少点亮一次 — 只看「在文中能被定位成一个词」的子串: 用正文包含判断
  const fullText = book.paras.join('\n')
  const core = [...lab].filter(([w, v]) => v === 2 && fullText.includes(w)).map(([w]) => w)
  const rec = core.filter(w => litTypes.has(w)).length / Math.max(1, core.length)
  // recK: 反复出现 (≥3 次) 的正例词 (标注 ≥1) 至少点亮一次的比例
  const keyRec = [...lab].filter(([w, v]) => v >= 1 && countOcc(fullText, w) >= 3).map(([w]) => w)
  const litArr = [...litTypes].filter(t => t.length >= 2)
  const recK = keyRec.filter(w => litTypes.has(w) || litArr.some(t => t.length > w.length && t.includes(w))).length / Math.max(1, keyRec.length)
  const oldP50 = top.filter(w => oldGold.includes(w)).length / 50
  const oldHit = lit.filter(p => oldGold.includes(p.word)).length / Math.max(1, lit.length)
  const oldRec = oldGold.filter(w => litTypes.has(w)).length / Math.max(1, oldGold.length)
  return { p50, p50s, hit, hitS, typeP, rec, recK, nKey: keyRec.length, dens: lit.length / book.N, lit: lit.length, litTypes: litTypes.size, unjudged: lit.length - judged.length, unjudgedTop: top.filter(w => L(w) === undefined).length, oldP50, oldHit, oldRec, nCore: core.length, top: top.slice(0, 25), present: present.size }
}

const occCache = new Map<string, number>()
function countOcc(text: string, w: string): number {
  const k = text.length + '|' + w
  let n = occCache.get(k)
  if (n === undefined) { n = 0; for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) n++; occCache.set(k, n) }
  return n
}

export function loadLabels(path: string): Labels {
  try { return new Map(Object.entries(JSON.parse(readFileSync(path, 'utf8')))) } catch { return new Map() }
}
