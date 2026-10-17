import type { BookMeta, ReadingStatus } from '../storage/types.ts'
import { isReadingStatus, resolveReadingStatus } from './readingStatus.ts'

export type LibraryQueryBook = Readonly<Pick<BookMeta,
  'id' | 'title' | 'author' | 'format' | 'language' | 'addedAt' | 'lastReadAt' | 'progress'
>> & { readonly tags: readonly string[]; readonly pinnedAt?: number; readonly readingStatus?: ReadingStatus }

export interface LibraryQueryOptions {
  search?: string
  tags?: readonly string[]
  tagMode?: 'and' | 'or'
  /** Exact normalized metadata values; not a list of supported reading engines. */
  formats?: readonly string[]
  languages?: readonly string[]
  statuses?: readonly ReadingStatus[]
  sortBy?: 'lastRead' | 'addedAt' | 'title' | 'author' | 'progress'
  direction?: 'asc' | 'desc'
  /** Library policy: newest pins precede every unpinned book, in either direction. */
  pinnedFirst?: boolean
  page?: number
  pageSize?: number
}

export interface LibraryQueryResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? value : 0
const positiveInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))) : fallback

/**
 * Metadata-only query. Preserves input objects (including legacy formats) and never
 * infers readability or an explicit read/unread state from numeric progress.
 * Empty results use page=1,totalPages=0. ID ties retain input order.
 * Default: lastRead descending; text sorts ascending; ID always ascending.
 */
export function queryLibraryBooks<T extends LibraryQueryBook>(
  books: readonly T[], options: LibraryQueryOptions = {},
): LibraryQueryResult<T> {
  const words = normalize(options.search ?? '').split(' ').filter(Boolean)
  const tags = (options.tags ?? []).map(normalize).filter(Boolean)
  const formats = new Set((options.formats ?? []).map(normalize).filter(Boolean))
  const languages = new Set((options.languages ?? []).map(normalize).filter(Boolean))
  const statuses = new Set((options.statuses ?? []).filter(isReadingStatus))
  const sortBy = options.sortBy ?? 'lastRead'
  const direction = options.direction ?? (sortBy === 'title' || sortBy === 'author' ? 'asc' : 'desc')
  const sign = direction === 'asc' ? 1 : -1
  const selected = books.filter(book => {
    const bookTags = book.tags.map(normalize)
    const fields = [normalize(book.title), normalize(book.author), ...bookTags]
    if (!words.every(word => fields.some(field => field.includes(word)))) return false
    if (tags.length && !(options.tagMode === 'or'
      ? tags.some(tag => bookTags.includes(tag))
      : tags.every(tag => bookTags.includes(tag)))) return false
    if (formats.size && !formats.has(normalize(book.format))) return false
    if (languages.size && !languages.has(normalize(book.language ?? ''))) return false
    if (statuses.size) {
      const statusInfo = resolveReadingStatus(book)
      if (!statusInfo.effective || !statuses.has(statusInfo.effective)) return false
    }
    return true
  })
  selected.sort((a, b) => {
    if (options.pinnedFirst) {
      const pinOrder = finite(b.pinnedAt) - finite(a.pinnedAt)
      if (pinOrder) return pinOrder
    }
    let order: number
    if (sortBy === 'title' || sortBy === 'author') {
      order = normalize(a[sortBy]).localeCompare(normalize(b[sortBy]), 'zh')
    } else {
      const key = sortBy === 'lastRead' ? 'lastReadAt' : sortBy
      order = sortBy === 'lastRead'
        ? finite(a.lastReadAt ?? a.addedAt) - finite(b.lastReadAt ?? b.addedAt)
        : finite(a[key]) - finite(b[key])
    }
    return sign * order || compare(a.id, b.id)
  })
  const pageSize = positiveInteger(options.pageSize, 12)
  const total = selected.length
  const totalPages = Math.ceil(total / pageSize)
  const page = Math.min(positiveInteger(options.page, 1), Math.max(1, totalPages))
  const start = (page - 1) * pageSize
  return { items: selected.slice(start, start + pageSize), total, page, pageSize, totalPages }
}
