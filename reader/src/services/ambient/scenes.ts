/**
 * 背景音场景定义 (docs/research/reading-ambient-audio.md §5.6, docs/reading-experience-plan.md Q3/Q10)。
 * - 合成场景: 本机实时合成, 零素材、离线可用 (阶段 1 首发)
 * - 录音场景: CC0 / 公有领域录音包, 按需下载 (阶段 3), 素材清单见 pack.ts 与 docs/ambient-sources.md
 * 轻音乐只有古典钢琴 + 生成式铺底音; 不收有歌词的音乐, 不收 lo-fi。
 * 名字走 i18n (ambient.scene.*), 中文名固定。
 */
import type { NoiseColor, SynthKind, SynthParams } from './dsp.ts'

export type AmbientLayer =
  | { id: string; type: 'synth'; kind: SynthKind; params?: SynthParams; labelKey: string; volume: number }
  /** 一段已做成无缝循环的录音 (解码为 AudioBuffer, 双 source 交叉淡化循环) */
  | { id: string; type: 'loop'; item: string; labelKey: string; volume: number }
  /** 曲目列表 (钢琴), 用媒体元素流式播放, 曲间淡入淡出 */
  | { id: string; type: 'playlist'; items: string[]; labelKey: string; volume: number }

export interface AmbientScene {
  id: string
  source: 'synth' | 'recorded'
  /** i18n key: 场景名 */
  nameKey: string
  /** i18n key: 一句话描述 */
  descKey: string
  /** 图标 (AmbientPanel 内联 SVG 的名字) */
  icon: 'rain' | 'wind' | 'noise' | 'moon' | 'window' | 'cup' | 'fire' | 'bird' | 'wave' | 'night' | 'piano'
  layers: AmbientLayer[]
}

export const SCENES: AmbientScene[] = [
  // ---- 合成 (首发) ----
  {
    id: 'rain-study',
    source: 'synth',
    nameKey: 'ambient.scene.rainStudy',
    descKey: 'ambient.scene.rainStudyDesc',
    icon: 'rain',
    layers: [
      { id: 'rain', type: 'synth', kind: 'rain', params: { intensity: 0.55 }, labelKey: 'ambient.layer.rain', volume: 0.8 },
      { id: 'pad', type: 'synth', kind: 'pad', labelKey: 'ambient.layer.pad', volume: 0.35 },
    ],
  },
  {
    id: 'forest-wind',
    source: 'synth',
    nameKey: 'ambient.scene.forestWind',
    descKey: 'ambient.scene.forestWindDesc',
    icon: 'wind',
    layers: [
      { id: 'wind', type: 'synth', kind: 'wind', params: { intensity: 0.5 }, labelKey: 'ambient.layer.wind', volume: 0.8 },
      { id: 'chimes', type: 'synth', kind: 'chimes', labelKey: 'ambient.layer.chimes', volume: 0.45 },
    ],
  },
  {
    id: 'focus-noise',
    source: 'synth',
    nameKey: 'ambient.scene.focusNoise',
    descKey: 'ambient.scene.focusNoiseDesc',
    icon: 'noise',
    layers: [
      { id: 'noise', type: 'synth', kind: 'noise', params: { color: 'pink', brightness: 0.6 }, labelKey: 'ambient.layer.noise', volume: 0.75 },
    ],
  },
  {
    id: 'nocturne-pad',
    source: 'synth',
    nameKey: 'ambient.scene.nocturnePad',
    descKey: 'ambient.scene.nocturnePadDesc',
    icon: 'moon',
    layers: [
      { id: 'pad', type: 'synth', kind: 'pad', labelKey: 'ambient.layer.pad', volume: 0.8 },
    ],
  },
  // ---- 录音 (按需下载) ----
  {
    id: 'rain-window',
    source: 'recorded',
    nameKey: 'ambient.scene.rainWindow',
    descKey: 'ambient.scene.rainWindowDesc',
    icon: 'window',
    layers: [
      { id: 'rec', type: 'loop', item: 'rain-window', labelKey: 'ambient.layer.rainRec', volume: 0.8 },
      { id: 'pad', type: 'synth', kind: 'pad', labelKey: 'ambient.layer.pad', volume: 0 },
    ],
  },
  {
    id: 'cafe',
    source: 'recorded',
    nameKey: 'ambient.scene.cafe',
    descKey: 'ambient.scene.cafeDesc',
    icon: 'cup',
    layers: [
      { id: 'rec', type: 'loop', item: 'cafe', labelKey: 'ambient.layer.cafe', volume: 0.75 },
      { id: 'rain', type: 'synth', kind: 'rain', params: { intensity: 0.4 }, labelKey: 'ambient.layer.rain', volume: 0 },
    ],
  },
  {
    id: 'fireplace',
    source: 'recorded',
    nameKey: 'ambient.scene.fireplace',
    descKey: 'ambient.scene.fireplaceDesc',
    icon: 'fire',
    layers: [
      { id: 'rec', type: 'loop', item: 'fireplace', labelKey: 'ambient.layer.fire', volume: 0.75 },
      { id: 'rain', type: 'synth', kind: 'rain', params: { intensity: 0.45 }, labelKey: 'ambient.layer.rain', volume: 0.3 },
    ],
  },
  {
    id: 'forest-birds',
    source: 'recorded',
    nameKey: 'ambient.scene.forestBirds',
    descKey: 'ambient.scene.forestBirdsDesc',
    icon: 'bird',
    layers: [
      { id: 'rec', type: 'loop', item: 'forest-birds', labelKey: 'ambient.layer.birds', volume: 0.6 },
      { id: 'wind', type: 'synth', kind: 'wind', params: { intensity: 0.35 }, labelKey: 'ambient.layer.wind', volume: 0.25 },
    ],
  },
  {
    id: 'seaside',
    source: 'recorded',
    nameKey: 'ambient.scene.seaside',
    descKey: 'ambient.scene.seasideDesc',
    icon: 'wave',
    layers: [
      { id: 'rec', type: 'loop', item: 'seaside', labelKey: 'ambient.layer.waves', volume: 0.75 },
      { id: 'wind', type: 'synth', kind: 'wind', params: { intensity: 0.4 }, labelKey: 'ambient.layer.wind', volume: 0 },
    ],
  },
  {
    id: 'summer-night',
    source: 'recorded',
    nameKey: 'ambient.scene.summerNight',
    descKey: 'ambient.scene.summerNightDesc',
    icon: 'night',
    layers: [
      { id: 'rec', type: 'loop', item: 'summer-night', labelKey: 'ambient.layer.crickets', volume: 0.6 },
      { id: 'pad', type: 'synth', kind: 'pad', labelKey: 'ambient.layer.pad', volume: 0 },
    ],
  },
  {
    id: 'piano-nocturne',
    source: 'recorded',
    nameKey: 'ambient.scene.pianoNocturne',
    descKey: 'ambient.scene.pianoNocturneDesc',
    icon: 'piano',
    layers: [
      { id: 'piano', type: 'playlist', items: ['piano-satie-gymnopedie-1', 'piano-chopin-nocturne-op9-2'], labelKey: 'ambient.layer.piano', volume: 0.7 },
      { id: 'rain', type: 'synth', kind: 'rain', params: { intensity: 0.35 }, labelKey: 'ambient.layer.rain', volume: 0 },
    ],
  },
]

export const DEFAULT_SCENE = 'rain-study'

export function findScene(id: string | null | undefined): AmbientScene | undefined {
  return SCENES.find(s => s.id === id)
}

/** 场景需要下载的素材 id (去重, 保持顺序) */
export function sceneItems(scene: AmbientScene): string[] {
  const ids: string[] = []
  for (const l of scene.layers) {
    const list = l.type === 'loop' ? [l.item] : l.type === 'playlist' ? l.items : []
    for (const id of list) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 设置里每层音量的键: 「场景/层」 */
export const layerKey = (sceneId: string, layerId: string): string => `${sceneId}/${layerId}`

/** 某层当前音量: 用户调过的值优先, 否则场景默认值 */
export function layerVolume(saved: Record<string, number> | undefined, sceneId: string, layer: AmbientLayer): number {
  const v = saved?.[layerKey(sceneId, layer.id)]
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : layer.volume
}

/** 专注噪音的颜色作用到噪声层参数上 */
export function layerParams(layer: AmbientLayer, noiseColor: NoiseColor): SynthParams | undefined {
  if (layer.type !== 'synth') return undefined
  return layer.kind === 'noise' ? { ...layer.params, color: noiseColor } : layer.params
}
