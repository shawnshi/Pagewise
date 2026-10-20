/**
 * 文石 (Onyx BOOX) FrontLightController 双色温阅读前光前端控制服务
 *
 * 替代在反射式墨水屏上造成灰阶噪点与对比度下降的 CSS 黑幕遮罩 (`rgba(0,0,0,alpha)`),
 * 直接通过原生 `com.onyx.android.sdk.api.device.FrontLightController` 控制：
 * - 前光总开关 (`openFrontLight` / `closeFrontLight`)
 * - 冷光亮度 (`ColdLight`: 0–100%)
 * - 暖光色温 (`WarmLight`: 0–100%)
 * - 阅读场景预设联动 (日间清亮 / 护眼暖纸 / 夜间纯暖 / 自然光关闭前光)
 */

import { getOnyxHardwareProfile } from './nativeReaderEnvironment.ts'

export interface OnyxFrontLightState {
  supported: boolean
  ctmSupported: boolean
  enabled: boolean
  cold: number
  warm: number
}

export type OnyxLightPresetId = 'daylight' | 'eyecare' | 'night' | 'off'

type FrontLightBridgeHost = {
  LightReadInsets?: {
    getFrontLightState?: () => string
    setFrontLightEnabled?: (enabled: boolean) => string
    setColdLight?: (percent: number) => string
    setWarmLight?: (percent: number) => string
  }
}

export function clampLightPercent(val: unknown, fallback = 0): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

class OnyxFrontLightService {
  private state: OnyxFrontLightState = {
    supported: false,
    ctmSupported: false,
    enabled: true,
    cold: 45,
    warm: 35,
  }

  private initialized = false

  private bridge(host?: FrontLightBridgeHost) {
    const target = host ?? (typeof window === 'undefined' ? undefined : (window as FrontLightBridgeHost))
    return target?.LightReadInsets
  }

  refresh(host?: FrontLightBridgeHost): OnyxFrontLightState {
    const b = this.bridge(host)
    if (typeof b?.getFrontLightState === 'function') {
      try {
        const raw = b.getFrontLightState()
        this.applyRawJson(raw)
        this.initialized = true
        return this.getState()
      } catch {
        // Fallback below
      }
    }
    const hw = getOnyxHardwareProfile()
    if (hw.status === 'available' && hw.value.boox && hw.value.frontLight) {
      this.state.supported = true
      this.state.ctmSupported = hw.value.ctmLight
    }
    this.initialized = true
    return this.getState()
  }

  getState(host?: FrontLightBridgeHost): OnyxFrontLightState {
    if (!this.initialized) {
      this.refresh(host)
    }
    return { ...this.state }
  }

  setEnabled(enabled: boolean, host?: FrontLightBridgeHost): OnyxFrontLightState {
    const next = Boolean(enabled)
    this.state.enabled = next
    try {
      const raw = this.bridge(host)?.setFrontLightEnabled?.(next)
      if (raw) this.applyRawJson(raw)
    } catch {
      // Keep local state
    }
    return { ...this.state }
  }

  setCold(percent: number, host?: FrontLightBridgeHost): OnyxFrontLightState {
    const clamped = clampLightPercent(percent, this.state.cold)
    this.state.cold = clamped
    if (clamped > 0) this.state.enabled = true
    try {
      const raw = this.bridge(host)?.setColdLight?.(clamped)
      if (raw) this.applyRawJson(raw)
    } catch {
      // Keep local state
    }
    return { ...this.state }
  }

  setWarm(percent: number, host?: FrontLightBridgeHost): OnyxFrontLightState {
    const clamped = clampLightPercent(percent, this.state.warm)
    this.state.warm = clamped
    if (clamped > 0) this.state.enabled = true
    try {
      const raw = this.bridge(host)?.setWarmLight?.(clamped)
      if (raw) this.applyRawJson(raw)
    } catch {
      // Keep local state
    }
    return { ...this.state }
  }

  applyPreset(preset: OnyxLightPresetId, host?: FrontLightBridgeHost): OnyxFrontLightState {
    switch (preset) {
      case 'off':
        return this.setEnabled(false, host)
      case 'daylight':
        this.setEnabled(true, host)
        this.setCold(50, host)
        return this.setWarm(20, host)
      case 'eyecare':
        this.setEnabled(true, host)
        this.setCold(25, host)
        return this.setWarm(55, host)
      case 'night':
        this.setEnabled(true, host)
        this.setCold(0, host)
        return this.setWarm(28, host)
    }
  }

  resetForTest(): void {
    this.initialized = false
    this.state = {
      supported: false,
      ctmSupported: false,
      enabled: true,
      cold: 45,
      warm: 35,
    }
  }

  private applyRawJson(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') return
      if (typeof parsed.supported === 'boolean') this.state.supported = parsed.supported
      if (typeof parsed.ctmSupported === 'boolean') this.state.ctmSupported = parsed.ctmSupported
      if (typeof parsed.enabled === 'boolean') this.state.enabled = parsed.enabled
      if (typeof parsed.cold === 'number') this.state.cold = clampLightPercent(parsed.cold, this.state.cold)
      if (typeof parsed.warm === 'number') this.state.warm = clampLightPercent(parsed.warm, this.state.warm)
    } catch {
      // Ignore malformed JSON
    }
  }
}

export const onyxFrontLight = new OnyxFrontLightService()
