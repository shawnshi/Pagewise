import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bookFileProblem, matchesAvailability, visibleBookTopics } from '../src/services/bookAvailability.ts'
import { queryLibraryBooks } from '../src/services/libraryQuery.ts'
import { queryLibrarySession, sanitizeSessionState, createFilterDraft, commitFilterDraft, setSessionStorageAdapter, saveLibrarySession, loadLibrarySession } from '../src/services/librarySession.ts'

const book = (id, patch = {}) => ({ id, title: id, author: '', format: 'epub', tags: [], addedAt: 1, ...patch })

test('file availability is independent of reading status; unknown is not verified available', () => {
  const rows = [book('unknown', { lastReadAt: 10 }), book('ok', { fileAvailability: 'available' }), book('lost', { fileAvailability: 'missing', readingStatus: 'reading' }), book('denied', { fileAvailability: 'permission-denied' })]
  assert.deepEqual(queryLibraryBooks(rows, { availability: 'unavailable' }).items.map(x => x.id), ['denied', 'lost'])
  assert.deepEqual(queryLibraryBooks(rows, { availability: 'available' }).items.map(x => x.id), ['ok'])
  assert.deepEqual(queryLibraryBooks(rows, { availability: 'missing', statuses: ['reading'] }).items.map(x => x.id), ['lost'])
  assert.equal(bookFileProblem(rows[0]), undefined)
  assert.equal(matchesAvailability(rows[0], 'available'), false)
  assert.equal(rows[2].readingStatus, 'reading')
})

test('two visible topics do not truncate full tags or third-topic filtering', () => {
  const row = book('a', { tags: ['文学', '主题一', '主题二', '主题三', '传记'], classification: { category: { value: 'literature' }, topics: [{ value: '主题一' }, { value: '主题二' }, { value: '主题三' }], feature: { value: '传记' }, legacyTags: [] } })
  const before = structuredClone(row)
  assert.deepEqual(visibleBookTopics(row), ['主题一', '主题二'])
  assert.equal(queryLibraryBooks([row], { tags: ['主题三'], category: 'literature' }).total, 1)
  assert.equal(queryLibraryBooks([row], { tags: ['传记'] }).total, 1)
  assert.deepEqual(row, before)
  assert.deepEqual(visibleBookTopics(book('legacy', { tags: ['old1', 'old2', 'old3'] })), ['old1', 'old2'])
})

test('availability composes with category, topic, format, language and reading filters', () => {
  const row = book('target', { fileAvailability: 'missing', readingStatus: 'paused', language: 'zh', tags: ['主题一', '主题二'], classification: { category: { value: 'literature' } } })
  const options = { availability: 'missing', category: 'literature', tags: ['主题二'], formats: ['epub'], languages: ['zh'], statuses: ['paused'] }
  assert.equal(queryLibraryBooks([row], options).total, 1)
  assert.equal(queryLibraryBooks([row], { ...options, languages: ['en'] }).total, 0)
  assert.equal(queryLibraryBooks([row], { ...options, availability: 'permission-denied' }).total, 0)
})

test('filter draft isolates availability until Apply and retains other predicates', () => {
  const initial = sanitizeSessionState({ availabilityFilter: 'missing', statusFilter: 'paused', tagFilter: ['full'], tagMode: 'and' })
  const draft = createFilterDraft(initial)
  draft.availability = 'permission-denied'
  draft.tags.push('third')
  assert.equal(initial.availabilityFilter, 'missing')
  assert.deepEqual(initial.tagFilter, ['full'])
  const applied = commitFilterDraft(draft)
  assert.equal(applied.availabilityFilter, 'permission-denied')
  assert.equal(applied.statusFilter, 'paused')
  assert.deepEqual(applied.tagFilter, ['full', 'third'])
})

test('browse snapshot remains stable despite reading updates; a new visit can re-sort', () => {
  const rows = [book('a', { lastReadAt: 2 }), book('b', { lastReadAt: 1 })]
  const snapshot = queryLibraryBooks(rows).items.map(x => x.id)
  rows[1].lastReadAt = 3
  assert.deepEqual(queryLibrarySession(rows, {}, snapshot).items.map(x => x.id), ['a', 'b'])
  assert.deepEqual(queryLibrarySession(rows, {}, []).items.map(x => x.id), ['b', 'a'])
  assert.deepEqual(queryLibrarySession(rows, { sortBy: 'title' }, []).items.map(x => x.id), ['a', 'b'])
})

test('session upgrades safely and retains a bounded return snapshot across navigation', () => {
  const data = new Map()
  setSessionStorageAdapter({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) })
  try {
    const previous = sanitizeSessionState({ keyword: 'original', page: 2, pageSize: 24, orderedBookIds: ['a', 'b'] })
    saveLibrarySession({ availabilityFilter: 'unavailable', unavailableReturn: previous, returnedFromReader: true })
    const state = loadLibrarySession()
    assert.equal(state.returnedFromReader, true)
    assert.equal(state.unavailableReturn.keyword, 'original')
    assert.equal(state.unavailableReturn.pageSize, 24)
    const nested = sanitizeSessionState({ unavailableReturn: { unavailableReturn: previous } })
    assert.equal(nested.unavailableReturn.unavailableReturn, undefined)
    assert.equal(sanitizeSessionState({ availabilityFilter: 'invalid', returnedFromReader: 'true' }).availabilityFilter, '')
    assert.equal(sanitizeSessionState({ returnedFromReader: 'true' }).returnedFromReader, false)
    saveLibrarySession({ unavailableReturn: undefined, returnedFromReader: false })
    assert.equal(loadLibrarySession().unavailableReturn, undefined)
  } finally { setSessionStorageAdapter(null) }
})
