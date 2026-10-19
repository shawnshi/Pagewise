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
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? value : 0
const positiveInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))) : fallback

const zhCollator = new Intl.Collator('zh')

export interface CachedBookNorm {
  titleRaw: string
  normalizedTitle: string
  authorRaw: string
  normalizedAuthor: string
  rawTags: readonly string[]
  normalizedTags: readonly string[]
  searchTokens: readonly string[]
  formatRaw: string
  normalizedFormat: string
  languageRaw?: string
  normalizedLanguage: string
  statusRaw?: ReadingStatus
  lastReadAtRaw?: number
  progressRaw?: number
  effectiveStatus: ReadingStatus | 'unmarked'
  classificationRef?: LibraryQueryClassification | null
  classificationRevision?: number
  categoryRaw?: string
  normalizedCategory: string
  audienceRaw?: string
  normalizedAudience: string
  workCountryRaw?: string
  normalizedWorkCountry: string
  workPeriodRaw?: string
  normalizedWorkPeriod: string
  isComplete: boolean
}

const bookNormCache = new WeakMap<object, CachedBookNorm>()

function areTagsEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function getCachedBookNorm(book: LibraryQueryBook): CachedBookNorm {
  let cached = bookNormCache.get(book)
  if (!cached) {
    const rawTags = book.tags ? [...book.tags] : []
    const normalizedTags = rawTags.map(normalize)
    const normalizedTitle = normalize(book.title || '')
    const normalizedAuthor = normalize(book.author || '')
    const categoryRaw = book.classification?.category?.value
    const audienceRaw = book.classification?.facets?.audience
    const workCountryRaw = book.classification?.facets?.workCountry
    const workPeriodRaw = book.classification?.facets?.workPeriod

    cached = {
      titleRaw: book.title,
      normalizedTitle,
      authorRaw: book.author,
      normalizedAuthor,
      rawTags,
      normalizedTags,
      searchTokens: [normalizedTitle, normalizedAuthor, ...normalizedTags],
      formatRaw: book.format,
      normalizedFormat: normalize(book.format || ''),
      languageRaw: book.language,
      normalizedLanguage: normalize(book.language ?? ''),
      statusRaw: book.readingStatus,
      lastReadAtRaw: book.lastReadAt,
      progressRaw: book.progress,
      effectiveStatus: resolveReadingStatus(book).effective ?? 'unmarked',
      classificationRef: book.classification,
      classificationRevision: book.classification?.revision,
      categoryRaw,
      normalizedCategory: categoryRaw ? normalize(categoryRaw) : '',
      audienceRaw,
      normalizedAudience: audienceRaw ? normalize(audienceRaw) : '',
      workCountryRaw,
      normalizedWorkCountry: workCountryRaw ? normalize(workCountryRaw) : '',
      workPeriodRaw,
      normalizedWorkPeriod: workPeriodRaw ? normalize(workPeriodRaw) : '',
      isComplete: isClassificationComplete(book.classification),
    }
    bookNormCache.set(book, cached)
    return cached
  }

  let searchTokensDirty = false

  if (cached.titleRaw !== book.title) {
    cached.titleRaw = book.title
    cached.normalizedTitle = normalize(book.title || '')
    searchTokensDirty = true
  }

  if (cached.authorRaw !== book.author) {
    cached.authorRaw = book.author
    cached.normalizedAuthor = normalize(book.author || '')
    searchTokensDirty = true
  }

  if (!areTagsEqual(cached.rawTags, book.tags)) {
    cached.rawTags = book.tags ? [...book.tags] : []
    cached.normalizedTags = cached.rawTags.map(normalize)
    searchTokensDirty = true
  }

  if (searchTokensDirty) {
    cached.searchTokens = [cached.normalizedTitle, cached.normalizedAuthor, ...cached.normalizedTags]
  }

  if (cached.formatRaw !== book.format) {
    cached.formatRaw = book.format
    cached.normalizedFormat = normalize(book.format || '')
  }

  if (cached.languageRaw !== book.language) {
    cached.languageRaw = book.language
    cached.normalizedLanguage = normalize(book.language ?? '')
  }

  if (cached.statusRaw !== book.readingStatus || cached.lastReadAtRaw !== book.lastReadAt || cached.progressRaw !== book.progress) {
    cached.statusRaw = book.readingStatus
    cached.lastReadAtRaw = book.lastReadAt
    cached.progressRaw = book.progress
    cached.effectiveStatus = resolveReadingStatus(book).effective ?? 'unmarked'
  }

  const currentCat = book.classification?.category?.value
  if (cached.categoryRaw !== currentCat) {
    cached.categoryRaw = currentCat
    cached.normalizedCategory = currentCat ? normalize(currentCat) : ''
  }

  const currentAudience = book.classification?.facets?.audience
  if (cached.audienceRaw !== currentAudience) {
    cached.audienceRaw = currentAudience
    cached.normalizedAudience = currentAudience ? normalize(currentAudience) : ''
  }

  const currentCountry = book.classification?.facets?.workCountry
  if (cached.workCountryRaw !== currentCountry) {
    cached.workCountryRaw = currentCountry
    cached.normalizedWorkCountry = currentCountry ? normalize(currentCountry) : ''
  }

  const currentPeriod = book.classification?.facets?.workPeriod
  if (cached.workPeriodRaw !== currentPeriod) {
    cached.workPeriodRaw = currentPeriod
    cached.normalizedWorkPeriod = currentPeriod ? normalize(currentPeriod) : ''
  }

  cached.isComplete = isClassificationComplete(book.classification)

  return cached
}

export interface PreparedLibraryQuery {
  readonly words: readonly string[]
  readonly tags: readonly string[]
  readonly tagMode?: 'and' | 'or'
  readonly formats?: ReadonlySet<string>
  readonly languages?: ReadonlySet<string>
  readonly statuses?: ReadonlySet<ReadingStatus>
  readonly category: string
  readonly classificationStatus?: 'all' | 'complete' | 'incomplete' | 'unclassified'
  readonly audience: string
  readonly textbook?: boolean | 'unknown' | 'true' | 'false' | 'all' | '' | null
  readonly ancientText?: boolean | 'unknown' | 'true' | 'false' | 'all' | '' | null
  readonly workCountry: string
  readonly workPeriod: string
  readonly availability?: AvailabilityFilter
  readonly sortBy: 'lastRead' | 'addedAt' | 'title' | 'author' | 'progress'
  readonly direction: 'asc' | 'desc'
  readonly sign: 1 | -1
  readonly pinnedFirst: boolean
  readonly page?: number
  readonly pageSize?: number
}

export function prepareLibraryQuery(options: LibraryQueryOptions = {}): PreparedLibraryQuery {

  const sortBy = options.sortBy ?? 'lastRead'
  const direction = options.direction ?? (sortBy === 'title' || sortBy === 'author' ? 'asc' : 'desc')
  const sign = direction === 'asc' ? 1 : -1

  const words = options.search ? normalize(options.search).split(' ').filter(Boolean) : []
  const tags = options.tags ? options.tags.map(normalize).filter(Boolean) : []
  const formats = options.formats && options.formats.length
    ? new Set(options.formats.map(normalize).filter(Boolean))
    : undefined
  const languages = options.languages && options.languages.length
    ? new Set(options.languages.map(normalize).filter(Boolean))
    : undefined
  const statuses = options.statuses && options.statuses.length
    ? new Set(options.statuses.map(normalizeReadingStatus).filter((status): status is ReadingStatus => status !== undefined))
    : undefined

  const prepared: PreparedLibraryQuery = {
    words,
    tags,
    tagMode: options.tagMode,
    formats,
    languages,
    statuses,
    category: options.category ? normalize(options.category) : '',
    classificationStatus: options.classificationStatus,
    audience: options.audience ? normalize(options.audience) : '',
    textbook: options.textbook,
    ancientText: options.ancientText,
    workCountry: options.workCountry ? normalize(options.workCountry) : '',
    workPeriod: options.workPeriod ? normalize(options.workPeriod) : '',
    availability: options.availability,
    sortBy,
    direction,
    sign,
    pinnedFirst: Boolean(options.pinnedFirst),
    page: options.page,
    pageSize: options.pageSize,
  }

  return prepared
}

export function compareLibraryBooks<T extends LibraryQueryBook>(
  a: T, b: T, options: LibraryQueryOptions = {},
): number {
  if (options.pinnedFirst) {
    const pinOrder = finite(b.pinnedAt) - finite(a.pinnedAt)
    if (pinOrder) return pinOrder
  }
  const sortBy = options.sortBy ?? 'lastRead'
  const direction = options.direction ?? (sortBy === 'title' || sortBy === 'author' ? 'asc' : 'desc')
  const sign = direction === 'asc' ? 1 : -1
  let order: number
  if (sortBy === 'title' || sortBy === 'author') {
    const normA = getCachedBookNorm(a)[sortBy === 'title' ? 'normalizedTitle' : 'normalizedAuthor']
    const normB = getCachedBookNorm(b)[sortBy === 'title' ? 'normalizedTitle' : 'normalizedAuthor']
    order = zhCollator.compare(normA, normB)
  } else {
    const key = sortBy === 'lastRead' ? 'lastReadAt' : sortBy
    order = sortBy === 'lastRead'
      ? finite(a.lastReadAt ?? a.addedAt) - finite(b.lastReadAt ?? b.addedAt)
      : finite(a[key]) - finite(b[key])
  }
  return sign * order || compare(a.id, b.id)
}

export function filterLibraryBooks<T extends LibraryQueryBook>(
  books: readonly T[], options: LibraryQueryOptions = {},
): T[] {
  const prep = prepareLibraryQuery(options)
  const words = prep.words
  const tags = prep.tags
  const formats = prep.formats
  const languages = prep.languages
  const statuses = prep.statuses
  const category = prep.category
  const audience = prep.audience
  const workCountry = prep.workCountry
  const workPeriod = prep.workPeriod

  const result: T[] = []
  for (let i = 0; i < books.length; i++) {
    const book = books[i]
    if (!matchesAvailability(book, prep.availability)) continue
    const norm = getCachedBookNorm(book)

    if (words.length > 0) {
      const tokens = norm.searchTokens
      let allWordsMatch = true
      for (let w = 0; w < words.length; w++) {
        const word = words[w]
        let wordFound = false
        for (let t = 0; t < tokens.length; t++) {
          if (tokens[t].includes(word)) {
            wordFound = true
            break
          }
        }
        if (!wordFound) {
          allWordsMatch = false
          break
        }
      }
      if (!allWordsMatch) continue
    }

    if (tags.length > 0) {
      if (prep.tagMode === 'or') {
        let tagFound = false
        for (let t = 0; t < tags.length; t++) {
          if (norm.normalizedTags.includes(tags[t])) {
            tagFound = true
            break
          }
        }
        if (!tagFound) continue
      } else {
        let allTagsMatch = true
        for (let t = 0; t < tags.length; t++) {
          if (!norm.normalizedTags.includes(tags[t])) {
            allTagsMatch = false
            break
          }
        }
        if (!allTagsMatch) continue
      }
    }

    if (options.category && norm.normalizedCategory !== category) continue

    if (prep.classificationStatus && prep.classificationStatus !== 'all') {
      const hasClassification = Boolean(book.classification)
      const complete = norm.isComplete
      if (prep.classificationStatus === 'complete' && !complete) continue
      if (prep.classificationStatus === 'incomplete' && (!hasClassification || complete)) continue
      if (prep.classificationStatus === 'unclassified' && hasClassification) continue
    }

    if (options.audience && norm.normalizedAudience !== audience) continue

    if (prep.textbook !== undefined && prep.textbook !== null && prep.textbook !== '' && prep.textbook !== 'all') {
      const actual = book.classification?.facets?.textbook
      if (prep.textbook === true || prep.textbook === 'true') {
        if (actual !== true) continue
      } else if (prep.textbook === false || prep.textbook === 'false') {
        if (actual !== false) continue
      } else if (prep.textbook === 'unknown') {
        if (actual !== undefined) continue
      }
    }

    if (prep.ancientText !== undefined && prep.ancientText !== null && prep.ancientText !== '' && prep.ancientText !== 'all') {
      const actual = book.classification?.facets?.ancientText
      if (prep.ancientText === true || prep.ancientText === 'true') {
        if (actual !== true) continue
      } else if (prep.ancientText === false || prep.ancientText === 'false') {
        if (actual !== false) continue
      } else if (prep.ancientText === 'unknown') {
        if (actual !== undefined) continue
      }
    }

    if (options.workCountry && norm.normalizedWorkCountry !== workCountry) continue
    if (options.workPeriod && norm.normalizedWorkPeriod !== workPeriod) continue

    if (formats?.size && !formats.has(norm.normalizedFormat)) continue
    if (languages?.size && !languages.has(norm.normalizedLanguage)) continue
    if (statuses?.size && !statuses.has(norm.effectiveStatus)) continue

    result.push(book)
  }
  return result
}

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
  const selected = filterLibraryBooks(books, options)
  selected.sort((a, b) => compareLibraryBooks(a, b, options))
  const pageSize = positiveInteger(options.pageSize, 12)
  const total = selected.length
  const totalPages = Math.ceil(total / pageSize)
  const page = Math.min(positiveInteger(options.page, 1), Math.max(1, totalPages))
  const start = (page - 1) * pageSize
  return { items: selected.slice(start, start + pageSize), total, page, pageSize, totalPages }
}
