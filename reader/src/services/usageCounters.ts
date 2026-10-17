/**
 * 点睛阅读的按天汇总计数 (本机 localStorage), 由 usageStats.pingUsage 随心跳带上已过完的日子。
 * 只记数字: 各状态的阅读分钟、重点词密度档、AI 重点词的可用块数与找不到的个数。不含书名、正文、具体的词。
 * 无 Vue 依赖 (点睛引擎在 node 测试里也会调用); 自动化测试与本机预览不累计。
 */
import {
  addDjKeyWordChunk, addDjReading, beijingDay, isTestEnvironment, pendingDjDays, pruneDjStore,
  type DjDay, type DjLevelIdx, type DjState, type DjStore,
} from './usageStatsCore.ts'

const KEY = 'lightread-dj-daily'

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function counting(): boolean {
  try {
    const tauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
    return !isTestEnvironment(typeof navigator === 'undefined' ? undefined : navigator, typeof location === 'undefined' ? 'localhost' : location.hostname, tauri)
  } catch { return false }
}

function load(): DjStore {
  const raw = storage()?.getItem(KEY)
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as DjStore : {}
  } catch { return {} }
}

function save(store: DjStore) {
  try { storage()?.setItem(KEY, JSON.stringify(store)) } catch { /* 存储已满 / 不可用 */ }
}

/** 记一段阅读时长 (秒) */
export function noteDjReading(seconds: number, state: DjState, level: DjLevelIdx | null, now = Date.now()) {
  if (!counting() || !(seconds > 0)) return
  save(addDjReading(load(), beijingDay(now), state, level, seconds))
}

/** 记一块 AI 重点词的结果 (点睛引擎调用) */
export function noteKeyWordChunk(r: { usable: boolean; lines: number; missing: number }, now = Date.now()) {
  if (!counting()) return
  save(addDjKeyWordChunk(load(), beijingDay(now), r.usable, r.lines, r.missing))
}

/** 待随心跳上报的日子 */
export function pendingDj(now = Date.now()): DjDay[] {
  return pendingDjDays(load(), beijingDay(now))
}

/** 上报成功后清掉已发出的日子 */
export function markDjSent(days: readonly string[], now = Date.now()) {
  save(pruneDjStore(load(), beijingDay(now), days))
}
