/**
 * 点睛阅读的绘制层 (DOM), docs/dianjing-reading.md §3.2: 不改 DOM。
 *
 * 主路径: CSS Custom Highlight API —— Highlight 构造函数与 CSS.highlights 都取自 doc.defaultView
 * (每个 iframe 文档一套注册表), 样式 ::highlight(lr-dj-*) 由 getReaderCSS 静态注入。
 * 注 (圆点角标) 始终画在 foliate overlayer 上 (SVG, 不接收指针事件)。
 * 回退路径 (Chrome < 105 / Safari < 17.2 的 WebView): 要句、概念也画在 overlayer 上
 * (实线 / 点线下划线), 概念不改字色。
 *
 * 注意: 打字机的兜底清理 clearReadingModeMarks() 会删掉所有 `lr-` 开头的 Highlight;
 * 这里每次 paint / ensure() 都会把自己的 Highlight 重新登记回去。
 */
import { DJ_PRIORITY, HL_BAND, HL_FLASH, HL_KEY, HL_TERM, type DjColors } from './theme.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const OV_MARKS = 'lr-dj-marks'
const OV_NOTES = 'lr-dj-notes'

export interface DjPaint {
  keys: Range[]
  terms: Range[]
  notes: Range[]
}

export interface DjLayer {
  readonly mode: 'highlight' | 'overlay'
  readonly doc: Document
  paint(p: DjPaint): void
  /** 速读视图: 要句加底色 (null 清除) */
  setBand(ranges: Range[] | null): void
  /** 跳转后让一句闪 1 秒 */
  flash(range: Range, ms?: number): void
  /** 主题变化 (回退路径重画) */
  refresh(): void
  /** 若 Highlight 被别人从注册表删掉, 重新登记 */
  ensure(): void
  dispose(): void
}

export function supportsHighlightApi(win: unknown): boolean {
  const w = win as any
  return !!(w && typeof w.Highlight === 'function' && w.CSS?.highlights)
}

/** 删除文档里所有点睛的 Highlight 与 overlayer 图层 (关闭功能 / 卸载时兜底) */
export function clearDianjingMarks(doc: Document | null | undefined, overlayer?: any) {
  if (!doc) return
  try {
    const reg = (doc.defaultView as any)?.CSS?.highlights
    if (reg) for (const name of Array.from(reg.keys()) as string[]) if (name.startsWith('lr-dj-')) reg.delete(name)
  } catch { /* 已卸载 */ }
  try {
    overlayer?.remove(OV_MARKS)
    overlayer?.remove(OV_NOTES)
  } catch { /* 已卸载 */ }
}

const rectsOf = (r: Range): DOMRect[] => {
  try { return Array.from(r.getClientRects()).filter(x => x.width > 0 && x.height > 0) } catch { return [] }
}

export function createDjLayer(
  doc: Document,
  opts: {
    getOverlayer: () => any
    colors: () => DjColors
    forceOverlay?: boolean
  },
): DjLayer {
  const win = doc.defaultView as any
  const useHl = !opts.forceOverlay && supportsHighlightApi(win)
  let state: DjPaint = { keys: [], terms: [], notes: [] }
  let band: Range[] | null = null
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  // overlayer.add 需要一个 range 取 rect; 给折叠的锚点 (零宽, 不会被 overlayer.hitTest 命中),
  // 实际图形由 draw 根据我们自己的 range 计算 (overlayer.redraw 时也会重新调用 draw)
  const anchor = doc.createRange()
  const firstText = doc.body ? doc.createTreeWalker(doc.body, 0x4).nextNode() : null
  if (firstText) anchor.setStart(firstText, 0)
  anchor.collapse(true)

  const hl: Record<string, any> = {}
  if (useHl) {
    const make = (name: string, priority: number) => {
      const h = new win.Highlight()
      try { h.priority = priority } catch { /* 旧实现无 priority */ }
      hl[name] = h
    }
    make(HL_BAND, DJ_PRIORITY.band)
    make(HL_KEY, DJ_PRIORITY.key)
    make(HL_TERM, DJ_PRIORITY.term)
    make(HL_FLASH, DJ_PRIORITY.flash)
  }

  const ensure = () => {
    if (!useHl) return
    try {
      const reg = win.CSS.highlights
      for (const [name, h] of Object.entries(hl)) if (reg.get(name) !== h) reg.set(name, h)
    } catch { /* 已卸载 */ }
  }

  const fill = (name: string, ranges: Range[]) => {
    const h = hl[name]
    if (!h) return
    h.clear()
    for (const r of ranges) if (r && !r.collapsed) h.add(r)
  }

  const svg = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    return el
  }

  /** 回退: 要句实线、概念点线 */
  const drawMarks = () => {
    const g = svg('g', {})
    const c = opts.colors()
    for (const r of state.keys) {
      for (const rect of rectsOf(r)) {
        const w = Math.max(1.5, rect.height * 0.08)
        g.append(svg('rect', { x: rect.left, y: rect.bottom - w, width: rect.width, height: w, fill: c.key }))
      }
    }
    for (const r of state.terms) {
      for (const rect of rectsOf(r)) {
        g.append(svg('line', {
          x1: rect.left, x2: rect.right, y1: rect.bottom - 0.5, y2: rect.bottom - 0.5,
          stroke: c.term, 'stroke-width': 1.2, 'stroke-dasharray': '1.5 2',
        }))
      }
    }
    if (band) {
      for (const r of band) {
        for (const rect of rectsOf(r)) {
          g.append(svg('rect', { x: rect.left, y: rect.top, width: rect.width, height: rect.height, fill: c.key, 'fill-opacity': c.eink ? 0 : 0.1 }))
        }
      }
    }
    return g
  }

  /** 注: 末字右上角的小圆点 (墨水屏空心) */
  const drawNotes = () => {
    const g = svg('g', {})
    const c = opts.colors()
    for (const r of state.notes) {
      const rects = rectsOf(r)
      const last = rects[rects.length - 1]
      if (!last) continue
      const rad = Math.max(2, last.height * 0.15)
      g.append(svg('circle', {
        cx: last.right + rad * 0.6, cy: last.top + rad * 0.9, r: rad,
        ...(c.eink ? { fill: 'none', stroke: '#000', 'stroke-width': 1 } : { fill: c.note }),
      }))
    }
    return g
  }

  const paintOverlay = () => {
    const ov = opts.getOverlayer()
    if (!ov) return
    try {
      if (!useHl) {
        if (state.keys.length || state.terms.length || band?.length) ov.add(OV_MARKS, anchor, drawMarks)
        else ov.remove(OV_MARKS)
      }
      if (state.notes.length) ov.add(OV_NOTES, anchor, drawNotes)
      else ov.remove(OV_NOTES)
    } catch { /* overlayer 随分节卸载 */ }
  }

  return {
    mode: useHl ? 'highlight' : 'overlay',
    doc,
    paint(p) {
      state = p
      if (useHl) {
        ensure()
        fill(HL_KEY, p.keys)
        fill(HL_TERM, p.terms)
      }
      paintOverlay()
    },
    setBand(ranges) {
      band = ranges && ranges.length ? ranges : null
      if (useHl) {
        ensure()
        fill(HL_BAND, band ?? [])
      } else paintOverlay()
    },
    flash(range, ms = 1000) {
      clearTimeout(flashTimer)
      if (useHl) {
        ensure()
        fill(HL_FLASH, [range])
        flashTimer = setTimeout(() => fill(HL_FLASH, []), ms)
      } else {
        const ov = opts.getOverlayer()
        try {
          ov?.add('lr-dj-flash', range, (rects: any[]) => {
            const g = svg('g', { fill: opts.colors().key, 'fill-opacity': 0.15 })
            for (const r of rects) g.append(svg('rect', { x: r.left, y: r.top, width: r.width, height: r.height }))
            return g
          })
          flashTimer = setTimeout(() => { try { ov?.remove('lr-dj-flash') } catch { /* 已卸载 */ } }, ms)
        } catch { /* 已卸载 */ }
      }
    },
    refresh: paintOverlay,
    ensure,
    dispose() {
      clearTimeout(flashTimer)
      try {
        const reg = win?.CSS?.highlights
        for (const [name, h] of Object.entries(hl)) {
          h.clear()
          if (reg?.get(name) === h) reg.delete(name)
        }
      } catch { /* 已卸载 */ }
      try {
        const ov = opts.getOverlayer()
        ov?.remove(OV_MARKS)
        ov?.remove(OV_NOTES)
        ov?.remove('lr-dj-flash')
      } catch { /* 已卸载 */ }
      state = { keys: [], terms: [], notes: [] }
      band = null
    },
  }
}

// ---- 命中检测 ----

/** 视口坐标处的插入点 (caretPositionFromPoint / caretRangeFromPoint 二选一) */
export function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as any
  try {
    if (typeof d.caretPositionFromPoint === 'function') {
      const p = d.caretPositionFromPoint(x, y)
      if (p?.offsetNode) return { node: p.offsetNode, offset: p.offset }
    }
    if (typeof d.caretRangeFromPoint === 'function') {
      const r = d.caretRangeFromPoint(x, y)
      if (r?.startContainer) return { node: r.startContainer, offset: r.startOffset }
    }
  } catch { /* 坐标越界 */ }
  return null
}

const near = (rects: DOMRect[], x: number, y: number, pad: number) =>
  rects.some(r => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad)

export interface HitTarget<T> { range: Range; data: T }

/**
 * 轻点命中: 先用插入点判断落在哪个 range 里 (再确认点确实在该 range 的矩形附近, 排除点在行尾空白),
 * 插入点不可用时退回矩形包含测试 (触屏手指有误差, 留 pad 像素余量)。
 * 注的圆点在末字右上角, 额外按圆点位置测试。
 */
export function hitTest<T>(
  doc: Document,
  x: number,
  y: number,
  targets: Array<HitTarget<T>>,
  opts: { pad?: number; dotTargets?: Array<HitTarget<T>> } = {},
): HitTarget<T> | null {
  const pad = opts.pad ?? 6
  const caret = caretAt(doc, x, y)
  if (caret) {
    for (const t of targets) {
      try {
        if (t.range.isPointInRange(caret.node, caret.offset) && near(rectsOf(t.range), x, y, pad)) return t
      } catch { /* 不同文档 */ }
    }
  }
  for (const t of targets) if (near(rectsOf(t.range), x, y, 0)) return t
  for (const t of opts.dotTargets ?? []) {
    const rects = rectsOf(t.range)
    const last = rects[rects.length - 1]
    if (!last) continue
    const rad = Math.max(2, last.height * 0.15)
    const cx = last.right + rad * 0.6
    const cy = last.top + rad * 0.9
    if (Math.hypot(x - cx, y - cy) <= rad + Math.max(pad, 10)) return t
  }
  return null
}
