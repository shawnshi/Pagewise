import assert from 'node:assert/strict'
import test from 'node:test'
import * as query from '../src/services/libraryQuery.ts'
import { DEFAULT_LIBRARY_SESSION, sanitizeSessionState, queryLibrarySession } from '../src/services/librarySession.ts'

const book = (id, patch = {}) => ({ id, title: id, author: 'Synthetic', format: 'epub', tags: [], addedAt: 1, ...patch })
const ids = (books, options) => query.queryLibraryBooks(books, { pageSize: 100, ...options }).items.map(item => item.id)
const classification = value => ({ version: 1, revision: 1, category: value ? { value, locked: false, source: 'manual' } : null, topics: [], feature: null, facets: {}, legacyTags: [] })

test('fresh and invalid sessions default to first-added ordering, valid choices survive', () => {
  assert.equal(DEFAULT_LIBRARY_SESSION.sortBy, 'added')
  assert.equal(sanitizeSessionState(null).sortBy, 'added')
  assert.equal(sanitizeSessionState({ sortBy: 'invalid' }).sortBy, 'added')
  assert.equal(sanitizeSessionState({ sortBy: 'recent' }).sortBy, 'recent')
  assert.equal(sanitizeSessionState({ sortBy: 'published' }).sortBy, 'published')
  assert.equal(sanitizeSessionState({ sortBy: 'published', unavailableReturn: { sortBy: 'published' } }).unavailableReturn.sortBy, 'published')
})

test('recently added uses original addedAt, never file modification, publication or read time', () => {
  const rows = [book('old', { addedAt: 10, lastReadAt: 999, publicationDate: '2099', modifiedAt: 9999 }), book('new', { addedAt: 20, lastReadAt: 1, publicationDate: '1900' })]
  assert.deepEqual(ids(rows, { sortBy: 'addedAt' }), ['new', 'old'])
})

test('recently read places never-read books last instead of substituting addedAt', () => {
  const rows = [book('never', { addedAt: 1000 }), book('read-old', { lastReadAt: 10 }), book('read-new', { lastReadAt: 20 }), book('invalid', { lastReadAt: NaN, addedAt: 2000 }), book('zero', { lastReadAt: 0, addedAt: 3000 })]
  assert.deepEqual(ids(rows, { sortBy: 'lastRead' }).slice(0, 2), ['read-new', 'read-old'])
})

test('publication ordering keeps partial precision, validates calendar dates and leaves unknown last', () => {
  const rows = [book('a-missing'), book('b-invalid', { publicationDate: '2025-02-29' }), book('c-year', { publicationDate: '2024' }), book('d-month', { publicationDate: '2024-02' }), book('e-leap', { publicationDate: '2024-02-29' }), book('f-older', { publicationDate: '2023-12-31' }), book('g-time', { publicationDate: '2025-01-01T00:00:00Z' })]
  assert.deepEqual(ids(rows, { sortBy: 'publicationDate' }), ['g-time', 'e-leap', 'd-month', 'c-year', 'f-older', 'a-missing', 'b-invalid'])
  assert.deepEqual(ids(rows, { sortBy: 'publicationDate', direction: 'asc' }), ['f-older', 'c-year', 'd-month', 'e-leap', 'g-time', 'a-missing', 'b-invalid'])
})

for (const date of ['2025-13', '2025-00', '2025-04-31', '1900-02-29', '2024-02-30', 'not a date', '2025年3月', '2025T12:00:00Z', '2025-01-01T99:00:00Z', '0000']) {
  test(`invalid publication date is not interpreted as a newer book: ${date}`, () => {
    assert.deepEqual(ids([book('a-invalid', { publicationDate: date, addedAt: 999 }), book('z-known', { publicationDate: '1901' })], { sortBy: 'publicationDate' }), ['z-known', 'a-invalid'])
  })
}

test('full publication timestamps retain time within the same calendar day', () => {
  const rows = [book('a-early', { publicationDate: '2024-03-01T00:00:00Z' }), book('z-late', { publicationDate: '2024-03-01T12:00:00Z' })]
  assert.deepEqual(ids(rows, { sortBy: 'publicationDate' }), ['z-late', 'a-early'])
})

test('full publication timestamps compare their actual timezone-aware instant', () => {
  const rows = [book('a-zone', { publicationDate: '2025-01-01T00:00:00+14:00' }), book('z-utc', { publicationDate: '2024-12-31T23:00:00Z' })]
  assert.deepEqual(ids(rows, { sortBy: 'publicationDate' }), ['z-utc', 'a-zone'])
})

test('publication norm cache updates on the same object; pins and equal-date IDs remain stable', () => {
  const changing = book('a', { publicationDate: '2000' }), other = book('b', { publicationDate: '2020' })
  assert.deepEqual(ids([changing, other], { sortBy: 'publicationDate' }), ['b', 'a'])
  changing.publicationDate = '2030'
  assert.deepEqual(ids([changing, other], { sortBy: 'publicationDate' }), ['a', 'b'])
  assert.deepEqual(ids([other, changing, book('pinned', { pinnedAt: 10 })], { sortBy: 'publicationDate', pinnedFirst: true }), ['pinned', 'a', 'b'])
  assert.deepEqual(ids([book('z', { publicationDate: '2020' }), book('a', { publicationDate: '2020' })], { sortBy: 'publicationDate' }), ['a', 'z'])
})

test('category counts include only populated normalized categories and a real unclassified bucket', () => {
  assert.equal(typeof query.countLibraryCategories, 'function')
  const rows = [book('a', { classification: classification('computing-ai') }), book('b', { classification: classification(' Computing-AI ') }), book('c'), book('d', { classification: classification('custom-category') })]
  const counts = query.countLibraryCategories(rows)
  assert.equal(counts.get('computing-ai'), 2)
  assert.equal(counts.get(query.UNCLASSIFIED_CATEGORY), 1)
  assert.equal(counts.get('custom-category'), 1)
  assert.equal(counts.has('medicine-health'), false)
  assert.equal(query.countLibraryCategories([]).size, 0)
})

test('category filters combine with search and recent/publication order without mutating source', () => {
  const rows = [book('cat-old', { title: 'Needle old', classification: classification('computing-ai'), publicationDate: '2000' }), book('cat-new', { title: 'Needle new', classification: classification('computing-ai'), publicationDate: '2020' }), book('other', { title: 'Needle other', classification: classification('medicine-health') }), book('none', { title: 'Needle none' })]
  const before = JSON.stringify(rows)
  assert.deepEqual(ids(rows, { search: 'Needle', category: 'computing-ai', sortBy: 'publicationDate' }), ['cat-new', 'cat-old'])
  assert.deepEqual(ids(rows, { category: query.UNCLASSIFIED_CATEGORY ?? '__unclassified__' }), ['none'])
  assert.equal(JSON.stringify(rows), before)
  assert.deepEqual(queryLibrarySession(rows, { sortBy: 'publicationDate', category: 'computing-ai' }).items.map(x => x.id), ['cat-new', 'cat-old'])
})
