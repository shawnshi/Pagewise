/**
 * 「重点词」的绘制层 (DOM): 和按词着色一样只用 CSS Custom Highlight, 不改 DOM、不重排、不影响 CFI。
 * 一节一层: 整节的段落交给 KeyWordService 选词 (Worker 里算, 阈值按整章定), 结果缓存在层里;
 * 绘制时只为可见范围前后一段 (约 2000 + 4000 字) 生成 Range, 翻页 / 滚动后按需补画。
 *
 * 高亮名: lr-wg-kw-s (全书第一次出现, 强: 着色 + 浅底) / lr-wg-kw-w (之后, 弱: 只着色)。
 * 用 lr-wg- 前缀, 与按词着色共用清理; 样式由 readerTheme.getReaderCSS 静态注入 (颜色、明显程度随基础版设置)。
 */
import { SectionText, upperBound } from './blocks.ts'
import type { KwLevel } from './keyWords.ts'
import type { KeyWordService, KwBookHost } from './keyWordsClient.ts'
import { sectionParagraphs } from './keyWordsClient.ts'
import { clearReadingModeMarks, supportsHighlights } from './revealLayer.ts'

export const HL_KW_STRONG = 'lr-wg-kw-s'
export const HL_KW_WEAK = 'lr-wg-kw-w'
const PREFIX = 'lr-wg-kw-'

const BEFORE = 2000
const AFTER = 4000

/** 智能版: 本节的 AI 词与分块 (块的起点与这块有没有 AI 结果) */
export interface KwSmartInput {
  words: Array<[string, number, number]>
  chunks: Array<{ node: Node; offset: number; ai: boolean }>
}

export interface KeyWordLayerParams {
  level: KwLevel
  spoilerSafe: boolean
  smart: KwSmartInput | null
}

export interface KeyWordLayerOptions {
  section: number
  service: KeyWordService
  host: KwBookHost
  params: () => KeyWordLayerParams
  /** 选词结果到了 (统计用): 本节有 AI 结果的块数 / 总块数 */
  onPicked?: (info: { section: number; aiChunks: number; chunks: number; ms: number }) => void
}

/** 便宜的字符串 hash (只用于判断请求有没有变) */
function sig(s: string): string {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36) + ':' + s.length
}

export class KeyWordLayer {
  readonly doc: Document
  readonly section: number
  #opts: KeyWordLayerOptions
  #text: SectionText
  #cuts: number[] = []
  #paras: string[] = []
  #strong: any
  #weak: any
  #reg: any
  /** 选词结果 (按段、段内起点排序) */
  #picks: Int32Array | null = null
  #reqSig = ''
  #from = -1
  #to = -1
  #visible: Range | null = null
  #disposed = false
  #unsub: () => void

  static create(doc: Document, opts: KeyWordLayerOptions): KeyWordLayer | null {
    const win = doc?.defaultView as any
    if (!doc?.body || !supportsHighlights(win)) return null
    return new KeyWordLayer(doc, win, opts)
  }

  private constructor(doc: Document, win: any, opts: KeyWordLayerOptions) {
    this.doc = doc
    this.section = opts.section
    this.#opts = opts
    this.#text = new SectionText(doc)
    const { cuts, paras } = sectionParagraphs(this.#text)
    this.#cuts = cuts
    this.#paras = paras
    this.#reg = win.CSS.highlights
    this.#strong = new win.Highlight()
    this.#weak = new win.Highlight()
    try {
      this.#strong.priority = 5
      this.#weak.priority = 5
    } catch { /* 旧实现无 priority */ }
    this.#register()
    this.#unsub = opts.service.onChange(() => this.refresh())
    this.refresh()
  }

  #register() {
    if (this.#reg.get(HL_KW_STRONG) !== this.#strong) this.#reg.set(HL_KW_STRONG, this.#strong)
    if (this.#reg.get(HL_KW_WEAK) !== this.#weak) this.#reg.set(HL_KW_WEAK, this.#weak)
  }

  /** 各段是否落在已有 AI 结果的块里 */
  #aiMask(smart: KwSmartInput): Uint8Array {
    const mask = new Uint8Array(this.#paras.length)
    const starts = smart.chunks
      .map(c => ({ at: this.#text.offsetOf(c.node, c.offset), ai: c.ai }))
      .sort((a, b) => a.at - b.at)
    if (!starts.length) return mask
    for (let p = 0; p < this.#paras.length; p++) {
      // 段的中点所在的块
      const mid = (this.#cuts[p] + this.#cuts[p + 1]) >> 1
      let k = -1
      for (let i = 0; i < starts.length && starts[i].at <= mid; i++) k = i
      if (k >= 0 && starts[k].ai) mask[p] = 1
    }
    return mask
  }

  /** 参数、AI 结果或全书统计变了: 重新取词 (请求没变就不动) */
  refresh() {
    if (this.#disposed) return
    const prm = this.#opts.params()
    const mask = prm.smart ? this.#aiMask(prm.smart) : null
    const words = prm.smart?.words ?? []
    const key = sig(`${prm.level}|${prm.spoilerSafe ? 1 : 0}|${this.#opts.service.version}|${mask ? mask.join('') : '-'}|${words.map(w => w.join(',')).join(';')}`)
    if (key === this.#reqSig) return
    this.#reqSig = key
    const t0 = Date.now()
    this.#opts.service.pick({
      section: this.section,
      paras: this.#paras,
      level: prm.level,
      spoilerSafe: prm.spoilerSafe,
      smart: prm.smart && mask ? { words, aiParas: Array.from(mask) } : null,
    }, this.#opts.host).then(picks => {
      if (this.#disposed || key !== this.#reqSig) return
      this.#picks = picks
      this.#from = this.#to = -1
      this.update(this.#visible)
      if (mask) {
        let chunks = 0
        let ai = 0
        for (const c of prm.smart!.chunks) { chunks++; if (c.ai) ai++ }
        this.#opts.onPicked?.({ section: this.section, aiChunks: ai, chunks, ms: Date.now() - t0 })
      } else this.#opts.onPicked?.({ section: this.section, aiChunks: 0, chunks: 0, ms: Date.now() - t0 })
    }).catch(e => {
      if (!this.#disposed) console.warn('key words pick failed', e)
    })
  }

  /** 可见范围变化 (relocate); 已画过的范围内不重画 */
  update(visible: Range | null) {
    if (this.#disposed) return
    this.#visible = visible
    const text = this.#text
    const len = text.length
    if (!len || !this.#picks) return
    let vs = 0
    let ve = Math.min(len, AFTER)
    if (visible && visible.startContainer?.ownerDocument === this.doc) {
      vs = text.offsetOf(visible.startContainer, visible.startOffset)
      ve = Math.max(vs, text.offsetOf(visible.endContainer, visible.endOffset))
    }
    if (this.#from >= 0 && vs >= this.#from + (this.#from > 0 ? 500 : 0) && ve <= this.#to - (this.#to < len ? 500 : 0)) return
    const from = vs > BEFORE ? text.breakBefore(vs - BEFORE) : 0
    const to = text.breakAtOrAfter(Math.min(len, ve + AFTER))
    this.#paint(from, Math.max(from, to))
  }

  #paint(from: number, to: number) {
    const picks = this.#picks!
    const text = this.#text
    this.#register()
    this.#strong.clear()
    this.#weak.clear()
    const firstPara = Math.max(0, upperBound(this.#cuts, from) - 1)
    for (let i = 0; i < picks.length; i += 4) {
      const p = picks[i]
      if (p < firstPara) continue
      const base = this.#cuts[p]
      if (base === undefined || base >= to) break
      const a = base + picks[i + 1]
      const b = a + picks[i + 2]
      if (b <= from) continue
      const r = text.range(a, b)
      if (!r || r.collapsed) continue
      ;(picks[i + 3] & 1 ? this.#strong : this.#weak).add(r)
    }
    this.#from = from
    this.#to = to
  }

  dispose() {
    this.#disposed = true
    this.#visible = null
    this.#unsub()
    try {
      this.#strong.clear()
      this.#weak.clear()
    } catch { /* 文档已卸载 */ }
    clearReadingModeMarks(this.doc, [PREFIX])
  }
}

/** 文档里的中文是否占多数 (决定「重点词」能不能用): 汉字占字母的 30% 以上且没有假名 / 谚文 */
export function looksChinese(doc: Document, lang = ''): boolean {
  if (/^(ja|ko)\b/i.test(lang)) return false
  const sample = (doc.body?.textContent ?? '').slice(0, 6000)
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sample)) return false
  const han = sample.match(/\p{Script=Han}/gu)?.length ?? 0
  const latin = sample.match(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/gu)?.length ?? 0
  if (han + latin < 20) return /^zh\b/i.test(lang)
  return han >= 0.3 * (han + latin)
}
