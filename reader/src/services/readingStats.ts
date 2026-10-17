/**
 * 阅读记录的聚合计算: 纯函数, 不依赖 vue / dexie, 可在 node 里直接测试.
 * 日期一律是 `YYYY-MM-DD` 字符串, 加减与星期按 UTC 运算 (与时区、夏令时无关);
 * 「今天」由调用方用 readingLog.localDay() 按本地时区给出.
 */

export interface DayBook {
  /** 聚合键: `id:<bookId>` / `h:<hash>` / `t:<书名>` */
  key: string
  bookId?: string
  title: string
  kind: 'book' | 'paper'
  seconds: number
}

export interface DayEntry {
  seconds: number
  /** 按秒数降序 */
  books: DayBook[]
}

/** 键: YYYY-MM-DD */
export type DailyMap = Record<string, DayEntry>

/** 当天读满 1 分钟才算「阅读天」 */
export const ACTIVE_DAY_SECONDS = 60

const DAY_MS = 86_400_000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function dayToUtc(day: string): number {
  const m = DAY_RE.exec(day)
  if (!m) throw new RangeError(`invalid day: ${day}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function utcToDay(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  return `${String(y).padStart(4, '0')}-${mo}-${da}`
}

export function addDays(day: string, n: number): string {
  return utcToDay(dayToUtc(day) + n * DAY_MS)
}

/** 0 = 周日 … 6 = 周六 */
export function dayOfWeek(day: string): number {
  return new Date(dayToUtc(day)).getUTCDay()
}

const isActive = (e: DayEntry | undefined) => !!e && e.seconds >= ACTIVE_DAY_SECONDS

/**
 * 连续阅读天数. current: 今天读满就从今天往前数; 今天还没读满则从昨天往前数
 * (今天还有机会续上, 不算断). longest: 历史最长连续天数.
 */
export function streaks(daily: DailyMap, today: string): { current: number; longest: number } {
  let current = 0
  let cursor = isActive(daily[today]) ? today : addDays(today, -1)
  while (isActive(daily[cursor])) {
    current++
    cursor = addDays(cursor, -1)
  }

  return { current, longest: Math.max(longestStreak(daily), current) }
}

/** 历史最长连续阅读天数 (与「今天」无关) */
function longestStreak(daily: DailyMap): number {
  const days = Object.keys(daily).filter(d => DAY_RE.test(d) && isActive(daily[d])).sort()
  let longest = 0
  let run = 0
  let prev: string | undefined
  for (const d of days) {
    run = prev !== undefined && addDays(prev, 1) === d ? run + 1 : 1
    if (run > longest) longest = run
    prev = d
  }
  return longest
}

/** [from, to] 两端都含的汇总; books 跨天按 key 合并, 按秒数降序 */
export function rangeSummary(
  daily: DailyMap,
  from: string,
  to: string,
): { seconds: number; activeDays: number; books: DayBook[] } {
  let seconds = 0
  let activeDays = 0
  const books = new Map<string, DayBook>()
  for (const [day, entry] of Object.entries(daily)) {
    if (!DAY_RE.test(day) || day < from || day > to) continue
    seconds += entry.seconds
    if (isActive(entry)) activeDays++
    for (const b of entry.books) {
      const prev = books.get(b.key)
      if (prev) {
        prev.seconds += b.seconds
        if (!prev.bookId && b.bookId) prev.bookId = b.bookId
      } else {
        books.set(b.key, { ...b })
      }
    }
  }
  return { seconds, activeDays, books: sortBooks([...books.values()]) }
}

export function sortBooks(books: DayBook[]): DayBook[] {
  return books.sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}

/**
 * 年度热力图: 返回若干列, 每列是一周 7 格 (从 weekStart 开始), 最后一列含今天.
 * 今天之后的格子为 null. 默认 53 周、周一起.
 */
export function heatmap(
  daily: DailyMap,
  today: string,
  weeks = 53,
  weekStart: 0 | 1 = 1,
): Array<Array<{ day: string; seconds: number } | null>> {
  const offset = (dayOfWeek(today) - weekStart + 7) % 7
  const lastWeekStart = addDays(today, -offset)
  const first = addDays(lastWeekStart, -7 * (Math.max(1, weeks) - 1))
  const cols: Array<Array<{ day: string; seconds: number } | null>> = []
  for (let w = 0; w < Math.max(1, weeks); w++) {
    const col: Array<{ day: string; seconds: number } | null> = []
    for (let i = 0; i < 7; i++) {
      const day = addDays(first, w * 7 + i)
      col.push(day > today ? null : { day, seconds: daily[day]?.seconds ?? 0 })
    }
    cols.push(col)
  }
  return cols
}

export function totalActiveDays(daily: DailyMap): number {
  return Object.values(daily).filter(isActive).length
}

// ---- 统计页 v2: 周期 / 环比 / 本周 / 月历 / 里程碑 / 刻度 / 筛选 ----

export type PeriodKind = 'week' | 'month' | 'year'
export type KindFilter = 'all' | 'book' | 'paper'

const pad2 = (n: number) => String(n).padStart(2, '0')
const pad4 = (n: number) => String(n).padStart(4, '0')

function parseDay(day: string): { y: number; m: number; d: number } {
  const m = DAY_RE.exec(day)
  if (!m) throw new RangeError(`invalid day: ${day}`)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** 组装 YYYY-MM-DD (month 为 1–12) */
export function makeDay(year: number, month: number, day: number): string {
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`
}

/** 某月天数 (month 为 1–12) */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** [from, to] 两端都含的天数 */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToUtc(to) - dayToUtc(from)) / DAY_MS) + 1
}

/** 周一起始: day 所在周的周一 */
export function weekStartOf(day: string): string {
  return addDays(day, -((dayOfWeek(day) + 6) % 7))
}

/** anchor 所在周期的起止（含两端）。周 = 周一到周日 */
export function periodRange(kind: PeriodKind, anchor: string): { from: string; to: string } {
  const { y, m } = parseDay(anchor)
  if (kind === 'week') {
    const from = weekStartOf(anchor)
    return { from, to: addDays(from, 6) }
  }
  if (kind === 'month') return { from: makeDay(y, m, 1), to: makeDay(y, m, daysInMonth(y, m)) }
  return { from: makeDay(y, 1, 1), to: makeDay(y, 12, 31) }
}

/** 相邻周期的锚点日（delta = -1 上一期, +1 下一期）；月份不存在的日期取月末，年同理 */
export function shiftPeriod(kind: PeriodKind, anchor: string, delta: number): string {
  const n = Math.trunc(delta) || 0
  if (kind === 'week') return addDays(anchor, 7 * n)
  const { y, m, d } = parseDay(anchor)
  let ty = y
  let tm = m
  if (kind === 'month') {
    const idx = y * 12 + (m - 1) + n
    ty = Math.floor(idx / 12)
    tm = idx - ty * 12 + 1
  } else {
    ty = y + n
  }
  return makeDay(ty, tm, Math.min(d, daysInMonth(ty, tm)))
}

function sumSeconds(daily: DailyMap, from: string, to: string): number {
  let seconds = 0
  if (from > to) return 0
  for (const [day, entry] of Object.entries(daily)) {
    if (DAY_RE.test(day) && day >= from && day <= to) seconds += entry.seconds
  }
  return seconds
}

/** 环比：当前期若包含 today，只与上一期「相同已过天数」比较（如本周到周三 vs 上周一到周三）；
 *  deltaRatio = (cur - prev) / prev，prev 为 0 时 null。
 *  elapsedDays: 当前期已过去的天数 (含 today); 整期在过去为整期天数, 整期在未来为 0。 */
export function comparePeriods(
  daily: DailyMap,
  kind: PeriodKind,
  anchor: string,
  today: string,
): { seconds: number; prevSeconds: number; deltaRatio: number | null; elapsedDays: number } {
  const cur = periodRange(kind, anchor)
  const prev = periodRange(kind, shiftPeriod(kind, anchor, -1))
  let elapsedDays: number
  let curTo = cur.to
  let prevTo = prev.to
  if (today < cur.from) {
    elapsedDays = 0
    curTo = addDays(cur.from, -1)
    prevTo = addDays(prev.from, -1)
  } else if (today <= cur.to) {
    elapsedDays = daysBetween(cur.from, today)
    curTo = today
    const p = addDays(prev.from, elapsedDays - 1)
    if (p < prevTo) prevTo = p
  } else {
    elapsedDays = daysBetween(cur.from, cur.to)
  }
  const seconds = sumSeconds(daily, cur.from, curTo)
  const prevSeconds = sumSeconds(daily, prev.from, prevTo)
  const deltaRatio = prevSeconds > 0 ? (seconds - prevSeconds) / prevSeconds : null
  return { seconds, prevSeconds, deltaRatio, elapsedDays }
}

/** 今天所在周的 7 天：ratio = 当天秒数 / goalSeconds 封顶 1；goalSeconds <= 0 时 ratio = 当天是否 ≥ ACTIVE_DAY_SECONDS（0 或 1）；future 为今天之后 */
export function weekStrip(
  daily: DailyMap,
  today: string,
  goalSeconds: number,
): Array<{ day: string; seconds: number; ratio: number; met: boolean; future: boolean; isToday: boolean }> {
  const from = weekStartOf(today)
  const goal = Number.isFinite(goalSeconds) ? goalSeconds : 0
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(from, i)
    const seconds = daily[day]?.seconds ?? 0
    const met = goal > 0 ? seconds >= goal : seconds >= ACTIVE_DAY_SECONDS
    const ratio = goal > 0 ? Math.min(1, seconds / goal) : (met ? 1 : 0)
    return { day, seconds, ratio, met, future: day > today, isToday: day === today }
  })
}

/** 月历：按周分行，每行 7 格（周一起），不属于该月的格为 null；month 为 1–12 */
export function monthCalendar(year: number, month: number): Array<Array<string | null>> {
  const first = makeDay(year, month, 1)
  const lead = (dayOfWeek(first) + 6) % 7
  const total = daysInMonth(year, month)
  const cells: Array<string | null> = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= total; d++) cells.push(makeDay(year, month, d))
  while (cells.length % 7) cells.push(null)
  const rows: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

/** 里程碑: 累计时长 / 阅读天数 / 最长连续 / 单日最长 (同秒数取较早的一天) / 读得最久的一本 */
export function milestones(daily: DailyMap): {
  totalSeconds: number
  activeDays: number
  longestStreak: number
  bestDay: { day: string; seconds: number } | null
  topBook: DayBook | null
} {
  let totalSeconds = 0
  let activeDays = 0
  let bestDay: { day: string; seconds: number } | null = null
  for (const day of Object.keys(daily).filter(d => DAY_RE.test(d)).sort()) {
    const e = daily[day]
    totalSeconds += e.seconds
    if (isActive(e)) activeDays++
    if (e.seconds > 0 && (!bestDay || e.seconds > bestDay.seconds)) bestDay = { day, seconds: e.seconds }
  }
  const books = rangeSummary(daily, '0000-01-01', '9999-12-31').books
  return { totalSeconds, activeDays, longestStreak: longestStreak(daily), bestDay, topBook: books[0] ?? null }
}

const MIN = 60
const HOUR = 3600
/** 人类友好的刻度间隔 (秒): 5/10/15/30 分, 1/2/3/5/10 时, 之后 20/50/100… 时 */
const TICK_STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 5 * HOUR, 10 * HOUR]

/** 柱状图纵轴取整刻度（单位秒，含 0，升序，最后一项 ≥ maxSeconds）；最多 3 段 (≤ 4 个刻度)；maxSeconds 为 0 时返回 [0, 1800] */
export function niceTicks(maxSeconds: number): number[] {
  const max = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : 0
  if (max === 0) return [0, 30 * MIN]
  let step = 0
  for (const s of TICK_STEPS) {
    if (Math.ceil(max / s) <= 3) { step = s; break }
  }
  if (!step) {
    // 10 时以上: 20 / 50 / 100 / 200 / 500 … 时
    for (let mag = 10 * HOUR; !step; mag *= 10) {
      for (const k of [2, 5, 10]) {
        if (Math.ceil(max / (mag * k)) <= 3) { step = mag * k; break }
      }
    }
  }
  const n = Math.max(1, Math.ceil(max / step))
  return Array.from({ length: n + 1 }, (_, i) => i * step)
}

/** 按书 / 论文过滤（重算每天 seconds 与 books）; 'all' 原样返回浅拷贝; 过滤后没有书的日子去掉 */
export function filterDaily(daily: DailyMap, kind: KindFilter): DailyMap {
  if (kind === 'all') return { ...daily }
  const out: DailyMap = {}
  for (const [day, entry] of Object.entries(daily)) {
    const books = entry.books.filter(b => b.kind === kind)
    if (!books.length) continue
    out[day] = { seconds: books.reduce((s, b) => s + b.seconds, 0), books }
  }
  return out
}

/** 有数据（秒数 > 0）的年份，降序 */
export function yearsWithData(daily: DailyMap): number[] {
  const years = new Set<number>()
  for (const [day, e] of Object.entries(daily)) {
    if (DAY_RE.test(day) && e.seconds > 0) years.add(Number(day.slice(0, 4)))
  }
  return [...years].sort((a, b) => b - a)
}

/** 年视图按月汇总：返回 12 项 { month: 'YYYY-MM', seconds, activeDays } */
export function monthlyTotals(daily: DailyMap, year: number): Array<{ month: string; seconds: number; activeDays: number }> {
  const out = Array.from({ length: 12 }, (_, i) => ({ month: `${pad4(year)}-${pad2(i + 1)}`, seconds: 0, activeDays: 0 }))
  const prefix = `${pad4(year)}-`
  for (const [day, e] of Object.entries(daily)) {
    if (!DAY_RE.test(day) || !day.startsWith(prefix)) continue
    const m = out[Number(day.slice(5, 7)) - 1]
    if (!m) continue
    m.seconds += e.seconds
    if (isActive(e)) m.activeDays++
  }
  return out
}
