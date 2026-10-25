import type { BookDescriptionSnapshot, BookMeta } from '../storage/types.ts'

export const BOOK_INTRODUCTION_MAX_LENGTH = 16_000
export class BookDescriptionConflictError extends Error {
  readonly code = 'source_changed'
  constructor() { super('Book metadata or description changed'); this.name = 'BookDescriptionConflictError' }
}

export function bookDescriptionSnapshot(book: Pick<BookMeta, 'id' | 'title' | 'author' | 'publisher' | 'publicationDate' | 'description'>): BookDescriptionSnapshot {
  return { id: book.id, title: book.title, author: book.author, publisher: book.publisher ?? '', publicationDate: book.publicationDate ?? '', description: book.description ?? '' }
}
export function bookDescriptionMatches(book: Pick<BookMeta, 'id' | 'title' | 'author' | 'publisher' | 'publicationDate' | 'description'>, expected: BookDescriptionSnapshot): boolean {
  const actual = bookDescriptionSnapshot(book)
  return (Object.keys(actual) as (keyof BookDescriptionSnapshot)[]).every(key => actual[key] === expected[key])
}
export function validateBookDescriptionUpdate(id: string, expected: BookDescriptionSnapshot, description: string): void {
  if (!id || expected?.id !== id || ['id', 'title', 'author', 'publisher', 'publicationDate', 'description'].some(key => typeof expected[key as keyof BookDescriptionSnapshot] !== 'string')) throw new TypeError('Invalid description snapshot')
  if (typeof description !== 'string' || !description.trim() || description.length > BOOK_INTRODUCTION_MAX_LENGTH || description.includes('\0')) throw new TypeError('Invalid introduction text')
}
