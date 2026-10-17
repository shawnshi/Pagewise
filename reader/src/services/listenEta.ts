/**
 * 听书剩余时间: 按实际朗读速度 (字/秒) 估算本章、全书还要听多久。
 *
 * - 语速随引擎、音色、倍速而异, 所以边读边测: 每段朗读的字数 / 实际耗时 (扣除暂停)。
 *   测得的速度归一到 1.0x 存放, 调倍速后立即按比例换算, 不必重新学习。
 * - 还没测到时用常见语速兜底: 中文约 4.5 字/秒, 西文约 13 字母/秒 (≈150 词/分)。
 * - 字数只数文字和数字, 标点与空白不算; 正文与朗读段落用同一口径, 两边才能相除。
 */

export interface SpeechPace {
  /** 1.0x 下每秒朗读的字数 */
  cps: number
  /** 已计入的样本数; 0 表示尚未实测 */
  samples: number
}

export const DEFAULT_CPS = { cjk: 4.5, other: 13 } as const

const WORD_CHAR = /[\p{L}\p{N}]/gu

export function countSpeechChars(text: string | null | undefined): number {
  if (!text) return 0
  return text.match(WORD_CHAR)?.length ?? 0
}

/**
 * 计入一段朗读。过短的段 (标题、一两个字) 计时误差大, 不计;
 * 明显离谱的速度 (卡顿、跳过) 也不计。前几段等权平均, 之后指数平滑, 能跟上换音色后的变化。
 */
export function recordPace(pace: SpeechPace, chars: number, seconds: number, rate: number): SpeechPace {
  if (chars < 6 || seconds < 1 || rate <= 0) return pace
  const sample = chars / seconds / rate
  if (sample < 0.5 || sample > 40) return pace
  const weight = Math.max(0.2, 1 / (pace.samples + 1))
  const cps = pace.samples ? pace.cps + (sample - pace.cps) * weight : sample
  return { cps, samples: pace.samples + 1 }
}

/** 当前倍速下的实际语速 */
export function paceCps(pace: SpeechPace, rate: number, cjk: boolean): number {
  const base = pace.samples ? pace.cps : cjk ? DEFAULT_CPS.cjk : DEFAULT_CPS.other
  return base * Math.max(0.1, rate)
}

export type HumanDuration =
  | { kind: 'lessThanMinute' }
  | { kind: 'minutes'; m: number }
  | { kind: 'hours'; h: number }
  | { kind: 'hoursMinutes'; h: number; m: number }

/**
 * 人话时长: 精度随量级变粗, 和人报时间的习惯一致。
 * <1 分钟「不到 1 分钟」; <10 分钟精确到分; <1 小时取整到 5 分;
 * <10 小时「X 小时 Y 分」取整到 10 分; 更长只说小时。
 */
export function humanizeDuration(seconds: number): HumanDuration {
  const s = Math.max(0, seconds)
  if (s < 60) return { kind: 'lessThanMinute' }
  const min = s / 60
  if (min < 10) return { kind: 'minutes', m: Math.ceil(min) }
  if (min < 57.5) return { kind: 'minutes', m: Math.round(min / 5) * 5 }
  if (min < 10 * 60 - 5) {
    let h = Math.floor(min / 60)
    let m = Math.round((min - h * 60) / 10) * 10
    if (m === 60) { h++; m = 0 }
    return m ? { kind: 'hoursMinutes', h, m } : { kind: 'hours', h }
  }
  return { kind: 'hours', h: Math.round(min / 60) }
}

/**
 * 预计听完的钟点; 超过 12 小时不给钟点 (没人会一口气听那么久)。
 * dayOffset: 0 今天, 1 明天。
 */
export function finishClock(seconds: number, now: Date): { hh: string; mm: string; dayOffset: number } | null {
  if (!(seconds >= 0) || seconds > 12 * 3600) return null
  const end = new Date(now.getTime() + seconds * 1000)
  // 取整到分钟 (向上), 避免显示一个已经过去的分钟
  if (end.getSeconds() || end.getMilliseconds()) end.setMinutes(end.getMinutes() + 1, 0, 0)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayOffset = Math.round((startOfDay(end) - startOfDay(now)) / 86400000)
  return {
    hh: String(end.getHours()).padStart(2, '0'),
    mm: String(end.getMinutes()).padStart(2, '0'),
    dayOffset,
  }
}
