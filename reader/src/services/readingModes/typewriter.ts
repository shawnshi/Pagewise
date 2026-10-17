/**
 * 打字机控制器 (docs/reading-modes.md §3.1 §5.4): 状态机 idle / running / paused / turning + rAF 循环。
 *
 * 位置模型: 「光标」cursor 为节内偏移 (见 blocks.SectionText), 光标之前正常显示、之后隐藏或淡显。
 * 另记一个「已显示到」revealed 的高水位: 往回翻页时光标移到新页页首, 但读过的内容仍全部可见,
 * 打字机在已显示的文字上推进 (只有墨迹在走), 越过高水位后再继续隐藏后文。
 *
 * 推进: 从光标起按窗口 (约 2000 字、在段末截断, 至多 5000 字; 逐行模式为本页可见部分) 惰性切 token、
 * 建时间表, 每帧二分查找当前出字点, 只在偏移变化时更新 Highlight。
 *
 * 翻页: 分页模式下光标越过本页可见范围末尾 → turning, 停留 pageDwellMs 后 host.nextPage();
 * 之后只信任 relocate / load 事件接续 (onRelocate / onSectionLoad), 超时未到则看门狗恢复。
 * 滚动模式: 出字行超过视口 60% 时向下滚到约 40% 处; 节末 host.nextSection()。
 *
 * 任何异常都 stop() 并清除所有隐藏, 绝不把正文留在透明状态。
 */
import { SectionText, upperBound } from './blocks.ts'
import {
  ATOM_MS,
  buildSchedule,
  freshStart,
  groupLines,
  indexAt,
  sentenceSpans,
  tokenize,
  type RevealUnit,
  type Schedule,
  type Token,
} from './pacing.ts'
import { clearReadingModeMarks, createRevealLayer, type RevealColors, type RevealLayer } from './revealLayer.ts'
import { FOCUS_BAND_BOTTOM, FOCUS_LINE } from '../readingFocus.ts'

export type TypewriterState = 'idle' | 'running' | 'paused' | 'turning'

export interface TypewriterConfig {
  unit: RevealUnit
  /** 字当量/分 (中文书为字/分, 西文书为词/分) */
  unitsPerMinute: number
  /** 后文淡显 (否则隐藏) */
  ghost: boolean
  punctuationPause: boolean
  freshInk: boolean
  /** 打完一页后的停留, 毫秒 */
  pageDwellMs: number
}

/** 控制器对阅读器的全部依赖 (由 useReadingModes 用 foliate-view 实现) */
export interface TypewriterHost {
  /** 当前显示的分节: renderer.getContents()[0] (跨章连续滚动时为阅读线所在的主章) */
  contents(): { doc: Document; index: number; overlayer?: any } | null
  /** 指定文档所在的已渲染分节 (跨章连续滚动时同时有多个); 不提供时只认 contents() */
  contentOf?(doc: Document): { doc: Document; index: number; overlayer?: any } | null
  /** 最近一次 relocate 的可见范围 (view.lastLocation.range) */
  visibleRange(): Range | null
  scrolled(): boolean
  /** 已在全书最后一页 (滚动模式: 最后一节) */
  atBookEnd(): boolean
  /** 翻到下一页 (到节末时进入下一节) */
  nextPage(): unknown
  nextSection(): unknown
  /** 滚动模式: 向前滚动 px; 单章渲染时实现方需保证只在本节内滚动, 不跨节 */
  scrollForward(px: number): void
  /** 阅读区视口在宿主窗口中的位置 (滚动跟随用) */
  viewportRect(): DOMRect | null
  colors(): RevealColors
  lang(): string
}

export interface TypewriterEvents {
  onState?(state: TypewriterState): void
  /** 出现了新的出字点; ticks 为其中应响打字声的个数 */
  onAdvance?(ticks: number): void
  onFinish?(reason: 'book-end' | 'error', error?: unknown): void
}

const WINDOW_TARGET = 2000
const WINDOW_MAX = 5000
const LINE_FALLBACK = 600
const TURN_WATCHDOG_MS = 3000
const FOLLOW_INTERVAL_MS = 150

export class TypewriterController {
  #host: TypewriterHost
  #cfg: TypewriterConfig
  #ev: TypewriterEvents
  #state: TypewriterState = 'idle'

  #text: SectionText | null = null
  #layer: RevealLayer | null = null
  #section = -1
  #vertical = false

  #cursor = 0
  #revealed = 0
  #visStart = 0
  #visEnd: number | null = null

  #sched: Schedule | null = null
  #winEnd = 0
  #t0 = 0
  #lastIndex = -1
  #pausedAt = 0

  #raf = 0
  #turnTimer: ReturnType<typeof setTimeout> | undefined
  #watchdog: ReturnType<typeof setTimeout> | undefined
  #awaitingTurn = false
  #turnFailures = 0
  #atomShown = 0
  #atomRevealedAt = 0
  #lastFollow = 0

  constructor(host: TypewriterHost, cfg: TypewriterConfig, ev: TypewriterEvents = {}) {
    this.#host = host
    this.#cfg = { ...cfg }
    this.#ev = ev
  }

  get state(): TypewriterState { return this.#state }
  get active(): boolean { return this.#state !== 'idle' }
  /** 当前分节文档 (选区监听等用) */
  get doc(): Document | null { return this.#text?.doc ?? null }
  get cursor(): number { return this.#cursor }
  /** 当前分节序号 */
  get section(): number { return this.#section }
  get config(): Readonly<TypewriterConfig> { return this.#cfg }

  /** 从当前页第一个可见字开始; 本页先全部隐藏再从页首打出。没有可用的分节时返回 false */
  start(): boolean {
    this.stop()
    const c = this.#host.contents()
    if (!c?.doc?.body) return false
    try {
      this.#attach(c.doc, c.index, false)
      const vis = this.#host.visibleRange()
      if (vis && vis.startContainer?.ownerDocument === c.doc) this.#setVisible(vis)
      this.#cursor = this.#visStart
      this.#revealed = this.#cursor
      this.#render()
    } catch (e) {
      this.#fail(e)
      return false
    }
    this.#setState('running')
    this.#loop()
    return true
  }

  pause() {
    if (this.#state !== 'running' && this.#state !== 'turning') return
    clearTimeout(this.#turnTimer)
    this.#turnTimer = undefined
    this.#cancelFrame()
    this.#pausedAt = performance.now()
    this.#setState('paused')
  }

  resume() {
    if (this.#state !== 'paused') return
    if (this.#sched) this.#t0 += performance.now() - this.#pausedAt
    this.#setState('running')
    this.#loop()
  }

  /** 退出打字机: 清除所有隐藏, 正文恢复原样 */
  stop() {
    clearTimeout(this.#turnTimer)
    clearTimeout(this.#watchdog)
    this.#turnTimer = undefined
    this.#watchdog = undefined
    this.#awaitingTurn = false
    this.#cancelFrame()
    const doc = this.#text?.doc
    try { this.#layer?.dispose() } catch { /* 文档已卸载 */ }
    clearReadingModeMarks(doc)
    this.#layer = null
    this.#text = null
    this.#sched = null
    this.#setState('idle')
  }

  dispose() {
    this.stop()
  }

  setConfig(partial: Partial<TypewriterConfig>) {
    const prev = this.#cfg
    this.#cfg = { ...prev, ...partial }
    const c = this.#cfg
    if (c.unit !== prev.unit || c.unitsPerMinute !== prev.unitsPerMinute || c.punctuationPause !== prev.punctuationPause) {
      // 从当前光标处按新节奏重建时间表, 位置不变
      this.#sched = null
    }
    if (c.ghost !== prev.ghost) this.#layer?.setGhost(c.ghost)
    if (this.active) this.#safeRender()
  }

  /** 主题颜色变化 (回退路径的遮罩颜色) */
  refreshColors() {
    try { this.#layer?.refresh() } catch { /* 忽略 */ }
  }

  /** foliate relocate: 翻页 (自己或用户)、跳转、重排后接续 */
  onRelocate(range: Range | null | undefined) {
    const text = this.#text
    if (!this.active || !text || !range) return
    if (range.startContainer?.ownerDocument !== text.doc) return
    try {
      this.#setVisible(range)
      if (this.#awaitingTurn) {
        this.#awaitingTurn = false
        this.#turnFailures = 0
        clearTimeout(this.#watchdog)
      } else if (this.#turnTimer) {
        // 停留期间用户自己翻了页: 取消自动翻页, 按新位置接续
        clearTimeout(this.#turnTimer)
        this.#turnTimer = undefined
      }
      const visEnd = this.#visEnd ?? this.#visStart
      const inView = this.#cursor >= this.#visStart && this.#cursor <= visEnd
      if (!inView) {
        // 翻到别处: 光标移到新页页首; 往回翻时 revealed 高水位保证读过的页仍全部显示
        this.#cursor = this.#visStart
        if (this.#cursor > this.#revealed) this.#revealed = this.#cursor
        this.#sched = null
      } else if (!this.#host.scrolled()) {
        // 分页模式的翻页 / 重排: 从光标处以新的可见范围重建 (逐行模式需要重新测量行)
        this.#sched = null
      }
      if (this.#state === 'turning') {
        this.#setState('running')
        this.#loop()
      }
      this.#render()
    } catch (e) {
      this.#fail(e)
    }
  }

  /** foliate load: 换节 (自动翻页进入下一章, 或用户跳到别的章节) */
  onSectionLoad(doc: Document, index: number) {
    if (!this.active || !doc) return
    if (this.#text?.doc === doc) return
    try {
      clearTimeout(this.#turnTimer)
      this.#turnTimer = undefined
      const backward = this.#section >= 0 && index < this.#section
      this.#attach(doc, index, backward)
      // 在首次绘制前就隐藏 (load 早于 relocate)
      this.#render()
    } catch (e) {
      this.#fail(e)
    }
  }

  /** 光标所在行在视口内 (跨章连续滚动时据此判断用户是否滚去了别的分节); 文档已卸载为 false */
  cursorInView(): boolean {
    const text = this.#text
    if (!this.active || !text) return false
    const frame = (text.doc.defaultView?.frameElement as Element | null | undefined)?.getBoundingClientRect()
    if (!frame) return false
    const vp = this.#host.viewportRect()
    if (!vp || vp.height <= 0) return true
    const off = Math.min(this.#cursor, text.length)
    const r = text.length ? text.range(Math.max(0, off - 1), Math.max(off, 1)) : null
    const rects = r?.getClientRects()
    const rect = rects?.length ? rects[rects.length - 1] : null
    if (!rect) return true
    const top = frame.top + rect.top
    const bottom = frame.top + rect.bottom
    return bottom > vp.top && top < vp.top + vp.height
  }

  /** 选区越过了光标: 把光标推进到选区末尾 (只能选已显示的文字) */
  revealSelection(range: Range) {
    const text = this.#text
    if (!text || range.endContainer?.ownerDocument !== text.doc) return
    const off = text.offsetOf(range.endContainer, range.endOffset)
    if (off > this.#hiddenStart()) this.revealTo(off)
  }

  /** 立即显示到 offset (→ 键: 本段末) */
  revealTo(offset: number) {
    const text = this.#text
    if (!text) return
    const off = Math.min(text.length, Math.max(0, offset))
    if (off <= this.#cursor) return
    this.#cursor = off
    if (off > this.#revealed) this.#revealed = off
    this.#sched = null
    this.#safeRender()
  }

  /** 立即显示到本段末 */
  revealParagraph() {
    const text = this.#text
    if (!text) return
    this.revealTo(text.breakAfter(this.#cursor))
  }

  /** 重打当前句 (← 键): 光标回到所在句首 (刚打完一句时为上一句), 这一句重新隐藏后打出 */
  retypeSentence() {
    const text = this.#text
    if (!text || this.#cursor <= 0) return
    const cur = this.#cursor
    const from = text.breakBefore(cur)
    const str = text.slice(from, cur)
    const rel = cur - from
    let start = from
    for (const [s] of sentenceSpans(str, this.#host.lang())) {
      if (s < rel) start = from + s
    }
    if (this.#revealed <= cur) this.#revealed = start
    this.#cursor = start
    this.#sched = null
    this.#safeRender()
  }

  // ---- 内部 ----

  #setState(s: TypewriterState) {
    if (s === this.#state) return
    this.#state = s
    this.#ev.onState?.(s)
  }

  #attach(doc: Document, index: number, backward: boolean) {
    try { this.#layer?.dispose() } catch { /* 旧文档已卸载 */ }
    const text = new SectionText(doc)
    this.#text = text
    this.#section = index
    this.#layer = createRevealLayer(doc, {
      getOverlayer: () => {
        const c = this.#host.contentOf ? this.#host.contentOf(doc) : this.#host.contents()
        return c && c.doc === doc ? c.overlayer : null
      },
      colors: () => this.#host.colors(),
      ghost: this.#cfg.ghost,
    })
    this.#cursor = 0
    // 往回进入上一节: 那一节视为读过, 全部显示
    this.#revealed = backward ? text.length : 0
    this.#visStart = 0
    this.#visEnd = null
    this.#sched = null
    this.#atomShown = 0
    this.#atomRevealedAt = 0
    let vertical = false
    try {
      const wm = doc.defaultView?.getComputedStyle(doc.body).writingMode ?? ''
      vertical = wm.startsWith('vertical') || wm.startsWith('sideways')
    } catch { /* 忽略 */ }
    this.#vertical = vertical
    this.#syncAtoms(true)
  }

  #setVisible(range: Range) {
    const text = this.#text!
    this.#visStart = text.offsetOf(range.startContainer, range.startOffset)
    this.#visEnd = Math.max(this.#visStart, text.offsetOf(range.endContainer, range.endOffset))
  }

  #hiddenStart(): number {
    const len = this.#text?.length ?? 0
    return Math.min(len, Math.max(this.#cursor, this.#revealed))
  }

  /** 原子块: 位置 ≤ 显示起点的显示, 之后的隐藏 */
  #syncAtoms(full = false) {
    const text = this.#text
    const layer = this.#layer
    if (!text || !layer || !text.atoms.length) return
    const hs = this.#hiddenStart()
    const atoms = text.atoms
    let n = 0
    while (n < atoms.length && atoms[n].offset <= hs) n++
    if (full) {
      atoms.forEach((a, i) => layer.setPending(a.el, i >= n))
      // 光标正好停在图片处 (如只有一张插图的页): 同样保证停留 1.2 秒
      if (n > 0 && atoms[n - 1].offset >= this.#cursor) this.#atomRevealedAt = performance.now()
    } else if (n > this.#atomShown) {
      for (let i = this.#atomShown; i < n; i++) layer.setPending(atoms[i].el, false)
      this.#atomRevealedAt = performance.now()
    } else {
      for (let i = n; i < this.#atomShown; i++) layer.setPending(atoms[i].el, true)
    }
    this.#atomShown = n
  }

  #render() {
    const text = this.#text
    const layer = this.#layer
    if (!text || !layer) return
    const hs = this.#hiddenStart()
    let hidden: Range | null = null
    if (layer.mode === 'highlight') {
      hidden = text.rangeToEnd(hs)
    } else {
      // 遮罩只画到本页之后再多一页的量, 翻页动画滑入的下一页也是遮住的
      const vs = this.#visStart
      const ve = this.#visEnd ?? Math.min(text.length, hs + 1500)
      const end = Math.min(text.length, ve + Math.max(500, ve - vs))
      hidden = end > hs ? text.range(hs, end) : null
    }
    let fresh: Range | null = null
    if (this.#cfg.freshInk && this.#sched && this.#lastIndex >= 0) {
      const fs = Math.max(this.#sched.start, freshStart(this.#sched, this.#lastIndex, this.#cfg.unit))
      if (fs < this.#cursor) fresh = text.range(fs, this.#cursor)
    }
    layer.update(hidden, fresh)
    this.#syncAtoms()
  }

  #safeRender() {
    try { this.#render() } catch (e) { this.#fail(e) }
  }

  #loop() {
    if (this.#raf || this.#state !== 'running') return
    this.#raf = requestAnimationFrame(this.#frame)
  }

  #cancelFrame() {
    if (this.#raf) cancelAnimationFrame(this.#raf)
    this.#raf = 0
  }

  #frame = () => {
    this.#raf = 0
    if (this.#state !== 'running') return
    try {
      this.#step(performance.now())
    } catch (e) {
      this.#fail(e)
      return
    }
    this.#loop()
  }

  #step(now: number) {
    const text = this.#text
    if (!text) return
    const scrolled = this.#host.scrolled()
    if (this.#visEnd == null && !scrolled) {
      // 换节后等 relocate 给出可见范围; 迟迟不来就自己取
      const vis = this.#host.visibleRange()
      if (vis && vis.startContainer?.ownerDocument === text.doc) {
        this.#setVisible(vis)
        if (this.#cursor < this.#visStart) this.#cursor = this.#visStart
      } else return
    }
    if (!this.#sched) this.#buildWindow(now)
    const s = this.#sched!
    const elapsed = now - this.#t0
    const i = indexAt(s, elapsed)
    if (i > this.#lastIndex) {
      let ticks = 0
      for (let k = this.#lastIndex + 1; k <= i; k++) ticks += s.ticks[k]
      this.#lastIndex = i
      if (s.ends[i] > this.#cursor) this.#cursor = s.ends[i]
      if (this.#cursor > this.#revealed) this.#revealed = this.#cursor
      this.#render()
      this.#ev.onAdvance?.(ticks)
    }
    if (!scrolled && this.#visEnd != null && this.#cursor >= this.#visEnd) {
      this.#beginTurn(now)
      return
    }
    if (scrolled && !this.#vertical && now - this.#lastFollow > FOLLOW_INTERVAL_MS) {
      this.#lastFollow = now
      this.#follow()
    }
    if (elapsed >= s.total) {
      // 窗口打完 (含末尾停顿): 窗口末尾的开引号等零宽内容一并显示, 再接下一个窗口
      if (this.#winEnd > this.#cursor) {
        this.#cursor = this.#winEnd
        if (this.#cursor > this.#revealed) this.#revealed = this.#cursor
        this.#render()
      }
      if (this.#cursor >= text.length) {
        this.#beginTurn(now)
        return
      }
      this.#sched = null
    }
  }

  #buildWindow(now: number) {
    const text = this.#text!
    const len = text.length
    const start = Math.min(this.#cursor, len)
    let end: number
    if (this.#cfg.unit === 'line') {
      const ve = this.#visEnd
      end = ve != null && ve > start ? Math.min(ve, start + WINDOW_MAX) : Math.min(len, start + LINE_FALLBACK)
    } else {
      const target = Math.min(len, start + WINDOW_TARGET)
      const br = text.breakAtOrAfter(target)
      end = br <= start + WINDOW_MAX ? br : Math.min(len, start + WINDOW_MAX)
    }
    if (end <= start) end = len
    const lang = this.#host.lang()
    const str = text.slice(start, end)
    const tokens = tokenize(str, lang)
    // 注音、display:none 文本不占时间
    for (const [a, b] of text.silentSpans(start, end)) {
      for (const tok of tokens) {
        if (tok.start >= a && tok.end <= b && tok.weight > 0) {
          tok.weight = 0
          tok.kind = 'space'
          tok.wordStart = false
        }
      }
    }
    // 原子块: 位于 (start, end] 的插入为零宽出字点, 之后停留 1.2 秒
    const atomRel: number[] = []
    for (const a of text.atoms) if (a.offset > start && a.offset <= end) atomRel.push(a.offset - start)
    let merged: Token[] = tokens
    if (atomRel.length) {
      merged = []
      let ai = 0
      for (const tok of tokens) {
        while (ai < atomRel.length && atomRel[ai] <= tok.start) merged.push(atomToken(atomRel[ai++]))
        merged.push(tok)
      }
      while (ai < atomRel.length) merged.push(atomToken(atomRel[ai++]))
    }
    const bFrom = upperBound(text.breaks, start)
    const bTo = upperBound(text.breaks, end)
    const breaks = text.breaks.slice(bFrom, bTo).map(b => b - start)
    let units: Array<[number, number]> | undefined
    if (this.#cfg.unit === 'sentence') units = sentenceSpans(str, lang)
    else if (this.#cfg.unit === 'line') units = this.#measureLines(tokens, start)
    this.#sched = buildSchedule(merged, this.#cfg.unitsPerMinute, {
      punctuationPause: this.#cfg.punctuationPause,
      breaks,
      units,
      origin: start,
    })
    this.#winEnd = end
    this.#t0 = now
    this.#lastIndex = -1
  }

  /** 逐行: 测量窗口内每个出字单位的 top (竖排为 left), 分行 */
  #measureLines(tokens: readonly Token[], origin: number): Array<[number, number]> {
    const text = this.#text!
    const weighted = tokens.filter(t => t.weight > 0)
    const pos: number[] = []
    const sizes: number[] = []
    const vertical = this.#vertical
    for (const tok of weighted) {
      const r = text.range(origin + tok.start, origin + tok.end)
      const rect = r ? Array.from(r.getClientRects()).find(x => x.width > 0 && x.height > 0) : undefined
      pos.push(rect ? (vertical ? rect.left : rect.top) : NaN)
      if (rect) sizes.push(vertical ? rect.width : rect.height)
    }
    sizes.sort((a, b) => a - b)
    const lineSize = sizes.length ? sizes[sizes.length >> 1] : 20
    return groupLines(pos, lineSize).map(([a, b]) => [weighted[a].start, weighted[b - 1].end] as [number, number])
  }

  /** 滚动模式的打字机滚动: 与听书跟随同一套阅读焦点 (services/readingFocus) — 出字行越过舒适区下沿 (65%) 时挪回焦点线 (38%) */
  #follow() {
    const text = this.#text!
    if (this.#cursor <= 0) return
    const r = text.range(Math.max(0, this.#cursor - 1), this.#cursor)
    const rects = r?.getClientRects()
    const rect = rects?.length ? rects[rects.length - 1] : null
    if (!rect) return
    const frame = (text.doc.defaultView?.frameElement as Element | null)?.getBoundingClientRect()
    const vp = this.#host.viewportRect()
    if (!frame || !vp || vp.height <= 0) return
    const y = frame.top + rect.bottom
    if ((y - vp.top) / vp.height > FOCUS_BAND_BOTTOM) this.#host.scrollForward(y - vp.top - vp.height * FOCUS_LINE)
  }

  #beginTurn(now: number) {
    this.#cancelFrame()
    this.#setState('turning')
    const atomWait = this.#atomRevealedAt ? this.#atomRevealedAt + ATOM_MS - now : 0
    const dwell = Math.max(this.#cfg.pageDwellMs, atomWait, 0)
    clearTimeout(this.#turnTimer)
    this.#turnTimer = setTimeout(() => void this.#doTurn(), dwell)
  }

  async #doTurn() {
    this.#turnTimer = undefined
    if (this.#state !== 'turning' || !this.#text) return
    const scrolled = this.#host.scrolled()
    const atSectionEnd = this.#cursor >= this.#text.length
    if (this.#host.atBookEnd() && (atSectionEnd || !scrolled)) {
      this.#finish('book-end')
      return
    }
    this.#awaitingTurn = true
    clearTimeout(this.#watchdog)
    this.#watchdog = setTimeout(() => this.#turnTimedOut(), TURN_WATCHDOG_MS)
    try {
      await (scrolled ? this.#host.nextSection() : this.#host.nextPage())
    } catch (e) {
      console.warn('typewriter: page turn failed', e)
    }
  }

  /** 翻页后迟迟没有 relocate (翻页被锁、已到书末): 按当前可见范围恢复, 连续失败则暂停 */
  #turnTimedOut() {
    if (!this.#awaitingTurn || this.#state !== 'turning') return
    this.#awaitingTurn = false
    this.#turnFailures++
    if (this.#host.atBookEnd()) {
      this.#finish('book-end')
      return
    }
    if (this.#turnFailures >= 2) {
      this.pause()
      return
    }
    const vis = this.#host.visibleRange()
    if (vis) this.onRelocate(vis)
    if (this.#state === 'turning') {
      this.#setState('running')
      this.#loop()
    }
  }

  #finish(reason: 'book-end') {
    this.stop()
    this.#ev.onFinish?.(reason)
  }

  #fail(e: unknown) {
    console.error('typewriter failed', e)
    this.stop()
    this.#ev.onFinish?.('error', e)
  }
}

function atomToken(at: number): Token {
  return { start: at, end: at, weight: 0, kind: 'atom' }
}
