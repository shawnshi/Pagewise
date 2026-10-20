import assert from 'node:assert/strict'
import { test } from 'node:test'
import { queryLibraryBooks } from '../src/services/libraryQuery.ts'
import {
  saveLibrarySession,
  loadLibrarySession,
  setSessionStorageAdapter,
  createFilterDraft,
  commitFilterDraft,
  SORT_LABELS,
} from '../src/services/librarySession.ts'
import { resolveReadingStatus } from '../src/services/readingStatus.ts'

const makeBook = (id, patch = {}) => ({
  id,
  title: `Title ${id}`,
  author: `Author ${id}`,
  format: 'epub',
  tags: [],
  addedAt: 1000,
  ...patch,
})

test('status filter: matches explicit readingStatus correctly', () => {
  const books = [
    makeBook('b-unread', { readingStatus: 'unread' }),
    makeBook('b-reading', { readingStatus: 'reading' }),
    makeBook('b-finished', { readingStatus: 'finished' }),
    makeBook('b-paused', { readingStatus: 'paused' }),
    makeBook('b-legacy-none', { progress: 0 }),
    makeBook('b-legacy-full', { progress: 1 }),
  ]

  const unreadRes = queryLibraryBooks(books, { statuses: ['unread'] })
  assert.deepEqual(unreadRes.items.map(b => b.id), ['b-legacy-full', 'b-legacy-none', 'b-unread'])

  const finishedRes = queryLibraryBooks(books, { statuses: ['finished'] })
  assert.deepEqual(finishedRes.items.map(b => b.id), ['b-finished'])

  const pausedRes = queryLibraryBooks(books, { statuses: ['paused'] })
  assert.deepEqual(pausedRes.items.map(b => b.id), ['b-paused'])
})

test('status filter: legacy books with positive lastReadAt match reading, but progress alone never matches unread/finished', () => {
  const books = [
    makeBook('b-legacy-reading', { lastReadAt: 5000 }),
    makeBook('b-legacy-zero-progress', { progress: 0 }),
    makeBook('b-legacy-full-progress', { progress: 1 }),
    makeBook('b-explicit-unread', { readingStatus: 'unread', progress: 0 }),
  ]

  // Querying reading: legacy with positive lastReadAt matches
  const readingRes = queryLibraryBooks(books, { statuses: ['reading'] })
  assert.deepEqual(readingRes.items.map(b => b.id), ['b-legacy-reading'])

  // Querying unread: only explicit unread matches, b-legacy-zero-progress must NOT match!
  const unreadRes = queryLibraryBooks(books, { statuses: ['unread'] })
  assert.deepEqual(unreadRes.items.map(b => b.id), ['b-explicit-unread', 'b-legacy-full-progress', 'b-legacy-zero-progress'])

  // Querying finished: b-legacy-full-progress must NOT match!
  const finishedRes = queryLibraryBooks(books, { statuses: ['finished'] })
  assert.deepEqual(finishedRes.items.map(b => b.id), [])
})

test('empty result handling: page=1, totalPages=0, total=0, items=[]', () => {
  const books = [makeBook('b1', { title: 'Vue Guide' })]
  const result = queryLibraryBooks(books, { search: 'NonExistentXYZ' })
  assert.equal(result.total, 0)
  assert.equal(result.totalPages, 0)
  assert.equal(result.page, 1)
  assert.deepEqual(result.items, [])
})

test('query and session round-trip restoration', () => {
  const mockStorage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null },
    setItem(k, v) { this.data.set(k, v) },
    removeItem(k) { this.data.delete(k) },
  }
  setSessionStorageAdapter(mockStorage)

  // 10 books
  const books = Array.from({ length: 10 }, (_, i) => makeBook(String(i + 1).padStart(2, '0'), {
    title: `Book ${i + 1}`,
    author: i % 2 === 0 ? 'Author Even' : 'Author Odd',
    format: i % 3 === 0 ? 'pdf' : 'epub',
    tags: i % 2 === 0 ? ['Philosophy'] : ['Science'],
    addedAt: i * 10,
    lastReadAt: i * 20,
  }))

  // Save session at page 2, filter by Philosophy
  saveLibrarySession({
    keyword: '',
    sortBy: 'added',
    tagFilter: ['Philosophy'],
    tagMode: 'and',
    page: 2,
    pageSize: 2,
    lastViewedBookId: '06',
  })

  // Restore session
  const session = loadLibrarySession()
  assert.equal(session.page, 2)
  assert.deepEqual(session.tagFilter, ['Philosophy'])
  assert.equal(session.lastViewedBookId, '06')

  // Execute query with restored session options
  const queryRes = queryLibraryBooks(books, {
    tags: session.tagFilter,
    tagMode: session.tagMode,
    sortBy: session.sortBy === 'recent' ? 'lastRead' : session.sortBy === 'added' ? 'addedAt' : session.sortBy,
    page: session.page,
    pageSize: session.pageSize,
  })

  assert.equal(queryRes.total, 5) // 5 Philosophy books
  assert.equal(queryRes.page, 2)
  assert.equal(queryRes.pageSize, 2)
  assert.equal(queryRes.items.length, 2)

  setSessionStorageAdapter(null)
})

test('transactional filter draft lifecycle in query workflow', () => {
  const currentFilters = {
    tagFilter: ['Fiction'],
    tagMode: 'and',
    formatFilter: 'epub',
    languageFilter: 'en',
    statusFilter: 'reading',
    sortBy: 'recent',
  }

  // User opens filter modal -> draft created
  const draft = createFilterDraft(currentFilters)

  // User changes things in draft
  draft.tags = ['History']
  draft.format = 'mobi'
  draft.status = 'unread'
  draft.sortBy = 'title'

  // User cancels: original filters unchanged
  assert.deepEqual(currentFilters.tagFilter, ['Fiction'])
  assert.equal(currentFilters.formatFilter, 'epub')

  // User opens again and applies (commits)
  const committed = commitFilterDraft(draft)
  assert.deepEqual(committed.tagFilter, ['History'])
  assert.equal(committed.formatFilter, 'mobi')
  assert.equal(committed.statusFilter, 'unmarked')
  assert.equal(committed.sortBy, 'title')
})

test('visible sort names mapping covers all valid sort values', () => {
  const expectedLabels = {
    recent: '最近阅读',
    added: '最近加入',
    published: '出版时间',
    title: '书名',
    author: '作者',
    progress: '阅读进度',
  }
  assert.deepEqual(Object.keys(SORT_LABELS).sort(), Object.keys(expectedLabels).sort())
  for (const [key, label] of Object.entries(expectedLabels)) {
    assert.equal(SORT_LABELS[key], label)
  }
})

test('query does not mutate input dataset', () => {
  const original = Object.freeze([
    Object.freeze(makeBook('1', { readingStatus: 'reading' })),
    Object.freeze(makeBook('2', { lastReadAt: 100 })),
  ])
  const copy = JSON.stringify(original)
  queryLibraryBooks(original, { statuses: ['reading'], sortBy: 'title' })
  assert.equal(JSON.stringify(original), copy)
})
