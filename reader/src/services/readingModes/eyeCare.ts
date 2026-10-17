/**
 * 护眼与夜间定时的纯逻辑 (docs/research/reading-modes-landscape.md §3.2 §6.1 §6.2)。
 *
 * - 应用内调暗: 0–60%, 其他平台在正文上叠一层黑色半透明遮罩 (pointer-events:none);
 *   Android 可改用原生窗口亮度 (由阅读器决定), 数值同一来源。
 * - 休息提醒 (20-20-20): 连续阅读满 N 分钟提示「看看 6 米外，休息 20 秒」;
 *   计时口径与阅读记录相同: 两次阅读活动间隔超过 5 分钟算中断, 重新计时。
 * - 夜间定时: 在 from–to 之间自动切到夜间 (可跨午夜), 只在进出时间段的那一刻动作,
 *   时间段内用户手动关掉夜间不会被反复改回。
 */

export const DIM_MAX = 60

/** 调暗档位收敛到 0–60 的整数 */
export function clampDim(level: unknown): number {
  const n = Number(level)
  if (!Number.isFinite(n)) return 0
  return Math.min(DIM_MAX, Math.max(0, Math.round(n)))
}

/** 遮罩不透明度: 调暗 x% = 亮度乘以 (1 − x%), 黑色遮罩的 alpha 正好是 x% */
export function dimAlpha(level: unknown): number {
  return clampDim(level) / 100
}

/** 遮罩背景色; 0 时为空串 (不渲染遮罩) */
export function dimBackground(level: unknown): string {
  const a = dimAlpha(level)
  return a > 0 ? `rgba(0, 0, 0, ${a.toFixed(2)})` : ''
}

// ---- 夜间定时 ----

/** 'HH:MM' → 当天第几分钟; 格式不对返回 null */
export function parseClock(s: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** now 是否落在 [from, to) 内; from > to 表示跨午夜 (22:00–07:00); from == to 或格式错误视为不启用 */
export function inNightWindow(now: number, from: unknown, to: unknown): boolean {
  const a = parseClock(from)
  const b = parseClock(to)
  if (a == null || b == null || a === b) return false
  return a < b ? now >= a && now < b : now >= a || now < b
}

/**
 * 定时器每分钟调用一次: 返回该做的动作。
 * - prevIn 为 null (刚打开阅读器): 在时间段内且不是夜间 → 'on';
 * - 进入时间段 → 'on' (已是夜间则不动);
 * - 离开时间段 (或重新打开时已在时间段外) 且夜间是定时打开的 (autoApplied) → 'off'; 用户自己开的夜间不关。
 */
export function nightScheduleAction(p: {
  inWindow: boolean
  prevIn: boolean | null
  nightOn: boolean
  autoApplied: boolean
}): 'on' | 'off' | null {
  if (p.inWindow && (p.prevIn === null || !p.prevIn)) return p.nightOn ? null : 'on'
  if (!p.inWindow && p.prevIn !== false && p.autoApplied && p.nightOn) return 'off'
  return null
}

// ---- 休息提醒 ----

export const IDLE_RESET_MS = 5 * 60 * 1000
export const SNOOZE_MS = 30 * 60 * 1000

export interface BreakTimer {
  /** 本轮连续阅读的起点 */
  start: number
  /** 最近一次阅读活动 */
  last: number
  /** 在此之前不提醒 (「30 分钟内不再提醒」) */
  snoozeUntil: number
}

export function newBreakTimer(now: number): BreakTimer {
  return { start: now, last: now, snoozeUntil: 0 }
}

/** 记一次阅读活动 (翻页、轻点、带读推进); 间隔超过 5 分钟视为中断, 重新计时 */
export function noteActivity(s: BreakTimer, now: number, idleResetMs = IDLE_RESET_MS): BreakTimer {
  if (now - s.last > idleResetMs) return { start: now, last: now, snoozeUntil: s.snoozeUntil }
  return { ...s, last: now }
}

/** 连续阅读的毫秒数 (已中断则为 0) */
export function readingSpan(s: BreakTimer, now: number, idleResetMs = IDLE_RESET_MS): number {
  if (now - s.last > idleResetMs) return 0
  return Math.max(0, s.last - s.start)
}

/** 该提醒了: 连续阅读满 intervalMin 分钟, 且不在「稍后」期间 */
export function reminderDue(s: BreakTimer, now: number, intervalMin: number, idleResetMs = IDLE_RESET_MS): boolean {
  if (now < s.snoozeUntil) return false
  return readingSpan(s, now, idleResetMs) >= Math.max(1, intervalMin) * 60000
}

/**
 * 处理提醒: done (休息完) 和 skip (跳过) 都从现在重新计时; snooze 另外 30 分钟内不提醒。
 */
export function afterReminder(s: BreakTimer, now: number, action: 'done' | 'skip' | 'snooze', snoozeMs = SNOOZE_MS): BreakTimer {
  return { start: now, last: now, snoozeUntil: action === 'snooze' ? now + snoozeMs : s.snoozeUntil }
}
