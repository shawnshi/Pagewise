import assert from 'node:assert/strict'
import { test } from 'node:test'
import { queryLibraryBooks, isClassificationComplete } from '../src/services/libraryQuery.ts'
import {
  saveLibrarySession,
  loadLibrarySession,
  clearLibrarySession,
  sanitizeSessionState,
  createFilterDraft,
  commitFilterDraft,
  setSessionStorageAdapter,
  DEFAULT_LIBRARY_SESSION,
} from '../src/services/librarySession.ts'

const makeBook = (id, patch = {}) => ({
  id,
  title: `Book ${id}`,
  author: `Author ${id}`,
  tags: [],
  format: 'epub',
  addedAt: 100,
  ...patch,
})

test('classification complete check respects 1 category and 2-3 topics', () => {
  assert.equal(isClassificationComplete(null), false)
  assert.equal(isClassificationComplete(undefined), false)
  assert.equal(isClassificationComplete({ category: null, topics: [] }), false)
  // Has category, but only 1 topic -> incomplete
  assert.equal(isClassificationComplete({
    category: { value: 'computing-ai' },
    topics: [{ value: '人工智能' }],
  }), false)
  // Has category and 2 topics -> complete
  assert.equal(isClassificationComplete({
    category: { value: 'computing-ai' },
    topics: [{ value: '人工智能' }, { value: '机器学习' }],
  }), true)
  // Has category, 3 topics, and optional feature -> complete
  assert.equal(isClassificationComplete({
    category: { value: 'computing-ai' },
    topics: [{ value: '人工智能' }, { value: '机器学习' }, { value: '深度学习' }],
    feature: { value: '大模型实践' },
  }), true)
  // No category even with 2 topics -> incomplete
  assert.equal(isClassificationComplete({
    category: null,
    topics: [{ value: '人工智能' }, { value: '机器学习' }],
  }), false)
})

test('filtering by category and classificationStatus (complete / incomplete / unclassified)', () => {
  const books = [
    makeBook('b-comp', {
      classification: {
        category: { value: 'computing-ai' },
        topics: [{ value: '人工智能' }, { value: '机器学习' }],
      },
    }),
    makeBook('b-incomp', {
      classification: {
        category: { value: 'computing-ai' },
        topics: [{ value: '人工智能' }],
      },
    }),
    makeBook('b-hist', {
      classification: {
        category: { value: 'history-archaeology' },
        topics: [{ value: '中国古代史' }, { value: '唐代' }],
      },
    }),
    makeBook('b-none', {
      tags: ['legacy-tag'],
    }),
  ]

  // Category filter
  assert.deepEqual(
    queryLibraryBooks(books, { category: 'computing-ai' }).items.map(b => b.id),
    ['b-comp', 'b-incomp'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { category: 'history-archaeology' }).items.map(b => b.id),
    ['b-hist'],
  )

  // classificationStatus complete
  assert.deepEqual(
    queryLibraryBooks(books, { classificationStatus: 'complete' }).items.map(b => b.id),
    ['b-comp', 'b-hist'],
  )

  // classificationStatus incomplete
  assert.deepEqual(
    queryLibraryBooks(books, { classificationStatus: 'incomplete' }).items.map(b => b.id),
    ['b-incomp'],
  )

  // classificationStatus unclassified
  assert.deepEqual(
    queryLibraryBooks(books, { classificationStatus: 'unclassified' }).items.map(b => b.id),
    ['b-none'],
  )

  // category + complete intersection
  assert.deepEqual(
    queryLibraryBooks(books, { category: 'computing-ai', classificationStatus: 'complete' }).items.map(b => b.id),
    ['b-comp'],
  )
})

test('unknown vs false distinction is strictly preserved for textbook and ancientText facets', () => {
  const books = [
    makeBook('b-tb-true', {
      classification: {
        category: { value: 'science-mathematics' },
        topics: [{ value: '数学' }, { value: '高等数学' }],
        facets: { textbook: true, ancientText: false },
      },
    }),
    makeBook('b-tb-false', {
      classification: {
        category: { value: 'science-mathematics' },
        topics: [{ value: '科普' }, { value: '物理' }],
        facets: { textbook: false, ancientText: false },
      },
    }),
    makeBook('b-tb-unknown', {
      classification: {
        category: { value: 'science-mathematics' },
        topics: [{ value: '数学' }, { value: '代数' }],
        facets: { ancientText: true }, // textbook is omitted => unknown!
      },
    }),
    makeBook('b-ancient-unknown', {
      classification: {
        category: { value: 'literature-language' },
        topics: [{ value: '小说' }, { value: '现代文学' }],
        facets: {}, // both omitted => unknown!
      },
    }),
  ]

  // Filter textbook === true
  assert.deepEqual(
    queryLibraryBooks(books, { textbook: true }).items.map(b => b.id),
    ['b-tb-true'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { textbook: 'true' }).items.map(b => b.id),
    ['b-tb-true'],
  )

  // Filter textbook === false: MUST NOT match b-tb-unknown or b-ancient-unknown!
  assert.deepEqual(
    queryLibraryBooks(books, { textbook: false }).items.map(b => b.id),
    ['b-tb-false'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { textbook: 'false' }).items.map(b => b.id),
    ['b-tb-false'],
  )

  // Filter textbook === 'unknown': matches books where facets.textbook is omitted
  assert.deepEqual(
    queryLibraryBooks(books, { textbook: 'unknown' }).items.map(b => b.id),
    ['b-ancient-unknown', 'b-tb-unknown'],
  )

  // Ancient text facet: true, false, unknown
  assert.deepEqual(
    queryLibraryBooks(books, { ancientText: true }).items.map(b => b.id),
    ['b-tb-unknown'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { ancientText: false }).items.map(b => b.id),
    ['b-tb-false', 'b-tb-true'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { ancientText: 'unknown' }).items.map(b => b.id),
    ['b-ancient-unknown'],
  )
})

test('filtering by audience, workCountry, and workPeriod facets', () => {
  const books = [
    makeBook('b1', {
      classification: {
        category: { value: 'literature-language' },
        topics: [{ value: '诗歌' }, { value: '古典诗词' }],
        facets: { audience: '儿童', workCountry: '中国', workPeriod: '唐代' },
      },
    }),
    makeBook('b2', {
      classification: {
        category: { value: 'literature-language' },
        topics: [{ value: '小说' }, { value: '科幻' }],
        facets: { audience: '青年', workCountry: '英国', workPeriod: '20世纪' },
      },
    }),
  ]

  assert.deepEqual(
    queryLibraryBooks(books, { audience: '儿童' }).items.map(b => b.id),
    ['b1'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { workCountry: '英国' }).items.map(b => b.id),
    ['b2'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { workPeriod: '唐代' }).items.map(b => b.id),
    ['b1'],
  )
  assert.deepEqual(
    queryLibraryBooks(books, { workCountry: '中国', workPeriod: '20世纪' }).items.map(b => b.id),
    [],
  )
})

test('librarySession preserves classification facet state across save, load, draft, and commit', () => {
  clearLibrarySession()

  saveLibrarySession({
    categoryFilter: 'computing-ai',
    classificationStatusFilter: 'complete',
    audienceFilter: '学术',
    textbookFilter: 'false',
    ancientTextFilter: 'unknown',
    workCountryFilter: '中国',
    workPeriodFilter: '当代',
  })

  const loaded = loadLibrarySession()
  assert.equal(loaded.categoryFilter, 'computing-ai')
  assert.equal(loaded.classificationStatusFilter, 'complete')
  assert.equal(loaded.audienceFilter, '学术')
  assert.equal(loaded.textbookFilter, 'false')
  assert.equal(loaded.ancientTextFilter, 'unknown')
  assert.equal(loaded.workCountryFilter, '中国')
  assert.equal(loaded.workPeriodFilter, '当代')

  // Transactional draft
  const draft = createFilterDraft(loaded)
  assert.equal(draft.category, 'computing-ai')
  assert.equal(draft.classificationStatus, 'complete')
  assert.equal(draft.audience, '学术')
  assert.equal(draft.textbook, 'false')
  assert.equal(draft.ancientText, 'unknown')

  // Modify draft
  draft.category = 'history-archaeology'
  draft.textbook = 'true'
  draft.ancientText = 'true'

  // Original session still unaffected before commit
  assert.equal(loadLibrarySession().categoryFilter, 'computing-ai')

  // Commit draft
  const committed = commitFilterDraft(draft)
  assert.equal(committed.categoryFilter, 'history-archaeology')
  assert.equal(committed.textbookFilter, 'true')
  assert.equal(committed.ancientTextFilter, 'true')

  saveLibrarySession(committed)
  const reloaded = loadLibrarySession()
  assert.equal(reloaded.categoryFilter, 'history-archaeology')
  assert.equal(reloaded.textbookFilter, 'true')

  clearLibrarySession()
})

test('sanitizeSessionState sanitizes unknown or corrupted facet values', () => {
  const corrupt = {
    categoryFilter: 12345,
    classificationStatusFilter: 'not-a-valid-status',
    textbookFilter: 'maybe',
    ancientTextFilter: 999,
    audienceFilter: null,
    workCountryFilter: ['invalid'],
    workPeriodFilter: {},
  }
  const clean = sanitizeSessionState(corrupt)
  assert.equal(clean.categoryFilter, '')
  assert.equal(clean.classificationStatusFilter, '')
  assert.equal(clean.textbookFilter, '')
  assert.equal(clean.ancientTextFilter, '')
  assert.equal(clean.audienceFilter, '')
  assert.equal(clean.workCountryFilter, '')
  assert.equal(clean.workPeriodFilter, '')
})
