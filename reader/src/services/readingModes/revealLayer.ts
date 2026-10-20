/**
 * 打字机的「显隐层」: 只改颜色, 不动 DOM (docs/reading-modes.md §5.1)。
 *
 * 主路径: CSS Custom Highlight API。每个 iframe 文档有自己的 CSS.highlights 注册表,
 * Highlight 构造函数也必须取自 doc.defaultView。样式 (::highlight(lr-*)) 由 getReaderCSS 静态注入,
 * 这里只增删 Highlight 里的 Range, 浏览器只重绘、不重新布局。
 *
 * 回退路径 (Chrome < 105 / Safari < 17.2 的 WebView): 在 foliate overlayer (盖在正文上的 SVG) 里
 * 用正文背景色画不透明矩形遮住「光标到本页末」; 淡显用半透明矩形, 墨迹未干画成强调色下划线。
 *
 * 图片等原子块用 data-lr-pending 属性 + 静态 CSS visibility:hidden 隐藏 (不改尺寸, CFI 不含属性)。
 */

export interface RevealColors {
  bg: string
  fg: string
  link: string
}

export type RevealMode = 'highlight' | 'overlay'

export const HL_HIDDEN = 'lr-tw-hidden'
export const HL_GHOST = 'lr-tw-ghost'
export const HL_FRESH = 'lr-tw-fresh'
export const PENDING_ATTR = 'data-lr-pending'
const MASK_KEY = 'lr-tw-mask'
const SVG_NS = 'http://www.w3.org/2000/svg'

export interface RevealLayer {
  readonly mode: RevealMode
  setGhost(on: boolean): void
  /** hidden: 要隐藏 (或淡显) 的范围; fresh: 墨迹未干的范围; null 为清除 */
  update(hidden: Range | null, fresh: Range | null): void
  setPending(el: Element, pending: boolean): void
  /** 回退路径下颜色随主题变化时重画 */
  refresh(): void
  dispose(): void
}

export function supportsHighlights(win: Window | null | undefined): boolean {
  const w = win as any
  return !!(w && typeof w.Highlight === 'function' && w.CSS?.highlights)
}

/** 各阅读模式的高亮前缀: 打字机 / 仿生阅读 (伴读的 lr-dj-* 不归这里管, 不能顺手删掉) */
export const TYPEWRITER_PREFIX = 'lr-tw-'
export const READING_MODE_PREFIXES = ['lr-tw-', 'lr-wg-'] as const

/**
 * 兜底清理: 删除文档里指定前缀的高亮 (默认只删打字机的) 和待显示标记 (卸载、换书、出错时调用, 保证不会残留透明正文)。
 * 只按前缀删, 不碰其他功能 (伴读等) 注册的高亮。
 */
export function clearReadingModeMarks(doc: Document | null | undefined, prefixes: readonly string[] = [TYPEWRITER_PREFIX]) {
  if (!doc) return
  try {
    const reg = (doc.defaultView as any)?.CSS?.highlights
    if (reg) {
      for (const name of Array.from(reg.keys()) as string[]) {
        if (prefixes.some(p => name.startsWith(p))) reg.delete(name)
      }
    }
  } catch { /* 文档已卸载 */ }
  if (!prefixes.includes(TYPEWRITER_PREFIX)) return
  try {
    for (const el of Array.from(doc.querySelectorAll(`[${PENDING_ATTR}]`))) el.removeAttribute(PENDING_ATTR)
  } catch { /* 文档已卸载 */ }
}

export function createRevealLayer(
  doc: Document,
  opts: {
    /** foliate overlayer (view.renderer.getContents()[0].overlayer), 回退路径用 */
    getOverlayer: () => any
    colors: () => RevealColors
    ghost: boolean
    /** 测试 / 排障: 强制走回退路径 */
    forceOverlay?: boolean
  },
): RevealLayer {
  const win = doc.defaultView as any
  if (!opts.forceOverlay && supportsHighlights(win)) return highlightLayer(doc, win, opts.ghost)
  return overlayLayer(doc, opts)
}

function setPendingAttr(el: Element, pending: boolean) {
  if (pending) {
    if (!el.hasAttribute(PENDING_ATTR)) el.setAttribute(PENDING_ATTR, '')
  } else if (el.hasAttribute(PENDING_ATTR)) el.removeAttribute(PENDING_ATTR)
}

function highlightLayer(doc: Document, win: any, ghostInit: boolean): RevealLayer {
  const reg = win.CSS.highlights
  const hidden = new win.Highlight()
  const fresh = new win.Highlight()
  // 隐藏层优先级最高: 盖过墨迹、词块着色等其他高亮
  try { hidden.priority = 100 } catch { /* 旧实现无 priority */ }
  try { fresh.priority = 50 } catch { /* 同上 */ }
  let ghost = ghostInit
  const register = () => {
    reg.delete(ghost ? HL_HIDDEN : HL_GHOST)
    reg.set(ghost ? HL_GHOST : HL_HIDDEN, hidden)
    reg.set(HL_FRESH, fresh)
  }
  register()
  return {
    mode: 'highlight',
    setGhost(on) {
      if (on === ghost) return
      ghost = on
      register()
    },
    update(h, f) {
      hidden.clear()
      if (h && !h.collapsed) hidden.add(h)
      fresh.clear()
      if (f && !f.collapsed) fresh.add(f)
    },
    setPending: setPendingAttr,
    refresh() { /* 颜色在 getReaderCSS 里, 随主题自动变化 */ },
    dispose() {
      try {
        hidden.clear()
        fresh.clear()
        if (reg.get(HL_HIDDEN) === hidden) reg.delete(HL_HIDDEN)
        if (reg.get(HL_GHOST) === hidden) reg.delete(HL_GHOST)
        if (reg.get(HL_FRESH) === fresh) reg.delete(HL_FRESH)
      } catch { /* 文档已卸载 */ }
      clearReadingModeMarks(doc)
    },
  }
}

function overlayLayer(
  doc: Document,
  opts: { getOverlayer: () => any; colors: () => RevealColors; ghost: boolean },
): RevealLayer {
  let hidden: Range | null = null
  let fresh: Range | null = null
  let ghost = opts.ghost
  // overlayer.add 会对传入的 range 取 rect; 给它一个落在文本节点里的折叠 range, 实际矩形由 draw 自己算
  const anchor = doc.createRange()
  const firstText = doc.body ? doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT).nextNode() : null
  if (firstText) anchor.setStart(firstText, 0)
  anchor.collapse(true)

  const draw = () => {
    const g = document.createElementNS(SVG_NS, 'g')
    const c = opts.colors()
    if (hidden && !hidden.collapsed) {
      for (const r of Array.from(hidden.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue
        const el = document.createElementNS(SVG_NS, 'rect')
        el.setAttribute('x', String(r.left - 1))
        el.setAttribute('y', String(r.top - 1))
        el.setAttribute('width', String(r.width + 2))
        el.setAttribute('height', String(r.height + 2))
        el.setAttribute('fill', c.bg)
        if (ghost) el.setAttribute('fill-opacity', '0.82')
        g.append(el)
      }
    }
    if (fresh && !fresh.collapsed) {
      for (const r of Array.from(fresh.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue
        const el = document.createElementNS(SVG_NS, 'rect')
        el.setAttribute('x', String(r.left))
        el.setAttribute('y', String(r.bottom - 2))
        el.setAttribute('width', String(r.width))
        el.setAttribute('height', '2')
        el.setAttribute('fill', c.link)
        g.append(el)
      }
    }
    return g
  }
  const paint = () => {
    const ov = opts.getOverlayer()
    if (!ov) return
    try {
      if (!hidden && !fresh) ov.remove(MASK_KEY)
      else ov.add(MASK_KEY, anchor, draw)
    } catch { /* overlayer 随分节卸载 */ }
  }
  return {
    mode: 'overlay',
    setGhost(on) {
      if (on === ghost) return
      ghost = on
      paint()
    },
    update(h, f) {
      hidden = h
      fresh = f
      paint()
    },
    setPending: setPendingAttr,
    refresh: paint,
    dispose() {
      hidden = null
      fresh = null
      try { opts.getOverlayer()?.remove(MASK_KEY) } catch { /* 已卸载 */ }
      clearReadingModeMarks(doc)
    },
  }
}
