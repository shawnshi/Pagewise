/**
 * 文石 (Onyx BOOX) EpdController 墨水屏刷新与波形控制前端调度器
 *
 * 负责将阅读器的翻页、跨章滚动、PDF 缩放拖拽、弹窗/抽屉开闭等交互场景
 * 映射到文石底层 `com.onyx.android.sdk.api.device.epd.EpdController` 波形状态机：
 * - 静态阅读基准：`REGAL` (兼顾无闪烁与低残影)
 * - 满 N 页翻页消残影：`GC` (全局闪黑清残影，默认每 10 页一次，可设 0/1/5/10/20)
 * - 连续滚动 / PDF 拖拽缩放：`DU` / `A2` 快速模式，停手后自动恢复 `REGAL` 高清重绘
 * - 抽屉 / 弹窗关闭：在 DOM 移除下一帧触发 `REGAL` / `GC` 消除边框阴影残影
 */

export type OnyxEpdMode = 'regal' | 'gc' | 'gu' | 'du' | 'a2'

export interface OnyxEpdStatus {
  mode: OnyxEpdMode
  defaultMode: OnyxEpdMode
  fastMode: boolean
  scene: string
  pageTurnCount: number
  gcIntervalPages: number
}

type EpdBridgeHost = {
  LightReadInsets?: {
    configureEpdGcInterval?: (pages: number) => string
    notifyEpdPageTurn?: () => string
    setEpdFastMode?: (enabled: boolean, scene: string, mode: string) => string
    repaintEpd?: (mode: string) => string
    scheduleEpdFastExit?: (delayMs: number) => void
    scheduleEpdOverlayRepaint?: (mode: string, delayMs: number) => void
    getEpdStatus?: () => string
  }
}

export const EPD_GC_INTERVAL_OPTIONS = [0, 1, 5, 10, 20] as const
export type EpdGcIntervalOption = (typeof EPD_GC_INTERVAL_OPTIONS)[number]

export function clampGcIntervalPages(val: unknown, fallback = 10): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  return Math.max(0, Math.min(100, rounded))
}

class OnyxEpdService {
  private state: OnyxEpdStatus = {
    mode: 'regal',
    defaultMode: 'regal',
    fastMode: false,
    scene: '',
    pageTurnCount: 0,
    gcIntervalPages: 10,
  }

  private fastExitTimer: ReturnType<typeof setTimeout> | null = null
  private overlayRepaintTimer: ReturnType<typeof setTimeout> | null = null

  private bridge(host?: EpdBridgeHost) {
    const target = host ?? (typeof window === 'undefined' ? undefined : (window as EpdBridgeHost))
    return target?.LightReadInsets
  }

  getStatus(): OnyxEpdStatus {
    const raw = this.bridge()?.getEpdStatus?.()
    if (raw) this.syncFromJson(raw, true)
    return { ...this.state }
  }

  configureGcInterval(pages: number, host?: EpdBridgeHost): OnyxEpdStatus {
    const safePages = clampGcIntervalPages(pages, 10)
    this.state.gcIntervalPages = safePages
    if (safePages === 0) this.state.pageTurnCount = 0
    try {
      const raw = this.bridge(host)?.configureEpdGcInterval?.(safePages)
      if (raw) this.syncFromJson(raw)
    } catch {
      // Bridge unavailable or threw; keep in-memory state consistent
    }
    return this.getStatus()
  }

  notifyPageTurn(host?: EpdBridgeHost): OnyxEpdStatus {
    const bridge = this.bridge(host)
    if (bridge?.getEpdStatus && bridge.notifyEpdPageTurn) {
      this.syncFromJson(bridge.notifyEpdPageTurn(), true)
      return this.getStatus()
    }
    if (this.state.fastMode) return this.getStatus()
    this.state.pageTurnCount += 1
    if (this.state.gcIntervalPages > 0 && this.state.pageTurnCount >= this.state.gcIntervalPages) {
      this.state.pageTurnCount = 0
      this.state.mode = 'gc'
    } else {
      this.state.mode = this.state.defaultMode
    }
    try {
      const raw = this.bridge(host)?.notifyEpdPageTurn?.()
      if (raw) this.syncFromJson(raw)
    } catch {
      // Keep local state
    }
    return this.getStatus()
  }

  enterFastMode(scene = 'scroll', mode: 'du' | 'a2' = 'du', host?: EpdBridgeHost): OnyxEpdStatus {
    if (this.fastExitTimer !== null) {
      clearTimeout(this.fastExitTimer)
      this.fastExitTimer = null
    }
    const alreadyInSameFastMode = this.state.fastMode && this.state.scene === scene && this.state.mode === mode
    this.state.fastMode = true
    this.state.scene = scene
    this.state.mode = mode
    if (!alreadyInSameFastMode || this.bridge(host)?.scheduleEpdFastExit) {
      try {
        const raw = this.bridge(host)?.setEpdFastMode?.(true, scene, mode)
        if (raw) this.syncFromJson(raw)
      } catch {
        // Ignore bridge error
      }
    }
    return this.getStatus()
  }

  scheduleExitFastMode(delayMs = 180, host?: EpdBridgeHost): void {
    if (this.fastExitTimer !== null) {
      clearTimeout(this.fastExitTimer)
    }
    const safeDelay = Number.isFinite(delayMs) ? Math.max(16, Math.min(2000, Math.round(delayMs))) : 180
    const bridge = this.bridge(host)
    if (bridge?.scheduleEpdFastExit) {
      this.fastExitTimer = null
      bridge.scheduleEpdFastExit(safeDelay)
      return
    }
    this.fastExitTimer = setTimeout(() => {
      this.fastExitTimer = null
      this.exitFastModeNow(host)
    }, safeDelay)
  }

  exitFastModeNow(host?: EpdBridgeHost): OnyxEpdStatus {
    if (this.fastExitTimer !== null) {
      clearTimeout(this.fastExitTimer)
      this.fastExitTimer = null
    }
    const wasFast = this.state.fastMode
    this.state.fastMode = false
    this.state.scene = ''
    this.state.mode = this.state.defaultMode
    if (wasFast || this.bridge(host)?.scheduleEpdFastExit) {
      try {
        const raw = this.bridge(host)?.setEpdFastMode?.(false, '', 'regal')
        if (raw) this.syncFromJson(raw)
      } catch {
        // Ignore bridge error
      }
    }
    return this.getStatus()
  }

  repaint(mode: OnyxEpdMode = 'gc', host?: EpdBridgeHost): OnyxEpdStatus {
    this.state.mode = mode
    if (mode === 'gc') {
      this.state.pageTurnCount = 0
    }
    try {
      const raw = this.bridge(host)?.repaintEpd?.(mode)
      if (raw) this.syncFromJson(raw)
    } catch {
      // Ignore bridge error
    }
    return this.getStatus()
  }

  repaintAfterOverlayClose(mode: 'regal' | 'gc' = 'regal', delayMs = 32, host?: EpdBridgeHost): void {
    if (this.overlayRepaintTimer !== null) {
      clearTimeout(this.overlayRepaintTimer)
    }
    const safeDelay = Number.isFinite(delayMs) ? Math.max(0, Math.min(2000, Math.round(delayMs))) : 32
    const bridge = this.bridge(host)
    if (bridge?.scheduleEpdOverlayRepaint) {
      this.overlayRepaintTimer = null
      bridge.scheduleEpdOverlayRepaint(mode, safeDelay)
      return
    }
    this.overlayRepaintTimer = setTimeout(() => {
      this.overlayRepaintTimer = null
      this.repaint(mode, host)
    }, safeDelay)
  }

  resetForTest(): void {
    if (this.fastExitTimer !== null) clearTimeout(this.fastExitTimer)
    if (this.overlayRepaintTimer !== null) clearTimeout(this.overlayRepaintTimer)
    this.fastExitTimer = null
    this.overlayRepaintTimer = null
    this.state = {
      mode: 'regal',
      defaultMode: 'regal',
      fastMode: false,
      scene: '',
      pageTurnCount: 0,
      gcIntervalPages: 10,
    }
  }

  private syncFromJson(raw: string, authoritative = false): void {
    try {
      const parsed = JSON.parse(raw) as Partial<OnyxEpdStatus>
      if (!parsed || typeof parsed !== 'object') return
      // Command replies can precede their UI-thread action, especially on installed old shells.
      // Only the new explicit status endpoint may replace the pending local mode intent.
      if (authoritative) {
        const modes: OnyxEpdMode[] = ['regal', 'gc', 'gu', 'du', 'a2']
        if (parsed.mode && modes.includes(parsed.mode)) this.state.mode = parsed.mode
        if (parsed.defaultMode && modes.includes(parsed.defaultMode)) this.state.defaultMode = parsed.defaultMode
        if (typeof parsed.fastMode === 'boolean') this.state.fastMode = parsed.fastMode
        if (typeof parsed.scene === 'string') this.state.scene = parsed.scene
      }
      if (typeof parsed.gcIntervalPages === 'number') {
        this.state.gcIntervalPages = clampGcIntervalPages(parsed.gcIntervalPages, this.state.gcIntervalPages)
      }
      if (typeof parsed.pageTurnCount === 'number' && parsed.pageTurnCount >= 0) {
        this.state.pageTurnCount = Math.round(parsed.pageTurnCount)
      }
    } catch {
      // Ignore malformed bridge response
    }
  }
}

export const onyxEpd = new OnyxEpdService()
