import type { ReadingStatus } from '../storage/types.ts'

export type { ReadingStatus }

export const READING_STATUSES: readonly ReadingStatus[] = ['unmarked', 'wanted', 'reading', 'paused', 'finished', 'abandoned'] as const

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unmarked: '未标记',
  wanted: '想读',
  reading: '在读',
  paused: '暂缓',
  finished: '已读',
  abandoned: '弃读',
}

export function isReadingStatus(value: unknown): value is ReadingStatus {
  return typeof value === 'string' && (READING_STATUSES as readonly string[]).includes(value)
}

/** Legacy unread records carry no evidence of reading intent. */
export function normalizeReadingStatus(value: unknown): ReadingStatus | undefined {
  if (value === 'unread') return 'unmarked'
  return isReadingStatus(value) ? value : undefined
}

export interface ReadingStatusInfo {
  /** 显式存储的阅读状态 (若未设置或无效则为 undefined) */
  readonly explicit?: ReadingStatus
  /**
   * 界面展示 / 筛选推断状态:
   * - 存在合法 explicit 状态时: 直接以 explicit 为准;
   * - 若无 explicit 状态 (legacy unknown):
   *   - 仅当拥有合法正值 lastReadAt (>0) 时支持认定为 'reading';
   *   - 进度数值 (progress) 本身绝不作为判定 unread 或 finished 的依据;
   *   - 否则保持 undefined (未标记未知状态).
   */
  readonly effective?: ReadingStatus
  /** 是否为未显式标记的旧版历史记录 */
  readonly isLegacy: boolean
}

/**
 * 解析书籍的阅读状态。
 * 遵循协议要求:
 * - 遗留未标记书籍保持 unmarked;
 * - 正向有效 lastReadAt 支持推断为 reading;
 * - 单纯 progress 绝不可推断为 unread 或 finished;
 * - 显式标记优先级高于推断.
 */
export function resolveReadingStatus(book: {
  readonly readingStatus?: unknown
  readonly lastReadAt?: unknown
  readonly progress?: unknown
}): ReadingStatusInfo {
  const explicit = normalizeReadingStatus(book.readingStatus)
  if (explicit !== undefined) {
    return { explicit, effective: explicit, isLegacy: false }
  }

  const rawLastRead = book.lastReadAt
  const hasPositiveLastRead = typeof rawLastRead === 'number' && Number.isFinite(rawLastRead) && rawLastRead > 0

  return {
    explicit: undefined,
    effective: hasPositiveLastRead ? 'reading' : undefined,
    isLegacy: true,
  }
}

/**
 * 新导入书籍的显式初始化状态辅助函数。
 * 新书默认未标记，不将“尚未阅读”推断成“想读”。
 */
export function createNewBookReadingStatus(initial: ReadingStatus = 'unmarked'): ReadingStatus {
  if (!isReadingStatus(initial)) throw new TypeError('Invalid readingStatus')
  return initial
}
