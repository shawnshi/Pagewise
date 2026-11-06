import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bookMetadataSnapshot,
  bookMetadataMatches,
  validateBookMetadataUpdate,
  mergeMetadata,
  diffMetadataField,
  BookMetadataConflictError,
  METADATA_LIMITS,
} from '../src/services/bookMetadata.ts'

import {
  normalizeLanguageCode,
  normalizePublicationDate,
  sanitizeSearchTitle,
} from '../src/services/openBookSearch.ts'

import {
  extractJsonFromAiResponse,
  AiMetadataError,
} from '../src/services/aiBookMetadata.ts'

test('bookMetadataSnapshot: captures exact canonical fields', () => {
  const book = {
    id: 'book-1',
    title: '三体',
    author: '刘慈欣',
    publisher: '重庆出版社',
    publicationDate: '2008-01',
    language: 'zh',
  }
  const snap = bookMetadataSnapshot(book)
  assert.deepEqual(snap, {
    id: 'book-1',
    title: '三体',
    author: '刘慈欣',
    publisher: '重庆出版社',
    publicationDate: '2008-01',
    language: 'zh',
  })

  // Handles undefined/null gracefully
  const partialBook = { id: 'book-2', title: 'Unknown' }
  const partialSnap = bookMetadataSnapshot(partialBook)
  assert.deepEqual(partialSnap, {
    id: 'book-2',
    title: 'Unknown',
    author: '',
    publisher: '',
    publicationDate: '',
    language: '',
  })
})

test('bookMetadataMatches: accurately detects matching and drifting states', () => {
  const book = {
    id: 'b-1',
    title: '活着',
    author: '余华',
    publisher: '作家出版社',
    publicationDate: '1993',
    language: 'zh',
  }
  const snap = bookMetadataSnapshot(book)
  assert.equal(bookMetadataMatches(book, snap), true)

  // Modified author
  assert.equal(bookMetadataMatches({ ...book, author: '余华 (改)' }, snap), false)
  // Modified publisher
  assert.equal(bookMetadataMatches({ ...book, publisher: '南海出版公司' }, snap), false)
  // Modified date
  assert.equal(bookMetadataMatches({ ...book, publicationDate: '1998' }, snap), false)
  // Modified language
  assert.equal(bookMetadataMatches({ ...book, language: 'en' }, snap), false)
})

test('validateBookMetadataUpdate: enforces bounds, types, and forbids null-bytes', () => {
  const validSnapshot = {
    id: 'b-1',
    title: 'Test',
    author: 'Author',
    publisher: 'Publisher',
    publicationDate: '2020',
    language: 'zh',
  }

  // Valid patch
  assert.doesNotThrow(() => {
    validateBookMetadataUpdate('b-1', validSnapshot, {
      author: 'New Author',
      publisher: 'New Publisher',
      publicationDate: '2021-05',
      language: 'en',
    })
  })

  // ID mismatch
  assert.throws(
    () => validateBookMetadataUpdate('b-2', validSnapshot, {}),
    /id mismatch/,
  )

  // Null byte in ID
  assert.throws(
    () => validateBookMetadataUpdate('b-1\0', { ...validSnapshot, id: 'b-1\0' }, {}),
    /Invalid book id/,
  )

  // Null byte in patch
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { author: 'Evil\0Author' }),
    /null bytes are forbidden/,
  )
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { publisher: 'Evil\0Press' }),
    /null bytes are forbidden/,
  )
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { publicationDate: '2020\0' }),
    /null bytes are forbidden/,
  )
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { language: 'zh\0' }),
    /null bytes are forbidden/,
  )

  // Length limits
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { author: 'a'.repeat(METADATA_LIMITS.author + 1) }),
    /exceeds limit/,
  )
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { publisher: 'p'.repeat(METADATA_LIMITS.publisher + 1) }),
    /exceeds limit/,
  )
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { publicationDate: 'd'.repeat(METADATA_LIMITS.publicationDate + 1) }),
    /exceeds limit/,
  )
  assert.throws(
    () => validateBookMetadataUpdate('b-1', validSnapshot, { language: 'l'.repeat(METADATA_LIMITS.language + 1) }),
    /exceeds limit/,
  )
})

test('mergeMetadata: supports fill-empty and overwrite modes', () => {
  const current = {
    id: 'b-1',
    title: 'Sample',
    author: 'Original Author',
    publisher: '', // empty
    publicationDate: '2010',
    language: '', // empty
  }
  const suggested = {
    author: 'Suggested Author',
    publisher: 'Suggested Press',
    publicationDate: '2020',
    language: 'zh',
  }

  // fill-empty: keeps existing non-empty values, fills empty ones
  const fillResult = mergeMetadata(current, suggested, 'fill-empty')
  assert.deepEqual(fillResult, {
    author: 'Original Author',
    publisher: 'Suggested Press',
    publicationDate: '2010',
    language: 'zh',
  })

  // overwrite: overwrites existing values with suggested if non-empty
  const overwriteResult = mergeMetadata(current, suggested, 'overwrite')
  assert.deepEqual(overwriteResult, {
    author: 'Suggested Author',
    publisher: 'Suggested Press',
    publicationDate: '2020',
    language: 'zh',
  })

  // overwrite with empty suggestion preserves current
  const partialSuggested = { author: '', publisher: 'New Press' }
  const overwritePartial = mergeMetadata(current, partialSuggested, 'overwrite')
  assert.equal(overwritePartial.author, 'Original Author')
  assert.equal(overwritePartial.publisher, 'New Press')
})

test('diffMetadataField: accurately classifies diff state', () => {
  assert.equal(diffMetadataField('', ''), 'empty')
  assert.equal(diffMetadataField(undefined, ''), 'empty')
  assert.equal(diffMetadataField('', 'New Value'), 'added')
  assert.equal(diffMetadataField('Old Value', 'New Value'), 'modified')
  assert.equal(diffMetadataField('Same Value', 'Same Value'), 'unchanged')
  assert.equal(diffMetadataField('  Same  ', 'Same'), 'unchanged')
})

test('openBookSearch normalization utilities', () => {
  // Languages
  assert.equal(normalizeLanguageCode('chi'), 'zh')
  assert.equal(normalizeLanguageCode('zho'), 'zh')
  assert.equal(normalizeLanguageCode('zh-CN'), 'zh')
  assert.equal(normalizeLanguageCode('eng'), 'en')
  assert.equal(normalizeLanguageCode('ENGLISH'), 'en')
  assert.equal(normalizeLanguageCode('jpn'), 'ja')
  assert.equal(normalizeLanguageCode(''), undefined)

  // Dates
  assert.equal(normalizePublicationDate('2018'), '2018')
  assert.equal(normalizePublicationDate('2018-05'), '2018-05')
  assert.equal(normalizePublicationDate('2018-05-12'), '2018-05-12')
  assert.equal(normalizePublicationDate('2018/5/1'), '2018-05-01')
  assert.equal(normalizePublicationDate('Published May 2019'), '2019')
  assert.equal(normalizePublicationDate(2021), '2021')
  assert.equal(normalizePublicationDate(''), undefined)

  // Title sanitization
  assert.equal(sanitizeSearchTitle('三体.epub'), '三体')
  assert.equal(sanitizeSearchTitle('解忧杂货店 (精装典藏版)'), '解忧杂货店')
  assert.equal(sanitizeSearchTitle('The_Great_Gatsby.pdf'), 'The Great Gatsby')
})

test('aiBookMetadata: extractJsonFromAiResponse handles diverse outputs', () => {
  // Pure JSON
  const pure = '{"author": "村上春树", "publisher": "上海译文出版社", "publicationDate": "2001", "language": "zh"}'
  assert.deepEqual(extractJsonFromAiResponse(pure), {
    author: '村上春树',
    publisher: '上海译文出版社',
    publicationDate: '2001',
    language: 'zh',
  })

  // Markdown code block
  const markdown = 'Here is the catalog info:\n```json\n{"author": "Plato", "publisher": "Penguin", "publicationDate": "2003", "language": "en"}\n```\nHope it helps.'
  assert.deepEqual(extractJsonFromAiResponse(markdown), {
    author: 'Plato',
    publisher: 'Penguin',
    publicationDate: '2003',
    language: 'en',
  })

  // Invalid JSON throws AiMetadataError
  assert.throws(
    () => extractJsonFromAiResponse('No json here'),
    err => err instanceof AiMetadataError && err.code === 'invalid_json',
  )
  assert.throws(
    () => extractJsonFromAiResponse(''),
    err => err instanceof AiMetadataError && err.code === 'empty_output',
  )
})

test('searchOpenBookMetadata: supports AbortSignal cancellation immediately', async () => {
  const { searchOpenBookMetadata } = await import('../src/services/openBookSearch.ts')
  const controller = new AbortController()
  controller.abort() // already aborted

  const result = await searchOpenBookMetadata({
    title: '任意书名',
    signal: controller.signal,
    timeoutMs: 1000,
  })

  // Should gracefully complete with candidates empty or errors recorded, without hanging
  assert.ok(Array.isArray(result.candidates))
  assert.ok(Array.isArray(result.errors))
})

test('CAS conflict simulation: validates metadata concurrency guard', () => {
  // Mock store state
  let storedBook = {
    id: 'cas-book-1',
    title: '围城',
    author: '钱锺书',
    publisher: '人民文学出版社',
    publicationDate: '1991',
    language: 'zh',
  }

  function mockUpdateMetadata(id, expected, patch) {
    validateBookMetadataUpdate(id, expected, patch)
    if (!bookMetadataMatches(storedBook, expected)) {
      throw new BookMetadataConflictError()
    }
    storedBook = {
      ...storedBook,
      author: patch.author ?? storedBook.author,
      publisher: patch.publisher ?? storedBook.publisher,
      publicationDate: patch.publicationDate ?? storedBook.publicationDate,
      language: patch.language ?? storedBook.language,
    }
  }

  // 1. Initial snapshot matches -> successfully updates
  const snap1 = bookMetadataSnapshot(storedBook)
  mockUpdateMetadata('cas-book-1', snap1, { publisher: '三联书店' })
  assert.equal(storedBook.publisher, '三联书店')

  // 2. Concurrent change occurs (e.g. from another tab or device sync)
  storedBook.author = '钱钟书 (简体注)'

  // 3. Stale update with snap1 must throw BookMetadataConflictError and preserve concurrent change
  assert.throws(
    () => mockUpdateMetadata('cas-book-1', snap1, { publisher: '商务印书馆' }),
    err => err instanceof BookMetadataConflictError && err.code === 'source_changed',
  )
  assert.equal(storedBook.publisher, '三联书店')
  assert.equal(storedBook.author, '钱钟书 (简体注)')
})

