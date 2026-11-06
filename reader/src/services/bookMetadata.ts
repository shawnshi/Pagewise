import type { BookMeta, BookMetadataFields, BookMetadataSnapshot } from '../storage/types.ts'

export type { BookMetadataFields, BookMetadataSnapshot }

export const METADATA_LIMITS = {
  author: 256,
  publisher: 256,
  publicationDate: 64,
  language: 32,
} as const

export class BookMetadataConflictError extends Error {
  readonly code = 'source_changed'
  constructor(message = 'Book metadata changed concurrently') {
    super(message)
    this.name = 'BookMetadataConflictError'
  }
}

export function bookMetadataSnapshot(
  book: Pick<BookMeta, 'id' | 'title' | 'author' | 'publisher' | 'publicationDate' | 'language'>,
): BookMetadataSnapshot {
  return {
    id: book.id,
    title: book.title ?? '',
    author: book.author ?? '',
    publisher: book.publisher ?? '',
    publicationDate: book.publicationDate ?? '',
    language: book.language ?? '',
  }
}

export function bookMetadataMatches(
  book: Pick<BookMeta, 'id' | 'title' | 'author' | 'publisher' | 'publicationDate' | 'language'>,
  expected: BookMetadataSnapshot,
): boolean {
  const actual = bookMetadataSnapshot(book)
  return (['id', 'title', 'author', 'publisher', 'publicationDate', 'language'] as const).every(
    key => actual[key] === expected[key],
  )
}

export function validateBookMetadataUpdate(
  id: string,
  expected: BookMetadataSnapshot,
  patch: BookMetadataFields,
): void {
  if (!id || typeof id !== 'string' || id.includes('\0') || id.length > 512) {
    throw new TypeError('Invalid book id')
  }
  if (!expected || expected.id !== id) {
    throw new TypeError('Invalid metadata snapshot: id mismatch')
  }
  for (const key of ['id', 'title', 'author', 'publisher', 'publicationDate', 'language'] as const) {
    if (typeof expected[key] !== 'string' || expected[key].includes('\0')) {
      throw new TypeError(`Invalid metadata snapshot field: ${key}`)
    }
  }

  for (const key of ['author', 'publisher', 'publicationDate', 'language'] as const) {
    const val = patch[key]
    if (val === undefined) continue
    if (typeof val !== 'string') {
      throw new TypeError(`Invalid metadata patch field ${key}: must be a string`)
    }
    if (val.includes('\0')) {
      throw new TypeError(`Invalid metadata patch field ${key}: null bytes are forbidden`)
    }
    const limit = METADATA_LIMITS[key]
    if (val.length > limit) {
      throw new TypeError(`Invalid metadata patch field ${key}: length exceeds limit of ${limit}`)
    }
  }
}

export type MetadataMergeMode = 'fill-empty' | 'overwrite'

export function mergeMetadata(
  current: BookMetadataSnapshot,
  suggested: BookMetadataFields,
  mode: MetadataMergeMode,
): BookMetadataFields {
  const result: BookMetadataFields = {}
  const keys = ['author', 'publisher', 'publicationDate', 'language'] as const

  for (const key of keys) {
    const curVal = (current[key] ?? '').trim()
    const sugVal = (suggested[key] ?? '').trim()

    if (mode === 'fill-empty') {
      // 仅补全空白字段：已有非空值则保留原值；原值为空且新值存在时补入
      result[key] = curVal || sugVal
    } else {
      // 覆盖已有字段：新值非空则用新值覆盖；新值为空则保留原值
      result[key] = sugVal || curVal
    }
  }
  return result
}

export type MetadataFieldDiffStatus = 'added' | 'modified' | 'unchanged' | 'empty'

export function diffMetadataField(originalVal: string | undefined, newVal: string | undefined): MetadataFieldDiffStatus {
  const orig = (originalVal ?? '').trim()
  const next = (newVal ?? '').trim()

  if (!orig && !next) return 'empty'
  if (!orig && next) return 'added'
  if (orig && next && orig !== next) return 'modified'
  return 'unchanged'
}
