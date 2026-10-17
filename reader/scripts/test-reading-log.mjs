// 阅读记录 (GitHub #7): readingStats 纯函数 + 本地身份注入 + 历史记录 / 备份恢复.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVE_DAY_SECONDS, addDays, comparePeriods, dayOfWeek, daysInMonth, filterDaily, heatmap, milestones,
  monthCalendar, monthlyTotals, niceTicks, periodRange, rangeSummary, shiftPeriod, streaks, totalActiveDays,
  weekStrip, yearsWithData,
} from '../src/services/readingStats.ts'
import {
  aggregateReadingLog, createMemoryReadingLogStore, createReadingLog, localDay, normalizeRow,
  planReadingLogLanding,
} from '../src/services/readingLog.ts'

// ---- readingStats ----

const entry = (seconds, books = []) => ({ seconds, books })
const dailyOf = obj => Object.fromEntries(Object.entries(obj).map(([d, s]) => [d, entry(s)]))

test('addDays: 跨月 / 跨年 / 闰年 / 负数', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2027-01-01', -1), '2026-12-31')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29', '闰年')
  assert.equal(addDays('2024-02-29', 1), '2024-03-01')
  assert.equal(addDays('2026-02-28', 1), '2026-03-01', '平年')
  assert.equal(addDays('2000-02-28', 1), '2000-02-29', '世纪闰年')
  assert.equal(addDays('2100-02-28', 1), '2100-03-01', '世纪平年')
  assert.equal(addDays('2026-03-08', 0), '2026-03-08')
  assert.equal(addDays('2026-03-01', 365), '2027-03-01')
  // 夏令时切换日附近不受影响 (纯 UTC 运算)
  assert.equal(addDays('2026-03-07', 2), '2026-03-09')
  assert.equal(addDays('2026-11-01', 1), '2026-11-02')
  assert.throws(() => addDays('2026/01/01', 1))
})

test('dayOfWeek: 0 = 周日', () => {
  assert.equal(dayOfWeek('2026-10-04'), 0) // 周日
  assert.equal(dayOfWeek('2026-10-05'), 1)
  assert.equal(dayOfWeek('2024-02-29'), 4) // 周四
  assert.equal(dayOfWeek('2000-01-01'), 6) // 周六
})

test('streaks: 今天未读从昨天数; 不满 1 分钟不算; 跨月跨年', () => {
  const today = '2026-01-02'
  const daily = dailyOf({
    '2025-12-29': 600, '2025-12-30': 60, '2025-12-31': 120, '2026-01-01': 300,
    // 更早的一段更长
    '2025-11-01': 100, '2025-11-02': 100, '2025-11-03': 100, '2025-11-04': 100, '2025-11-05': 100,
    '2025-11-06': 59, // 不满 1 分钟
  })
  assert.deepEqual(streaks(daily, today), { current: 4, longest: 5 }, '今天没读: 从昨天数')
  assert.deepEqual(streaks({ ...daily, [today]: entry(30) }, today), { current: 4, longest: 5 }, '今天不足 1 分钟')
  assert.deepEqual(streaks({ ...daily, [today]: entry(60) }, today), { current: 5, longest: 5 })
  assert.deepEqual(streaks({ ...daily, [today]: entry(60), '2025-12-28': entry(60) }, today), { current: 6, longest: 6 })
  assert.deepEqual(streaks(dailyOf({ '2026-01-01': 600 }), '2026-01-03'), { current: 0, longest: 1 }, '昨天也没读: 断了')
  assert.deepEqual(streaks({}, today), { current: 0, longest: 0 })
  assert.deepEqual(streaks(dailyOf({ '2024-02-28': 60, '2024-02-29': 60, '2024-03-01': 60 }), '2024-03-01'),
    { current: 3, longest: 3 }, '闰日')
  assert.equal(ACTIVE_DAY_SECONDS, 60)
})

test('rangeSummary: 两端都含, 跨天按 key 合并书, 秒数降序', () => {
  const b = (key, seconds, extra = {}) => ({ key, title: key, kind: 'book', seconds, ...extra })
  const daily = {
    '2026-01-31': entry(100, [b('id:a', 100)]),
    '2026-02-01': entry(400, [b('h:x', 300), b('id:a', 100, { bookId: 'a' })]),
    '2026-02-28': entry(30, [b('t:z', 30)]),
    '2026-03-01': entry(999, [b('id:a', 999)]),
  }
  const r = rangeSummary(daily, '2026-02-01', '2026-02-28')
  assert.equal(r.seconds, 430)
  assert.equal(r.activeDays, 1, '30 秒那天不算阅读天')
  assert.deepEqual(r.books.map(x => [x.key, x.seconds]), [['h:x', 300], ['id:a', 100], ['t:z', 30]])
  const all = rangeSummary(daily, '2026-01-31', '2026-03-01')
  assert.equal(all.seconds, 1529)
  assert.equal(all.activeDays, 3)
  assert.deepEqual(all.books[0], { key: 'id:a', title: 'id:a', kind: 'book', seconds: 1199, bookId: 'a' })
  assert.deepEqual(rangeSummary(daily, '2027-01-01', '2027-12-31'), { seconds: 0, activeDays: 0, books: [] })
  // 不改动输入
  assert.equal(daily['2026-02-01'].books[1].seconds, 100)
})

test('heatmap: 周一起 / 周日起, 最后一列含今天, 未来为 null', () => {
  const today = '2026-10-04' // 周日
  const daily = dailyOf({ '2026-10-04': 120, '2026-09-28': 60, '2025-10-01': 999 })
  const cols = heatmap(daily, today)
  assert.equal(cols.length, 53)
  assert.ok(cols.every(c => c.length === 7))
  const last = cols.at(-1)
  assert.equal(last[0].day, '2026-09-28', '周一起')
  assert.equal(dayOfWeek(last[0].day), 1)
  assert.deepEqual(last[6], { day: '2026-10-04', seconds: 120 })
  assert.equal(last[0].seconds, 60)
  assert.equal(cols[0][0].day, addDays('2026-09-28', -52 * 7))
  // 周日起: 今天是一周的第一天, 后 6 天为未来
  const sun = heatmap(daily, today, 2, 0)
  assert.equal(sun.length, 2)
  assert.deepEqual(sun[1][0], { day: '2026-10-04', seconds: 120 })
  assert.deepEqual(sun[1].slice(1), [null, null, null, null, null, null])
  assert.equal(sun[0][0].day, '2026-09-27')
  // 周中: 周三, 周一起时周四到周日为 null
  const wed = heatmap({}, '2026-10-07', 1, 1)
  assert.deepEqual(wed[0].map(c => c && c.day), ['2026-10-05', '2026-10-06', '2026-10-07', null, null, null, null])
  // 跨年
  const ny = heatmap({}, '2027-01-01', 1, 1)
  assert.equal(ny[0][0].day, '2026-12-28')
})

test('totalActiveDays: 满 1 分钟才算', () => {
  assert.equal(totalActiveDays(dailyOf({ '2026-01-01': 60, '2026-01-02': 59, '2026-01-03': 3600 })), 2)
  assert.equal(totalActiveDays({}), 0)
})

test('periodRange: 周一起 / 跨年周 / 闰年 2 月 / 年', () => {
  assert.deepEqual(periodRange('week', '2026-10-04'), { from: '2026-09-28', to: '2026-10-04' }, '周日属于上周一开始的那周')
  assert.deepEqual(periodRange('week', '2026-10-05'), { from: '2026-10-05', to: '2026-10-11' })
  assert.deepEqual(periodRange('week', '2027-01-01'), { from: '2026-12-28', to: '2027-01-03' }, '跨年周')
  assert.deepEqual(periodRange('month', '2024-02-10'), { from: '2024-02-01', to: '2024-02-29' }, '闰年')
  assert.deepEqual(periodRange('month', '2026-02-28'), { from: '2026-02-01', to: '2026-02-28' })
  assert.deepEqual(periodRange('month', '2100-02-01'), { from: '2100-02-01', to: '2100-02-28' }, '世纪平年')
  assert.deepEqual(periodRange('month', '2026-12-31'), { from: '2026-12-01', to: '2026-12-31' })
  assert.deepEqual(periodRange('year', '2026-06-15'), { from: '2026-01-01', to: '2026-12-31' })
  assert.equal(daysInMonth(2024, 2), 29)
  assert.equal(daysInMonth(2026, 4), 30)
})

test('shiftPeriod: 月末截断 / 跨年 / 闰日 / 周', () => {
  assert.equal(shiftPeriod('month', '2026-01-31', 1), '2026-02-28', '1 月 31 日 → 2 月取月末')
  assert.equal(shiftPeriod('month', '2024-01-31', 1), '2024-02-29', '闰年')
  assert.equal(shiftPeriod('month', '2026-03-31', -1), '2026-02-28')
  assert.equal(shiftPeriod('month', '2026-12-15', 1), '2027-01-15')
  assert.equal(shiftPeriod('month', '2026-01-15', -1), '2025-12-15')
  assert.equal(shiftPeriod('month', '2026-01-15', -13), '2024-12-15')
  assert.equal(shiftPeriod('month', '2026-05-31', 0), '2026-05-31')
  assert.equal(shiftPeriod('year', '2024-02-29', 1), '2025-02-28', '闰日 → 平年取月末')
  assert.equal(shiftPeriod('year', '2024-02-29', 4), '2028-02-29')
  assert.equal(shiftPeriod('year', '2026-10-04', -1), '2025-10-04')
  assert.equal(shiftPeriod('week', '2026-12-30', 1), '2027-01-06')
  assert.equal(shiftPeriod('week', '2026-10-04', -1), '2026-09-27')
})

test('comparePeriods: 进行中的期只比相同已过天数; prev = 0 时 null; 过去 / 未来的期', () => {
  const daily = dailyOf({
    // 本周 (2026-09-28 周一起)
    '2026-09-28': 100, '2026-09-29': 200, '2026-09-30': 300,
    // 上周: 周四那天不在「相同已过天数」内
    '2026-09-21': 100, '2026-09-23': 200, '2026-09-24': 1000,
  })
  assert.deepEqual(comparePeriods(daily, 'week', '2026-09-30', '2026-09-30'),
    { seconds: 600, prevSeconds: 300, deltaRatio: 1, elapsedDays: 3 })
  assert.deepEqual(comparePeriods(daily, 'week', '2026-09-28', '2026-09-30'),
    { seconds: 600, prevSeconds: 300, deltaRatio: 1, elapsedDays: 3 }, '锚点是周内哪天无关')
  // 已结束的期: 整期对整期, 上上周为 0 → null
  assert.deepEqual(comparePeriods(daily, 'week', '2026-09-22', '2026-09-30'),
    { seconds: 1300, prevSeconds: 0, deltaRatio: null, elapsedDays: 7 })
  // 未来的期
  assert.deepEqual(comparePeriods(daily, 'week', '2026-10-10', '2026-09-30'),
    { seconds: 0, prevSeconds: 0, deltaRatio: null, elapsedDays: 0 })
  // 月: 3 月 31 日 vs 整个 2 月 (上期更短, 封顶到月末)
  const m = dailyOf({ '2026-02-01': 100, '2026-02-28': 100, '2026-03-01': 50, '2026-03-31': 50, '2026-03-15': 300 })
  assert.deepEqual(comparePeriods(m, 'month', '2026-03-31', '2026-03-31'),
    { seconds: 400, prevSeconds: 200, deltaRatio: 1, elapsedDays: 31 })
  assert.deepEqual(comparePeriods(m, 'month', '2026-03-10', '2026-03-10'),
    { seconds: 50, prevSeconds: 100, deltaRatio: -0.5, elapsedDays: 10 })
  // 年: 闰年 2 月 29 日 → 已过 60 天, 上一年同样 60 天 (到 3 月 1 日)
  const y = dailyOf({ '2024-01-01': 100, '2024-02-29': 100, '2023-03-01': 50, '2023-03-02': 999 })
  assert.deepEqual(comparePeriods(y, 'year', '2024-02-29', '2024-02-29'),
    { seconds: 200, prevSeconds: 50, deltaRatio: 3, elapsedDays: 60 })
})

test('weekStrip: 目标完成度封顶 1, 目标关闭按阅读天, 未来日', () => {
  const daily = dailyOf({ '2026-09-28': 3600, '2026-09-29': 900, '2026-09-30': 30, '2026-10-01': 999 })
  const s = weekStrip(daily, '2026-09-30', 1800)
  assert.deepEqual(s.map(d => d.day), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  assert.deepEqual(s.map(d => d.ratio), [1, 0.5, 30 / 1800, 999 / 1800, 0, 0, 0])
  assert.deepEqual(s.map(d => d.met), [true, false, false, false, false, false, false])
  assert.deepEqual(s.map(d => d.future), [false, false, false, true, true, true, true])
  assert.deepEqual(s.map(d => d.isToday), [false, false, true, false, false, false, false])
  assert.equal(s[0].seconds, 3600)
  const off = weekStrip(daily, '2026-09-30', 0)
  assert.deepEqual(off.map(d => d.ratio), [1, 1, 0, 1, 0, 0, 0])
  assert.deepEqual(off.slice(0, 3).map(d => d.met), [true, true, false])
  // 周日: 整周都不是未来; 跨年周
  assert.ok(weekStrip({}, '2026-10-04', 1800).every(d => !d.future))
  assert.equal(weekStrip({}, '2027-01-01', 1800)[0].day, '2026-12-28')
})

test('monthCalendar: 周一起, 首尾 null 填充', () => {
  const oct = monthCalendar(2026, 10) // 10 月 1 日周四
  assert.equal(oct.length, 5)
  assert.ok(oct.every(r => r.length === 7))
  assert.deepEqual(oct[0], [null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  assert.deepEqual(oct[4], ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null])
  const feb26 = monthCalendar(2026, 2) // 2 月 1 日周日
  assert.deepEqual(feb26[0], [null, null, null, null, null, null, '2026-02-01'])
  assert.equal(feb26.flat().filter(Boolean).length, 28)
  const feb27 = monthCalendar(2027, 2) // 周一开始, 28 天正好 4 行
  assert.equal(feb27.length, 4)
  assert.ok(feb27.flat().every(Boolean))
  assert.equal(feb27[0][0], '2027-02-01')
  const feb24 = monthCalendar(2024, 2)
  assert.equal(feb24.flat().filter(Boolean).length, 29)
  assert.equal(feb24.flat().filter(Boolean).at(-1), '2024-02-29')
  // 每个非 null 格子的星期与列对应
  for (const row of monthCalendar(2026, 8)) row.forEach((d, i) => { if (d) assert.equal((dayOfWeek(d) + 6) % 7, i) })
})

test('milestones: 累计 / 阅读天 / 最长连续 / 单日最长 / 最久的一本', () => {
  const b = (key, kind, seconds) => ({ key, title: key, kind, seconds })
  const daily = {
    '2026-01-01': entry(600, [b('id:a', 'book', 600)]),
    '2026-01-02': entry(1200, [b('id:a', 'book', 200), b('id:p', 'paper', 1000)]),
    '2026-01-03': entry(30, [b('id:p', 'paper', 30)]),
    '2026-01-05': entry(1200, [b('id:p', 'paper', 1200)]),
  }
  const m = milestones(daily)
  assert.equal(m.totalSeconds, 3030)
  assert.equal(m.activeDays, 3)
  assert.equal(m.longestStreak, 2)
  assert.deepEqual(m.bestDay, { day: '2026-01-02', seconds: 1200 }, '同秒数取较早的一天')
  assert.deepEqual(m.topBook, b('id:p', 'paper', 2230))
  assert.deepEqual(milestones({}), { totalSeconds: 0, activeDays: 0, longestStreak: 0, bestDay: null, topBook: null })
})

test('niceTicks: 含 0、升序、覆盖最大值、人类友好间隔', () => {
  const H = 3600
  assert.deepEqual(niceTicks(0), [0, 1800])
  assert.deepEqual(niceTicks(-5), [0, 1800])
  assert.deepEqual(niceTicks(60), [0, 300])
  assert.deepEqual(niceTicks(600), [0, 300, 600])
  assert.deepEqual(niceTicks(50 * 60), [0, 1800, H], '0 / 30 分 / 1 时')
  assert.deepEqual(niceTicks(2 * H), [0, H, 2 * H])
  assert.deepEqual(niceTicks(2 * H + 1), [0, H, 2 * H, 3 * H])
  assert.deepEqual(niceTicks(30000), [0, 3 * H, 6 * H, 9 * H])
  assert.deepEqual(niceTicks(60 * H), [0, 20 * H, 40 * H, 60 * H])
  assert.deepEqual(niceTicks(1000 * H), [0, 500 * H, 1000 * H])
  const allowed = new Set([5, 10, 15, 30, 60, 120, 180, 300, 600].map(x => x * 60))
  for (let max = 1; max < 40 * H; max = Math.ceil(max * 1.37)) {
    const t = niceTicks(max)
    assert.equal(t[0], 0)
    assert.ok(t.at(-1) >= max, String(max))
    assert.ok(t.length >= 2 && t.length <= 4, `${max}: ${t}`)
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1])
    if (max <= 30 * H) assert.ok(allowed.has(t[1]), `${max}: step ${t[1]}`)
  }
})

test('filterDaily / yearsWithData / monthlyTotals', () => {
  const b = (key, kind, seconds) => ({ key, title: key, kind, seconds })
  const daily = {
    '2025-12-31': entry(100, [b('id:a', 'book', 100)]),
    '2026-01-01': entry(400, [b('id:p', 'paper', 300), b('id:a', 'book', 100)]),
    '2026-01-02': entry(50, [b('id:p', 'paper', 50)]),
    '2026-03-01': entry(30, [b('id:a', 'book', 30)]),
    '2024-06-01': entry(0, []),
  }
  const books = filterDaily(daily, 'book')
  assert.deepEqual(Object.keys(books).sort(), ['2025-12-31', '2026-01-01', '2026-03-01'])
  assert.deepEqual(books['2026-01-01'], entry(100, [b('id:a', 'book', 100)]))
  const papers = filterDaily(daily, 'paper')
  assert.deepEqual(papers, { '2026-01-01': entry(300, [b('id:p', 'paper', 300)]), '2026-01-02': entry(50, [b('id:p', 'paper', 50)]) })
  assert.deepEqual(filterDaily(daily, 'all'), daily)
  assert.equal(daily['2026-01-01'].seconds, 400, '不改动输入')

  assert.deepEqual(yearsWithData(daily), [2026, 2025], '秒数为 0 的年份不算')
  assert.deepEqual(yearsWithData({}), [])

  const months = monthlyTotals(daily, 2026)
  assert.equal(months.length, 12)
  assert.deepEqual(months.map(m => m.month), Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`))
  assert.deepEqual(months[0], { month: '2026-01', seconds: 450, activeDays: 1 }, '50 秒那天不算阅读天')
  assert.deepEqual(months[2], { month: '2026-03', seconds: 30, activeDays: 0 })
  assert.equal(months[11].seconds, 0)
  assert.deepEqual(monthlyTotals(daily, 2025)[11], { month: '2025-12', seconds: 100, activeDays: 1 })
})

// ---- readingLog 内存实现 ----

const AT = Date.UTC(2026, 9, 4, 12) // 中午: 绝大多数时区里仍是同一天
const DAY = localDay(AT)

function makeLog({ device = 'dev-A', books = null, hashes = {} } = {}) {
  const store = createMemoryReadingLogStore()
  const identity = {
    getDeviceId: async () => device,
    getHashes: async () => new Map(Object.entries(hashes)),
  }
  const shelf = books
  const log = createReadingLog({ store, identity, listBooks: shelf ? async () => shelf : undefined, now: () => AT })
  return { log, store, identity, shelf }
}

test('localDay 按本地时区', () => {
  const d = new Date(2026, 0, 2, 0, 30) // 本地 1 月 2 日 00:30
  assert.equal(localDay(d.getTime()), '2026-01-02')
  assert.match(localDay(), /^\d{4}-\d{2}-\d{2}$/)
})

test('recordReading 同一 key 累加; loadDaily 按天按书聚合; 通知变化', async () => {
  const { log } = makeLog({ books: [{ id: 'a', title: '三体·新名', kind: 'book' }, { id: 'p', title: 'Attention', kind: 'paper' }] })
  let changes = 0
  const off = log.onChange(() => changes++)
  await log.recordReading({ id: 'a', title: '三体' }, 60, AT)
  await log.recordReading({ id: 'a', title: '三体' }, 45.4, AT)
  await log.recordReading({ id: 'p', title: 'Attention', kind: 'paper' }, 300, AT)
  await log.recordReading({ id: 'a', title: '三体' }, 0, AT) // 忽略
  await log.recordReading({ id: 'a', title: '三体' }, 120, AT + 86_400_000)
  assert.equal(changes, 4)
  off()
  await log.recordReading({ id: 'a', title: '三体' }, 1, AT)
  assert.equal(changes, 4, '取消订阅后不再通知')

  const rows = await log.list()
  const rowA = rows.find(r => r.key === `dev-A|${DAY}|id:a`)
  assert.equal(rowA.seconds, 106)
  assert.equal(rowA.bookId, 'a')
  assert.equal(rowA.title, '三体')
  assert.equal(rowA.kind, 'book')
  assert.equal(rowA.device, 'dev-A')

  const daily = await log.loadDaily()
  assert.deepEqual(Object.keys(daily).sort(), [DAY, localDay(AT + 86_400_000)].sort())
  assert.equal(daily[DAY].seconds, 406)
  assert.deepEqual(daily[DAY].books, [
    { key: 'id:p', bookId: 'p', title: 'Attention', kind: 'paper', seconds: 300 },
    { key: 'id:a', bookId: 'a', title: '三体·新名', kind: 'book', seconds: 106 },
  ], '书架上的书用最新书名, 按秒数降序')
})

test('loadDaily: 跨设备同书合并 (bookId / hash / 书名), 删掉的书用快照且不给 bookId', async () => {
  const { log, store } = makeLog({
    books: [{ id: 'a', title: '三体', kind: 'book', addedAt: 2 }, { id: 'a2', title: '三体(重复导入)', addedAt: 1 }],
    hashes: { a: 'H1', a2: 'H1', gone: 'H2' },
  })
  await log.recordReading({ id: 'a', title: '三体' }, 100, AT)
  await log.recordReading({ id: 'gone', title: '已删的书' }, 50, AT)
  await log.recordReading({ id: 'nohash', title: '无 hash 的书' }, 70, AT)
  // 历史备份保留其他设备的 hash 行, 不执行已退役的网络同步.
  const history = [
    { key: `dev-B|${DAY}|h:H1`, seconds: 200, title: '三体', kind: 'book' },
    { key: `dev-B|${DAY}|h:H2`, seconds: 25, title: '已删的书', kind: 'book' },
    { key: `dev-B|${DAY}|h:H3`, seconds: 10, title: '只在 B 上的书', kind: 'paper' },
  ]
  assert.equal(await log.importRows(history), 3)
  assert.equal(await log.importRows(history), 0)
  // 旧备份里的、另一设备的无 hash 行: 同书名合并
  await store.putMax([normalizeRow({ key: `dev-C|${DAY}|id:old-x`, title: '无 hash 的书', kind: 'book', seconds: 6, updatedAt: 1 })])
  const daily = await log.loadDaily()
  assert.equal(daily[DAY].seconds, 100 + 50 + 70 + 200 + 25 + 10 + 6)
  assert.deepEqual(daily[DAY].books.map(b => [b.key, b.bookId, b.title, b.kind, b.seconds]), [
    ['id:a2', 'a2', '三体(重复导入)', 'book', 300],
    ['t:无 hash 的书', undefined, '无 hash 的书', 'book', 76],
    ['h:H2', undefined, '已删的书', 'book', 75],
    ['h:H3', undefined, '只在 B 上的书', 'paper', 10],
  ])
})

test('normalizeRow 拒绝无效行', () => {
  assert.equal(normalizeRow(null), null)
  assert.equal(normalizeRow({ key: 'a|2026-1-1|id:x', seconds: 5 }), null)
  assert.equal(normalizeRow({ key: 'a|2026-01-01|zz', seconds: 5 }), null)
  assert.equal(normalizeRow({ key: 'a|2026-01-01|id:x', seconds: -1 }), null)
  assert.equal(normalizeRow({ key: 'a|2026-01-01|id:x', seconds: 'NaN' }), null)
  assert.deepEqual(normalizeRow({ key: 'a|2026-01-01|h:abc', seconds: 5, title: 't', kind: 'paper' }), {
    key: 'a|2026-01-01|h:abc', device: 'a', day: '2026-01-01', hash: 'abc', title: 't', kind: 'paper', seconds: 5, updatedAt: 0,
  })
})

test('importRows 按 key 取较大值, 重复导入幂等', async () => {
  const { log } = makeLog()
  await log.recordReading({ id: 'a', title: 'A' }, 100, AT)
  const rows = [
    { key: `dev-A|${DAY}|id:a`, title: 'A', kind: 'book', seconds: 80, updatedAt: 1 },
    { key: `dev-X|${DAY}|id:b`, title: 'B', kind: 'book', seconds: 30, updatedAt: 1 },
    { key: 'bad', seconds: 1 },
  ]
  assert.equal(await log.importRows(rows), 1)
  assert.equal(await log.importRows(rows), 0)
  const list = await log.list()
  assert.equal(list.find(r => r.key === `dev-A|${DAY}|id:a`).seconds, 100)
  assert.equal(list.find(r => r.key === `dev-X|${DAY}|id:b`).seconds, 30)
})

// ---- 历史归档: hash 聚合与差额 ----

test('aggregateReadingLog / planReadingLogLanding', () => {
  const rows = [
    { key: 'A|2026-01-01|id:a', device: 'A', day: '2026-01-01', bookId: 'a', title: '', kind: 'book', seconds: 10, updatedAt: 0 },
    { key: 'A|2026-01-01|id:a2', device: 'A', day: '2026-01-01', bookId: 'a2', title: '', kind: 'book', seconds: 5, updatedAt: 0 },
    { key: 'A|2026-01-01|h:H1', device: 'A', day: '2026-01-01', hash: 'H1', title: '', kind: 'book', seconds: 1, updatedAt: 0 },
    { key: 'A|2026-01-01|id:nohash', device: 'A', day: '2026-01-01', bookId: 'nohash', title: '', kind: 'book', seconds: 99, updatedAt: 0 },
    { key: 'B|2026-01-02|h:H2', device: 'B', day: '2026-01-02', hash: 'H2', title: '', kind: 'book', seconds: 7, updatedAt: 0 },
  ]
  const local = aggregateReadingLog(rows, new Map([['a', 'H1'], ['a2', 'H1']]))
  assert.deepEqual(local, { A: { '2026-01-01': { H1: 16 } }, B: { '2026-01-02': { H2: 7 } } })
  const merged = { A: { '2026-01-01': { H1: 20 } }, B: { '2026-01-02': { H2: 3 } }, C: { '2026-01-03': { H3: 4 } } }
  assert.deepEqual(planReadingLogLanding(merged, local), [
    { device: 'A', day: '2026-01-01', hash: 'H1', seconds: 4 },
    { device: 'C', day: '2026-01-03', hash: 'H3', seconds: 4 },
  ])
  assert.deepEqual(planReadingLogLanding(undefined, local), [])
})

// ---- readingClock: 防挂机计时 ----
import {
  createReadingClock, READING_AUTO_MAX_MS, READING_IDLE_MS, READING_TAIL_MS,
} from '../src/services/readingClock.ts'

/** 从 start 起每 15s 心跳, 跑到 until (毫秒偏移) */
const run = (clock, start, from, until, visible = true) => {
  for (let t = from + 15_000; t <= until; t += 15_000) clock.tick(start + t, 15, visible)
}

test('readingClock: 持续操作全额计时; 页面隐藏不计', () => {
  const c = createReadingClock(0)
  for (let t = 15_000; t <= 600_000; t += 15_000) {
    c.input(t - 1000)
    c.tick(t, 15, true)
  }
  assert.equal(c.drain(), 600)
  run(c, 0, 600_000, 660_000, false)
  assert.equal(c.drain(), 0)
})

test('readingClock: 离开后最多多记 2 分钟, 5 分钟后停止', () => {
  const c = createReadingClock(0)
  run(c, 0, 0, 30 * 60_000)
  assert.equal(c.drain(), READING_TAIL_MS / 1000)
})

test('readingClock: 2–5 分钟内回来, 挂起的时间补记', () => {
  const c = createReadingClock(0)
  run(c, 0, 0, 4 * 60_000)
  assert.equal(c.pendingFlush, 120, '超过 2 分钟的部分先挂起')
  c.input(4 * 60_000 + 1)
  assert.equal(c.drain(), 240)
})

test('readingClock: 自动推进 (朗读) 距最后一次手动操作 60 分钟后不再计时', () => {
  const c = createReadingClock(0)
  const end = 90 * 60_000
  for (let t = 15_000; t <= end; t += 15_000) {
    c.auto(t - 1000)
    c.tick(t, 15, true)
  }
  const got = c.drain()
  assert.ok(got >= READING_AUTO_MAX_MS / 1000 && got <= (READING_AUTO_MAX_MS + READING_TAIL_MS) / 1000 + 15, String(got))
  assert.ok(READING_IDLE_MS > READING_TAIL_MS)
})

test('readingClock: creditedAt 记录最后确认时间 (跨零点落库归日用)', () => {
  const c = createReadingClock(0)
  c.input(10_000)
  c.tick(15_000, 15, true)
  assert.equal(c.creditedAt, 15_000)
})
