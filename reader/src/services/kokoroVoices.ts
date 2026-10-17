/**
 * 本地离线语音 (sherpa-onnx + kokoro-multi-lang-v1_1) 的 103 个音色, 按 sid 排序.
 *
 * 来源 (2026-10-04 核对):
 * - sid → 名称对照表: sherpa-onnx 文档
 *   https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html
 *   (af = 美式英语女声 sid 0–1, bf = 英式英语女声 sid 2, zf = 中文女声 sid 3–57 共 55 个,
 *   zm = 中文男声 sid 58–102 共 45 个; 即按名称字母序排列). voices.bin 大小
 *   53790720 = 103 × 510 × 256 × 4 字节, 与 103 个音色一致.
 * - 模型卡 https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh : 中文音色来自龙猫数据的
 *   100 名专业发音人, 英文 Maple / Sol (美式女声) 与 Vale (年长英式女声) 各约 1 小时合成数据.
 *   模型卡只给了两段中文示例 (samples/HEARME_zf_001.wav, HEARME_zm_010.wav).
 *
 * 推荐标记: 官方没有发布音色质量排名, 也没找到可信的社区对比; 这里只把模型卡挑出来做示例的
 * zf_001 / zm_010 标成推荐, 其余不做主观推荐. 默认音色 sid 50 (zf_086) 是中文女声, 保持不变.
 */

export interface KokoroVoice {
  sid: number
  name: string
  gender: 'female' | 'male'
  lang: 'zh' | 'en'
  recommended?: boolean
  note?: string
}

/** 下标即 sid (与 voices.bin 中的顺序一致) */
const NAMES = [
  'af_maple', 'af_sol', 'bf_vale', 'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', // 0–7
  'zf_006', 'zf_007', 'zf_008', 'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', // 8–15
  'zf_023', 'zf_024', 'zf_026', 'zf_027', 'zf_028', 'zf_032', 'zf_036', 'zf_038', // 16–23
  'zf_039', 'zf_040', 'zf_042', 'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048', // 24–31
  'zf_049', 'zf_051', 'zf_059', 'zf_060', 'zf_067', 'zf_070', 'zf_071', 'zf_072', // 32–39
  'zf_073', 'zf_074', 'zf_075', 'zf_076', 'zf_077', 'zf_078', 'zf_079', 'zf_083', // 40–47
  'zf_084', 'zf_085', 'zf_086', 'zf_087', 'zf_088', 'zf_090', 'zf_092', 'zf_093', // 48–55
  'zf_094', 'zf_099', 'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', // 56–63
  'zm_015', 'zm_016', 'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033', // 64–71
  'zm_034', 'zm_035', 'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052', 'zm_053', // 72–79
  'zm_054', 'zm_055', 'zm_056', 'zm_057', 'zm_058', 'zm_061', 'zm_062', 'zm_063', // 80–87
  'zm_064', 'zm_065', 'zm_066', 'zm_068', 'zm_069', 'zm_080', 'zm_081', 'zm_082', // 88–95
  'zm_089', 'zm_091', 'zm_095', 'zm_096', 'zm_097', 'zm_098', 'zm_100', // 96–102
] as const

/** 有出处支撑的推荐 (见文件头): 模型卡示例音色 */
const RECOMMENDED: Record<string, string> = {
  zf_001: 'Official sample voice on the Kokoro-82M-v1.1-zh model card',
  zm_010: 'Official sample voice on the Kokoro-82M-v1.1-zh model card',
}

const NOTES: Record<string, string> = {
  af_maple: 'American English female (synthetic training data)',
  af_sol: 'American English female (synthetic training data)',
  bf_vale: 'Older British English female (synthetic training data)',
}

export const KOKORO_VOICES: KokoroVoice[] = NAMES.map((name, sid) => {
  const voice: KokoroVoice = {
    sid,
    name,
    gender: name[1] === 'm' ? 'male' : 'female',
    lang: name[0] === 'z' ? 'zh' : 'en',
  }
  if (RECOMMENDED[name]) {
    voice.recommended = true
    voice.note = RECOMMENDED[name]
  } else if (NOTES[name]) {
    voice.note = NOTES[name]
  }
  return voice
})

/** 默认音色: sid 50 = zf_086 (中文女声) */
export const DEFAULT_KOKORO_SID = 50

/** 人类可读的音色名, 例如 '中文女声 · zf_001 · 推荐' / 'Chinese female · zf_001 · recommended' */
export function kokoroVoiceLabel(v: KokoroVoice, lang: 'zh' | 'en'): string {
  const british = v.name.startsWith('b')
  let kind: string
  if (lang === 'zh') {
    const who = v.gender === 'male' ? '男声' : '女声'
    kind = v.lang === 'zh' ? `中文${who}` : `${british ? '英式' : '美式'}英语${who}`
  } else {
    const who = v.gender === 'male' ? 'male' : 'female'
    kind = v.lang === 'zh' ? `Chinese ${who}` : `${british ? 'British' : 'American'} English ${who}`
  }
  const parts = [kind, v.name]
  if (v.recommended) parts.push(lang === 'zh' ? '推荐' : 'recommended')
  return parts.join(' · ')
}
