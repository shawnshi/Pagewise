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
const INK_DB_NAME = 'pagewise-ink-v1'
const INK_DB_STORE = 'pages'

export interface OnyxInkBackupEntry {
  bookId: string
  pageKey: string
  strokes: OnyxInkStroke[]
}

export interface OnyxInkSaveResult {
  ok: boolean
  error?: string
}

/**
 * Ramer-Douglas-Peucker 笔画抽稀：压缩 Wacom EMR 高频采样点体积（同时保留起笔/落笔与压感拐点）。
 */
export function decimateStrokePoints(
  points: OnyxNormPoint[],
  epsilon = 0.0015,
): OnyxNormPoint[] {
  if (points.length <= 2) return points
  const sqEps = epsilon * epsilon
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    if (end - start <= 1) continue
    const ax = points[start].x
    const ay = points[start].y
    const bx = points[end].x
    const by = points[end].y
    const dx = bx - ax
    const dy = by - ay
    const segLenSq = dx * dx + dy * dy
    let maxDistSq = -1
    let maxIdx = -1
    for (let i = start + 1; i < end; i++) {
      const px = points[i].x - ax
      const py = points[i].y - ay
      let distSq: number
      if (segLenSq <= 1e-12) {
        distSq = px * px + py * py
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / segLenSq))
        const projX = px - t * dx
        const projY = py - t * dy
        distSq = projX * projX + projY * projY
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        maxIdx = i
      }
    }
    if (maxIdx > start && maxDistSq > sqEps) {
      keep[maxIdx] = 1
      stack.push([start, maxIdx], [maxIdx, end])
    }
  }

  const out: OnyxNormPoint[] = []
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i])
  }
  return out
}

function makeInkRecordId(bookId: string, pageKey: string): string {
  return `${bookId}::${pageKey}`
}

let inkDbPromise: Promise<IDBDatabase | null> | null = null

export async function closeInkDbForTest(): Promise<void> {
  const pending = inkDbPromise
  inkDbPromise = null
  if (!pending) return
  const db = await pending.catch(() => null)
  try { db?.close?.() } catch { /* ignore */ }
}

function openInkDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (inkDbPromise) return inkDbPromise
  inkDbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(INK_DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(INK_DB_STORE)) {
          db.createObjectStore(INK_DB_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          try { db.close() } catch { /* ignore */ }
          inkDbPromise = null
        }
        db.onclose = () => {
          inkDbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => {
        inkDbPromise = null
        resolve(null)
      }
      req.onblocked = () => {
        inkDbPromise = null
        resolve(null)
      }
    } catch {
      inkDbPromise = null
      resolve(null)
    }
  })
  return inkDbPromise
}

async function idbGetRecord(id: string): Promise<OnyxInkBackupEntry | null> {
  const db = await openInkDb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const tx = db.transaction(INK_DB_STORE, 'readonly')
      const req = tx.objectStore(INK_DB_STORE).get(id)
      req.onsuccess = () => {
        const val = req.result as { bookId?: string; pageKey?: string; strokes?: OnyxInkStroke[] } | undefined
        if (val && typeof val.bookId === 'string' && typeof val.pageKey === 'string' && Array.isArray(val.strokes)) {
          resolve({ bookId: val.bookId, pageKey: val.pageKey, strokes: val.strokes })
        } else {
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPutRecord(bookId: string, pageKey: string, strokes: OnyxInkStroke[]): Promise<OnyxInkSaveResult> {
  const db = await openInkDb()
  if (!db) return { ok: false, error: 'IndexedDB unavailable' }
  return new Promise(resolve => {
    try {
      const tx = db.transaction(INK_DB_STORE, 'readwrite')
      const id = makeInkRecordId(bookId, pageKey)
      const store = tx.objectStore(INK_DB_STORE)
      if (!strokes.length) {
        store.delete(id)
      } else {
        store.put({ id, bookId, pageKey, strokes, updatedAt: Date.now() })
      }
      tx.oncomplete = () => resolve({ ok: true })
      tx.onerror = () => resolve({ ok: false, error: tx.error?.message || 'IndexedDB write failed' })
      tx.onabort = () => resolve({ ok: false, error: tx.error?.message || 'IndexedDB transaction aborted' })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

async function idbListAll(): Promise<OnyxInkBackupEntry[]> {
  const db = await openInkDb()
  if (!db) return []
  return new Promise(resolve => {
    try {
      const tx = db.transaction(INK_DB_STORE, 'readonly')
      const req = tx.objectStore(INK_DB_STORE).getAll()
      req.onsuccess = () => {
        const list = Array.isArray(req.result) ? req.result : []
        resolve(
          list
            .filter((item): item is { bookId: string; pageKey: string; strokes: OnyxInkStroke[] } =>
              Boolean(item && typeof item.bookId === 'string' && typeof item.pageKey === 'string' && Array.isArray(item.strokes) && item.strokes.length > 0),
            )
            .map(item => ({ bookId: item.bookId, pageKey: item.pageKey, strokes: item.strokes })),
        )
      }
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

async function idbDeleteBook(bookId: string): Promise<void> {
  const db = await openInkDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(INK_DB_STORE, 'readwrite')
      const store = tx.objectStore(INK_DB_STORE)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return
        const val = cursor.value as { bookId?: string } | undefined
        if (val?.bookId === bookId) cursor.delete()
        cursor.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

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
  if (pts.length === 2) {
    const x0 = (pts[0].x * widthPx).toFixed(1)
    const y0 = (pts[0].y * heightPx).toFixed(1)
    const x1 = (pts[1].x * widthPx).toFixed(1)
    const y1 = (pts[1].y * heightPx).toFixed(1)
    return `M ${x0} ${y0} L ${x1} ${y1}`
  }
  const parts: string[] = [`M ${(pts[0].x * widthPx).toFixed(1)} ${(pts[0].y * heightPx).toFixed(1)}`]
  for (let i = 1; i < pts.length - 1; i++) {
    const cx = pts[i].x * widthPx
    const cy = pts[i].y * heightPx
    const mx = ((cx + pts[i + 1].x * widthPx) / 2).toFixed(1)
    const my = ((cy + pts[i + 1].y * heightPx) / 2).toFixed(1)
    parts.push(`Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${mx} ${my}`)
  }
  const last = pts[pts.length - 1]
  parts.push(`L ${(last.x * widthPx).toFixed(1)} ${(last.y * heightPx).toFixed(1)}`)
  return parts.join(' ')
}

export function findIntersectingStrokeIds(
  strokes: OnyxInkStroke[],
  eraserPoints: OnyxNormPoint[],
  radiusNorm = 0.025,
): Set<string> {
  const hitIds = new Set<string>()
  if (!eraserPoints.length || !strokes.length) return hitIds
  const r2 = radiusNorm * radiusNorm
  for (const stroke of strokes) {
    for (const sp of stroke.points) {
      let hit = false
      for (const ep of eraserPoints) {
        const dx = sp.x - ep.x
        const dy = sp.y - ep.y
        if (dx * dx + dy * dy <= r2) {
          hit = true
          break
        }
      }
      if (hit) {
        hitIds.add(stroke.id)
        break
      }
    }
  }
  return hitIds
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
  private nativeActive = false
  private tool: OnyxBrushTool = 'fountain'
  private strokeWidth = 3
  private modalSuspended = false
  private limitRect: OnyxCssRect | null = null
  private excludeRects: OnyxCssRect[] = []
  private listeners = new Set<ScribbleListener>()
  private hookInstalled = false
  private memoryCache = new Map<string, OnyxInkStroke[]>()

  private bridge(host?: ScribbleBridgeHost) {
    const target = host ?? (typeof window === 'undefined' ? undefined : (window as ScribbleBridgeHost))
    return target?.LightReadInsets
  }

  isNativeActive(): boolean {
    return this.nativeActive
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
      const raw = this.bridge(host)?.setScribbleModalSuspended?.(next)
      if (raw) {
        const parsed = JSON.parse(raw) as { active?: unknown }
        if (typeof parsed.active === 'boolean') this.nativeActive = parsed.active
      } else if (next) {
        this.nativeActive = false
      }
    } catch {
      if (next) this.nativeActive = false
    }
  }

  loadPageStrokes(bookId: string, pageKey: string): OnyxInkStroke[] {
    if (!bookId || !pageKey) return []
    const cacheKey = makeInkRecordId(bookId, pageKey)
    const cached = this.memoryCache.get(cacheKey)
    if (cached) return cached
    try {
      if (typeof localStorage === 'undefined') return []
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${bookId}:${pageKey}`)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      this.memoryCache.set(cacheKey, parsed)
      return parsed
    } catch {
      return []
    }
  }

  async loadPageStrokesAsync(bookId: string, pageKey: string): Promise<OnyxInkStroke[]> {
    if (!bookId || !pageKey) return []
    const cacheKey = makeInkRecordId(bookId, pageKey)
    const rec = await idbGetRecord(cacheKey)
    if (rec && rec.strokes.length) {
      this.memoryCache.set(cacheKey, rec.strokes)
      return rec.strokes
    }
    const legacy = this.loadPageStrokes(bookId, pageKey)
    if (legacy.length) {
      const saved = await idbPutRecord(bookId, pageKey, legacy)
      if (saved.ok) {
        try { localStorage.removeItem(`${STORAGE_PREFIX}${bookId}:${pageKey}`) } catch { /* ignore */ }
      }
      return legacy
    }
    return this.memoryCache.get(cacheKey) ?? []
  }

  private saveToLocalStorage(bookId: string, pageKey: string, copy: OnyxInkStroke[]): OnyxInkSaveResult {
    try {
      if (typeof localStorage === 'undefined') return { ok: true }
      const key = `${STORAGE_PREFIX}${bookId}:${pageKey}`
      if (!copy.length) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(copy))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  savePageStrokes(bookId: string, pageKey: string, strokes: OnyxInkStroke[]): OnyxInkSaveResult {
    if (!bookId || !pageKey) return { ok: false, error: 'Missing bookId or pageKey' }
    if (typeof indexedDB !== 'undefined') {
      return { ok: false, error: 'Use savePageStrokesAsync for IndexedDB persistence' }
    }
    const cacheKey = makeInkRecordId(bookId, pageKey)
    const copy = strokes.map(s => ({ ...s, points: [...s.points] }))
    if (!copy.length) this.memoryCache.delete(cacheKey)
    else this.memoryCache.set(cacheKey, copy)
    return this.saveToLocalStorage(bookId, pageKey, copy)
  }

  async savePageStrokesAsync(bookId: string, pageKey: string, strokes: OnyxInkStroke[]): Promise<OnyxInkSaveResult> {
    if (!bookId || !pageKey) return { ok: false, error: 'Missing bookId or pageKey' }
    const cacheKey = makeInkRecordId(bookId, pageKey)
    const copy = strokes.map(s => ({ ...s, points: [...s.points] }))
    if (!copy.length) this.memoryCache.delete(cacheKey)
    else this.memoryCache.set(cacheKey, copy)

    if (typeof indexedDB !== 'undefined') {
      const idbResult = await idbPutRecord(bookId, pageKey, copy)
      if (idbResult.ok) {
        if (typeof localStorage !== 'undefined') {
          try { localStorage.removeItem(`${STORAGE_PREFIX}${bookId}:${pageKey}`) } catch { /* ignore */ }
        }
        return idbResult
      }
      return idbResult
    }
    return this.saveToLocalStorage(bookId, pageKey, copy)
  }

  getState() {
    return {
      enabled: this.enabled,
      nativeActive: this.nativeActive,
      tool: this.tool,
      strokeWidth: this.strokeWidth,
      modalSuspended: this.modalSuspended,
      limitRect: this.limitRect,
      excludeRects: [...this.excludeRects],
    }
  }

  resetForTest(): void {
    this.enabled = false
    this.nativeActive = false
    this.tool = 'fountain'
    this.strokeWidth = 3
    this.modalSuspended = false
    this.limitRect = null
    this.excludeRects = []
    this.listeners.clear()
    this.hookInstalled = false
    this.memoryCache.clear()
    void closeInkDbForTest()
  }

  private syncToNative(host?: ScribbleBridgeHost): void {
    const b = this.bridge(host)
    if (!b?.configureScribble) {
      this.nativeActive = false
      return
    }
    const nativeEnabled = this.enabled && !this.modalSuspended && this.tool !== 'eraser' && Boolean(this.limitRect)
    const styleCode = this.tool === 'eraser' ? ONYX_STROKE_STYLE_MAP.fountain : ONYX_STROKE_STYLE_MAP[this.tool]
    const limitJson = this.limitRect ? JSON.stringify(this.limitRect) : ''
    const excludesJson = JSON.stringify(this.excludeRects)
    try {
      const raw = b.configureScribble(nativeEnabled, styleCode, this.strokeWidth, limitJson, excludesJson)
      const parsed = raw ? (JSON.parse(raw) as { active?: unknown }) : null
      this.nativeActive = Boolean(parsed?.active)
    } catch {
      this.nativeActive = false
    }
  }
}

export async function exportAllInkStrokes(): Promise<OnyxInkBackupEntry[]> {
  const byId = new Map<string, OnyxInkBackupEntry>()
  for (const rec of await idbListAll()) {
    if (rec.strokes.length) byId.set(makeInkRecordId(rec.bookId, rec.pageKey), rec)
  }
  if (typeof localStorage !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key || !key.startsWith(STORAGE_PREFIX)) continue
        const rest = key.slice(STORAGE_PREFIX.length)
        const sep = rest.indexOf(':')
        if (sep <= 0) continue
        const bookId = rest.slice(0, sep)
        const pageKey = rest.slice(sep + 1)
        const raw = localStorage.getItem(key)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length) {
          const id = makeInkRecordId(bookId, pageKey)
          if (!byId.has(id)) byId.set(id, { bookId, pageKey, strokes: parsed })
        }
      }
    } catch {
      // Ignore storage access errors
    }
  }
  return [...byId.values()]
}

export async function importAllInkStrokes(
  entries: OnyxInkBackupEntry[],
  idMap?: Map<string, string>,
): Promise<number> {
  let restored = 0
  for (const entry of entries) {
    if (!entry || typeof entry.bookId !== 'string' || typeof entry.pageKey !== 'string' || !Array.isArray(entry.strokes) || !entry.strokes.length) {
      continue
    }
    const targetBookId = idMap !== undefined ? idMap.get(entry.bookId) : entry.bookId
    if (!targetBookId) continue
    const existing = await onyxScribble.loadPageStrokesAsync(targetBookId, entry.pageKey)
    const knownIds = new Set(existing.map(s => s.id))
    const merged = [...existing]
    let added = 0
    for (const s of entry.strokes) {
      if (s && typeof s.id === 'string' && !knownIds.has(s.id) && Array.isArray(s.points) && s.points.length) {
        merged.push(s)
        knownIds.add(s.id)
        added++
      }
    }
    if (added > 0) {
      const res = await onyxScribble.savePageStrokesAsync(targetBookId, entry.pageKey, merged)
      if (!res.ok) {
        throw new Error(res.error || 'Failed to persist imported ink strokes')
      }
      restored += added
    }
  }
  return restored
}

export async function deleteBookInkStrokes(bookId: string): Promise<void> {
  if (!bookId) return
  for (const key of [...onyxScribble['memoryCache'].keys()]) {
    if (key.startsWith(`${bookId}::`)) onyxScribble['memoryCache'].delete(key)
  }
  await idbDeleteBook(bookId)
  if (typeof localStorage !== 'undefined') {
    try {
      const prefix = `${STORAGE_PREFIX}${bookId}:`
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(prefix)) toRemove.push(k)
      }
      for (const k of toRemove) localStorage.removeItem(k)
    } catch {
      // Ignore storage errors
    }
  }
}

export const onyxScribble = new OnyxScribbleService()
