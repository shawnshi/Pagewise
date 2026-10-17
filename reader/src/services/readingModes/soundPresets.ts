/**
 * 打字声音色: 预设清单 + 播放调度用的纯函数 (轮换不连发同一条、轻微音高/音量随机、限频、复音上限、音量曲线) + 合成兜底。
 * 不碰 DOM / WebAudio, 可在 node --test 里直接测试; 播放器在 sound.ts。
 *
 * 录音素材在 public/sounds/typewriter/<preset>/<n>.{ogg,m4a}, 清单同目录 manifest.json (含来源与测量数据),
 * 来源与许可见 docs/ambient-sources.md「打字声」一节。这里的 TYPING_SOUND_PRESETS 与 manifest.json 由契约测试保证一致。
 */

export type TypingSoundPresetId = 'typewriter' | 'mechanical' | 'soft' | 'pen'

// 设置里的 typewriter.soundPreset 与这里的 id 保持一致 (类型层面的双向检查)
type SettingsPresetId = import('../../stores/settings').TypewriterPrefs['soundPreset']
const _presetIdsMatch: [SettingsPresetId] extends [TypingSoundPresetId] ? ([TypingSoundPresetId] extends [SettingsPresetId] ? true : never) : never = true
void _presetIdsMatch

export interface TypingSoundPreset {
  id: TypingSoundPresetId
  /** i18n key */
  nameKey: string
  /** 轮换的单发样本, 相对 sounds/typewriter/ 的路径, 不带扩展名 */
  hits: readonly string[]
  /** 段落末的点缀 (打字机: 回车滑架的「咔哒」; 机械键盘: 空格键); 没有就用普通击键 */
  accent?: string
}

export const TYPING_SOUND_PRESETS: readonly TypingSoundPreset[] = [
  { id: 'typewriter', nameKey: 'readingMode.soundPresetTypewriter', hits: numbered('typewriter', 6), accent: 'typewriter/accent' },
  { id: 'mechanical', nameKey: 'readingMode.soundPresetMechanical', hits: numbered('mechanical', 6), accent: 'mechanical/accent' },
  { id: 'soft', nameKey: 'readingMode.soundPresetSoft', hits: numbered('soft', 6) },
  { id: 'pen', nameKey: 'readingMode.soundPresetPen', hits: numbered('pen', 6) },
]

/** 默认音色: 润滑线性轴的低沉「咚」声, 频谱重心约 1.0–1.5 kHz、衰减约 35 ms, 每秒 5 下也不刺耳 */
export const DEFAULT_TYPING_SOUND_PRESET: TypingSoundPresetId = 'mechanical'
/** 默认音量 (0–1) */
export const DEFAULT_TYPING_SOUND_VOLUME = 0.4

/** 两次击键声的最小间隔: 一帧里推进多个字、或掉帧后追赶时不会连珠炮 */
export const MIN_HIT_GAP_MS = 45
/** 同时发声的上限, 超出时淡出最早的那一声 */
export const MAX_VOICES = 4
/** 每次击键的随机变化: 音高 ±3%, 音量 ±2 dB */
export const PITCH_JITTER = 0.03
export const GAIN_JITTER_DB = 2

function numbered(dir: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${dir}/${i + 1}`)
}

export function isTypingSoundPresetId(id: unknown): id is TypingSoundPresetId {
  return TYPING_SOUND_PRESETS.some(p => p.id === id)
}

/** 设置里存的 id 不认识 (旧版本 / 手改) 时回到默认音色 */
export function resolveTypingSoundPreset(id: unknown): TypingSoundPreset {
  return TYPING_SOUND_PRESETS.find(p => p.id === id) ?? TYPING_SOUND_PRESETS.find(p => p.id === DEFAULT_TYPING_SOUND_PRESET)!
}

/** 音量 0–1 → 增益。指数 1.6 的曲线让滑块中段更好调; 默认 40% ≈ −13 dB */
export function volumeToGain(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_TYPING_SOUND_VOLUME
  return v === 0 ? 0 : Math.pow(v, 1.6)
}

export type Rand = () => number

/**
 * 轮换袋: 每一轮把所有变体洗一遍依次用完, 新一轮的第一个不等于上一轮最后一个 → 永远不会连着两次同一条,
 * 而且短时间内每条出现次数均匀 (比纯随机更不容易听出「循环」)。
 */
export interface RoundRobin {
  next(): number
  readonly last: number
}

export function createRoundRobin(count: number, rand: Rand = Math.random): RoundRobin {
  let bag: number[] = []
  let last = -1
  const refill = () => {
    bag = Array.from({ length: count }, (_, i) => i)
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    // 新一轮首个与上一轮末个相同时, 和袋里随便另一个交换
    if (count > 1 && bag[0] === last) {
      const k = 1 + Math.floor(rand() * (count - 1))
      ;[bag[0], bag[k]] = [bag[k], bag[0]]
    }
  }
  return {
    next() {
      if (count <= 0) return -1
      if (!bag.length) refill()
      last = bag.shift()!
      return last
    },
    get last() { return last },
  }
}

/** 单次击键的随机变化: playbackRate 1±3%, 增益 ±2 dB (线性值) */
export function hitVariation(rand: Rand = Math.random): { rate: number; gain: number } {
  const rate = 1 + (rand() * 2 - 1) * PITCH_JITTER
  const db = (rand() * 2 - 1) * GAIN_JITTER_DB
  return { rate, gain: Math.pow(10, db / 20) }
}

/** 限频: 距上一声不到 minGapMs 就跳过 (段落点缀不受限, 但也会刷新时间) */
export function allowHit(nowMs: number, lastHitMs: number, accent = false, minGapMs = MIN_HIT_GAP_MS): boolean {
  return accent || nowMs - lastHitMs >= minGapMs
}

/** 复音上限: 当前 active 个在响, 再加一个之前需要停掉最早的几个 */
export function voicesToSteal(active: number, max = MAX_VOICES): number {
  return Math.max(0, active + 1 - max)
}

/** 抽稀: 每 every 个字响一次 (every 来自 pacing.soundEvery); 返回新的计数与这次是否发声 */
export function thinTicks(count: number, ticks: number, every: number): { count: number; play: boolean } {
  const c = count + Math.max(0, ticks)
  if (ticks > 0 && c >= Math.max(1, every)) return { count: 0, play: true }
  return { count: c, play: false }
}

// ---------------------------------------------------------------------------
// 清单校验 (public/sounds/typewriter/manifest.json)

export interface TypingSoundManifest {
  version: 1
  formats: Array<'ogg' | 'm4a'>
  presets: Record<string, { hits: string[]; accent?: string; source: { url: string; license: string; author: string } }>
}

export function validateTypingSoundManifest(m: any): { ok: true; manifest: TypingSoundManifest } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const path = /^[a-z]+\/[a-z0-9]+$/
  if (!m || typeof m !== 'object') return { ok: false, errors: ['not an object'] }
  if (m.version !== 1) errors.push('version must be 1')
  if (!Array.isArray(m.formats) || !m.formats.includes('ogg') || !m.formats.includes('m4a')) errors.push('formats must list ogg and m4a')
  if (!m.presets || typeof m.presets !== 'object') errors.push('presets missing')
  else {
    for (const [id, p] of Object.entries<any>(m.presets)) {
      if (!isTypingSoundPresetId(id)) errors.push(`${id}: unknown preset id`)
      if (!Array.isArray(p?.hits) || p.hits.length < 4 || p.hits.length > 8) errors.push(`${id}: needs 4–8 hits`)
      else {
        for (const h of p.hits) if (typeof h !== 'string' || !path.test(h) || !h.startsWith(id + '/')) errors.push(`${id}: bad hit path ${h}`)
        if (new Set(p.hits).size !== p.hits.length) errors.push(`${id}: duplicate hits`)
      }
      if (p?.accent != null && (typeof p.accent !== 'string' || !path.test(p.accent) || !p.accent.startsWith(id + '/'))) errors.push(`${id}: bad accent path`)
      if (!p?.source || p.source.license !== 'CC0-1.0' || !/^https:\/\/freesound\.org\/people\/[^/]+\/sounds\/\d+\/$/.test(p.source.url ?? '')) errors.push(`${id}: source must be a CC0 Freesound page`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m as TypingSoundManifest }
}

// ---------------------------------------------------------------------------
// 合成兜底: 录音解不了 (旧 WebView / 离线又没缓存) 时用。模态合成: 一小段滤波噪声 (击打) + 几个指数衰减的共振, 每次随机微调。

interface Mode { f: number; decay: number; amp: number }
interface SynthSpec { noiseMs: number; noiseLp: number; noiseHp: number; noiseAmp: number; modes: Mode[]; ms: number; attackMs: number }

const SYNTH: Record<TypingSoundPresetId, SynthSpec> = {
  // 润滑线性轴: 低沉的「咚」+ 轻微塑料声
  mechanical: { noiseMs: 6, noiseLp: 4000, noiseHp: 300, noiseAmp: 0.35, ms: 70, attackMs: 0.5,
    modes: [{ f: 210, decay: 0.018, amp: 0.9 }, { f: 480, decay: 0.012, amp: 0.45 }, { f: 1250, decay: 0.006, amp: 0.25 }] },
  // 打字机: 清脆的金属「嗒」+ 机身共鸣
  typewriter: { noiseMs: 4, noiseLp: 7000, noiseHp: 1200, noiseAmp: 0.6, ms: 90, attackMs: 0.3,
    modes: [{ f: 260, decay: 0.025, amp: 0.35 }, { f: 1850, decay: 0.012, amp: 0.4 }, { f: 3400, decay: 0.008, amp: 0.3 }] },
  // 笔记本剪刀脚: 很轻很短的「嗒」
  soft: { noiseMs: 4, noiseLp: 3000, noiseHp: 200, noiseAmp: 0.3, ms: 60, attackMs: 1,
    modes: [{ f: 330, decay: 0.010, amp: 0.6 }, { f: 950, decay: 0.006, amp: 0.3 }] },
  // 钢笔: 100 ms 的柔和沙沙声, 无共振
  pen: { noiseMs: 90, noiseLp: 6000, noiseHp: 900, noiseAmp: 0.5, ms: 100, attackMs: 10, modes: [] },
}

/** 一阶低通/高通 (够用, 合成兜底不追求精确) */
function onePole(x: Float32Array, fc: number, sr: number, type: 'lp' | 'hp'): Float32Array {
  const a = Math.exp(-2 * Math.PI * fc / sr)
  const y = new Float32Array(x.length)
  let lp = 0
  for (let i = 0; i < x.length; i++) {
    lp = (1 - a) * x[i] + a * lp
    y[i] = type === 'lp' ? lp : x[i] - lp
  }
  return y
}

/** 生成一条合成击键 (单声道, 峰值归一到 0.5 ≈ −6 dBFS); 同一个 rand 序列结果确定, 便于测试 */
export function synthHit(preset: TypingSoundPresetId, sampleRate: number, rand: Rand = Math.random): Float32Array {
  const s = SYNTH[preset] ?? SYNTH.mechanical
  const n = Math.max(1, Math.round(sampleRate * s.ms / 1000))
  const nNoise = Math.min(n, Math.round(sampleRate * s.noiseMs / 1000))
  let noise: Float32Array = new Float32Array(n)
  for (let i = 0; i < nNoise; i++) {
    // 噪声包络: 击打类迅速衰减; 笔划类是两头渐变的「梭形」
    const p = i / nNoise
    const env = preset === 'pen' ? Math.sin(Math.PI * p) ** 1.5 * (0.75 + 0.25 * rand()) : Math.exp(-p * 5)
    noise[i] = (rand() * 2 - 1) * env
  }
  noise = onePole(onePole(noise, s.noiseHp, sampleRate, 'hp'), s.noiseLp, sampleRate, 'lp')
  const out = new Float32Array(n)
  const detune = 1 + (rand() * 2 - 1) * 0.04
  for (let i = 0; i < n; i++) out[i] = noise[i] * s.noiseAmp
  for (const m of s.modes) {
    const f = m.f * detune * (1 + (rand() * 2 - 1) * 0.02)
    const amp = m.amp * (0.85 + 0.3 * rand())
    const w = 2 * Math.PI * f / sampleRate
    for (let i = 0; i < n; i++) out[i] += amp * Math.exp(-i / (m.decay * sampleRate)) * Math.sin(w * i)
  }
  // 起音与 5 ms 收尾淡出, 防止爆音
  const na = Math.max(1, Math.round(sampleRate * s.attackMs / 1000))
  const nf = Math.min(n, Math.round(sampleRate * 0.005))
  for (let i = 0; i < na && i < n; i++) out[i] *= i / na
  for (let i = 0; i < nf; i++) out[n - 1 - i] *= i / nf
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.5 / peak
  return out
}
