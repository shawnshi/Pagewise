/**
 * 背景音的纯函数: 音量曲线、闪避、定时淡出、循环交叉淡化排程、音量漂移。
 * 不依赖 Web Audio, 单测直接覆盖 (scripts/test-ambient.mjs)。
 */

/**
 * 主音量上限: 满格时比素材基准 (-27 LUFS) 高 6 dB (约 -21 LUFS, 仍明显低于一般音乐与听书人声);
 * 默认 30% 约 -8 dB (约 -35 LUFS): 听得见, 但退在背景里。
 */
export const MASTER_MAX_GAIN = 2
/** 听书时默认压低到 0.25 (-12 dB) */
export const DEFAULT_DUCK_LEVEL = 0.25
export const DUCK_ATTACK_SEC = 0.3
export const DUCK_RELEASE_SEC = 1.5
export const FADE_SEC = 1.5
/** 定时结束前的淡出时长 */
export const TIMER_FADE_MS = 30_000
export const TIMER_CHOICES = [15, 30, 60, 90] as const

export const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** 滑块 0..1 → 增益: v^1.35 近似等响曲线, 低段更细腻 */
export function sliderToGain(v: number, max = 1): number {
  const x = clamp01(v)
  return x <= 0 ? 0 : max * Math.pow(x, 1.35)
}

export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g))
export const dbToGain = (db: number): number => Math.pow(10, db / 20)

/** setTargetAtTime 的时间常数: 约 3τ 到达目标的 95% */
export const rampTau = (seconds: number): number => Math.max(0.001, seconds / 3)

export interface TimerPlan {
  /** 距开始淡出的毫秒数 (≥0) */
  fadeStartIn: number
  /** 淡出时长 (剩余时间不足 30 s 时缩短) */
  fadeMs: number
  /** 距停止的毫秒数 (≥0) */
  stopIn: number
}

/** 定时器排程: 结束前 fadeMs 开始淡出, 到点停止 */
export function timerPlan(now: number, endsAt: number, fadeMs = TIMER_FADE_MS): TimerPlan {
  const stopIn = Math.max(0, endsAt - now)
  const fade = Math.min(fadeMs, stopIn)
  return { fadeStartIn: stopIn - fade, fadeMs: fade, stopIn }
}

/** 淡出过程中某一时刻的增益 (线性), 供 UI / 测试对照 */
export function timerGainAt(now: number, endsAt: number, fadeMs = TIMER_FADE_MS): number {
  const left = endsAt - now
  if (left <= 0) return 0
  if (left >= fadeMs) return 1
  return left / fadeMs
}

/** 剩余时间文案用: 向上取整到分钟 */
export function minutesLeft(now: number, endsAt: number | null): number | null {
  if (endsAt == null) return null
  return Math.max(0, Math.ceil((endsAt - now) / 60_000))
}

export interface LoopSegment {
  /** 第几段 (从 0 起) */
  index: number
  /** AudioContext 时间: 本段开始播放 */
  start: number
  /** 本段淡入结束 (第 0 段没有淡入, 等于 start) */
  fadeInEnd: number
  /** 本段开始淡出 = 下一段开始 */
  fadeOutStart: number
  /** 本段结束 (= fadeOutStart + crossfade) */
  end: number
}

/**
 * 双 source 交叉淡化循环: 第 k 段在 start + k·(D − X) 开始,
 * 前 X 秒等功率淡入 (第 0 段除外), 最后 X 秒淡出, 与下一段的淡入重叠。
 * 素材在文件里已做成无缝循环, 运行时再叠这一层保险, 不依赖各浏览器对编码器延迟的处理。
 */
export function loopSegments(duration: number, crossfade: number, startAt: number, fromIndex: number, count: number): LoopSegment[] {
  const x = effectiveCrossfade(duration, crossfade)
  const period = duration - x
  const out: LoopSegment[] = []
  for (let k = fromIndex; k < fromIndex + count; k++) {
    const start = startAt + k * period
    out.push({
      index: k,
      start,
      fadeInEnd: k === 0 ? start : start + x,
      fadeOutStart: start + period,
      end: start + duration,
    })
  }
  return out
}

/** 交叉淡化不超过素材时长的 1/3 */
export function effectiveCrossfade(duration: number, crossfade: number): number {
  return Math.max(0, Math.min(crossfade, duration / 3))
}

/** 等功率曲线 (cos/sin), 交给 setValueCurveAtTime; up = 淡入 */
export function equalPowerCurve(points: number, up: boolean): Float32Array {
  const n = Math.max(2, Math.floor(points))
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1)
    c[i] = up ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2)
  }
  return c
}

/**
 * 音量漂移: 每层在 ±range dB 内随机游走, 间隔 minSec–maxSec。
 * 返回下一个目标增益与等待秒数; rand 可注入以便测试。
 */
export function nextDrift(rand: () => number, rangeDb = 1.5, minSec = 20, maxSec = 60): { gain: number; afterSec: number } {
  const db = (rand() * 2 - 1) * rangeDb
  return { gain: dbToGain(db), afterSec: minSec + (maxSec - minSec) * rand() }
}

/** 文件大小文案: 1.2 MB / 640 KB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}
