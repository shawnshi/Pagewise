/**
 * 文石 (Onyx BOOX) Android 原生加速桥接服务 (Stage 1 ~ Stage 4)
 *
 * 1. Stage 1 (P1-1 & P2-1):
 *    - 物理翻页键 (音量加减键 / 文石保护套按键 / 蓝牙翻页器) 原生拦截与系统音量弹窗抑制
 *    - 合盖极速休眠下的阅读进度与阅读时长同步 Checkpoint (`onPause` 原子落盘)
 * 2. Stage 2 (P0-1):
 *    - Android `content://` 外部文件打开流式落盘队列与零拷贝入库 (`commitStagedExternalFile`)
 * 3. Stage 3 (P1-2):
 *    - 原生 `java.util.zip.ZipFile` 中央目录极速 EPUB 全文检索 (`searchNativeEpubText`)
 * 4. Stage 4 (P0-2):
 *    - 原生 `android.graphics.pdf.PdfRenderer` 文件描述符按页低内存栅格化 (`renderNativePdfPage`)
 */

export type HardwareTurnDirection = 'next' | 'prev'

export interface OnyxRecoveredCheckpoint {
  bookId: string
  cfi: string
  progress: number
  readingDeltaSeconds: number
  updatedAtMs: number
}

export interface OnyxStagedExternalFile {
  stagedPath: string
  fileName: string
  ext: string
  size: number
}

export interface OnyxNativeEpubSearchHit {
  href: string
  count: number
  excerpts: string[]
}

export interface OnyxNativePdfInfo {
  supported: boolean
  pageCount: number
  firstPageWidth: number
  firstPageHeight: number
}

type NativeAcceleratorHost = {
  LightReadInsets?: {
    configureHardwareKeys?: (capture: boolean, volumeKeysEnabled: boolean) => string
    stageReadingCheckpoint?: (
      bookId: string,
      cfi: string,
      progress: number,
      readingDeltaSeconds: number,
    ) => boolean
    consumeReadingCheckpoint?: () => string
    drainExternalOpenQueue?: () => string
    commitStagedExternalFile?: (stagedPath: string, targetRelPath: string) => boolean
    searchNativeEpubText?: (bookRelPath: string, query: string, maxHits: number) => string
    openNativePdfInfo?: (bookRelPath: string) => string
    renderNativePdfPage?: (
      bookRelPath: string,
      pageNumber: number,
      targetWidth: number,
      targetHeight: number,
    ) => string
  }
  __pagewiseHardwarePageTurn?: (direction: string) => void
  __pagewiseNativeExternalOpen?: () => void
}

type TurnHandler = (direction: HardwareTurnDirection) => void

class OnyxNativeAcceleratorService {
  private turnHandlers = new Set<TurnHandler>()
  private externalOpenListeners = new Set<() => void>()
  private hooksInstalled = false

  private targetHost(host?: NativeAcceleratorHost): NativeAcceleratorHost | undefined {
    return host ?? (typeof window === 'undefined' ? undefined : (window as NativeAcceleratorHost))
  }

  private bridge(host?: NativeAcceleratorHost) {
    return this.targetHost(host)?.LightReadInsets
  }

  private ensureGlobalHooks(host?: NativeAcceleratorHost): void {
    const target = this.targetHost(host)
    if (!target || this.hooksInstalled) return
    this.hooksInstalled = true
    target.__pagewiseHardwarePageTurn = (dir: string) => {
      const normalized: HardwareTurnDirection | null =
        dir === 'next' ? 'next' : dir === 'prev' ? 'prev' : null
      if (!normalized) return
      for (const fn of this.turnHandlers) {
        fn(normalized)
      }
    }
    target.__pagewiseNativeExternalOpen = () => {
      for (const fn of this.externalOpenListeners) {
        fn()
      }
    }
  }

  // ===========================================================================
  // Stage 1.1: Hardware Page-Turn Keys (Volume Up/Down, Page Up/Down)
  // ===========================================================================

  bindHardwarePageTurn(
    handler: TurnHandler,
    volumeKeysEnabled = true,
    host?: NativeAcceleratorHost,
  ): () => void {
    this.ensureGlobalHooks(host)
    this.turnHandlers.add(handler)
    try {
      this.bridge(host)?.configureHardwareKeys?.(true, Boolean(volumeKeysEnabled))
    } catch {
      // Ignore bridge error
    }
    return () => {
      this.turnHandlers.delete(handler)
      if (this.turnHandlers.size === 0) {
        try {
          this.bridge(host)?.configureHardwareKeys?.(false, Boolean(volumeKeysEnabled))
        } catch {
          // Ignore bridge error
        }
      }
    }
  }

  setHardwareKeyCapture(
    capture: boolean,
    volumeKeysEnabled = true,
    host?: NativeAcceleratorHost,
  ): void {
    try {
      this.bridge(host)?.configureHardwareKeys?.(Boolean(capture), Boolean(volumeKeysEnabled))
    } catch {
      // Ignore bridge error
    }
  }

  // ===========================================================================
  // Stage 1.2: Cover-Sleep Synchronous Reading Checkpoint
  // ===========================================================================

  stageReadingCheckpoint(
    bookId: string,
    cfi: string,
    progress: number,
    readingDeltaSeconds = 0,
    host?: NativeAcceleratorHost,
  ): boolean {
    if (!bookId || !Number.isFinite(progress)) return false
    const clampedProgress = Math.max(0, Math.min(1, progress))
    const clampedSeconds = Math.max(0, Math.round(readingDeltaSeconds))
    try {
      const fn = this.bridge(host)?.stageReadingCheckpoint
      if (typeof fn === 'function') {
        return Boolean(fn(bookId, cfi || '', clampedProgress, clampedSeconds))
      }
    } catch {
      // Ignore bridge error
    }
    return false
  }

  consumeReadingCheckpoint(host?: NativeAcceleratorHost): OnyxRecoveredCheckpoint | null {
    try {
      const raw = this.bridge(host)?.consumeReadingCheckpoint?.()
      if (!raw || raw === '{}') return null
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed.bookId !== 'string' || !parsed.bookId.trim()) return null
      return {
        bookId: parsed.bookId.trim(),
        cfi: typeof parsed.cfi === 'string' ? parsed.cfi : '',
        progress: typeof parsed.progress === 'number' && Number.isFinite(parsed.progress)
          ? Math.max(0, Math.min(1, parsed.progress))
          : 0,
        readingDeltaSeconds: typeof parsed.readingDeltaSeconds === 'number' && Number.isFinite(parsed.readingDeltaSeconds)
          ? Math.max(0, Math.round(parsed.readingDeltaSeconds))
          : 0,
        updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0,
      }
    } catch {
      return null
    }
  }

  // ===========================================================================
  // Stage 2: Android `content://` Zero-Copy External Open Queue
  // ===========================================================================

  onNativeExternalOpen(listener: () => void, host?: NativeAcceleratorHost): () => void {
    this.ensureGlobalHooks(host)
    this.externalOpenListeners.add(listener)
    return () => {
      this.externalOpenListeners.delete(listener)
    }
  }

  drainExternalOpenQueue(host?: NativeAcceleratorHost): OnyxStagedExternalFile[] {
    try {
      const raw = this.bridge(host)?.drainExternalOpenQueue?.()
      if (!raw) return []
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return []
      const out: OnyxStagedExternalFile[] = []
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        if (typeof rec.stagedPath === 'string' && rec.stagedPath && typeof rec.fileName === 'string') {
          out.push({
            stagedPath: rec.stagedPath,
            fileName: rec.fileName,
            ext: typeof rec.ext === 'string' ? rec.ext : '',
            size: typeof rec.size === 'number' ? rec.size : 0,
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  commitStagedExternalFile(
    stagedPath: string,
    targetRelPath: string,
    host?: NativeAcceleratorHost,
  ): boolean {
    if (!stagedPath || !targetRelPath) return false
    try {
      return Boolean(this.bridge(host)?.commitStagedExternalFile?.(stagedPath, targetRelPath))
    } catch {
      return false
    }
  }

  // ===========================================================================
  // Stage 3: Native ZipFile Central-Directory EPUB Full-Text Search
  // ===========================================================================

  hasNativeEpubSearch(host?: NativeAcceleratorHost): boolean {
    return typeof this.bridge(host)?.searchNativeEpubText === 'function'
  }

  searchNativeEpubText(
    bookRelPath: string,
    query: string,
    maxHits = 200,
    host?: NativeAcceleratorHost,
  ): OnyxNativeEpubSearchHit[] | null {
    const fn = this.bridge(host)?.searchNativeEpubText
    if (typeof fn !== 'function' || !bookRelPath || !query.trim()) return null
    try {
      const raw = fn(bookRelPath, query.trim(), maxHits)
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return null
      const hits: OnyxNativeEpubSearchHit[] = []
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        if (typeof rec.href === 'string' && Array.isArray(rec.excerpts)) {
          const excerpts = rec.excerpts.filter((e): e is string => typeof e === 'string')
          if (excerpts.length > 0) {
            hits.push({
              href: rec.href,
              count: excerpts.length,
              excerpts,
            })
          }
        }
      }
      return hits
    } catch {
      return null
    }
  }

  // ===========================================================================
  // Stage 4: Native Android `PdfRenderer` Low-Memory Page Rasterizer
  // ===========================================================================

  openNativePdfInfo(bookRelPath: string, host?: NativeAcceleratorHost): OnyxNativePdfInfo | null {
    const fn = this.bridge(host)?.openNativePdfInfo
    if (typeof fn !== 'function' || !bookRelPath) return null
    try {
      const raw = fn(bookRelPath)
      if (!raw || raw === '{}') return null
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.supported !== true || typeof parsed.pageCount !== 'number' || parsed.pageCount <= 0) {
        return null
      }
      return {
        supported: true,
        pageCount: parsed.pageCount,
        firstPageWidth: typeof parsed.firstPageWidth === 'number' ? parsed.firstPageWidth : 0,
        firstPageHeight: typeof parsed.firstPageHeight === 'number' ? parsed.firstPageHeight : 0,
      }
    } catch {
      return null
    }
  }

  renderNativePdfPage(
    bookRelPath: string,
    pageNumber: number,
    targetWidth: number,
    targetHeight: number,
    host?: NativeAcceleratorHost,
  ): string {
    const fn = this.bridge(host)?.renderNativePdfPage
    if (typeof fn !== 'function' || !bookRelPath || pageNumber < 1) return ''
    try {
      return fn(bookRelPath, Math.round(pageNumber), Math.round(targetWidth), Math.round(targetHeight)) || ''
    } catch {
      return ''
    }
  }

  resetForTest(): void {
    this.turnHandlers.clear()
    this.externalOpenListeners.clear()
    this.hooksInstalled = false
  }
}

export const onyxNativeAccelerator = new OnyxNativeAcceleratorService()
