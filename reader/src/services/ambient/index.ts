/**
 * 背景音 (阅读环境音) 对外接口。设计见 docs/research/reading-ambient-audio.md, 来源与许可见 docs/ambient-sources.md。
 *
 * 用法 (阅读器接线):
 *
 *   import { useAmbient } from '../services/ambient'
 *   const ambient = useAmbient()            // 全局单例; 模板里读 ambient.state.*
 *
 *   ambient.scenes                          // 全部场景 (合成 4 个 + 录音 7 个), 见 scenes.ts
 *   ambient.state                           // 响应式: playing / loading / sceneId / volume / layers / noiseColor /
 *                                           //   duckWithVoice / ducked / timerEndsAt / timerMinutes / downloads / error / mode
 *   ambient.play(sceneId?)                  // 必须在用户手势里调用 (点按钮); 录音场景未下载时先下载再播放
 *   ambient.stop()                          // 1.5 s 淡出后停止, 挂起 AudioContext
 *   ambient.toggle()                        // 播放上次场景 / 停止
 *   ambient.setVolume(v)                    // 主音量 0..1 (默认 0.3), 持久化
 *   ambient.setLayerVolume(layerId, v)      // 当前场景某层音量 0..1, 持久化
 *   ambient.setNoiseColor('pink'|'white'|'brown')
 *   ambient.setDuckWithVoice(on)            // 「听书时自动降低」开关, 持久化
 *   ambient.duck(on)                        // 听书播放中传 true, 暂停 / 停止传 false (-12 dB, 300 ms 压下, 1.5 s 恢复)
 *   ambient.setTimer(minutes | null)        // 背景音自己的定时: 到点前 30 s 开始淡出, 到点停止
 *   ambient.fadeOutAndStop(seconds = 30)    // 听书睡眠定时触发时调用, 背景音跟着慢慢淡出
 *   ambient.setPauseWhenHidden(v)           // 切后台时是否暂停。默认: 手机 (Android / iOS) 上暂停、桌面继续;
 *                                           //   传函数 = 在默认规则上再加条件, 阅读器传 () => ttsState !== 'playing'
 *                                           //   (听书在播时跟随听书的后台策略, 不单独暂停); 传 boolean = 强制; null = 恢复默认
 *   ambient.download(sceneId) / removeDownload(sceneId) / refreshDownloads()
 *   ambient.dispose()                       // 退出阅读器: 立即停止并关闭 AudioContext
 *
 * 约定: 只记住上次的场景和音量 (settings.ambient), 从不在启动或打开书时自动播放。
 */
import { reactive } from 'vue'
import { useSettings, type AmbientPrefs } from '../../stores/settings'
import type { NoiseColor } from './dsp.ts'
import { AmbientEngine, type EngineLayer } from './engine.ts'
import { DEFAULT_DUCK_LEVEL, TIMER_FADE_MS, clamp01, timerPlan } from './math.ts'
import {
  currentFormat,
  downloadItem,
  getCachedBlob,
  getItem,
  markFormatBroken,
  removeItem,
  type PackFormat,
  type PackItem,
} from './pack.ts'
import { DEFAULT_SCENE, SCENES, findScene, layerKey, layerParams, layerVolume, sceneItems, type AmbientScene } from './scenes.ts'

export { SCENES, findScene, sceneItems } from './scenes.ts'
export type { AmbientScene, AmbientLayer } from './scenes.ts'
export type { NoiseColor } from './dsp.ts'
export { TIMER_CHOICES, formatBytes } from './math.ts'
export { getManifest, getItem, itemsBytes, currentFormat } from './pack.ts'

export type DownloadStatus = 'none' | 'downloading' | 'ready' | 'error'

export interface SceneDownload {
  status: DownloadStatus
  loaded: number
  total: number
}

export interface AmbientState {
  playing: boolean
  /** 正在准备 (下载 / 解码 / 加载 Worklet) */
  loading: boolean
  sceneId: string
  /** 主音量 0..1 */
  volume: number
  /** 当前场景各层音量 (层 id → 0..1) */
  layers: Record<string, number>
  noiseColor: NoiseColor
  duckWithVoice: boolean
  /** 当前是否处于压低状态 (听书中) */
  ducked: boolean
  /** 背景音定时的结束时刻 (ms), 未设为 null */
  timerEndsAt: number | null
  timerMinutes: number | null
  /** 录音场景的下载状态 (场景 id → 状态) */
  downloads: Record<string, SceneDownload>
  /** i18n key, 例如 ambient.errorUnsupported */
  error: string | null
  /** 合成层实际使用的实现 (诊断用) */
  mode: 'worklet' | 'script' | null
}

const PREF_DEFAULTS: AmbientPrefs = {
  scene: DEFAULT_SCENE,
  master: 0.3,
  layers: {},
  noiseColor: 'pink',
  duckWithVoice: true,
  duckLevel: DEFAULT_DUCK_LEVEL,
  pauseWhenHidden: true,
}

/** 旧存档里没有 / 缺字段的 ambient 设置补默认值 (settings.load 只做浅合并) */
export function normalizeAmbientPrefs(raw: unknown): AmbientPrefs {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<AmbientPrefs>) : {}
  return {
    scene: typeof r.scene === 'string' && findScene(r.scene) ? r.scene : PREF_DEFAULTS.scene,
    master: typeof r.master === 'number' ? clamp01(r.master) : PREF_DEFAULTS.master,
    layers: r.layers && typeof r.layers === 'object' && !Array.isArray(r.layers) ? { ...r.layers } : {},
    noiseColor: r.noiseColor === 'white' || r.noiseColor === 'brown' || r.noiseColor === 'pink' ? r.noiseColor : 'pink',
    duckWithVoice: typeof r.duckWithVoice === 'boolean' ? r.duckWithVoice : true,
    duckLevel: typeof r.duckLevel === 'number' ? Math.min(1, Math.max(0.05, r.duckLevel)) : DEFAULT_DUCK_LEVEL,
    pauseWhenHidden: typeof r.pauseWhenHidden === 'boolean' ? r.pauseWhenHidden : true,
  }
}

const isMobile = (): boolean =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')

function createAmbient() {
  const settings = useSettings()
  const prefs = (): AmbientPrefs => {
    const s = settings as unknown as { ambient?: AmbientPrefs }
    const n = normalizeAmbientPrefs(s.ambient)
    if (!s.ambient || Object.keys(n).some(k => !(k in (s.ambient as object)))) s.ambient = n
    return s.ambient!
  }

  const engine = new AmbientEngine()
  const p0 = prefs()
  const state = reactive<AmbientState>({
    playing: false,
    loading: false,
    sceneId: p0.scene,
    volume: p0.master,
    layers: {},
    noiseColor: p0.noiseColor,
    duckWithVoice: p0.duckWithVoice,
    ducked: false,
    timerEndsAt: null,
    timerMinutes: null,
    downloads: {},
    error: null,
    mode: null,
  })

  const syncLayers = (scene: AmbientScene) => {
    const saved = prefs().layers
    state.layers = Object.fromEntries(scene.layers.map(l => [l.id, layerVolume(saved, scene.id, l)]))
  }
  syncLayers(findScene(state.sceneId) ?? SCENES[0])

  // ---- 录音素材 ----
  const buffers = new Map<string, AudioBuffer>()
  const objectUrls: string[] = []

  const downloadAll = async (scene: AmbientScene, format: PackFormat): Promise<Map<string, Blob>> => {
    const items = sceneItems(scene).map(id => getItem(id)).filter((i): i is PackItem => !!i)
    const total = items.reduce((s, i) => s + i.files[format].bytes, 0)
    const done = new Map<string, number>()
    const progress = () => {
      const loaded = [...done.values()].reduce((a, b) => a + b, 0)
      state.downloads[scene.id] = { status: 'downloading', loaded, total }
    }
    const blobs = new Map<string, Blob>()
    for (const it of items) {
      blobs.set(it.id, await downloadItem(it, format, p => { done.set(it.id, p.loaded); progress() }))
      done.set(it.id, it.files[format].bytes)
      progress()
    }
    state.downloads[scene.id] = { status: 'ready', loaded: total, total }
    return blobs
  }

  async function decode(ctx: AudioContext, item: PackItem, format: PackFormat): Promise<AudioBuffer> {
    const hit = buffers.get(item.id)
    if (hit) return hit
    const blob = (await getCachedBlob(item, format)) ?? (await downloadItem(item, format))
    const data = await blob.arrayBuffer()
    const buf = await new Promise<AudioBuffer>((resolve, reject) => {
      // 回调写法兼容旧 Safari (decodeAudioData 不返回 Promise)
      const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined
      p?.catch?.(reject)
    })
    buffers.set(item.id, buf)
    return buf
  }

  /** 把场景定义变成引擎层; 录音素材按需下载 + 解码 (Opus 解不了时改用 m4a 重来一次) */
  async function buildLayers(ctx: AudioContext, scene: AmbientScene): Promise<EngineLayer[]> {
    let format = currentFormat()
    if (scene.source === 'recorded') {
      try {
        await downloadAll(scene, format)
      } catch (e) {
        state.downloads[scene.id] = { status: 'error', loaded: 0, total: 0 }
        throw e
      }
    }
    const build = async (fmt: PackFormat) => {
      const out: EngineLayer[] = []
      for (const l of scene.layers) {
        const volume = state.layers[l.id] ?? l.volume
        if (l.type === 'synth') {
          out.push({ id: l.id, volume, source: { type: 'synth', kind: l.kind, params: layerParams(l, state.noiseColor) } })
        } else if (l.type === 'loop') {
          const item = getItem(l.item)
          if (item) out.push({ id: l.id, volume, source: { type: 'loop', buffer: await decode(ctx, item, fmt) } })
        } else {
          const urls: string[] = []
          for (const id of l.items) {
            const item = getItem(id)
            if (!item) continue
            const blob = (await getCachedBlob(item, fmt)) ?? (await downloadItem(item, fmt))
            const url = URL.createObjectURL(blob)
            objectUrls.push(url)
            urls.push(url)
          }
          if (urls.length) out.push({ id: l.id, volume, source: { type: 'playlist', urls } })
        }
      }
      return out
    }
    try {
      return await build(format)
    } catch (e) {
      if (format !== 'opus' || scene.source !== 'recorded') throw e
      console.warn('[ambient] Opus 解码失败, 改用 m4a', e)
      markFormatBroken('opus')
      format = 'm4a'
      buffers.clear()
      await downloadAll(scene, format)
      return build(format)
    }
  }

  const releaseMedia = () => {
    buffers.clear()
    for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u)
  }

  // ---- 定时 ----
  let fadeTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    clearTimeout(fadeTimer)
    clearTimeout(stopTimer)
    state.timerEndsAt = null
    state.timerMinutes = null
  }
  const armTimer = () => {
    clearTimeout(fadeTimer)
    clearTimeout(stopTimer)
    if (state.timerEndsAt == null || !state.playing) return
    const plan = timerPlan(Date.now(), state.timerEndsAt, TIMER_FADE_MS)
    fadeTimer = setTimeout(() => { void stop(plan.fadeMs / 1000) }, plan.fadeStartIn)
    // 兜底: 页面被节流时也按时清理状态
    stopTimer = setTimeout(() => { if (state.playing) void stop(0.3) }, plan.stopIn + 2000)
  }

  // ---- 切后台 ----
  let hiddenPolicy: boolean | (() => boolean) | null = null
  let hiddenPaused = false
  let listening = false
  const shouldPauseHidden = (): boolean => {
    if (typeof hiddenPolicy === 'boolean') return hiddenPolicy
    // 默认: 手机上 (Android / iOS) 且设置开启时暂停; 传入的函数是额外条件 (例如「听书没在播」)
    const base = prefs().pauseWhenHidden && isMobile()
    return typeof hiddenPolicy === 'function' ? base && hiddenPolicy() : base
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (state.playing && shouldPauseHidden()) {
        hiddenPaused = true
        void engine.pauseForHidden()
      }
    } else if (hiddenPaused) {
      hiddenPaused = false
      if (state.timerEndsAt != null && Date.now() >= state.timerEndsAt) void stop(0.3)
      else if (state.playing) void engine.resumeFromHidden()
    }
  }
  const listen = () => {
    if (listening || typeof document === 'undefined') return
    listening = true
    document.addEventListener('visibilitychange', onVisibility)
  }

  // ---- 播放控制 ----
  let playToken = 0

  async function play(sceneId?: string): Promise<void> {
    const scene = findScene(sceneId ?? state.sceneId) ?? SCENES[0]
    // 同步创建 / 唤醒 AudioContext: 必须在手势调用栈里
    const ctx = engine.ensureContext()
    if (!ctx) {
      state.error = 'ambient.errorUnsupported'
      return
    }
    const token = ++playToken
    state.error = null
    state.loading = true
    if (scene.id !== state.sceneId) {
      state.sceneId = scene.id
      syncLayers(scene)
    }
    prefs().scene = scene.id
    listen()
    try {
      const layers = await buildLayers(ctx, scene)
      if (token !== playToken) return
      await engine.start(layers)
      if (token !== playToken) return
      state.mode = engine.mode
      state.playing = true
      engine.duck(state.ducked && state.duckWithVoice, prefs().duckLevel)
      armTimer()
    } catch (e) {
      if (token !== playToken) return
      console.warn('[ambient] 播放失败', e)
      state.error = scene.source === 'recorded' ? 'ambient.errorDownload' : 'ambient.errorUnsupported'
      state.playing = false
    } finally {
      if (token === playToken) state.loading = false
    }
  }

  async function stop(fadeSec?: number): Promise<void> {
    const token = ++playToken
    state.loading = false
    state.playing = false
    hiddenPaused = false
    clearTimer()
    await engine.stop(fadeSec)
    // 淡出期间用户又点了播放: 新场景可能正在用这些 buffer / blob URL, 不能释放
    if (token === playToken) releaseMedia()
  }

  function toggle(): Promise<void> {
    return state.playing ? stop() : play()
  }

  function setVolume(v: number): void {
    state.volume = clamp01(v)
    prefs().master = state.volume
    engine.setMaster(state.volume)
  }

  function setLayerVolume(layerId: string, v: number): void {
    const value = clamp01(v)
    state.layers[layerId] = value
    prefs().layers[layerKey(state.sceneId, layerId)] = value
    engine.setLayerVolume(layerId, value)
  }

  function setNoiseColor(c: NoiseColor): void {
    state.noiseColor = c
    prefs().noiseColor = c
    const scene = findScene(state.sceneId)
    for (const l of scene?.layers ?? []) {
      if (l.type === 'synth' && l.kind === 'noise') engine.setLayerParams(l.id, layerParams(l, c) ?? {})
    }
  }

  function setDuckWithVoice(on: boolean): void {
    state.duckWithVoice = on
    prefs().duckWithVoice = on
    engine.duck(on && state.ducked, prefs().duckLevel)
  }

  /** 听书状态联动: 播放中 true, 暂停 / 停止 false。关闭「听书时自动降低」时只记录状态不压低 */
  function duck(on: boolean): void {
    state.ducked = on
    engine.duck(on && state.duckWithVoice, prefs().duckLevel)
  }

  function setTimer(minutes: number | null): void {
    if (!minutes || minutes <= 0) {
      clearTimer()
      return
    }
    state.timerMinutes = minutes
    state.timerEndsAt = Date.now() + minutes * 60_000
    armTimer()
  }

  function fadeOutAndStop(seconds = TIMER_FADE_MS / 1000): Promise<void> {
    if (!state.playing) return Promise.resolve()
    return stop(seconds)
  }

  function setPauseWhenHidden(v: boolean | (() => boolean) | null): void {
    hiddenPolicy = v
  }

  async function download(sceneId: string): Promise<boolean> {
    const scene = findScene(sceneId)
    if (!scene || scene.source !== 'recorded') return false
    if (state.downloads[sceneId]?.status === 'downloading') return false
    try {
      await downloadAll(scene, currentFormat())
      return true
    } catch (e) {
      console.warn('[ambient] 下载失败', e)
      state.downloads[sceneId] = { status: 'error', loaded: 0, total: 0 }
      return false
    }
  }

  async function removeDownload(sceneId: string): Promise<void> {
    const scene = findScene(sceneId)
    if (!scene) return
    if (state.playing && state.sceneId === sceneId) await stop(0.3)
    for (const id of sceneItems(scene)) {
      const item = getItem(id)
      if (item) await removeItem(item)
      buffers.delete(id)
    }
    state.downloads[sceneId] = { status: 'none', loaded: 0, total: 0 }
  }

  /** 读一遍缓存, 刷新各录音场景的「已下载」状态 (打开面板时调用) */
  async function refreshDownloads(): Promise<void> {
    const format = currentFormat()
    for (const scene of SCENES) {
      if (scene.source !== 'recorded' || state.downloads[scene.id]?.status === 'downloading') continue
      const items = sceneItems(scene).map(id => getItem(id)).filter((i): i is PackItem => !!i)
      let ready = items.length > 0
      for (const it of items) if (!(await getCachedBlob(it, format))) { ready = false; break }
      const total = items.reduce((s, i) => s + i.files[format].bytes, 0)
      state.downloads[scene.id] = { status: ready ? 'ready' : 'none', loaded: ready ? total : 0, total }
    }
  }

  /** 预热: 在任意用户手势里调用, 提前创建 AudioContext (可选) */
  function warm(): void {
    engine.ensureContext()
  }

  function dispose(): void {
    playToken++
    clearTimer()
    state.playing = false
    state.loading = false
    state.ducked = false
    hiddenPaused = false
    engine.dispose()
    releaseMedia()
    if (listening) {
      document.removeEventListener('visibilitychange', onVisibility)
      listening = false
    }
  }

  return {
    scenes: SCENES,
    state,
    play,
    stop: () => stop(),
    toggle,
    setVolume,
    setLayerVolume,
    setNoiseColor,
    setDuckWithVoice,
    duck,
    setTimer,
    fadeOutAndStop,
    setPauseWhenHidden,
    download,
    removeDownload,
    refreshDownloads,
    warm,
    dispose,
  }
}

export type Ambient = ReturnType<typeof createAmbient>

let instance: Ambient | null = null

/** 全局单例 (需在 pinia 初始化之后调用) */
export function useAmbient(): Ambient {
  return (instance ??= createAmbient())
}
