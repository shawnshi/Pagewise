/**
 * 阅读计时的纯逻辑 (不依赖 vue / 存储, 可在 node 里测试). 规则见 docs/reading-stats.md:
 * - 页面在前台, 且最近一次操作在 5 分钟内才计时;
 * - 最后一次操作后超过 2 分钟的时间先挂起: 之后又有操作才补记, 5 分钟内都没有操作就作废
 *   (离开座位最多多记 2 分钟; 挂起的时间不落库, 同步计数永远只增不减);
 * - 朗读、自动滚动等自动推进也算操作, 但距最后一次手动操作超过 60 分钟就不再算.
 */
export const READING_IDLE_MS = 5 * 60_000
export const READING_TAIL_MS = 2 * 60_000
export const READING_AUTO_MAX_MS = 60 * 60_000

export interface ReadingClock {
  /** 手动操作 (点击 / 按键 / 滚轮 / 触摸 / 翻页) */
  input(now: number): void
  /** 自动推进 (朗读下一句、自动翻页) */
  auto(now: number): void
  /** 经过 dtSec 秒的一次心跳 */
  tick(now: number, dtSec: number, visible: boolean): void
  /** 已确认、尚未落库的秒数 */
  readonly pendingFlush: number
  /** 最近一次计入确认时长的时间 (落库时用来归日) */
  readonly creditedAt: number
  /** 取走已确认的秒数 */
  drain(): number
}

export function createReadingClock(start: number): ReadingClock {
  let lastInput = start
  let lastAuto = -Infinity
  let held = 0
  let acc = 0
  let creditedAt = start

  const lastActivity = () => Math.max(lastInput, Math.min(lastAuto, lastInput + READING_AUTO_MAX_MS))
  const release = (now: number) => {
    if (held > 0) {
      acc += held
      held = 0
      creditedAt = now
    }
  }

  return {
    input(now) {
      lastInput = now
      release(now)
    },
    auto(now) {
      lastAuto = now
      if (now - lastInput <= READING_AUTO_MAX_MS) release(now)
    },
    tick(now, dtSec, visible) {
      const since = now - lastActivity()
      if (!visible || since > READING_IDLE_MS) {
        held = 0
        return
      }
      if (since <= READING_TAIL_MS) {
        acc += dtSec
        creditedAt = now
      } else {
        held += dtSec
      }
    },
    get pendingFlush() { return acc },
    get creditedAt() { return creditedAt },
    drain() {
      const n = acc
      acc = 0
      return n
    },
  }
}
