import type { BookMeta, ReadingStatus } from '../storage/types.ts'
import { normalizeReadingStatus, resolveReadingStatus } from './readingStatus.ts'
import { matchesAvailability, type AvailabilityFilter } from './bookAvailability.ts'

export interface LibraryQueryClassification {
  readonly category?: { readonly value: string; readonly locked?: boolean; readonly source?: string } | null
  readonly topics?: readonly { readonly value: string; readonly locked?: boolean; readonly source?: string }[]
  readonly feature?: { readonly value: string; readonly locked?: boolean; readonly source?: string } | null
  readonly facets?: {
    readonly audience?: string
    readonly textbook?: boolean
    readonly ancientText?: boolean
    readonly workCountry?: string
    readonly workPeriod?: string
  }
  readonly legacyTags?: readonly string[]
  readonly revision?: number
}

export type LibraryQueryBook = Readonly<Pick<BookMeta,
  'id' | 'title' | 'author' | 'format' | 'language' | 'addedAt' | 'lastReadAt' | 'progress' | 'fileAvailability'
>> & {
  readonly tags: readonly string[]
  readonly pinnedAt?: number
  readonly readingStatus?: ReadingStatus
  readonly classification?: LibraryQueryClassification
}

export interface LibraryQueryOptions {
  search?: string
  availability?: AvailabilityFilter
  tags?: readonly string[]
  tagMode?: 'and' | 'or'
  category?: string
  classificationStatus?: 'all' | 'complete' | 'incomplete' | 'unclassified'
  audience?: string
  textbook?: boolean | 'unknown' | 'true' | 'false' | 'all' | '' | null
  ancientText?: boolean | 'unknown' | 'true' | 'false' | 'all' | '' | null
  workCountry?: string
  workPeriod?: string
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

export function isClassificationComplete(classification?: LibraryQueryClassification | null): boolean {
  if (!classification) return false
  if (!classification.category || !classification.category.value) return false
  if (!Array.isArray(classification.topics) || classification.topics.length < 2) return false
  return true
}

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
  const statuses = new Set((options.statuses ?? []).map(normalizeReadingStatus).filter((status): status is ReadingStatus => status !== undefined))
  const sortBy = options.sortBy ?? 'lastRead'
  const direction = options.direction ?? (sortBy === 'title' || sortBy === 'author' ? 'asc' : 'desc')
  const sign = direction === 'asc' ? 1 : -1
  const selected = books.filter(book => {
    if (!matchesAvailability(book, options.availability)) return false
    const bookTags = book.tags.map(normalize)
    const fields = [normalize(book.title), normalize(book.author), ...bookTags]
    if (!words.every(word => fields.some(field => field.includes(word)))) return false
    if (tags.length && !(options.tagMode === 'or'
      ? tags.some(tag => bookTags.includes(tag))
      : tags.every(tag => bookTags.includes(tag)))) return false
    if (options.category) {
      const cat = normalize(options.category)
      const bookCat = book.classification?.category?.value ? normalize(book.classification.category.value) : ''
      if (bookCat !== cat) return false
    }
    if (options.classificationStatus && options.classificationStatus !== 'all') {
      const hasClassification = Boolean(book.classification)
      const complete = isClassificationComplete(book.classification)
      if (options.classificationStatus === 'complete' && !complete) return false
      if (options.classificationStatus === 'incomplete' && (!hasClassification || complete)) return false
      if (options.classificationStatus === 'unclassified' && hasClassification) return false
    }
    if (options.audience) {
      const target = normalize(options.audience)
      const actual = normalize(book.classification?.facets?.audience ?? '')
      if (actual !== target) return false
    }
    if (options.textbook !== undefined && options.textbook !== null && options.textbook !== '' && options.textbook !== 'all') {
      const actual = book.classification?.facets?.textbook
      if (options.textbook === true || options.textbook === 'true') {
        if (actual !== true) return false
      } else if (options.textbook === false || options.textbook === 'false') {
        if (actual !== false) return false
      } else if (options.textbook === 'unknown') {
        if (actual !== undefined) return false
      }
    }
    if (options.ancientText !== undefined && options.ancientText !== null && options.ancientText !== '' && options.ancientText !== 'all') {
      const actual = book.classification?.facets?.ancientText
      if (options.ancientText === true || options.ancientText === 'true') {
        if (actual !== true) return false
      } else if (options.ancientText === false || options.ancientText === 'false') {
        if (actual !== false) return false
      } else if (options.ancientText === 'unknown') {
        if (actual !== undefined) return false
      }
    }
    if (options.workCountry) {
      const target = normalize(options.workCountry)
      const actual = normalize(book.classification?.facets?.workCountry ?? '')
      if (actual !== target) return false
    }
    if (options.workPeriod) {
      const target = normalize(options.workPeriod)
      const actual = normalize(book.classification?.facets?.workPeriod ?? '')
      if (actual !== target) return false
    }
    if (formats.size && !formats.has(normalize(book.format))) return false
    if (languages.size && !languages.has(normalize(book.language ?? ''))) return false
    if (statuses.size) {
      const statusInfo = resolveReadingStatus(book)
      if (!statuses.has(statusInfo.effective ?? 'unmarked')) return false
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
