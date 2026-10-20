/**
 * 文石 (Onyx BOOX) onyxsdk-pen / onyxsdk-scribble 低延迟手写与笔迹管理服务
 *
 * 架构职责：
 * 1. 原生硬件直写同步：通过 `LightReadInsets.configureScribble` 将画布矩形 (`limitRect`) 与
 *    工具栏排除矩形 (`excludeRects`) 同步给 Android 层 `TouchHelper`，使 Wacom EMR 电磁笔在书写时
 *    直接驱动墨水屏 EPD 帧缓冲 (<20ms 延迟)。
 * 2. 弹窗与生命周期安全锁：任何抽屉、弹窗或菜单打开时，调用 `setScribbleModalSuspended(true)`
 *    立即释放底层 `TouchHelper` 拦截，确保 UI 按钮可正常点击。
 * 3. 抬笔矢量合入与持久化：接收 `window.__pagewiseOnyxScribbleEvent` 回传的原始压感点序列，
 *    归一化为页面相对坐标 `[0..1]`，支持压感笔迹 SVG 渲染、笔尾/轨迹橡皮擦碰撞擦除及本地持久化。
 */

export type OnyxBrushTool = 'fountain' | 'pencil' | 'marker' | 'eraser'

export const ONYX_STROKE_STYLE_MAP: Record<Exclude<OnyxBrushTool, 'eraser'>, number> = {
  pencil: 0,
  fountain: 1,
  marker: 2,
}

export interface OnyxTouchPointCss {
  x: number
  y: number
  p: number
  s?: number
  t?: number
}

export interface OnyxNormPoint {
  /** 页面相对横坐标 [0..1] */
  x: number
  /** 页面相对纵坐标 [0..1] */
  y: number
  /** 压感 [0..1] */
  p: number
}

export interface OnyxInkStroke {
  id: string
  tool: Exclude<OnyxBrushTool, 'eraser'>
  width: number
  points: OnyxNormPoint[]
  createdAt: number
}

export interface OnyxCssRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface OnyxNativeScribbleEvent {
  kind: 'stroke' | 'erase'
  style?: number
  width?: number
  points: OnyxTouchPointCss[]
}

type ScribbleBridgeHost = {
  LightReadInsets?: {
    configureScribble?: (
      enabled: boolean,
      style: number,
      strokeWidth: number,
      limitRectJson: string,
      excludeRectsJson: string,
    ) => string
    setScribbleModalSuspended?: (suspended: boolean) => string
  }
  __pagewiseOnyxScribbleEvent?: (payload: OnyxNativeScribbleEvent | string) => void
}

const STORAGE_PREFIX = 'pagewise-onyx-ink:v1:'

export function normalizePointsToRect(
  points: OnyxTouchPointCss[],
  rect: OnyxCssRect,
): OnyxNormPoint[] {
  const w = rect.right - rect.left
  const h = rect.bottom - rect.top
  if (w <= 1 || h <= 1) return []
  const out: OnyxNormPoint[] = []
  for (const pt of points) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue
    const nx = Math.max(0, Math.min(1, (pt.x - rect.left) / w))
    const ny = Math.max(0, Math.min(1, (pt.y - rect.top) / h))
    const np = Number.isFinite(pt.p) ? Math.max(0.05, Math.min(1, pt.p)) : 0.5
    out.push({
      x: Math.round(nx * 10000) / 10000,
      y: Math.round(ny * 10000) / 10000,
      p: Math.round(np * 1000) / 1000,
    })
  }
  return out
}

export function strokeToSvgPath(stroke: OnyxInkStroke, widthPx = 1000, heightPx = 1000): string {
  const pts = stroke.points
  if (!pts.length) return ''
  if (pts.length === 1) {
    const x = (pts[0].x * widthPx).toFixed(1)
    const y = (pts[0].y * heightPx).toFixed(1)
    return `M ${x} ${y} L ${x} ${y}`
  }
  const parts: string[] = []
  for (let i = 0; i < pts.length; i++) {
    const x = (pts[i].x * widthPx).toFixed(1)
    const y = (pts[i].y * heightPx).toFixed(1)
    parts.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)
  }
  return parts.join(' ')
}

export function eraseIntersectingStrokes(
  strokes: OnyxInkStroke[],
  eraserPoints: OnyxNormPoint[],
  radiusNorm = 0.025,
): { remaining: OnyxInkStroke[]; removedIds: string[] } {
  if (!eraserPoints.length || !strokes.length) {
    return { remaining: strokes, removedIds: [] }
  }
  const r2 = radiusNorm * radiusNorm
  const remaining: OnyxInkStroke[] = []
  const removedIds: string[] = []

  for (const stroke of strokes) {
    let hit = false
    for (const sp of stroke.points) {
      for (const ep of eraserPoints) {
        const dx = sp.x - ep.x
        const dy = sp.y - ep.y
        if (dx * dx + dy * dy <= r2) {
          hit = true
          break
        }
      }
      if (hit) break
    }
    if (hit) removedIds.push(stroke.id)
    else remaining.push(stroke)
  }
  return { remaining, removedIds }
}

type ScribbleListener = (event: OnyxNativeScribbleEvent) => void

class OnyxScribbleService {
  private enabled = false
  private tool: OnyxBrushTool = 'fountain'
  private strokeWidth = 3
  private modalSuspended = false
  private limitRect: OnyxCssRect | null = null
  private excludeRects: OnyxCssRect[] = []
  private listeners = new Set<ScribbleListener>()
  private hookInstalled = false

  private bridge(host?: ScribbleBridgeHost) {
    const target = host ?? (typeof window === 'undefined' ? undefined : (window as ScribbleBridgeHost))
    return target?.LightReadInsets
  }

  installGlobalHook(host?: ScribbleBridgeHost): void {
    const target = host ?? (typeof window === 'undefined' ? undefined : (window as ScribbleBridgeHost))
    if (!target || this.hookInstalled) return
    this.hookInstalled = true
    target.__pagewiseOnyxScribbleEvent = (payload: OnyxNativeScribbleEvent | string) => {
      try {
        const parsed: OnyxNativeScribbleEvent = typeof payload === 'string' ? JSON.parse(payload) : payload
        if (!parsed || !Array.isArray(parsed.points)) return
        for (const listener of this.listeners) {
          listener(parsed)
        }
      } catch {
        // Ignore malformed native scribble event
      }
    }
  }

  subscribe(listener: ScribbleListener, host?: ScribbleBridgeHost): () => void {
    this.installGlobalHook(host)
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  configure(
    opts: {
      enabled?: boolean
      tool?: OnyxBrushTool
      strokeWidth?: number
      limitRect?: OnyxCssRect | null
      excludeRects?: OnyxCssRect[]
    },
    host?: ScribbleBridgeHost,
  ): void {
    if (opts.enabled !== undefined) this.enabled = Boolean(opts.enabled)
    if (opts.tool !== undefined) this.tool = opts.tool
    if (opts.strokeWidth !== undefined && Number.isFinite(opts.strokeWidth)) {
      this.strokeWidth = Math.max(1, Math.min(24, opts.strokeWidth))
    }
    if (opts.limitRect !== undefined) this.limitRect = opts.limitRect
    if (opts.excludeRects !== undefined) this.excludeRects = opts.excludeRects
    this.syncToNative(host)
  }

  setModalSuspended(suspended: boolean, host?: ScribbleBridgeHost): void {
    const next = Boolean(suspended)
    if (this.modalSuspended === next) return
    this.modalSuspended = next
    try {
      this.bridge(host)?.setScribbleModalSuspended?.(next)
    } catch {
      // Ignore bridge error
    }
  }

  loadPageStrokes(bookId: string, pageKey: string): OnyxInkStroke[] {
    if (!bookId || !pageKey) return []
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${bookId}:${pageKey}`)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  savePageStrokes(bookId: string, pageKey: string, strokes: OnyxInkStroke[]): void {
    if (!bookId || !pageKey) return
    try {
      const key = `${STORAGE_PREFIX}${bookId}:${pageKey}`
      if (!strokes.length) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(strokes))
      }
    } catch {
      // Ignore storage quota or private mode error
    }
  }

  getState() {
    return {
      enabled: this.enabled,
      tool: this.tool,
      strokeWidth: this.strokeWidth,
      modalSuspended: this.modalSuspended,
      limitRect: this.limitRect,
      excludeRects: [...this.excludeRects],
    }
  }

  resetForTest(): void {
    this.enabled = false
    this.tool = 'fountain'
    this.strokeWidth = 3
    this.modalSuspended = false
    this.limitRect = null
    this.excludeRects = []
    this.listeners.clear()
    this.hookInstalled = false
  }

  private syncToNative(host?: ScribbleBridgeHost): void {
    const b = this.bridge(host)
    if (!b?.configureScribble) return
    const nativeEnabled = this.enabled && !this.modalSuspended && this.tool !== 'eraser' && Boolean(this.limitRect)
    const styleCode = this.tool === 'eraser' ? ONYX_STROKE_STYLE_MAP.fountain : ONYX_STROKE_STYLE_MAP[this.tool]
    const limitJson = this.limitRect ? JSON.stringify(this.limitRect) : ''
    const excludesJson = JSON.stringify(this.excludeRects)
    try {
      b.configureScribble(nativeEnabled, styleCode, this.strokeWidth, limitJson, excludesJson)
    } catch {
      // Ignore bridge error
    }
  }
}

export const onyxScribble = new OnyxScribbleService()
