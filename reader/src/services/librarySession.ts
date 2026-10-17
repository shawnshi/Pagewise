import type { ReadingStatus } from '../storage/types.ts'
import { isReadingStatus } from './readingStatus.ts'
import { queryLibraryBooks, type LibraryQueryBook, type LibraryQueryOptions, type LibraryQueryResult } from './libraryQuery.ts'

export type LibrarySortBy = 'recent' | 'added' | 'title' | 'author' | 'progress'

export interface LibrarySessionState {
  keyword: string
  sortBy: LibrarySortBy
  tagFilter: string[]
  tagMode: 'and' | 'or'
  formatFilter: string
  languageFilter: string
  statusFilter: ReadingStatus | ''
  page: number
  pageSize: number
  activeBooklistId: string
  lastViewedBookId?: string
  orderedBookIds?: string[]
}

export interface AdvancedFilterDraft {
  tags: string[]
  tagMode: 'and' | 'or'
  format: string
  language: string
  status: ReadingStatus | ''
  sortBy: LibrarySortBy
}

export const DEFAULT_LIBRARY_SESSION: Readonly<LibrarySessionState> = Object.freeze({
  keyword: '',
  sortBy: 'recent',
  tagFilter: [],
  tagMode: 'and',
  formatFilter: '',
  languageFilter: '',
  statusFilter: '',
  page: 1,
  pageSize: 12,
  activeBooklistId: '',
  lastViewedBookId: undefined,
})

export const VALID_SORTS: readonly LibrarySortBy[] = ['recent', 'added', 'title', 'author', 'progress'] as const

export const SORT_LABELS: Record<LibrarySortBy, string> = {
  recent: '最近阅读',
  added: '最近添加',
  title: '书名',
  author: '作者',
  progress: '阅读进度',
}

/**
 * 校验并净化恢复的会话数据。
 * 处理坏数据、非法类型或格式损坏（如负数页码、非数组标签、未知排序），平滑回退安全默认值。
 */
export function sanitizeSessionState(raw: unknown): LibrarySessionState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_LIBRARY_SESSION, tagFilter: [] }
  }
  const obj = raw as Record<string, unknown>

  const keyword = typeof obj.keyword === 'string' ? obj.keyword.trim() : ''

  const sortBy: LibrarySortBy = (typeof obj.sortBy === 'string' && (VALID_SORTS as readonly string[]).includes(obj.sortBy))
    ? (obj.sortBy as LibrarySortBy)
    : 'recent'

  const tagFilter = Array.isArray(obj.tagFilter)
    ? obj.tagFilter.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

  const tagMode = obj.tagMode === 'or' ? 'or' : 'and'
  const formatFilter = typeof obj.formatFilter === 'string' ? obj.formatFilter.trim().toLowerCase() : ''
  const languageFilter = typeof obj.languageFilter === 'string' ? obj.languageFilter.trim().toLowerCase() : ''

  const statusFilter: ReadingStatus | '' = isReadingStatus(obj.statusFilter)
    ? obj.statusFilter
    : ''

  const rawPage = typeof obj.page === 'number' ? obj.page : Number(obj.page)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1

  const rawPageSize = typeof obj.pageSize === 'number' ? obj.pageSize : Number(obj.pageSize)
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.floor(rawPageSize) : 12

  const activeBooklistId = typeof obj.activeBooklistId === 'string' ? obj.activeBooklistId : ''
  const lastViewedBookId = typeof obj.lastViewedBookId === 'string' && obj.lastViewedBookId.trim()
    ? obj.lastViewedBookId.trim()
    : undefined

  return {
    keyword,
    sortBy,
    tagFilter,
    tagMode,
    formatFilter,
    languageFilter,
    statusFilter,
    page,
    pageSize,
    activeBooklistId,
    lastViewedBookId,
    ...(Array.isArray(obj.orderedBookIds) ? { orderedBookIds: [...new Set(obj.orderedBookIds.filter((id): id is string => typeof id === 'string' && !!id))].slice(0, 10000) } : {}),
  }
}

/** Keep the user's result order while reading changes lastReadAt; refreshed metadata and predicates still apply. */
export function queryLibrarySession<T extends LibraryQueryBook>(books: readonly T[], options: LibraryQueryOptions, orderedIds?: readonly string[]): LibraryQueryResult<T> {
  if (!orderedIds?.length) return queryLibraryBooks(books, options)
  const all = queryLibraryBooks(books, { ...options, page: 1, pageSize: Number.MAX_SAFE_INTEGER })
  const rank = new Map(orderedIds.map((id, index) => [id, index]))
  all.items.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  const pageSize = Number.isFinite(options.pageSize) ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(options.pageSize!))) : 12
  const totalPages = Math.ceil(all.total / pageSize)
  const requestedPage = Number.isFinite(options.page) ? Math.max(1, Math.trunc(options.page!)) : 1
  const page = Math.min(requestedPage, Math.max(1, totalPages))
  return { items: all.items.slice((page - 1) * pageSize, page * pageSize), total: all.total, totalPages, page, pageSize }
}

/**
 * 事务性筛选草稿：从当前激活状态派生草稿副本。
 */
export function createFilterDraft(current: {
  tagFilter: readonly string[]
  tagMode: 'and' | 'or'
  formatFilter: string
  languageFilter: string
  statusFilter: ReadingStatus | ''
  sortBy: LibrarySortBy
}): AdvancedFilterDraft {
  return {
    tags: [...current.tagFilter],
    tagMode: current.tagMode,
    format: current.formatFilter,
    language: current.languageFilter,
    status: current.statusFilter,
    sortBy: current.sortBy,
  }
}

/**
 * 事务性筛选草稿提交：将草稿应用为正式筛选状态。
 */
export function commitFilterDraft(draft: AdvancedFilterDraft): {
  tagFilter: string[]
  tagMode: 'and' | 'or'
  formatFilter: string
  languageFilter: string
  statusFilter: ReadingStatus | ''
  sortBy: LibrarySortBy
} {
  return {
    tagFilter: [...draft.tags],
    tagMode: draft.tagMode,
    formatFilter: draft.format,
    languageFilter: draft.language,
    statusFilter: draft.status,
    sortBy: draft.sortBy,
  }
}

export interface SessionStorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

class MemoryStorageAdapter implements SessionStorageAdapter {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
}

const memoryAdapterInstance = new MemoryStorageAdapter()
let configuredAdapter: SessionStorageAdapter | null = null

/**
 * 配置自定义会话存储适配器（测试时用于注入模拟器或清空隔离，防止在 Node 环境静默读取用户真实的 localStorage）。
 */
export function setSessionStorageAdapter(adapter: SessionStorageAdapter | null): void {
  configuredAdapter = adapter
}

function resolveStorage(): SessionStorageAdapter {
  if (configuredAdapter) return configuredAdapter
  // 单元测试 / Node.js 环境: 绝不调用任何全局/真实宿主存储
  if (typeof window === 'undefined') {
    return memoryAdapterInstance
  }
  try {
    if (typeof window.localStorage !== 'undefined') {
      return window.localStorage
    }
  } catch (error) {
    console.warn('[librarySession] sessionStorage access error, falling back to memory', error)
  }
  return memoryAdapterInstance
}

const STORAGE_KEY = 'pagewise:library-session:v1'

/**
 * 保存藏书导航与查询会话。
 */
export function saveLibrarySession(state: Partial<LibrarySessionState>): void {
  try {
    const storage = resolveStorage()
    const current = loadLibrarySession()
    const merged = sanitizeSessionState({ ...current, ...state })
    storage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch (error) {
    console.warn('[librarySession] saveLibrarySession failed', error)
  }
}

/**
 * 读取已保存的会话；若无或已损坏则返回标准初始状态。
 */
export function loadLibrarySession(): LibrarySessionState {
  try {
    const storage = resolveStorage()
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_LIBRARY_SESSION, tagFilter: [] }
    const parsed = JSON.parse(raw)
    return sanitizeSessionState(parsed)
  } catch (error) {
    console.warn('[librarySession] loadLibrarySession failed, returning default', error)
    return { ...DEFAULT_LIBRARY_SESSION, tagFilter: [] }
  }
}

/**
 * 清除已保存的会话。
 */
export function clearLibrarySession(): void {
  try {
    const storage = resolveStorage()
    storage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.warn('[librarySession] clearLibrarySession failed', error)
  }
}
