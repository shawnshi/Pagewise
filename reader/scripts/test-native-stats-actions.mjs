import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativeStatsActions } from '../src/services/nativeStatsActions.ts'
const b = (seconds, kind = 'book', id = 'a') => ({ key: 'id:' + id, bookId: id, title: id === 'a' ? 'OLD TITLE' : 'Paper history', kind, seconds })
const daily = {
  '2026-10-12': { seconds: 60, books: [b(60)] },
  '2026-10-19': { seconds: 90, books: [b(60), b(30, 'paper', 'removed')] },
  '2026-10-20': { seconds: 10, books: [b(10)] },
  '2026-10-21': { seconds: 180, books: [b(120), b(60, 'paper', 'removed')] },
}
const make = (extra = {}) => createNativeStatsActions({ daily: async () => structuredClone(daily), settings: async () => ({ language: 'zh', dailyGoalMinutes: 2 }), today: async () => '2026-10-21', books: async () => [{ id: 'a', title: 'Current catalog title' }], ...extra }).statisticsGet
const ask = (extra = {}) => make()({ period: 'week', anchor: '2026-10-21', ...extra })
test('period summary preserves existing >=60-second active day/average semantics and period comparison', async () => {
  const r = await ask()
  assert.equal(r.period.seconds, 280); assert.equal(r.period.activeDays, 2); assert.equal(r.period.activeAverageSeconds, 140)
  assert.equal(r.period.comparison.prevSeconds, 60); assert.equal(r.period.comparison.elapsedDays, 3)
  assert.equal(r.overview.todaySeconds, 180); assert.equal(r.overview.yesterdaySeconds, 10)
  assert.equal(r.overview.streak.current, 1); assert.equal(r.overview.milestones.totalSeconds, 340)
})
test('calendar/week/years/year chart use existing shared pure functions without a second stats store', async () => {
  const r = await ask({ period: 'year', calendarMonth: '2026-10' })
  assert.equal(r.period.trend.length, 12); assert.deepEqual(r.period.years, [2026])
  assert.equal(r.calendar.rows.flat().filter(Boolean).length, 31)
  const wed = r.overview.week.find(d => d.day === '2026-10-21'); assert.equal(wed.met, true)
  assert.equal(r.overview.week.find(d => d.day === '2026-10-19').met, false)
  assert.equal(r.overview.week.find(d => d.day === '2026-10-22').future, true)
})
test('global filter/count before bounded paging; history titles retained but missing books are not jump links', async () => {
  const r = await ask({ limit: 2 }), next = await ask({ limit: 2, offset: 2 })
  assert.equal(r.days.total, 3); assert.deepEqual(r.days.items.map(d => d.day), ['2026-10-21', '2026-10-20'])
  assert.deepEqual(next.days.items.map(d => d.day), ['2026-10-19'])
  assert.equal(r.books.total, 2); assert.equal(r.books.items[0].title, 'Current catalog title')
  assert.equal(r.books.items[1].bookId, null); assert.equal(r.books.items[1].title, 'Paper history')
  const paper = await ask({ kind: 'paper' }); assert.equal(paper.period.seconds, 90); assert.equal(paper.period.activeAverageSeconds, 90)
  const oneBook = await ask({ bookOffset: 1, limit: 1 }); assert.equal(oneBook.books.items[0].key, 'id:removed')
})
test('selected day detail, custom range, zero/negative legacy goal and empty genuine records', async () => {
  const r = await ask({ selectedDay: '2026-10-21', period: 'range', from: '2026-10-20', to: '2026-10-21' })
  assert.equal(r.selectedDay.books.length, 2); assert.equal(r.period.seconds, 190)
  const old = await make({ settings: async () => ({ language: 'en', dailyGoalMinutes: -1 }) })({})
  assert.equal(old.goalMinutes, 0); assert.equal(old.goalBefore, -1, 'CAS compares actual canonical value, not normalized display goal')
  const empty = await make({ daily: async () => ({}) })({})
  assert.equal(empty.days.total, 0); assert.equal(empty.period.activeAverageSeconds, 0)
})
for (const input of [{ period: 'bogus' }, { period: ['month'] }, { kind: ['all'] }, { kind: 'invalid' }, { anchor: '2026-02-31' }, { calendarMonth: '2026-13' }, { offset: -1 }, { limit: 0 }, { limit: 1000 }, { period: 'range', from: '2026-10-21', to: '2026-10-01' }, { selectedDay: 'wrong' }, { unknown: true }]) test(`reject invalid statistics request ${JSON.stringify(input)}`, async () => {
  await assert.rejects(ask(input), /invalid_payload|invalid_date/)
})
test('year calendar covers complete leap/Sunday year without silently dropping boundary days', async () => {
  const r = await ask({ heatmapYear: '2012' })
  const cells = r.calendar.heatmap.flat().filter(Boolean)
  assert.equal(cells.length, 366); assert.equal(cells[0].day, '2012-01-01'); assert.equal(cells.at(-1).day, '2012-12-31')
  assert.equal(r.calendar.heatmap.length, 54)
})
test('many-book day is paged separately; day rows never multiply an unbounded embedded book list', async () => {
  const many = Array.from({ length: 65 }, (_, i) => b(60, 'book', 'synthetic-' + i))
  const request = make({ daily: async () => ({ '2026-10-21': { seconds: 3900, books: many } }) })
  const first = await request({ selectedDay: '2026-10-21', limit: 20 })
  assert.equal(first.selectedDay.totalBooks, 65); assert.equal(first.selectedDay.books.length, 20)
  assert.equal('books' in first.days.items[0], false)
  const tail = await request({ selectedDay: '2026-10-21', dayBookOffset: 60, limit: 20 })
  assert.equal(tail.selectedDay.books.length, 5)
})
test('continue reader uses existing format policy and preserves undated cumulative time without daily synthesis', async () => {
  const r = await make({ daily: async () => ({}), books: async () => [{ id: 'synthetic', title: 'Synthetic PDF', format: 'pdf', lastReadAt: 10, readingSeconds: 125 }] })({})
  assert.equal(r.legacySeconds, 125); assert.equal(r.continueBook.readerPath, '/read-pdf/synthetic')
  assert.equal(r.period.seconds, 0); assert.equal(r.days.total, 0)
})
test('database/recovery errors propagate; no fake no-data result', async () => {
  await assert.rejects(make({ daily: async () => { throw new Error('database_unavailable') } })({}), /database_unavailable/)
  await assert.rejects(make({ settings: async () => { throw new Error('native_settings_unsaved') } })({}), /native_settings_unsaved/)
})
