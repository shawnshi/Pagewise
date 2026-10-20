import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import {
  queryLibraryBooks,
  filterLibraryBooks,
  compareLibraryBooks,
  prepareLibraryQuery,
  getCachedBookNorm,
} from '../src/services/libraryQuery.ts'

const book = (id, patch = {}) => ({ id, title: 'Same', author: 'Same', tags: [], format: 'epub', addedAt: 0, ...patch })
const ids = result => result.items.map(item => item.id)
const corpus = Object.freeze(Array.from({ length: 4000 }, (_, i) => Object.freeze(book(String(i).padStart(4, '0'), {
  title: `Book ${i}`, author: `Author ${i % 20}`, tags: Object.freeze([`tag${i % 4}`, 'shared']),
  format: i % 2 ? 'epub' : 'mobi', language: i % 2 ? 'en' : 'zh', addedAt: i,
  lastReadAt: i % 17, progress: (i % 101) / 100,
}))))

test('4000 immutable metadata items: pagination, identity, legacy formats and host timing', () => {
  const before = JSON.stringify(corpus)
  const start = performance.now()
  const result = queryLibraryBooks(corpus)
  console.log(`host-only ${process.platform}/${process.arch} ${process.version}: 4000 metadata query ${(performance.now() - start).toFixed(2)}ms (not device evidence)`)
  assert.equal(result.total, 4000)
  assert.equal(result.pageSize, 12)
  assert.equal(result.totalPages, 334)
  assert.equal(result.items.length, 12)
  assert.ok(result.items.every(item => corpus.includes(item)))
  assert.equal(queryLibraryBooks(corpus, { formats: ['mobi'] }).total, 2000)
  assert.equal(JSON.stringify(corpus), before)
  const all = Array.from({ length: 334 }, (_, page) => queryLibraryBooks(corpus, { page: page + 1 }).items).flat()
  assert.equal(all.length, 4000)
  assert.equal(new Set(all.map(item => item.id)).size, 4000)
})

test('NFKC, case, whitespace tokens AND across metadata fields, not descriptions or other books', () => {
  const books = [book('a', { title: 'ＦＯＯ Café', author: 'ALICE', tags: ['医学'] }),
    book('b', { title: 'foo', description: 'alice 医学' }), book('c', { author: 'alice' })]
  assert.deepEqual(ids(queryLibraryBooks(books, { search: '  foo\u3000ALICE  医学 ' })), ['a'])
  assert.deepEqual(ids(queryLibraryBooks(books, { search: 'cafe\u0301' })), ['a'])
  assert.equal(queryLibraryBooks(books, { search: 'description-only' }).total, 0)
})

test('tag AND/OR and exact normalized format/language metadata intersection', () => {
  const books = [book('a', { tags: ['Ａ', 'B'], language: 'ＥＮ' }), book('b', { tags: ['a'], language: 'en-US' }),
    book('c', { tags: ['B'], format: 'cbr' }), book('d')]
  assert.deepEqual(ids(queryLibraryBooks(books, { tags: ['a', 'b'] })), ['a'])
  assert.deepEqual(ids(queryLibraryBooks(books, { tags: ['a', 'b'], tagMode: 'or' })), ['a', 'b', 'c'])
  assert.deepEqual(ids(queryLibraryBooks(books, { languages: ['en'], formats: ['ＥＰＵＢ'] })), ['a'])
  assert.deepEqual(ids(queryLibraryBooks(books, { formats: ['cbr'] })), ['c'])
  assert.equal(queryLibraryBooks(books, { languages: ['fr'] }).total, 0)
})

test('PERF-REVIEW-003: normalized-empty facets retain the frozen query semantics', () => {
  const books = [book('empty'), book('classified', {
    classification: { category: { value: 'Science' }, facets: { audience: 'adult', workCountry: 'CN', workPeriod: 'modern' } },
  })]
  for (const facet of ['formats', 'languages', 'statuses']) {
    for (const value of [[], [' '], ['\u3000', '\t']]) {
      assert.deepEqual(ids(queryLibraryBooks(books, { [facet]: value })), ['classified', 'empty'], `${facet}: ${JSON.stringify(value)}`)
    }
  }
  for (const facet of ['category', 'audience', 'workCountry', 'workPeriod']) {
    for (const value of [undefined, '']) {
      assert.deepEqual(ids(queryLibraryBooks(books, { [facet]: value })), ['classified', 'empty'])
    }
    for (const value of [' ', '\u3000', '\t']) {
      assert.deepEqual(ids(queryLibraryBooks(books, { [facet]: value })), ['empty'], `${facet}: normalized-empty predicate`)
    }
  }
})

test('all five sorts, both directions, deterministic ID tie and stable duplicate IDs', () => {
  for (const [sortBy, key] of [['lastRead', 'lastReadAt'], ['addedAt', 'addedAt'], ['title', 'title'], ['author', 'author'], ['progress', 'progress']]) {
    const text = key === 'title' || key === 'author'
    const books = [book('c', { [key]: text ? 'b' : 2 }), book('b', { [key]: text ? 'a' : 1 }), book('a', { [key]: text ? 'a' : 1 })]
    assert.deepEqual(ids(queryLibraryBooks(books, { sortBy, direction: 'asc' })), ['a', 'b', 'c'])
    assert.deepEqual(ids(queryLibraryBooks(books, { sortBy, direction: 'desc' })), ['c', 'a', 'b'])
    assert.deepEqual(ids(queryLibraryBooks([...books].reverse(), { sortBy })), ids(queryLibraryBooks(books, { sortBy })))
  }
  const duplicates = [book('a', { extra: 1 }), book('a', { extra: 2 })]
  assert.deepEqual(queryLibraryBooks(duplicates).items, duplicates)
  assert.deepEqual(ids(queryLibraryBooks([book('b', { lastReadAt: NaN }), book('a')])), ['a', 'b'])
})

test('filters run over all metadata before page clamping, including records beyond the first page', () => {
  const result = queryLibraryBooks(corpus, {
    search: 'Book 3999', tags: ['shared', 'tag3'], tagMode: 'and',
    formats: ['epub'], languages: ['en'], pinnedFirst: true, page: 9999, pageSize: 24,
  })
  assert.deepEqual(ids(result), ['3999'])
  assert.equal(result.total, 1)
  assert.equal(result.totalPages, 1)
  assert.equal(result.page, 1)
  assert.equal(queryLibraryBooks(corpus, { search: 'Book 3999', languages: ['zh'] }).total, 0)
})

test('library pinned priority applies before pagination and never reverses with direction', () => {
  const books = [book('a', { addedAt: 100 }), book('b', { pinnedAt: 10 }), book('c', { pinnedAt: 20 }), book('d', { lastReadAt: 50 })]
  for (const direction of ['asc', 'desc']) {
    assert.deepEqual(ids(queryLibraryBooks(books, { pinnedFirst: true, direction, pageSize: 2 })), ['c', 'b'])
  }
  assert.deepEqual(ids(queryLibraryBooks(books, { pinnedFirst: true, page: 2, pageSize: 2 })), ['d', 'a'])
  assert.deepEqual(ids(queryLibraryBooks(books, { pinnedFirst: true, search: 'missing' })), [])
  assert.deepEqual(ids(queryLibraryBooks(books, { pinnedFirst: true, formats: ['epub'], pageSize: 24 })), ['c', 'b', 'd', 'a'])
  assert.deepEqual(ids(queryLibraryBooks(books, { pageSize: 24 })), ['d', 'a', 'b', 'c'])
})

test('pagination correction, empty results, no invented completion state', () => {
  assert.deepEqual(queryLibraryBooks([]), { items: [], total: 0, page: 1, pageSize: 12, totalPages: 0 })
  assert.equal(queryLibraryBooks(corpus, { page: Infinity, pageSize: NaN }).page, 1)
  assert.equal(queryLibraryBooks(corpus, { page: -3, pageSize: 0 }).pageSize, 1)
  assert.equal(queryLibraryBooks(corpus, { page: 9999 }).page, 334)
  assert.equal(queryLibraryBooks(corpus, { page: 2.9, pageSize: 10.9 }).page, 2)
  assert.equal(queryLibraryBooks(corpus, { pageSize: Number.MAX_VALUE }).items.length, 4000)
  const completeProgress = book('a', { progress: 1 })
  assert.equal(queryLibraryBooks([completeProgress]).items[0], completeProgress)
  assert.equal('readState' in completeProgress, false)
})

test('modular filter, compare, and prepared query composition', () => {
  const books = [
    book('b', { title: 'Book B', author: 'Author 2', addedAt: 2 }),
    book('a', { title: 'Book A', author: 'Author 1', addedAt: 1 }),
  ]
  const options = { search: 'Book', sortBy: 'title', direction: 'asc' }
  const prep = prepareLibraryQuery(options)
  assert.equal(prep.words[0], 'book')
  assert.equal(prep.sortBy, 'title')
  assert.equal(prep.direction, 'asc')

  const filtered = filterLibraryBooks(books, options)
  assert.equal(filtered.length, 2)

  const compared = compareLibraryBooks(books[0], books[1], options)
  assert.ok(compared > 0, 'Book B should sort after Book A in asc')

  const cachedA = getCachedBookNorm(books[1])
  assert.equal(cachedA.normalizedTitle, 'book a')
  assert.equal(cachedA.normalizedAuthor, 'author 1')
})
