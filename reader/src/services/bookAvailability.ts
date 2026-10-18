import type { BookMeta, FileAvailability } from '../storage/types.ts'

export type AvailabilityFilter = '' | 'available' | 'unavailable' | 'missing' | 'permission-denied'

export function bookFileProblem(book: Pick<BookMeta, 'fileAvailability'>): Exclude<FileAvailability, 'available'> | undefined {
  return book.fileAvailability === 'missing' || book.fileAvailability === 'permission-denied'
    ? book.fileAvailability : undefined
}

export function matchesAvailability(book: Pick<BookMeta, 'fileAvailability'>, filter?: AvailabilityFilter): boolean {
  if (!filter) return true
  const problem = bookFileProblem(book)
  if (filter === 'unavailable') return !!problem
  // Legacy records have no verified availability; they are not evidence of an available file.
  if (filter === 'available') return book.fileAvailability === 'available'
  return problem === filter
}

export function normalizeAvailability(value: unknown): AvailabilityFilter {
  return ['', 'available', 'unavailable', 'missing', 'permission-denied'].includes(String(value))
    ? value as AvailabilityFilter : ''
}

export function visibleBookTopics(book: Pick<BookMeta, 'classification' | 'tags'>): string[] {
  const topics = book.classification?.topics.map(topic => topic.value) ?? book.tags ?? []
  return [...new Set(topics.filter(Boolean))].slice(0, 2)
}
