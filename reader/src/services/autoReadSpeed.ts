/**
 * 自动翻页 / 自动滚动的速度: 1–100 档 (1 最慢, 100 最快), 刻度上标 极慢 … 很快。
 * 读者只需要「快一点 / 慢一点」, 不需要换算「几秒一屏」; 底层仍存 settings.autoReadSeconds
 * (秒/屏, 翻页时即秒/页), 老数据与多端同步不变, 旧值落在最接近的那一档。
 */
export type AutoSpeedLevel = 'slowest' | 'verySlow' | 'slow' | 'medium' | 'fast' | 'veryFast' | 'fastest'

/** 档位总数 */
export const AUTO_SPEED_STEPS = 100

/**
 * 有名字的刻度: 所在档位 + 对应秒数; 两端留足余地 (极慢约 5 分钟一屏, 极快 3 秒一屏), 默认「适中」在正中间。
 * 相邻刻度之间按秒数的对数插值, 每一档的快慢变化感受一致。
 */
export const AUTO_SPEED_LEVELS: ReadonlyArray<{ level: AutoSpeedLevel; position: number; seconds: number; key: string }> = [
  { level: 'slowest', position: 1, seconds: 300, key: 'reader.speedSlowest' },
  { level: 'verySlow', position: 17, seconds: 90, key: 'reader.speedVerySlow' },
  { level: 'slow', position: 33, seconds: 40, key: 'reader.speedSlow' },
  { level: 'medium', position: 50, seconds: 15, key: 'reader.speedMedium' },
  { level: 'fast', position: 67, seconds: 9, key: 'reader.speedFast' },
  { level: 'veryFast', position: 83, seconds: 5, key: 'reader.speedVeryFast' },
  { level: 'fastest', position: 100, seconds: 3, key: 'reader.speedFastest' },
]

const L = AUTO_SPEED_LEVELS

/** 秒数 → 档位 (1–100 的整数) */
export function speedPosition(seconds: number): number {
  if (!(seconds > 0)) return 50
  if (seconds >= L[0].seconds) return L[0].position
  if (seconds <= L[L.length - 1].seconds) return L[L.length - 1].position
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i]
    const b = L[i + 1]
    if (seconds <= a.seconds && seconds >= b.seconds) {
      const f = Math.log(a.seconds / seconds) / Math.log(a.seconds / b.seconds)
      return Math.round(a.position + f * (b.position - a.position))
    }
  }
  return 50
}

/** 档位 → 秒数; 正好在刻度上时取刻度的整秒数, 其余保留一位小数 */
export function secondsAtPosition(pos: number): number {
  const p = Math.min(L[L.length - 1].position, Math.max(L[0].position, Math.round(pos)))
  const exact = L.find(l => l.position === p)
  if (exact) return exact.seconds
  let i = 0
  while (i < L.length - 2 && p > L[i + 1].position) i++
  const a = L[i]
  const b = L[i + 1]
  const f = (p - a.position) / (b.position - a.position)
  return Math.round(a.seconds * Math.pow(b.seconds / a.seconds, f) * 10) / 10
}

/** 秒数对应的最近刻度下标 (按档位距离) */
export function autoSpeedIndex(seconds: number): number {
  const p = speedPosition(seconds)
  let best = 0
  L.forEach((l, i) => {
    if (Math.abs(l.position - p) < Math.abs(L[best].position - p)) best = i
  })
  return best
}

/** 刻度名的 i18n key (两刻度之间时取近的那个) */
export function autoSpeedKey(seconds: number): string {
  return L[autoSpeedIndex(seconds)].key
}

/** 快一点 (dir = 1) / 慢一点 (dir = -1): 每次 5 档, 到头不动 */
export function stepAutoSpeed(seconds: number, dir: 1 | -1, step = 5): number {
  return secondsAtPosition(speedPosition(seconds) + dir * step)
}
