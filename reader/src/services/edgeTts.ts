/**
 * Edge TTS (在线神经网络音色): 微软 Edge "大声朗读" 云端服务.
 * 合成在 Rust 侧完成 (需要特定握手头), 此处负责调用与播放. 仅桌面版可用.
 */
import { isTauri } from '../storage/types'

export interface EdgeVoice {
  id: string
  label: string
  gender?: 'female' | 'male'
  /** mandarin = 普通话 (含台湾国语), dialect = 方言/粤语, foreign = 外语 */
  group?: 'mandarin' | 'dialect' | 'foreign'
  /** 适合的朗读场景 */
  style?: string
  recommended?: boolean
}

/**
 * Edge「大声朗读」实际提供的音色 (2026-10-04 核对): 来自 edge-tts 使用的公开列表接口
 * speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list (共 322 个),
 * 中文共 14 个, 全部收录, 且逐个用 edge-tts 7.x 合成验证过; 该接口没有中文 Multilingual 音色.
 * style 参考接口返回的 VoiceTag (ContentCategories / VoicePersonalities).
 * 已有 id 不能删改, 否则用户保存的设置会失效.
 */
export const EDGE_VOICES: EdgeVoice[] = [
  // 默认: 台湾腔女声 (2026-10-05 用户指定), 语气柔和, 适合长时间听书
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾腔女声 (默认)', gender: 'female', group: 'mandarin', style: '通用朗读 · 小说', recommended: true },
  // 普通话 (中国大陆)
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声温暖 (推荐)', gender: 'female', group: 'mandarin', style: '小说有声书 · 新闻', recommended: true },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声阳光 (推荐)', gender: 'male', group: 'mandarin', style: '小说有声书', recommended: true },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声磁性', gender: 'male', group: 'mandarin', style: '小说 · 体育解说' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声活泼', gender: 'female', group: 'mandarin', style: '小说 · 动漫' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声新闻', gender: 'male', group: 'mandarin', style: '新闻播报' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年音', gender: 'male', group: 'mandarin', style: '儿童故事' },
  // 台湾国语
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 台湾腔女声', gender: 'female', group: 'mandarin', style: '通用朗读' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲 · 台湾腔男声', gender: 'male', group: 'mandarin', style: '通用朗读' },
  // 方言 / 粤语
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声', gender: 'female', group: 'dialect', style: '粤语朗读' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语女声', gender: 'female', group: 'dialect', style: '粤语朗读' },
  { id: 'zh-HK-WanLungNeural', label: '雲龍 · 粤语男声', gender: 'male', group: 'dialect', style: '粤语朗读' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话', gender: 'female', group: 'dialect', style: '方言 · 幽默' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话', gender: 'female', group: 'dialect', style: '方言' },
  // 外语
  { id: 'en-US-AriaNeural', label: 'Aria · 英语女声', gender: 'female', group: 'foreign', style: '英文小说 · 新闻' },
  { id: 'en-US-AndrewNeural', label: 'Andrew · 英语男声', gender: 'male', group: 'foreign', style: '英文对话' },
  { id: 'en-US-JennyNeural', label: 'Jenny · 英语女声', gender: 'female', group: 'foreign', style: '英文通用' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia · 英式英语女声', gender: 'female', group: 'foreign', style: '英文通用' },
  { id: 'ja-JP-NanamiNeural', label: 'Nanami · 日语女声', gender: 'female', group: 'foreign', style: '日文朗读' },
  { id: 'ja-JP-KeitaNeural', label: 'Keita · 日语男声', gender: 'male', group: 'foreign', style: '日文朗读' },
]

export const DEFAULT_EDGE_VOICE = 'zh-TW-HsiaoChenNeural'

export const edgeAvailable = () => isTauri()

let currentAudio: HTMLAudioElement | null = null

/** 合成一段文本为 mp3 Blob (Rust 侧完成) */
export async function edgeSynthesize(text: string, voice: string, rate: number): Promise<Blob> {
  const { invoke } = await import('@tauri-apps/api/core')
  const ratePercent = Math.round((rate - 1) * 100)
  const bytes = await invoke<ArrayBuffer>('edge_tts_synthesize', {
    text,
    voice: voice || DEFAULT_EDGE_VOICE,
    ratePercent,
  })
  return new Blob([bytes], { type: 'audio/mpeg' })
}

/** 播放 mp3 Blob, 结束 / 被取消时 resolve */
export function playAudio(blob: Blob): Promise<'end' | 'cancelled'> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    const done = (result: 'end' | 'cancelled') => {
      URL.revokeObjectURL(url)
      if (currentAudio === audio) currentAudio = null
      resolve(result)
    }
    audio.onended = () => done('end')
    audio.onerror = () => done(audio.dataset.cancelled ? 'cancelled' : 'end')
    audio.onpause = () => {
      // pause() 且被标记取消时立即结束
      if (audio.dataset.cancelled) done('cancelled')
    }
    audio.play().catch(() => done('end'))
  })
}

export function edgePause() {
  currentAudio?.pause()
}

export function edgeResume() {
  currentAudio?.play().catch(() => { /* 已结束 */ })
}

export function edgeStop() {
  if (currentAudio) {
    currentAudio.dataset.cancelled = '1'
    currentAudio.pause()
    currentAudio = null
  }
}
