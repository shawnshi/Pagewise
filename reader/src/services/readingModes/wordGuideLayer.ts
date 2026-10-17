/**
 * 仿生阅读的绘制层 (DOM): 只用 CSS Custom Highlight, 不改 DOM、不重排、不影响 CFI。
 * 只为可见范围前后一段文本 (约 2000 + 4000 字, 段落边界截断) 生成 Range, 翻页 / 滚动后按需补算;
 * 按段落分别分词 (交替序号每段从头开始), 避免把相邻两段的字拼成一个词; 段落结果按文本缓存。
 * 不支持 Highlight API 的旧 WebView 不提供这个模式。
 *
 * 中文词表在第一次遇到中文段落时才下载 (zhLexicon.ts); 下载完之前用 ICU + 合并表着色,
 * 下载完后每一层重绘一次 (只一次, 不循环)。
 *
 * 高亮名: lr-wg-alt-l / lr-wg-alt-n (中文交替着色, 轻 / 标准), lr-wg-tail (西文词尾降到 70%);
 * 样式由 readerTheme.getReaderCSS 静态注入, 优先级低于打字机、歌词与点睛阅读。
 */
import { SectionText } from './blocks.ts'
import { guideSpans, usesZhLexicon, type GuideSpans } from './wordGuide.ts'
import { loadZhLexicon, zhLexicon } from './zhLexicon.ts'
import { clearReadingModeMarks, supportsHighlights } from './revealLayer.ts'

export const HL_WG_ALT_LIGHT = 'lr-wg-alt-l'
export const HL_WG_ALT_NORMAL = 'lr-wg-alt-n'
export const HL_WG_TAIL = 'lr-wg-tail'
export const WORD_GUIDE_PREFIX = 'lr-wg-'

const BEFORE = 2000
const AFTER = 4000

/** 段落结果缓存 (键: 有无词表 / 样式 / 语言 / 段落文本), 翻页和重排时不重算 */
const CACHE_MAX = 2000
const spanCache = new Map<string, GuideSpans>()
function cachedSpans(str: string, lang: string, style: WordGuideOptions['style']): GuideSpans {
  const lexicon = zhLexicon()
  const key = `${lexicon ? 'L' : 'I'}|${style}|${lang}|${str}`
  let hit = spanCache.get(key)
  if (hit) {
    spanCache.delete(key)
    spanCache.set(key, hit)
    return hit
  }
  const { alt, tail } = guideSpans(str, lang, { style, lexicon })
  hit = { alt, tail }
  spanCache.set(key, hit)
  if (spanCache.size > CACHE_MAX) spanCache.delete(spanCache.keys().next().value!)
  return hit
}

export interface WordGuideOptions {
  style: 'auto' | 'alternate' | 'fixation'
  strength: 'light' | 'normal'
  lang: string
}

export class WordGuideLayer {
  readonly doc: Document
  #text: SectionText
  #opts: WordGuideOptions
  #alt: any
  #tail: any
  #reg: any
  #from = -1
  #to = -1
  #visible: Range | null = null
  #disposed = false
  /** 已为词表下载挂过一次重绘 */
  #awaitingLexicon = false

  /** 不支持 Highlight API 时返回 null */
  static create(doc: Document, opts: WordGuideOptions): WordGuideLayer | null {
    const win = doc?.defaultView as any
    if (!doc?.body || !supportsHighlights(win)) return null
    return new WordGuideLayer(doc, win, opts)
  }

  private constructor(doc: Document, win: any, opts: WordGuideOptions) {
    this.doc = doc
    this.#text = new SectionText(doc)
    this.#opts = { ...opts }
    this.#reg = win.CSS.highlights
    this.#alt = new win.Highlight()
    this.#tail = new win.Highlight()
    try {
      this.#alt.priority = 5
      this.#tail.priority = 5
    } catch { /* 旧实现无 priority */ }
    this.#register()
  }

  #register() {
    const altName = this.#opts.strength === 'normal' ? HL_WG_ALT_NORMAL : HL_WG_ALT_LIGHT
    const other = altName === HL_WG_ALT_NORMAL ? HL_WG_ALT_LIGHT : HL_WG_ALT_NORMAL
    if (this.#reg.get(other) === this.#alt) this.#reg.delete(other)
    if (this.#reg.get(altName) !== this.#alt) this.#reg.set(altName, this.#alt)
    if (this.#reg.get(HL_WG_TAIL) !== this.#tail) this.#reg.set(HL_WG_TAIL, this.#tail)
  }

  setOptions(opts: Partial<WordGuideOptions>) {
    const prev = this.#opts
    this.#opts = { ...prev, ...opts }
    this.#register()
    if (opts.style && opts.style !== prev.style || opts.lang && opts.lang !== prev.lang) {
      this.#from = this.#to = -1
    }
  }

  /** 可见范围变化 (relocate); 已覆盖的范围内不重算 */
  update(visible: Range | null) {
    if (this.#disposed) return
    this.#visible = visible
    const text = this.#text
    const len = text.length
    if (!len) return
    let vs = 0
    let ve = Math.min(len, AFTER)
    if (visible && visible.startContainer?.ownerDocument === this.doc) {
      vs = text.offsetOf(visible.startContainer, visible.startOffset)
      ve = Math.max(vs, text.offsetOf(visible.endContainer, visible.endOffset))
    }
    // 可见范围仍在已着色区间的安全区内: 不动
    if (this.#from >= 0 && vs >= this.#from + (this.#from > 0 ? 500 : 0) && ve <= this.#to - (this.#to < len ? 500 : 0)) return
    const from = vs > BEFORE ? text.breakBefore(vs - BEFORE) : 0
    const to = text.breakAtOrAfter(Math.min(len, ve + AFTER))
    this.#paint(from, Math.max(from, to))
  }

  #paint(from: number, to: number) {
    const text = this.#text
    const { lang, style } = this.#opts
    this.#alt.clear()
    this.#tail.clear()
    let wantsLexicon = false
    // 按段落分别分词, 交替序号每段从头开始
    const cuts = [from, ...text.breaks.filter(b => b > from && b < to), to]
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]
      const b = cuts[i + 1]
      if (b <= a) continue
      const str = text.slice(a, b)
      if (!str.trim()) continue
      if (!wantsLexicon && style !== 'fixation' && usesZhLexicon(str, lang)) wantsLexicon = true
      const res = cachedSpans(str, lang, style)
      for (const [s, e] of res.alt) {
        const r = text.range(a + s, a + e)
        if (r && !r.collapsed) this.#alt.add(r)
      }
      for (const [s, e] of res.tail) {
        const r = text.range(a + s, a + e)
        if (r && !r.collapsed) this.#tail.add(r)
      }
    }
    this.#from = from
    this.#to = to
    if (wantsLexicon && !zhLexicon()) this.#whenLexiconReady()
  }

  /** 词表下载完后重绘一次 (下载失败就保持 ICU 结果; 之后翻页时会再试) */
  #whenLexiconReady() {
    if (this.#awaitingLexicon) return
    this.#awaitingLexicon = true
    loadZhLexicon().then(lex => {
      this.#awaitingLexicon = false
      if (!lex || this.#disposed) return
      this.#from = this.#to = -1
      try {
        this.update(this.#visible)
      } catch (e) {
        console.warn('word guide repaint failed', e)
      }
    })
  }

  dispose() {
    this.#disposed = true
    this.#visible = null
    try {
      this.#alt.clear()
      this.#tail.clear()
    } catch { /* 文档已卸载 */ }
    clearReadingModeMarks(this.doc, [WORD_GUIDE_PREFIX])
  }
}
