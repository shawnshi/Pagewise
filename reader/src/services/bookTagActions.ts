import type { BookClassificationUpdate, BookMeta, LibraryStorage, NewBookMeta, LegacyBookTagsUpdate } from '../storage/types'
import {
  createClassification, parseClassification, classificationTags, getTaggingMetadata,
  mergeClassificationTag, normalizeTagName,
  type BookClassification, type BookTaggingMetadata,
} from './bookClassification'

const metadataKeys = ['title', 'author', 'publisher', 'publicationDate', 'description'] as const

export function classificationMetadataMatches(book: BookMeta, expected: BookTaggingMetadata): boolean {
  const actual = getTaggingMetadata(book)
  return metadataKeys.every(key => actual[key] === expected[key])
}

/** Validate before any backend side effects; callers still check stored revisions atomically. */
export function prepareClassificationUpdates(updates: readonly BookClassificationUpdate[], legacyUpdates: readonly LegacyBookTagsUpdate[] = []) {
  const ids = new Set<string>()
  const plainTags = (tags: readonly string[]) => {
    if (!Array.isArray(tags)) throw new Error('Invalid legacy tags')
    return createClassification(tags).legacyTags
  }
  const structured = updates.map(update => {
    if (typeof update.id !== 'string' || !update.id || ids.has(update.id)) throw new Error('Duplicate or invalid book ID')
    ids.add(update.id)
    if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0) throw new Error('Invalid expected revision')
    const classification = parseClassification(update.classification)
    if (classification.revision !== update.expectedRevision + 1) throw new Error('Invalid next revision')
    if (update.expectedMetadata && metadataKeys.some(key =>
      key === 'title' || key === 'author'
        ? typeof update.expectedMetadata![key] !== 'string'
        : update.expectedMetadata![key] !== undefined && typeof update.expectedMetadata![key] !== 'string')) {
      throw new Error('Invalid metadata snapshot')
    }
    return { ...update,
      expectedTags: update.expectedTags === undefined ? undefined : plainTags(update.expectedTags),
      expectedMetadata: update.expectedMetadata === undefined ? undefined : getTaggingMetadata(update.expectedMetadata),
      classification, tags: classificationTags(classification),
    }
  })
  const legacy = legacyUpdates.map(update => {
    if (typeof update.id !== 'string' || !update.id || ids.has(update.id)) throw new Error('Duplicate or invalid book ID')
    ids.add(update.id)
    return { id: update.id, expectedTags: plainTags(update.expectedTags), tags: plainTags(update.tags),
      expectedRevision: undefined, expectedMetadata: undefined, classification: null }
  })
  return [...structured, ...legacy]
}

export function validatedBookClassification<T extends NewBookMeta | BookMeta>(meta: T): T {
  if (meta.classification === undefined) return meta
  const classification = parseClassification(meta.classification)
  return { ...meta, classification, tags: classificationTags(classification) }
}

export function rejectClassificationPatch(patch: Partial<BookMeta>): void {
  if (Object.keys(patch).some(key => key === 'classification' || key.startsWith('classification.') || key.startsWith('tags.'))) {
    throw new Error('Use updateBookClassifications')
  }
}

export async function saveBookClassification(storage: LibraryStorage, original: BookMeta, draft: BookClassification): Promise<BookClassification> {
  const expectedRevision = original.classification === undefined ? 0 : parseClassification(original.classification).revision
  const classification = parseClassification({ ...draft,
    revision: expectedRevision + 1,
  })
  await storage.updateBookClassifications([{
    id: original.id, expectedRevision, expectedMetadata: getTaggingMetadata(original),
    expectedTags: original.classification === undefined ? original.tags : undefined, classification,
  }])
  return classification
}

type EditableRole = 'topic' | 'feature' | 'legacy'

async function editLibraryTags(storage: LibraryStorage, role: EditableRole, value: string, to?: string): Promise<number> {
  if (!['topic', 'feature', 'legacy'].includes(role)) throw new Error('Category cannot be edited globally')
  const name = normalizeTagName(value)
  if (!name || (to !== undefined && !normalizeTagName(to))) throw new Error('Tag name is required')
  const updates: BookClassificationUpdate[] = []
  const legacyUpdates: LegacyBookTagsUpdate[] = []
  for (const book of await storage.listBooks()) {
    if (!book.classification) {
      if (role !== 'legacy') continue
      const tags = to === undefined
        ? book.tags.filter(tag => normalizeTagName(tag) !== name)
        : [...new Set(book.tags.map(tag => normalizeTagName(tag) === name ? normalizeTagName(to) : tag))]
      if (JSON.stringify(tags) !== JSON.stringify(book.tags)) legacyUpdates.push({ id: book.id, expectedTags: book.tags, tags })
      continue
    }
    const current = book.classification ? parseClassification(book.classification) : createClassification(book.tags)
    let next: BookClassification
    if (to !== undefined) next = mergeClassificationTag(current, role, value, to)
    else {
      next = parseClassification(current)
      if (role === 'topic') next.topics = next.topics.filter(tag => normalizeTagName(tag.value) !== name)
      if (role === 'feature' && next.feature && normalizeTagName(next.feature.value) === name) next.feature = null
      if (role === 'legacy') next.legacyTags = next.legacyTags.filter(tag => normalizeTagName(tag) !== name)
    }
    if (JSON.stringify(next) === JSON.stringify(current)) continue
    next.revision = current.revision + 1
    updates.push({ id: book.id, expectedRevision: current.revision, expectedMetadata: getTaggingMetadata(book), classification: next })
  }
  await storage.updateBookClassifications(updates, legacyUpdates)
  return updates.length + legacyUpdates.length
}

export const mergeLibraryTags = (storage: LibraryStorage, role: EditableRole, from: string, to: string): Promise<number> =>
  editLibraryTags(storage, role, from, to)

export const removeLibraryTag = (storage: LibraryStorage, role: EditableRole, value: string): Promise<number> =>
  editLibraryTags(storage, role, value)

export async function clearBookClassifications(storage: LibraryStorage, ids: readonly string[]): Promise<number> {
  const wanted = new Set(ids)
  const books = (await storage.listBooks()).filter(book => wanted.has(book.id))
  if (books.length !== wanted.size) throw new Error('Book not found')
  const updates = books.map(book => {
    const revision = book.classification?.revision ?? 0
    const classification = createClassification(book.classification?.legacyTags ?? book.tags)
    classification.revision = revision + 1
    return { id: book.id, expectedRevision: revision, expectedMetadata: getTaggingMetadata(book),
      expectedTags: book.classification === undefined ? book.tags : undefined, classification }
  })
  await storage.updateBookClassifications(updates)
  return updates.length
}
