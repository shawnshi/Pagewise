// 听书剩余时间契约: 字数口径 / 语速学习 / 倍速换算 / 人话时长 / 听完钟点
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countSpeechChars, recordPace, paceCps, humanizeDuration, finishClock, DEFAULT_CPS } from '../src/services/listenEta.ts'

test('字数只数文字与数字, 不数标点空白', () => {
  assert.equal(countSpeechChars('夜色，慢慢压下来。'), 7)
  assert.equal(countSpeechChars('Hello, world 42!'), 12)
  assert.equal(countSpeechChars(''), 0)
  assert.equal(countSpeechChars(undefined), 0)
})

test('未实测时按语言兜底, 并随倍速线性换算', () => {
  const none = { cps: 0, samples: 0 }
  assert.equal(paceCps(none, 1, true), DEFAULT_CPS.cjk)
  assert.equal(paceCps(none, 1.5, true), DEFAULT_CPS.cjk * 1.5)
  assert.equal(paceCps(none, 1, false), DEFAULT_CPS.other)
})

test('实测语速归一到 1.0x; 过短与离谱样本不计', () => {
  let pace = recordPace({ cps: 0, samples: 0 }, 60, 10, 1.2) // 6 字/秒 @1.2x → 5 @1x
  assert.equal(pace.samples, 1)
  assert.equal(pace.cps, 5)
  assert.deepEqual(recordPace(pace, 3, 2, 1), pace, '太短')
  assert.deepEqual(recordPace(pace, 50, 0.5, 1), pace, '耗时过短')
  assert.deepEqual(recordPace(pace, 400, 2, 1), pace, '200 字/秒不可能')
  pace = recordPace(pace, 40, 10, 1) // 4
  assert.equal(pace.samples, 2)
  assert.equal(pace.cps, 4.5)
  assert.equal(paceCps(pace, 2, true), 9)
})

test('人话时长: 精度随量级变粗', () => {
  assert.deepEqual(humanizeDuration(0), { kind: 'lessThanMinute' })
  assert.deepEqual(humanizeDuration(59), { kind: 'lessThanMinute' })
  assert.deepEqual(humanizeDuration(61), { kind: 'minutes', m: 2 })
  assert.deepEqual(humanizeDuration(8 * 60), { kind: 'minutes', m: 8 })
  assert.deepEqual(humanizeDuration(23 * 60), { kind: 'minutes', m: 25 })
  assert.deepEqual(humanizeDuration(58 * 60), { kind: 'hours', h: 1 })
  assert.deepEqual(humanizeDuration(80 * 60), { kind: 'hoursMinutes', h: 1, m: 20 })
  assert.deepEqual(humanizeDuration(178 * 60), { kind: 'hours', h: 3 })
  assert.deepEqual(humanizeDuration(18.4 * 3600), { kind: 'hours', h: 18 })
})

test('听完钟点: 向上取整到分, 跨天标记, 超 12 小时不给', () => {
  const now = new Date(2026, 9, 4, 22, 10, 30)
  assert.deepEqual(finishClock(8 * 60, now), { hh: '22', mm: '19', dayOffset: 0 })
  assert.deepEqual(finishClock(3 * 3600, now), { hh: '01', mm: '11', dayOffset: 1 })
  assert.equal(finishClock(13 * 3600, now), null)
  assert.equal(finishClock(NaN, now), null)
})
