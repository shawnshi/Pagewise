import { onBeforeUnmount, onMounted } from 'vue'
import { useLibrary } from '../stores/library'
import { t } from '../i18n'
import { localDay } from '../services/readingLog.ts'
import { createReadingClock, READING_IDLE_MS } from '../services/readingClock.ts'

export { READING_IDLE_MS }

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

/**
 * 阅读时长统计 (规则见 services/readingClock.ts): 每 15s 心跳一次, 满一分钟落库, 跨零点和离开时冲账.
 * 手动操作 = window 上的 pointerdown/keydown/wheel/touchstart, 或阅读器调用 ping() (翻页、位置变化;
 * foliate 正文在 iframe 里, 其中的点击按键不会冒泡到 window); 朗读推进、自动滚动调用 pingAuto().
 */
export function useReadingTimer(
  bookId: string,
  opts: { onCredit?: (seconds: number, at: number) => void; enabled?: () => boolean } = {},
): { ping: () => void; pingAuto: () => void } {
  const library = useLibrary()
  const clock = createReadingClock(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  let mounted = false
  let lastActivityAt = Date.now()

  const stopTimer = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const flush = () => {
    const at = clock.creditedAt
    const seconds = clock.drain()
    if (seconds > 0) {
      library.addReadingTime(bookId, seconds, at)
      try { opts.onCredit?.(seconds, at) } catch { /* 统计失败不影响计时 */ }
    }
  }

  const tickOnce = () => {
    const now = Date.now()
    // Cross-midnight boundary settles yesterday's accumulated reading time first.
    if (clock.pendingFlush > 0 && localDay(clock.creditedAt) !== localDay(now)) flush()
    const visible = !document.hidden && opts.enabled?.() !== false
    clock.tick(now, 15, visible)
    if (clock.pendingFlush >= 60) flush()
    if (!visible || now - lastActivityAt > READING_IDLE_MS) {
      flush()
      stopTimer()
    }
  }

  const ensureTimer = () => {
    if (!mounted || document.hidden || opts.enabled?.() === false) return
    if (timer === undefined) timer = setInterval(tickOnce, 15_000)
  }

  const ping = () => {
    if (opts.enabled?.() === false) return
    const now = Date.now()
    lastActivityAt = now
    clock.input(now)
    ensureTimer()
  }
  const pingAuto = () => {
    if (opts.enabled?.() === false) return
    const now = Date.now()
    lastActivityAt = now
    clock.auto(now)
    ensureTimer()
  }

  onMounted(() => {
    mounted = true
    lastActivityAt = Date.now()
    clock.input(lastActivityAt)
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, ping, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibilityCheckpoint)
    ensureTimer()
  })

  // Flush settled duration on background; pause polling timer until visibility or input resumes.
  function onVisibilityCheckpoint() {
    if (document.visibilityState === 'hidden') {
      flush()
      stopTimer()
    } else {
      ensureTimer()
    }
  }

  onBeforeUnmount(() => {
    mounted = false
    stopTimer()
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, ping, { capture: true })
    document.removeEventListener('visibilitychange', onVisibilityCheckpoint)
    flush()
  })

  return { ping, pingAuto }
}

/** 秒 → "X 小时 Y 分钟" (随界面语言) */
export function formatReadingTime(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 1) return t('time.lessThanMinute')
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? t('time.hoursMinutes', { h, m }) : t('time.minutes', { m })
}
