// 匿名使用统计客户端契约: 北京时间切天 / 平台识别 / 每天最多两次
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beijingDay, detectPlatform, needsPing } from '../src/services/usageStatsCore.ts'

test('按北京时间切天', () => {
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 15, 59)), '2026-10-04')
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 16, 0)), '2026-10-05')
})

test('平台识别: 网页版统一记 web', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135 Safari/537.36'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
  const android = 'Mozilla/5.0 (Linux; Android 12; M2007J3SC) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36'
  assert.equal(detectPlatform(win, true), 'windows')
  assert.equal(detectPlatform(mac, true), 'macos')
  assert.equal(detectPlatform(linux, true), 'linux')
  assert.equal(detectPlatform(android, true), 'android')
  assert.equal(detectPlatform(android, false), 'web')
  assert.equal(detectPlatform(win, false), 'web')
})

test('每天: 打开应用一次, 第一次打开书再一次', () => {
  assert.equal(needsPing(null, '2026-10-05', false), true)
  assert.equal(needsPing('2026-10-04:reader', '2026-10-05', false), true)
  assert.equal(needsPing('2026-10-05:app', '2026-10-05', false), false)
  assert.equal(needsPing('2026-10-05:app', '2026-10-05', true), true)
  assert.equal(needsPing('2026-10-05:reader', '2026-10-05', true), false)
  assert.equal(needsPing('2026-10-05:reader', '2026-10-05', false), false)
})

import { isTestEnvironment } from '../src/services/usageStatsCore.ts'
test('自动化测试与本机预览不上报, App 内 (tauri.localhost) 照常', () => {
  assert.equal(isTestEnvironment({ webdriver: true }, 'lightread.example', false), true)
  assert.equal(isTestEnvironment({}, 'localhost', false), true)
  assert.equal(isTestEnvironment({}, '127.0.0.1', false), true)
  assert.equal(isTestEnvironment({}, 'tauri.localhost', true), false)
  assert.equal(isTestEnvironment({}, 'localhost', true), false, 'macOS App 的 tauri://localhost')
  assert.equal(isTestEnvironment({ webdriver: false }, 'lightread.ethereal-ai.workers.dev', false), false)
})

import { addDjKeyWordChunk, addDjReading, pendingDjDays, pruneDjStore } from '../src/services/usageStatsCore.ts'
test('点睛按天汇总: 按状态累计秒数, 密度档只记重点词时长, AI 块与找不到的词计数', () => {
  const s = {}
  addDjReading(s, '2026-10-05', 0, null, 600)
  addDjReading(s, '2026-10-05', 2, 1, 1800)
  addDjReading(s, '2026-10-05', 3, 2, 900)
  addDjReading(s, '2026-10-05', 1, null, 300)
  addDjReading(s, '2026-10-05', 1, 2, 300) // 词与词不计密度档
  addDjReading(s, '2026-10-05', 2, 0, -5) // 无效时长忽略
  addDjKeyWordChunk(s, '2026-10-05', true, 12, 1)
  addDjKeyWordChunk(s, '2026-10-05', false, 3, 9) // 找不到的个数不超过总数
  assert.deepEqual(s['2026-10-05'], { s: [600, 600, 1800, 900], lv: [0, 1800, 900], ai: [1, 2], nf: [4, 15] })
})

test('点睛按天汇总: 只报今天之前、7 天以内、最近 3 天; 折成分钟并封顶; 发出后清掉', () => {
  const s = {}
  for (const d of ['2026-09-20', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) addDjReading(s, d, 2, 1, 120)
  addDjReading(s, '2026-10-04', 0, null, 200_000) // 超过一天的分钟封顶 1440
  addDjKeyWordChunk(s, '2026-10-03', true, 5, 0)
  const days = pendingDjDays(s, '2026-10-05')
  assert.deepEqual(days.map(x => x.d), ['2026-10-02', '2026-10-03', '2026-10-04'])
  assert.deepEqual(days[0], { d: '2026-10-02', m: [0, 0, 2, 0], lv: [0, 2, 0], ai: [0, 0], nf: [0, 0] })
  assert.equal(days[2].m[0], 1440)
  assert.deepEqual(days[1].ai, [1, 1])
  // 体积: 3 天约 300 字节, 心跳整体远低于旧服务端的 1 KB 上限
  const body = JSON.stringify({ id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', platform: 'android', version: '1.15.0', lang: 'zh', reader: true, dj: days })
  assert.ok(body.length < 700, String(body.length))
  // 不含任何书名 / 正文 / 词: 只有约定的键
  for (const d of days) assert.deepEqual(Object.keys(d).sort(), ['ai', 'd', 'lv', 'm', 'nf'])
  const left = pruneDjStore(s, '2026-10-05', days.map(x => x.d))
  assert.deepEqual(Object.keys(left).sort(), ['2026-10-01', '2026-10-05'])
  assert.deepEqual(pendingDjDays({ '2026-10-04': { s: [0, 0, 0, 0], lv: [0, 0, 0], ai: [0, 0], nf: [0, 0] } }, '2026-10-05'), [])
})
