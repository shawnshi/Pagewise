/**
 * 背景音引擎: 单个 AudioContext (第一次用户手势里才创建), 混音链
 *
 *   layer source → driftGain (缓慢漂移 ±1.5 dB) → layerGain (每层音量)
 *     → master (主音量) → duck (听书时压低) → fade (淡入淡出 / 定时) → 安全限幅 → destination
 *
 * 各级增益分开, 自动化互不覆盖。引擎不碰 Vue / 设置, 由 index.ts 的控制器驱动。
 */
import type { SynthKind, SynthParams } from './dsp.ts'
import { createSynthNode, type SynthNode } from './worklet.ts'
import {
  DEFAULT_DUCK_LEVEL,
  DUCK_ATTACK_SEC,
  DUCK_RELEASE_SEC,
  FADE_SEC,
  MASTER_MAX_GAIN,
  equalPowerCurve,
  effectiveCrossfade,
  loopSegments,
  nextDrift,
  rampTau,
  sliderToGain,
} from './math.ts'

export type EngineSource =
  | { type: 'synth'; kind: SynthKind; params?: SynthParams }
  | { type: 'loop'; buffer: AudioBuffer }
  | { type: 'playlist'; urls: string[] }

export interface EngineLayer {
  id: string
  /** 滑块值 0..1 */
  volume: number
  source: EngineSource
}

interface LiveLayer {
  id: string
  gain: GainNode
  drift: GainNode
  synth?: SynthNode
  setParams(p: SynthParams): void
  pause(): void
  resume(): void
  /** 立即停止并断开 */
  kill(): void
}

const LOOP_CROSSFADE_SEC = 2.5
const TRACK_FADE_SEC = 3

function createContext(): AudioContext | null {
  const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
  if (!AC) return null
  try {
    // playback: 更大的缓冲, 更省电; 背景音不在乎延迟
    return new AC({ latencyHint: 'playback' }) as AudioContext
  } catch {
    try {
      return new AC() as AudioContext
    } catch {
      return null
    }
  }
}

function setTarget(param: AudioParam, value: number, ctx: BaseAudioContext, seconds: number): void {
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.setTargetAtTime(value, now, rampTau(seconds))
}

function linearTo(param: AudioParam, value: number, ctx: BaseAudioContext, seconds: number): void {
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(value, now + Math.max(0.01, seconds))
}

export class AmbientEngine {
  ctx: AudioContext | null = null
  mode: 'worklet' | 'script' | null = null
  private master: GainNode | null = null
  private duckNode: GainNode | null = null
  private fade: GainNode | null = null
  private layers = new Map<string, LiveLayer>()
  private masterValue = 0.3
  private duckLevel = DEFAULT_DUCK_LEVEL
  private ducked = false
  /** 每次 start / stop 自增, 让过期的异步收尾 (淡出后停止) 失效 */
  private epoch = 0
  private stopTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 创建 / 唤醒 AudioContext。必须在用户手势 (click / keydown) 的同步调用栈里调用一次,
   * 否则浏览器的自动播放策略会让它保持 suspended。
   */
  ensureContext(): AudioContext | null {
    if (!this.ctx) {
      const ctx = createContext()
      if (!ctx) return null
      this.ctx = ctx
      this.master = ctx.createGain()
      this.duckNode = ctx.createGain()
      this.fade = ctx.createGain()
      this.master.gain.value = sliderToGain(this.masterValue, MASTER_MAX_GAIN)
      this.duckNode.gain.value = this.ducked ? this.duckLevel : 1
      this.fade.gain.value = 0
      this.master.connect(this.duckNode)
      this.duckNode.connect(this.fade)
      // 安全限幅: 多层叠加 + 主音量满格时偶发的峰值不削波 (正常音量下不起作用)
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -6
      limiter.knee.value = 3
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      this.fade.connect(limiter)
      limiter.connect(ctx.destination)
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
    return this.ctx
  }

  get running(): boolean {
    return this.layers.size > 0
  }

  /**
   * 换成一组新层: 已在播时新旧层交叉淡化, 否则整体淡入。
   * 返回前所有新层都已接入 (合成层需要等 Worklet 模块加载)。
   */
  async start(layers: EngineLayer[], fadeSec = FADE_SEC): Promise<void> {
    const ctx = this.ensureContext()
    if (!ctx || !this.master || !this.fade) throw new Error('AudioContext unavailable')
    const epoch = ++this.epoch
    clearTimeout(this.stopTimer)
    const wasRunning = this.running && this.fade.gain.value > 0.001
    const old = [...this.layers.values()]
    this.layers.clear()

    const created: LiveLayer[] = []
    for (const l of layers) {
      const live = await this.createLayer(ctx, l)
      if (epoch !== this.epoch) {
        // start 期间又被 stop / start 取代
        live.kill()
        created.forEach(c => c.kill())
        return
      }
      created.push(live)
    }
    for (const live of created) {
      this.layers.set(live.id, live)
      const target = sliderToGain(layers.find(l => l.id === live.id)?.volume ?? 0)
      live.gain.gain.setValueAtTime(0, ctx.currentTime)
      setTarget(live.gain.gain, target, ctx, wasRunning ? fadeSec : 0.05)
    }
    for (const o of old) {
      setTarget(o.gain.gain, 0, ctx, fadeSec)
      setTimeout(() => o.kill(), fadeSec * 1000 + 200)
    }
    if (!wasRunning) {
      this.fade.gain.cancelScheduledValues(ctx.currentTime)
      this.fade.gain.setValueAtTime(0, ctx.currentTime)
      linearTo(this.fade.gain, 1, ctx, fadeSec)
    } else {
      linearTo(this.fade.gain, 1, ctx, 0.3)
    }
  }

  private async createLayer(ctx: AudioContext, l: EngineLayer): Promise<LiveLayer> {
    const gain = ctx.createGain()
    const drift = ctx.createGain()
    gain.gain.value = 0
    drift.connect(gain)
    gain.connect(this.master!)
    let driftTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleDrift = () => {
      const d = nextDrift(Math.random)
      setTarget(drift.gain, d.gain, ctx, 8)
      driftTimer = setTimeout(scheduleDrift, d.afterSec * 1000)
    }
    driftTimer = setTimeout(scheduleDrift, (10 + Math.random() * 20) * 1000)
    const base = {
      id: l.id,
      gain,
      drift,
      cleanup() {
        clearTimeout(driftTimer)
        try { gain.disconnect() } catch { /* 已断开 */ }
        try { drift.disconnect() } catch { /* 已断开 */ }
      },
    }
    const src = l.source
    if (src.type === 'synth') {
      const synth = await createSynthNode(ctx, src.kind, src.params ?? {})
      this.mode = synth.mode
      synth.node.connect(drift)
      return {
        ...base,
        synth,
        setParams: p => synth.set(p),
        pause() {},
        resume() {},
        kill() { synth.stop(); base.cleanup() },
      }
    }
    if (src.type === 'loop') {
      const loop = startLoop(ctx, src.buffer, drift)
      return { ...base, setParams() {}, pause() {}, resume() {}, kill() { loop.stop(); base.cleanup() } }
    }
    const list = startPlaylist(ctx, src.urls, drift)
    return {
      ...base,
      setParams() {},
      pause: () => list.pause(),
      resume: () => list.resume(),
      kill() { list.stop(); base.cleanup() },
    }
  }

  setMaster(v: number): void {
    this.masterValue = v
    if (this.ctx && this.master) setTarget(this.master.gain, sliderToGain(v, MASTER_MAX_GAIN), this.ctx, 0.15)
  }

  setLayerVolume(id: string, v: number): void {
    const live = this.layers.get(id)
    if (this.ctx && live) setTarget(live.gain.gain, sliderToGain(v), this.ctx, 0.15)
  }

  setLayerParams(id: string, params: SynthParams): void {
    this.layers.get(id)?.setParams(params)
  }

  /** 听书时压低: 0.3 s 压下, 1.5 s 恢复 (按会话, 不按句子起落) */
  duck(on: boolean, level = this.duckLevel): void {
    this.ducked = on
    this.duckLevel = level
    if (this.ctx && this.duckNode) setTarget(this.duckNode.gain, on ? level : 1, this.ctx, on ? DUCK_ATTACK_SEC : DUCK_RELEASE_SEC)
  }

  /** 淡出到 0 后停止全部层并挂起 AudioContext (释放音频设备, 省电) */
  stop(fadeSec = FADE_SEC): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.fade || !this.running) {
      this.killAll()
      return Promise.resolve()
    }
    const epoch = ++this.epoch
    linearTo(this.fade.gain, 0, ctx, fadeSec)
    clearTimeout(this.stopTimer)
    return new Promise(resolve => {
      this.stopTimer = setTimeout(() => {
        if (epoch === this.epoch) {
          this.killAll()
          void ctx.suspend().catch(() => {})
        }
        resolve()
      }, fadeSec * 1000 + 100)
    })
  }

  /** 切后台: 快速淡出后挂起 (层保留), 回前台 resumeFromHidden 接着播 */
  async pauseForHidden(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.fade || !this.running) return
    linearTo(this.fade.gain, 0, ctx, 0.3)
    for (const l of this.layers.values()) l.pause()
    await new Promise(r => setTimeout(r, 350))
    await ctx.suspend().catch(() => {})
  }

  async resumeFromHidden(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.fade || !this.running) return
    await ctx.resume().catch(() => {})
    for (const l of this.layers.values()) l.resume()
    linearTo(this.fade.gain, 1, ctx, FADE_SEC)
  }

  private killAll(): void {
    for (const l of this.layers.values()) l.kill()
    this.layers.clear()
  }

  dispose(): void {
    this.epoch++
    clearTimeout(this.stopTimer)
    this.killAll()
    const ctx = this.ctx
    this.ctx = null
    this.master = this.duckNode = this.fade = null
    void ctx?.close().catch(() => {})
  }
}

/** 录音循环: 双 source 交叉淡化, 提前排 3 段, 后台定时器被节流也不会断 */
function startLoop(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode): { stop(): void } {
  const duration = buffer.duration
  const x = effectiveCrossfade(duration, LOOP_CROSSFADE_SEC)
  const t0 = ctx.currentTime + 0.05
  const up = equalPowerCurve(64, true)
  const down = equalPowerCurve(64, false)
  const live = new Set<{ src: AudioBufferSourceNode; g: GainNode }>()
  let next = 0
  let stopped = false
  const schedule = () => {
    if (stopped) return
    const horizon = ctx.currentTime + 3 * (duration - x)
    while (true) {
      const [seg] = loopSegments(duration, x, t0, next, 1)
      if (seg.start > horizon) break
      next++
      const src = ctx.createBufferSource()
      src.buffer = buffer
      const g = ctx.createGain()
      src.connect(g)
      g.connect(dest)
      if (seg.index === 0 || x <= 0) g.gain.setValueAtTime(1, seg.start)
      else {
        g.gain.setValueAtTime(0, seg.start)
        g.gain.setValueCurveAtTime(up, seg.start, x)
      }
      if (x > 0) g.gain.setValueCurveAtTime(down, seg.fadeOutStart, x)
      const node = { src, g }
      live.add(node)
      src.onended = () => {
        live.delete(node)
        try { g.disconnect() } catch { /* 已断开 */ }
      }
      src.start(Math.max(seg.start, ctx.currentTime))
      src.stop(seg.end + 0.05)
    }
  }
  schedule()
  const timer = setInterval(schedule, Math.max(1000, ((duration - x) * 1000) / 2))
  return {
    stop() {
      stopped = true
      clearInterval(timer)
      for (const n of live) {
        try { n.src.stop() } catch { /* 未开始 */ }
        try { n.g.disconnect() } catch { /* 已断开 */ }
      }
      live.clear()
    },
  }
}

/** 钢琴曲目: 媒体元素流式播放 (不整首解码, 省内存), 曲首曲尾 3 s 淡入淡出, 列表循环 */
function startPlaylist(ctx: AudioContext, urls: string[], dest: AudioNode): { stop(): void; pause(): void; resume(): void } {
  const audio = new Audio()
  audio.preload = 'auto'
  const node = ctx.createMediaElementSource(audio)
  const g = ctx.createGain()
  g.gain.value = 0
  node.connect(g)
  g.connect(dest)
  let index = 0
  let stopped = false
  let fadingOut = false
  const playIndex = (i: number) => {
    if (stopped || !urls.length) return
    index = ((i % urls.length) + urls.length) % urls.length
    fadingOut = false
    audio.src = urls[index]
    g.gain.cancelScheduledValues(ctx.currentTime)
    g.gain.setValueAtTime(0, ctx.currentTime)
    linearTo(g.gain, 1, ctx, TRACK_FADE_SEC)
    void audio.play().catch(() => {})
  }
  const onTime = () => {
    if (!fadingOut && audio.duration && audio.duration - audio.currentTime < TRACK_FADE_SEC) {
      fadingOut = true
      linearTo(g.gain, 0, ctx, Math.max(0.2, audio.duration - audio.currentTime))
    }
  }
  // 曲间留 1.5 s 安静, 再进下一首
  const onEnded = () => setTimeout(() => playIndex(index + 1), 1500)
  audio.addEventListener('timeupdate', onTime)
  audio.addEventListener('ended', onEnded)
  playIndex(0)
  return {
    pause() { audio.pause() },
    resume() { if (!stopped) void audio.play().catch(() => {}) },
    stop() {
      stopped = true
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnded)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      try { node.disconnect() } catch { /* 已断开 */ }
      try { g.disconnect() } catch { /* 已断开 */ }
    },
  }
}
