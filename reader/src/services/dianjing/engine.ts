/**
 * 点睛阅读引擎 (docs/dianjing-reading.md §6.1 流水线):
 * 章节加载 → 文本模型 (段/句, 与听书同编号) → 分块 → 查缓存 → 未命中排队 (当前块优先, 并发 2–3)
 * → 流式请求 → 逐行校验 / 锚定 → 绘制 → 写缓存 → 章内完成后汇总要义。
 *
 * 不依赖 Vue: 宿主 (useDianjing) 提供 DjHost, 引擎通过 onChange 通知界面刷新。
 */
import { chunkIndexForBlock, chunkSection, hashText, requestOrder, type Chunk } from './chunker.ts'
import { DjError, streamDianjing, type DjChannel } from './client.ts'
import { cacheKey, feedbackKey, getDjCache, sectionKey, type ChunkRecord, type DjCache, type FeedbackRecord, type SectionSummary } from './cache.ts'
import { decideFiction, fictionFromMeta, fictionFromText, type FictionVerdict } from './fiction.ts'
import { createDjLayer, hitTest, type DjLayer, type HitTarget } from './layer.ts'
import { DJ_FALLBACK_MODEL, DJ_MODEL, LEGACY_PROMPT_VERSIONS, PROMPT_VERSION } from './prompt.ts'
import {
  isDjItem,
  keyWordsUsable,
  resolveItem,
  wantsKeyWords,
  selectKeys,
  selectTerms,
  type Density,
  type DjItem,
  type KeyItem,
  type NoteItem,
  type PointItem,
  type RawItem,
  type TermItem,
  type TrItem,
  type GistItem,
} from './protocol.ts'
import { noteKeyWordChunk } from '../usageCounters.ts'
import { SectionTextModel } from './textModel.ts'
import type { DjColors } from './theme.ts'

export type DjStatus = 'idle' | 'consent' | 'loading' | 'ready' | 'quota' | 'error' | 'offline' | 'unsupported'

export interface DjKinds { key: boolean; term: boolean; note: boolean }

export interface DjBookInfo {
  title?: string
  author?: string
  /** 书的语言 (BCP47) */
  language?: string
  subjects?: string[]
  tags?: string[]
}

export interface DjHost {
  bookId: string
  book(): DjBookInfo
  /** 界面语言 */
  uiLang(): 'zh' | 'en'
  chapterTitle(section: number): string
  /** 节数与是否线性 (非线性节如注释页不预取) */
  sectionCount(): number
  sectionLinear(section: number): boolean
  /** 未渲染的分节文档 (预取下一章); 不可用返回 null */
  sectionDoc(section: number): Promise<Document | null>
  /** 当前通道; null 表示未配置 */
  channel(): DjChannel | null
  density(): Density
  kinds(): DjKinds
  fictionOverride(): 'fiction' | 'nonfiction' | null
  colors(): DjColors
  getOverlayer(section: number): any
  concurrency(): number
  /** 墨水屏 / 减少动效: 标记攒到下次翻页再画 */
  batchPaint(): boolean
  onChange(): void
  /** 重点词 (AI 结果) 变了: 某一节有块完成 / 从缓存补齐, 或全书词表变了 */
  onKeyWords?(section: number | null): void
}

export interface DjPosition { section: number; block: number; sentence: number }

export interface ChunkState {
  chunk: Chunk
  status: 'idle' | 'queued' | 'loading' | 'done' | 'error'
  items: DjItem[]
  model?: string
  error?: DjError
  failedAt?: number
  /** 这一块的 AI 重点词可用 (否则这一块用离线结果) */
  kw?: boolean
}

export interface SectionState {
  index: number
  model: SectionTextModel
  chunks: ChunkState[]
  /** 已渲染 (foliate iframe) 的文档才有绘制层 */
  layer?: DjLayer
  rendered: boolean
  totalChars: number
  summary?: SectionSummary
  summaryLoading?: boolean
}

export interface VisibleMarks {
  keys: KeyItem[]
  terms: TermItem[]
  notes: NoteItem[]
}

export interface CardTarget {
  kind: 'term' | 'note' | 'key'
  section: number
  item: TermItem | NoteItem | KeyItem
  range: Range
  /** key: 原句; 其他: 词条 */
  text: string
  /** key: 译文 (书是外语时) */
  translation?: string
}

const RETRY_ERROR_MS = 30_000
const MIN_SECTION_CHARS = 40

export class DianjingEngine {
  readonly host: DjHost
  readonly cache: DjCache
  sections = new Map<number, SectionState>()
  status: DjStatus = 'idle'
  error: DjError | null = null
  remaining: number | undefined
  active = false
  /** 读者当前位置 (防剧透与预取) */
  position: DjPosition | null = null
  /** 速读视图: 要句加底色 */
  band = false
  dismissed = new Set<string>()
  adopted = new Set<string>()
  fiction = false
  fictionSource: 'user' | 'meta' | 'text' | 'model' | 'default' = 'default'
  #metaVerdict: FictionVerdict = 'unknown'
  #textVerdict: FictionVerdict = 'unknown'
  #modelVerdict: boolean | null = null
  #queue: Array<{ section: number; chunk: number }> = []
  #running = 0
  #controllers = new Set<AbortController>()
  #paintPending = new Set<number>()
  #limit: { section: number; block: number; sentence: number } | null = null
  #disposed = false
  /** 全书的 AI 重点词: 词 → 最高重要度与被选中的块 */
  #kwBook = new Map<string, { r: number; chunks: Set<string> }>()
  #kwLoaded = false
  #onOnline = () => { if (this.status === 'offline') { this.status = 'loading'; this.#schedule() } }

  constructor(host: DjHost, cache: DjCache = getDjCache()) {
    this.host = host
    this.cache = cache
    this.#metaVerdict = fictionFromMeta({ ...host.book(), title: host.book().title })
    try {
      const saved = localStorage.getItem(`lightread-dj-genre:${host.bookId}`)
      if (saved === 'fiction' || saved === 'nonfiction') this.#modelVerdict = saved === 'fiction'
    } catch { /* 存储不可用 */ }
    this.#decideFiction()
    try { window.addEventListener('online', this.#onOnline) } catch { /* 非浏览器 */ }
    void this.#loadFeedback()
  }

  // ---- 生命周期 ----

  /** 开启: 绘制已缓存的标记并开始调度 */
  start() {
    if (this.#disposed) return
    this.active = true
    void this.#loadBookKeyWords()
    if (this.status === 'idle' || this.status === 'consent') this.status = 'loading'
    for (const s of this.sections.values()) void this.#hydrate(s).then(() => this.#paint(s.index))
    this.#schedule()
    this.host.onChange()
  }

  /** 关闭: 停止请求、清除标记 (缓存保留) */
  stop() {
    this.active = false
    this.#queue = []
    for (const c of this.#controllers) c.abort()
    this.#controllers.clear()
    for (const s of this.sections.values()) {
      s.layer?.dispose()
      s.layer = undefined
      for (const c of s.chunks) if (c.status === 'loading' || c.status === 'queued') c.status = 'idle'
    }
    this.status = 'idle'
    this.host.onChange()
  }

  dispose() {
    this.stop()
    this.#disposed = true
    this.sections.clear()
    try { window.removeEventListener('online', this.#onOnline) } catch { /* 非浏览器 */ }
  }

  /** 通道 / 密钥变化后: 清除额度与错误状态, 重新调度 */
  resetErrors() {
    this.error = null
    for (const s of this.sections.values()) for (const c of s.chunks) if (c.status === 'error') { c.status = 'idle'; c.failedAt = undefined }
    if (this.active) {
      this.status = 'loading'
      this.#schedule()
    }
    this.host.onChange()
  }

  // ---- 分节 ----

  #buildSection(index: number, doc: Document, rendered: boolean): SectionState {
    const book = this.host.book()
    const model = new SectionTextModel(doc, doc.documentElement?.lang || book.language)
    const chunks = chunkSection(model.sectionBlocks()).map(chunk => ({ chunk, status: 'idle' as const, items: [] }))
    const s: SectionState = { index, model, chunks, rendered, totalChars: model.totalChars() }
    return s
  }

  /** foliate load: 已渲染的分节文档。keep: 仍在屏上的分节 (跨章连续滚动时同时渲染多个), 不因离得远被清掉 */
  attach(index: number, doc: Document, keep?: ReadonlySet<number>) {
    const old = this.sections.get(index)
    old?.layer?.dispose()
    const s = this.#buildSection(index, doc, true)
    // 同一节重新加载 (重排 / 换字号): 内容相同则沿用已得结果, 不重新请求
    if (old) {
      for (const c of s.chunks) {
        const prev = old.chunks.find(p => p.chunk.hash === c.chunk.hash)
        if (prev && prev.status === 'done') { c.status = 'done'; c.items = prev.items; c.model = prev.model; c.kw = prev.kw }
      }
      s.summary = old.summary
    }
    this.sections.set(index, s)
    // 只保留附近的分节, 防止长时间阅读内存增长
    for (const k of [...this.sections.keys()]) if (Math.abs(k - index) > 2 && !keep?.has(k)) {
      this.sections.get(k)?.layer?.dispose()
      this.sections.delete(k)
    }
    if (this.#textVerdict === 'unknown' && s.totalChars >= 800) {
      this.#textVerdict = fictionFromText(s.model.sectionBlocks(0, 60).map(b => b.sentences.join('')).join('\n').slice(0, 4000))
      this.#decideFiction()
    }
    if (!this.active) return
    void this.#hydrate(s).then(() => {
      this.#paint(index)
      this.#schedule()
    })
  }

  /** 分节卸载 (foliate 换章): 绘制层随文档销毁 */
  detach(index: number) {
    const s = this.sections.get(index)
    if (!s) return
    s.layer?.dispose()
    s.layer = undefined
    s.rendered = false
  }

  #ensureLayer(s: SectionState): DjLayer | null {
    if (!s.rendered) return null
    if (!s.layer) {
      s.layer = createDjLayer(s.model.doc, {
        getOverlayer: () => this.host.getOverlayer(s.index),
        colors: () => this.host.colors(),
      })
    }
    return s.layer
  }

  #models(): string[] {
    const ch = this.host.channel()
    if (!ch) return []
    return ch.kind === 'builtin' ? [DJ_MODEL, DJ_FALLBACK_MODEL] : [ch.model ?? '']
  }

  /** 从缓存补齐本节已完成的块与要义 */
  async #hydrate(s: SectionState) {
    const models = this.#models()
    let gotKw = false
    await Promise.all(s.chunks.map(async c => {
      if (c.status === 'done') return
      // 先找当前版本; 没有再用上一版的旧结果 (要句等照常显示, 重点词这一块用离线结果, 不为它重新花额度)
      for (const v of [PROMPT_VERSION, ...LEGACY_PROMPT_VERSIONS]) {
        for (const m of models) {
          const rec = await this.cache.get<ChunkRecord>('chunks', cacheKey(this.host.bookId, s.index, c.chunk.hash, m, v)).catch(() => undefined)
          if (rec?.complete) {
            c.status = 'done'
            c.items = rec.items
            c.model = rec.model
            c.kw = v === PROMPT_VERSION && !!rec.kw
            if (c.kw) { this.#addKw(c); gotKw = true }
            if (typeof rec.fiction === 'boolean' && this.#modelVerdict == null) this.#setModelVerdict(rec.fiction)
            return
          }
        }
      }
    }))
    if (gotKw || s.chunks.some(c => c.status === 'done')) this.host.onKeyWords?.(s.index)
    if (!s.summary) {
      // 章首要义与重点词无关: 上一版的也照用
      for (const v of [PROMPT_VERSION, ...LEGACY_PROMPT_VERSIONS]) {
        const sum = await this.cache.get<SectionSummary>('sections', sectionKey(this.host.bookId, s.index, v)).catch(() => undefined)
        if (sum && sum.basis === this.#basis(s)) { s.summary = sum; break }
      }
    }
    this.#updateStatus()
    this.host.onChange()
  }

  // ---- 位置与调度 ----

  /** foliate relocate: 可见范围的起点 */
  relocate(index: number, range: Range | null | undefined) {
    const s = this.sections.get(index)
    if (s && range) {
      const at = s.model.locate(range.startContainer, range.startOffset)
      if (at) this.position = { section: index, ...at }
    } else if (s) this.position = { section: index, block: 0, sentence: 0 }
    // 攒着的绘制 (墨水屏 / 减少动效) 在翻页时一起画
    for (const i of [...this.#paintPending]) { this.#paintPending.delete(i); this.#paint(i, true) }
    for (const st of this.sections.values()) st.layer?.ensure()
    if (this.active) this.#schedule()
    this.host.onChange()
  }

  /** 读者在本节的进度 (0–1, 按字数) */
  sectionFraction(): number {
    const p = this.position
    const s = p ? this.sections.get(p.section) : null
    if (!p || !s || !s.totalChars) return 0
    return s.model.charsBefore(p.block) / s.totalChars
  }

  #schedule() {
    if (!this.active || this.#disposed) return
    if (this.status === 'quota' || this.status === 'offline') return
    if (!this.host.channel()) { this.status = 'error'; this.error = new DjError('config', 'not configured'); this.host.onChange(); return }
    const p = this.position
    const want: Array<{ section: number; chunk: number }> = []
    const cur = p ? this.sections.get(p.section) : [...this.sections.values()].find(s => s.rendered)
    if (cur) {
      const ci = chunkIndexForBlock(cur.chunks.map(c => c.chunk), p?.block ?? 0)
      for (const i of requestOrder(cur.chunks.length, ci, 2, 1)) want.push({ section: cur.index, chunk: i })
      // 读到本节 60% 时预取下一章: 叙述类前 2 块; 非叙述类短章 (≤8000 字) 整章, 以便章首要义提前就绪
      if (this.sectionFraction() >= 0.6 || cur.totalChars < MIN_SECTION_CHARS * 10 || cur.chunks.length <= 1) void this.#prefetchNext(cur.index)
      // 本节全部完成 → 汇总要义 (非叙述类); 叙述类在读者离开本节后才总结 (上一章回顾)
      this.#maybeSummarize(cur)
      if (this.fiction) {
        const prev = this.sections.get(cur.index - 1)
        if (prev) this.#maybeSummarize(prev, true)
      }
    }
    const next = this.sections.get((cur?.index ?? -1) + 1)
    if (next) {
      const limit = this.fiction || next.totalChars > 8000 ? 2 : next.chunks.length
      for (let i = 0; i < Math.min(limit, next.chunks.length); i++) if (this.sectionFraction() >= 0.6) want.push({ section: next.index, chunk: i })
      if (!this.fiction && this.sectionFraction() >= 0.6) this.#maybeSummarize(next)
    }
    const now = Date.now()
    this.#queue = want.filter(w => {
      const c = this.sections.get(w.section)?.chunks[w.chunk]
      if (!c || c.status === 'done' || c.status === 'loading') return false
      if (c.status === 'error' && now - (c.failedAt ?? 0) < RETRY_ERROR_MS) return false
      return true
    })
    // 不再需要的排队块退回 idle, 再标记新队列
    for (const s of this.sections.values()) for (const c of s.chunks) if (c.status === 'queued') c.status = 'idle'
    for (const w of this.#queue) this.sections.get(w.section)!.chunks[w.chunk].status = 'queued'
    this.#pump()
    this.#updateStatus()
  }

  async #prefetchNext(index: number) {
    let n = index + 1
    const total = this.host.sectionCount()
    while (n < total && !this.host.sectionLinear(n)) n++
    if (n >= total || this.sections.has(n)) return
    const doc = await this.host.sectionDoc(n).catch(() => null)
    if (!doc || this.sections.has(n) || this.#disposed) return
    const s = this.#buildSection(n, doc, false)
    if (s.totalChars < MIN_SECTION_CHARS) return
    this.sections.set(n, s)
    await this.#hydrate(s)
    this.#schedule()
  }

  #pump() {
    const max = Math.max(1, this.host.concurrency())
    while (this.#running < max && this.#queue.length && this.active) {
      const w = this.#queue.shift()!
      const s = this.sections.get(w.section)
      const c = s?.chunks[w.chunk]
      if (!s || !c || c.status !== 'queued') continue
      this.#running++
      void this.#request(s, c).finally(() => {
        this.#running--
        this.#pump()
        this.#updateStatus()
        this.host.onChange()
      })
    }
  }

  #knownTerms(s: SectionState, c: ChunkState): string[] {
    const out: string[] = []
    for (const o of s.chunks) {
      if (o.chunk.index >= c.chunk.index) break
      for (const it of o.items) if (it.t === 'term' && !out.includes(it.q)) out.push(it.q)
    }
    return out.slice(-30)
  }

  async #request(s: SectionState, c: ChunkState, attempt = 0): Promise<void> {
    const channel = this.host.channel()
    if (!channel) return
    c.status = 'loading'
    c.items = []
    this.host.onChange()
    const ctrl = new AbortController()
    this.#controllers.add(ctrl)
    const stats: { dropped: number; kwLines?: number; kwMissing?: number } = { dropped: 0 }
    let fictionSeen: boolean | undefined
    const book = this.host.book()
    const wantKw = wantsKeyWords(s.model.lang || book.language, c.chunk.text)
    try {
      const res = await streamDianjing({
        mode: 'mark',
        lang: this.host.uiLang(),
        bookLang: s.model.lang || book.language,
        book: { title: book.title, author: book.author },
        chapter: this.host.chapterTitle(s.index),
        fiction: this.fiction,
        askGenre: this.fictionSource === 'default',
        text: c.chunk.text,
        knownTerms: this.#knownTerms(s, c),
        keywords: wantKw,
      }, channel, (raw: RawItem) => {
        const it = resolveItem(raw, c.chunk, stats)
        if (!it) return
        if (it.t === 'meta') {
          fictionSeen = it.fiction
          if (this.fictionSource === 'default') this.#setModelVerdict(it.fiction)
          return
        }
        if (!isDjItem(it) || c.items.some(x => x.id === it.id)) return
        c.items.push(it)
        this.#schedulePaint(s.index)
      }, ctrl.signal)
      if (typeof res.remaining === 'number') this.remaining = res.remaining
      const total = res.good + res.bad
      // 坏行 + 锚定失败超过一半: 重试一次
      if (attempt === 0 && total > 0 && (res.bad + stats.dropped) / total > 0.5) {
        this.#controllers.delete(ctrl)
        return this.#request(s, c, 1)
      }
      c.status = 'done'
      c.model = res.model
      if (wantKw) {
        const kws = c.items.filter(i => i.t === 'kw').length
        c.kw = keyWordsUsable(kws, stats.kwMissing ?? 0, c.chunk.chars)
        if (!c.kw) c.items = c.items.filter(i => i.t !== 'kw')
        else this.#addKw(c)
        noteKeyWordChunk({ usable: c.kw, lines: stats.kwLines ?? 0, missing: stats.kwMissing ?? 0 })
        this.host.onKeyWords?.(s.index)
      } else c.kw = false
      this.error = null
      if (this.status !== 'quota') this.status = 'ready'
      await this.cache.put<ChunkRecord>('chunks', this.#record(s, c, res.model, fictionSeen)).catch(() => {})
      this.#paint(s.index)
      this.#maybeSummarize(s)
    } catch (e) {
      const err = e instanceof DjError ? e : new DjError('http', String(e))
      if (err.code === 'aborted') { c.status = 'idle'; return }
      c.status = 'error'
      c.failedAt = Date.now()
      c.error = err
      this.error = err
      if (err.code === 'quota' || err.code === 'budget') {
        this.status = 'quota'
        this.#queue = []
      } else if (err.code === 'offline') {
        this.status = 'offline'
        this.#queue = []
      } else this.status = 'error'
    } finally {
      this.#controllers.delete(ctrl)
    }
  }

  #record(s: SectionState, c: ChunkState, model: string, fiction?: boolean): ChunkRecord {
    const texts: Record<string, string> = {}
    const lengths: Record<string, number> = {}
    for (const it of c.items) {
      if (it.t === 'key' || it.t === 'tr') {
        const sents = s.model.sentenceTexts(it.block)
        texts[it.id] = (sents[it.sentence] ?? '').slice(0, 160)
        lengths[`${it.block}.${it.sentence}`] = s.model.sentenceLength(it.block, it.sentence)
      }
    }
    const blocks = c.chunk.blocks
    return {
      key: cacheKey(this.host.bookId, s.index, c.chunk.hash, model, PROMPT_VERSION),
      bookId: this.host.bookId,
      section: s.index,
      chunkIndex: c.chunk.index,
      chunkHash: c.chunk.hash,
      model,
      promptVersion: PROMPT_VERSION,
      chars: c.chunk.chars,
      firstBlock: blocks[0]?.block ?? 0,
      lastBlock: blocks[blocks.length - 1]?.block ?? 0,
      items: c.items,
      texts,
      lengths,
      fiction,
      kw: !!c.kw,
      complete: true,
      at: Date.now(),
    }
  }

  // ---- 重点词 (AI) ----

  #addKw(c: ChunkState) {
    for (const it of c.items) {
      if (it.t !== 'kw') continue
      const cur = this.#kwBook.get(it.q)
      if (cur) { cur.r = Math.max(cur.r, it.r); cur.chunks.add(c.chunk.hash) }
      else this.#kwBook.set(it.q, { r: it.r, chunks: new Set([c.chunk.hash]) })
    }
  }

  /** 开启时读一次本书已保存的结果, 把其他章节的 AI 重点词并进全书词表 */
  async #loadBookKeyWords() {
    if (this.#kwLoaded) return
    this.#kwLoaded = true
    const rows = await this.cache.listBook<ChunkRecord>('chunks', this.host.bookId).catch(() => [] as ChunkRecord[])
    let added = 0
    for (const r of rows) {
      if (r.promptVersion !== PROMPT_VERSION || !r.kw) continue
      for (const it of r.items) {
        if (it.t !== 'kw') continue
        const cur = this.#kwBook.get(it.q)
        if (cur) { cur.r = Math.max(cur.r, it.r); cur.chunks.add(r.chunkHash) }
        else { this.#kwBook.set(it.q, { r: it.r, chunks: new Set([r.chunkHash]) }); added++ }
      }
    }
    if (added) this.host.onKeyWords?.(null)
  }

  /** 全书的 AI 重点词: [词, 重要度, 被选中的块数] */
  bookKeyWords(): Array<[string, number, number]> {
    return [...this.#kwBook].map(([w, v]) => [w, v.r, v.chunks.size] as [string, number, number])
  }

  /**
   * 给「重点词」绘制层: 本节各块的起点 (DOM 点) 与这块有没有可用的 AI 结果, 以及全书的 AI 词。
   * 本节还没接上 (或文档不是同一个) 时返回 null, 绘制层先全用离线结果。
   */
  keyWordInput(index: number, doc: Document): { words: Array<[string, number, number]>; chunks: Array<{ node: Node; offset: number; ai: boolean }> } | null {
    const s = this.sections.get(index)
    if (!s || s.model.doc !== doc) return null
    const chunks: Array<{ node: Node; offset: number; ai: boolean }> = []
    for (const c of s.chunks) {
      const b = c.chunk.blocks[0] as (typeof c.chunk.blocks)[number] & { offset?: number }
      if (!b) continue
      const r = s.model.sentenceRange(b.block, b.offset ?? 0)
      if (!r) continue
      chunks.push({ node: r.startContainer, offset: r.startOffset, ai: c.status === 'done' && !!c.kw })
    }
    return { words: this.bookKeyWords(), chunks }
  }

  #updateStatus() {
    if (!this.active) { this.status = 'idle'; return }
    if (this.status === 'quota' || this.status === 'offline') return
    const p = this.position
    const s = p ? this.sections.get(p.section) : [...this.sections.values()].find(x => x.rendered)
    if (!s) return
    const any = (st: ChunkState['status']) => s.chunks.some(c => c.status === st)
    if (any('loading') || any('queued')) this.status = 'loading'
    else if (this.error && any('error')) this.status = 'error'
    else this.status = 'ready'
  }

  // ---- 体裁 ----

  #decideFiction() {
    const d = decideFiction({
      override: this.host.fictionOverride(),
      meta: this.#metaVerdict,
      text: this.#textVerdict,
      model: this.#modelVerdict,
    })
    this.fiction = d.fiction
    this.fictionSource = d.source
  }

  #setModelVerdict(v: boolean) {
    this.#modelVerdict = v
    try { localStorage.setItem(`lightread-dj-genre:${this.host.bookId}`, v ? 'fiction' : 'nonfiction') } catch { /* 存储不可用 */ }
    this.#decideFiction()
  }

  /** 用户手动改体裁后调用 */
  refreshFiction() {
    this.#decideFiction()
    this.host.onChange()
  }

  // ---- 过滤与绘制 ----

  /** 某节按密度 / 类型 / 反馈过滤后的标记 */
  visible(index: number): VisibleMarks {
    const s = this.sections.get(index)
    const out: VisibleMarks = { keys: [], terms: [], notes: [] }
    if (!s) return out
    const kinds = this.host.kinds()
    const density = this.host.density()
    for (const c of s.chunks) {
      if (!c.items.length) continue
      const keys = c.items.filter((i): i is KeyItem => i.t === 'key' && !this.dismissed.has(i.id) && !this.adopted.has(i.id))
      if (kinds.key && keys.length) {
        const chosen = selectKeys(keys, k => s.model.sentenceLength(k.block, k.sentence), c.chunk.chars, density)
        out.keys.push(...keys.filter(k => chosen.has(k.id)))
      }
      if (kinds.term) {
        const terms = c.items.filter((i): i is TermItem => i.t === 'term' && !this.dismissed.has(i.id))
        out.terms.push(...selectTerms(terms, density))
      }
      if (kinds.note) out.notes.push(...c.items.filter((i): i is NoteItem => i.t === 'note' && !this.dismissed.has(i.id)))
    }
    const lim = this.#limit
    if (lim && lim.section === index) {
      const before = (i: { block: number; sentence: number }) => i.block < lim.block || (i.block === lim.block && i.sentence < lim.sentence)
      out.keys = out.keys.filter(before)
      out.terms = out.terms.filter(before)
      out.notes = out.notes.filter(before)
    }
    return out
  }

  #schedulePaint(index: number) {
    if (this.host.batchPaint()) { this.#paintPending.add(index); return }
    if (this.#paintPending.has(index)) return
    this.#paintPending.add(index)
    const run = () => { if (this.#paintPending.delete(index)) this.#paint(index) }
    try { requestAnimationFrame(run) } catch { setTimeout(run, 16) }
  }

  #paint(index: number, force = false) {
    if (!this.active) return
    const s = this.sections.get(index)
    if (!s || !s.rendered) return
    if (!force && this.host.batchPaint() && s.chunks.some(c => c.status === 'loading')) { this.#paintPending.add(index); return }
    const layer = this.#ensureLayer(s)
    if (!layer) return
    const v = this.visible(index)
    const keys = v.keys.map(k => s.model.sentenceRange(k.block, k.sentence)).filter(Boolean) as Range[]
    const terms = v.terms.map(t => s.model.termRange(t.block, t.sentence, t.start, t.end)).filter(Boolean) as Range[]
    const notes = v.notes.map(n => s.model.termRange(n.block, n.sentence, n.start, n.end)).filter(Boolean) as Range[]
    try {
      layer.paint({ keys, terms, notes })
      layer.setBand(this.band ? keys : null)
    } catch { /* 文档已卸载 */ }
  }

  /** 密度 / 类型 / 主题变化: 重画所有已渲染分节 (不重新请求) */
  repaint() {
    for (const s of this.sections.values()) {
      if (!s.rendered) continue
      this.#paint(s.index, true)
      s.layer?.refresh()
    }
  }

  setBand(on: boolean) {
    this.band = on
    this.repaint()
  }

  /**
   * 打字机联动: 只显示光标之前的标记 (光标之后的正文还隐藏着, 下划线会泄露排版)。
   * point 为 null 时取消限制。
   */
  setLimit(index: number, node: Node | null, offset = 0) {
    const s = this.sections.get(index)
    const at = node && s ? s.model.locate(node, offset) : null
    const next = at ? { section: index, ...at } : null
    const same = (a: typeof next, b: typeof next) => a?.section === b?.section && a?.block === b?.block && a?.sentence === b?.sentence
    if (same(next, this.#limit)) return
    this.#limit = next
    this.#paint(index, true)
  }

  // ---- 命中与卡片 ----

  /** 轻点正文: 命中概念或注时返回卡片目标 */
  hit(index: number, doc: Document, x: number, y: number): CardTarget | null {
    const s = this.sections.get(index)
    if (!this.active || !s || s.model.doc !== doc) return null
    const v = this.visible(index)
    const targets: Array<HitTarget<TermItem | NoteItem>> = []
    for (const t of [...v.terms, ...v.notes]) {
      const range = s.model.termRange(t.block, t.sentence, t.start, t.end)
      if (range) targets.push({ range, data: t })
    }
    const dotTargets = targets.filter(t => t.data.t === 'note')
    const found = hitTest(doc, x, y, targets.filter(t => t.data.t === 'term').concat(dotTargets), { dotTargets })
    if (!found) return null
    return { kind: found.data.t, section: index, item: found.data, range: found.range, text: found.data.q }
  }

  /** 选区 (长按) 落在哪条可见要句上 */
  keyAt(index: number, range: Range): CardTarget | null {
    const s = this.sections.get(index)
    if (!this.active || !s) return null
    const at = s.model.locate(range.startContainer, range.startOffset)
    if (!at) return null
    const key = this.visible(index).keys.find(k => k.block === at.block && k.sentence === at.sentence)
    if (!key) return null
    const r = s.model.sentenceRange(key.block, key.sentence)
    if (!r) return null
    return { kind: 'key', section: index, item: key, range: r, text: r.toString(), translation: this.translationOf(index, key) }
  }

  translationOf(index: number, pos: { block: number; sentence: number }): string | undefined {
    const s = this.sections.get(index)
    for (const c of s?.chunks ?? []) {
      const tr = c.items.find((i): i is TrItem => i.t === 'tr' && i.block === pos.block && i.sentence === pos.sentence)
      if (tr) return tr.text
    }
    return undefined
  }

  /** 是否为当前可见的要句 (打字机减速、听书停顿) */
  isKey(index: number, block: number, sentence: number): boolean {
    return this.visible(index).keys.some(k => k.block === block && k.sentence === sentence)
  }

  isKeyRange(range: Range): boolean {
    for (const s of this.sections.values()) {
      if (s.model.doc !== range.startContainer?.ownerDocument) continue
      const at = s.model.locate(range.startContainer, range.startOffset)
      return !!at && this.isKey(s.index, at.block, at.sentence)
    }
    return false
  }

  keyRanges(index: number): Range[] {
    const s = this.sections.get(index)
    if (!s) return []
    return this.visible(index).keys.map(k => s.model.sentenceRange(k.block, k.sentence)).filter(Boolean) as Range[]
  }

  sectionOfDoc(doc: Document): number | null {
    for (const s of this.sections.values()) if (s.model.doc === doc) return s.index
    return null
  }

  // ---- 反馈 ----

  async #loadFeedback() {
    const rows = await this.cache.listBook<FeedbackRecord>('feedback', this.host.bookId).catch(() => [] as FeedbackRecord[])
    for (const r of rows) (r.action === 'dismiss' ? this.dismissed : this.adopted).add(r.itemId)
    this.repaint()
  }

  async feedback(itemId: string, action: 'dismiss' | 'adopt') {
    ;(action === 'dismiss' ? this.dismissed : this.adopted).add(itemId)
    this.repaint()
    this.host.onChange()
    await this.cache.put<FeedbackRecord>('feedback', {
      key: feedbackKey(this.host.bookId, itemId), bookId: this.host.bookId, itemId, action, at: Date.now(),
    }).catch(() => {})
  }

  // ---- 要义 ----

  #basis(s: SectionState): string {
    return hashText(s.chunks.map(c => c.chunk.hash).join(','))
  }

  /** 本节全部块完成后汇总要义; recap=true 时 (叙述类) 只在读者已离开本节后生成 */
  #maybeSummarize(s: SectionState, recap = false) {
    if (!this.active || s.summary || s.summaryLoading) return
    if (!s.chunks.length || s.chunks.some(c => c.status !== 'done')) return
    if (this.fiction && !recap) return
    if (this.fiction && (this.position?.section ?? -1) <= s.index) return
    const keys: KeyItem[] = []
    const gists: GistItem[] = []
    for (const c of s.chunks) for (const it of c.items) {
      if (it.t === 'key' && it.r >= 2) keys.push(it)
      if (it.t === 'gist') gists.push(it)
    }
    if (!keys.length && !gists.length) return
    const channel = this.host.channel()
    if (!channel) return
    const keyList = keys.slice(0, 24)
    const lines = [
      ...(gists.length ? [this.host.uiLang() === 'en' ? 'Gists:' : '段意：', ...gists.slice(0, 40).map(g => `- ${g.text}`)] : []),
      this.host.uiLang() === 'en' ? 'Key sentences:' : '要句：',
      ...keyList.map((k, i) => `[${i + 1}] ${(s.model.sentenceTexts(k.block)[k.sentence] ?? '').slice(0, 200)}`),
    ]
    s.summaryLoading = true
    let text = ''
    const points: PointItem[] = []
    const book = this.host.book()
    void streamDianjing({
      mode: 'summary',
      lang: this.host.uiLang(),
      bookLang: s.model.lang || book.language,
      book: { title: book.title, author: book.author },
      chapter: this.host.chapterTitle(s.index),
      fiction: this.fiction,
      text: lines.join('\n'),
    }, channel, raw => {
      if (raw.t === 'sum' && typeof raw.text === 'string') text = raw.text.trim().slice(0, 400)
      if (raw.t === 'pt' && typeof raw.text === 'string') {
        const k = keyList[Number(String(raw.s ?? '').replace(/\D/g, '')) - 1]
        if (k && points.length < 5) points.push({ t: 'pt', block: k.block, sentence: k.sentence, text: raw.text.trim().slice(0, 90) })
      }
    }).then(async () => {
      if (!text) return
      s.summary = { key: sectionKey(this.host.bookId, s.index, PROMPT_VERSION), bookId: this.host.bookId, section: s.index, basis: this.#basis(s), text, points, at: Date.now() }
      await this.cache.put('sections', s.summary).catch(() => {})
      this.host.onChange()
    }).catch(() => { /* 要义失败不影响标记 */ }).finally(() => { s.summaryLoading = false })
  }

  /**
   * 章首卡片的数据: 非叙述类显示本章要义; 叙述类显示上一章回顾 (R6 不剧透)。
   */
  chapterCard(index: number): { mode: 'gist' | 'recap'; section: number; summary: SectionSummary } | null {
    if (this.fiction) {
      const prev = this.sections.get(index - 1)
      return prev?.summary ? { mode: 'recap', section: index - 1, summary: prev.summary } : null
    }
    const s = this.sections.get(index)
    return s?.summary ? { mode: 'gist', section: index, summary: s.summary } : null
  }

  /** 本节完成度 (0–1) */
  progress(index?: number): number {
    const s = this.sections.get(index ?? this.position?.section ?? -1)
    if (!s || !s.chunks.length) return 0
    return s.chunks.filter(c => c.status === 'done').length / s.chunks.length
  }

  // ---- 跳转 ----

  /** 位置 → Range (已加载分节直接取; 否则用未渲染文档) */
  async rangeFor(pos: DjPosition): Promise<Range | null> {
    let s = this.sections.get(pos.section)
    if (!s) {
      const doc = await this.host.sectionDoc(pos.section).catch(() => null)
      if (!doc) return null
      s = this.#buildSection(pos.section, doc, false)
    }
    return s.model.sentenceRange(pos.block, pos.sentence)
  }

  flash(pos: DjPosition) {
    const s = this.sections.get(pos.section)
    const layer = s ? this.#ensureLayer(s) : null
    const r = s?.model.sentenceRange(pos.block, pos.sentence)
    if (layer && r) layer.flash(r)
  }

  /** 全书缓存记录 (脉络 / 速读) */
  async bookRecords(): Promise<{ chunks: ChunkRecord[]; sections: SectionSummary[] }> {
    const [chunks, sections] = await Promise.all([
      this.cache.listBook<ChunkRecord>('chunks', this.host.bookId).catch(() => [] as ChunkRecord[]),
      this.cache.listBook<SectionSummary>('sections', this.host.bookId).catch(() => [] as SectionSummary[]),
    ])
    // 上一版的块 (没有重点词) 照样用于脉络 / 速读; 同一块两版都有时调用方按时间取新的
    const versions = new Set([PROMPT_VERSION, ...LEGACY_PROMPT_VERSIONS])
    return { chunks: chunks.filter(c => versions.has(c.promptVersion)), sections }
  }

  /** 重新点睛本章: 删掉内存结果, 重新请求 (缓存会被新结果覆盖) */
  redoSection(index: number) {
    const s = this.sections.get(index)
    if (!s) return
    for (const c of s.chunks) { c.status = 'idle'; c.items = []; c.failedAt = undefined; c.kw = false }
    s.summary = undefined
    this.repaint()
    this.host.onKeyWords?.(index)
    this.#schedule()
  }

  async clearBookCache() {
    await this.cache.clearBook(this.host.bookId).catch(() => {})
    this.dismissed.clear()
    this.adopted.clear()
    for (const s of this.sections.values()) { for (const c of s.chunks) { c.status = 'idle'; c.items = []; c.kw = false } s.summary = undefined }
    this.#kwBook.clear()
    this.repaint()
    this.host.onKeyWords?.(null)
    this.host.onChange()
  }
}

