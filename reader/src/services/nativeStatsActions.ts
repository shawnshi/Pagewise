/** Headless reuse of the existing reading log/statistics owners; Android only renders the bounded DTO. */
import { dayOfWeek, heatmap, addDays, comparePeriods, daysBetween, filterDaily, milestones, monthCalendar, monthlyTotals, periodRange, rangeSummary, streaks, weekStrip, yearsWithData, type DailyMap, type KindFilter, type PeriodKind } from './readingStats.ts'
import { isSupportedBookFormat } from './format.ts'
import { stateError, type JsonObject } from './nativeState.ts'
import type { NativeManagementHandler } from './nativeManagementActions.ts'
interface Dependencies {
  daily(): Promise<DailyMap>
  settings(): Promise<{ dailyGoalMinutes: number; language: string }>
  today(): Promise<string>
  books(): Promise<Array<{ id: string; title: string; format?: string; lastReadAt?: number; readingSeconds?: number }>>
}
const defaults: Dependencies = {
  daily: async () => (await import('./readingLog.ts')).loadDaily(),
  today: async () => (await import('./readingLog.ts')).localDay(),
  books: async () => (await (await import('../storage/index.ts')).getStorage()).listBooks(),
  settings: async () => {
    const settings = (await import('../stores/settings.ts')).useSettings()
    const recovery = await settings.reloadNativeSettings()
    if (recovery.unsavedPaths.length || recovery.failedCommits.length) throw stateError('native_settings_unsaved')
    return { dailyGoalMinutes: settings.dailyGoalMinutes, language: settings.language }
  },
}
const day = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw stateError('invalid_date')
  const date = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw stateError('invalid_date')
  return value
}
const number = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw stateError('invalid_payload')
  return value
}
export function createNativeStatsActions(injected: Partial<Dependencies> = {}): Record<string, NativeManagementHandler> {
  const deps = { ...defaults, ...injected }
  return { statisticsGet: async (p: JsonObject) => {
    if (Object.keys(p).some(k => !['period', 'anchor', 'kind', 'calendarMonth', 'heatmapYear', 'from', 'to', 'offset', 'bookOffset', 'dayBookOffset', 'limit', 'selectedDay'].includes(k))) throw stateError('invalid_payload')
    const period = p.period ?? 'month', kind = p.kind ?? 'all'
    if (typeof period !== 'string' || typeof kind !== 'string' || !['week', 'month', 'year', 'all', 'range'].includes(period) || !['all', 'book', 'paper'].includes(kind)) throw stateError('invalid_payload')
    const limit = number(p.limit, 30, 60), offset = number(p.offset, 0, 1_000_000), bookOffset = number(p.bookOffset, 0, 1_000_000), dayBookOffset = number(p.dayBookOffset, 0, 1_000_000)
    if (!limit) throw stateError('invalid_payload')
    const today = day(await deps.today()), anchor = day(p.anchor ?? today)
    const month = p.calendarMonth ?? anchor.slice(0, 7)
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw stateError('invalid_date')
    day(month + '-01')
    const raw = await deps.daily(), settings = await deps.settings(), catalogRows = await deps.books(), catalog = new Map(catalogRows.map(b => [b.id, b.title]))
    const recent = catalogRows.filter(b => b.lastReadAt).sort((a, b) => b.lastReadAt! - a.lastReadAt!)[0]
    const continueBook = recent ? { id: recent.id, title: recent.title, readerPath: isSupportedBookFormat(recent.format) ? `${recent.format === 'pdf' ? '/read-pdf/' : '/read/'}${encodeURIComponent(recent.id)}` : null } : null
    const daily = filterDaily(raw, kind as KindFilter)
    const range = period === 'all' ? { from: '0000-01-01', to: '9999-12-31' } : period === 'range' ? { from: day(p.from), to: day(p.to) } : periodRange(period as PeriodKind, anchor)
    if (range.from > range.to) throw stateError('invalid_date_range')
    const summary = rangeSummary(daily, range.from, range.to)
    const dates = Object.keys(daily).filter(d => d >= range.from && d <= range.to && daily[d]!.seconds > 0).sort().reverse()
    const displayBook = (b: typeof summary.books[number]) => ({ ...b, title: (b.bookId && catalog.get(b.bookId)) || b.title, bookId: b.bookId && catalog.has(b.bookId) ? b.bookId : null })
    const entry = (d: string) => ({ day: d, seconds: daily[d]?.seconds ?? 0 })
    const selected = p.selectedDay === undefined ? null : day(p.selectedDay)
    const selectedBooks = selected ? daily[selected]?.books ?? [] : []
    const goal = Math.max(0, Math.round(settings.dailyGoalMinutes || 0))
    const heatScope = p.heatmapYear ?? 'recent'
    if (heatScope !== 'recent' && (typeof heatScope !== 'string' || !/^\d{4}$/.test(heatScope))) throw stateError('invalid_payload')
    const heatStart = heatScope === 'recent' ? '' : day(`${heatScope}-01-01`)
    const heatEnd = heatScope === 'recent' ? today : day(`${heatScope}-12-31`)
    const heatWeeks = heatScope === 'recent' ? 53 : Math.ceil((daysBetween(heatStart, heatEnd) + (dayOfWeek(heatStart) + 6) % 7) / 7)
    const heat = heatmap(daily, heatEnd, heatWeeks).map(col => col.map(cell => cell && cell.day <= today && (heatScope === 'recent' || cell.day.startsWith(String(heatScope) + '-')) ? cell : null))
    const calendar = monthCalendar(Number(month.slice(0, 4)), Number(month.slice(5, 7))).map(row => row.map(d => d === null ? null : { day: d, seconds: daily[d]?.seconds ?? 0, met: (daily[d]?.seconds ?? 0) >= (goal > 0 ? goal * 60 : 60) }))
    const trend = period === 'year' ? monthlyTotals(daily, Number(anchor.slice(0, 4))).map(m => ({ label: m.month, seconds: m.seconds }))
      : ['week', 'month'].includes(String(period)) ? Array.from({ length: daysBetween(range.from, range.to) }, (_, i) => { const d = addDays(range.from, i); return { label: d, seconds: daily[d]?.seconds ?? 0 } })
        : dates.slice(0, 31).reverse().map(d => ({ label: d, seconds: daily[d]!.seconds }))
    const marks = milestones(raw)
    const result = {
      ok: true, language: settings.language, today, goalMinutes: goal, goalBefore: settings.dailyGoalMinutes,
      legacySeconds: catalogRows.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0), continueBook,
      overview: { todaySeconds: raw[today]?.seconds ?? 0, yesterdaySeconds: raw[addDays(today, -1)]?.seconds ?? 0, streak: streaks(raw, today), milestones: { ...marks, topBook: marks.topBook ? displayBook(marks.topBook) : null }, week: weekStrip(raw, today, goal * 60) },
      period: { period, kind, anchor, ...range, seconds: summary.seconds, activeDays: summary.activeDays, bookCount: summary.books.length, activeAverageSeconds: summary.activeDays ? summary.seconds / summary.activeDays : 0, comparison: ['week', 'month', 'year'].includes(String(period)) ? comparePeriods(daily, period as PeriodKind, anchor, today) : null, years: yearsWithData(daily), trend },
      calendar: { month, rows: calendar, heatmapScope: heatScope, heatmap: heat },
      days: { total: dates.length, offset, limit, items: dates.slice(offset, offset + limit).map(entry) },
      books: { total: summary.books.length, offset: bookOffset, limit, items: summary.books.slice(bookOffset, bookOffset + limit).map(displayBook) },
      selectedDay: selected === null ? null : { ...entry(selected), totalBooks: selectedBooks.length, offset: dayBookOffset, limit, books: selectedBooks.slice(dayBookOffset, dayBookOffset + limit).map(displayBook) },
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw stateError('resource_limit')
    return result
  } }
}
