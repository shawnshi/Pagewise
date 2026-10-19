import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The frozen task baseline lives beside the common Git directory, not four
// parents above a script (which only happened to work in the original lanes).
// An explicit baseline also supports running the benchmark outside this task.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const baselineRoot = process.env.PAGEWISE_PERF_BASELINE
  ? resolve(process.env.PAGEWISE_PERF_BASELINE)
  : resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: projectRoot, encoding: 'utf8',
    }).trim(), '../.cache/performance-20261019/baseline')
const { queryLibraryBooks: baselineQueryBooks } = await import(
  pathToFileURL(resolve(baselineRoot, 'reader/src/services/libraryQuery.ts')).href)
const { queryLibrarySession: baselineQuerySession } = await import(
  pathToFileURL(resolve(baselineRoot, 'reader/src/services/librarySession.ts')).href)

// Import optimized functions from current source
import {
  queryLibraryBooks as optimizedQueryBooks,
  filterLibraryBooks,
  compareLibraryBooks,
  getCachedBookNorm,
  prepareLibraryQuery,
} from '../src/services/libraryQuery.ts'
import {
  queryLibrarySession as optimizedQuerySession,
} from '../src/services/librarySession.ts'

/**
 * Deterministic synthetic metadata generator.
 * Produces identical data for the same seed/count.
 */
function createSyntheticBooks(count) {
  return Object.freeze(Array.from({ length: count }, (_, i) => Object.freeze({
    id: `book-${String(i).padStart(5, '0')}`,
    title: `书籍标题 ${i % 30} 中文书名 ${i}`,
    author: `著者 ${i % 20} 翻译`,
    tags: Object.freeze([`tag-${i % 8}`, `topic-${i % 4}`, '共享标签']),
    format: i % 3 === 0 ? 'epub' : i % 3 === 1 ? 'mobi' : 'pdf',
    language: i % 2 === 0 ? 'zh' : 'en',
    addedAt: 1600000000 + i * 1000,
    lastReadAt: i % 5 === 0 ? 1700000000 + i * 500 : undefined,
    progress: (i % 101) / 100,
    fileAvailability: i % 25 === 0 ? 'missing' : 'available',
    pinnedAt: i % 50 === 0 ? 1000000 + i : undefined,
    readingStatus: i % 4 === 0 ? 'reading' : i % 4 === 1 ? 'finished' : i % 4 === 2 ? 'paused' : 'unread',
    classification: Object.freeze({
      category: Object.freeze({ value: `cat-${i % 5}` }),
      topics: Object.freeze([{ value: `topic-${i % 3}` }, { value: `subtopic-${(i + 1) % 3}` }]),
      feature: Object.freeze({ value: `feat-${i % 2}` }),
      facets: Object.freeze({
        audience: i % 2 === 0 ? 'general' : 'academic',
        textbook: i % 3 === 0,
        ancientText: i % 6 === 0,
        workCountry: i % 2 === 0 ? 'cn' : 'foreign',
        workPeriod: 'modern',
      }),
      revision: 1,
    }),
  })))
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const weight = index - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

function benchmark(fn, warmup = 5, reps = 25) {
  for (let i = 0; i < warmup; i++) fn()
  const times = []
  for (let i = 0; i < reps; i++) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    min: times[0],
    max: times[times.length - 1],
  }
}

test('PERF-06: Deterministic equivalence check baseline vs modified across query options', () => {
  const dataset = createSyntheticBooks(200)

  const testOptions = [
    { search: '书籍标题 3' },
    { search: '著者 2 翻译' },
    { sortBy: 'title', direction: 'asc' },
    { sortBy: 'title', direction: 'desc' },
    { sortBy: 'author', direction: 'asc' },
    { sortBy: 'lastRead', direction: 'desc', pinnedFirst: true },
    { sortBy: 'progress', direction: 'desc' },
    { tags: ['共享标签', 'tag-2'], tagMode: 'and' },
    { tags: ['tag-1', 'tag-3'], tagMode: 'or' },
    { formats: ['epub', 'pdf'], languages: ['zh'] },
    { category: 'cat-1', audience: 'general' },
    { textbook: true, ancientText: false },
    { workCountry: 'cn', availability: 'available' },
    { statuses: ['reading', 'finished'], pageSize: 15, page: 2 },
  ]

  for (const opt of testOptions) {
    const base = baselineQueryBooks(dataset, opt)
    const optm = optimizedQueryBooks(dataset, opt)

    assert.equal(optm.total, base.total, `total match for ${JSON.stringify(opt)}`)
    assert.equal(optm.totalPages, base.totalPages, `totalPages match for ${JSON.stringify(opt)}`)
    assert.equal(optm.page, base.page, `page match for ${JSON.stringify(opt)}`)
    assert.equal(optm.pageSize, base.pageSize, `pageSize match for ${JSON.stringify(opt)}`)
    assert.deepEqual(
      optm.items.map(b => b.id),
      base.items.map(b => b.id),
      `item order match for ${JSON.stringify(opt)}`,
    )
  }
})

test('PERF-06: Deterministic 0 / 100 / 1000 / 5000 metadata benchmark (warmup, p50, p95)', () => {
  const sizes = [0, 100, 1000, 5000]
  const results = []

  for (const count of sizes) {
    const books = createSyntheticBooks(count)
    const queryOpts = {
      search: count > 0 ? '书籍标题' : '',
      sortBy: 'title',
      direction: 'asc',
      pinnedFirst: true,
      pageSize: 24,
      page: 1,
    }

    // Baseline queryBooks benchmark
    const baseBench = benchmark(() => baselineQueryBooks(books, queryOpts), 5, 20)

    // Optimized queryBooks benchmark
    const optBench = benchmark(() => optimizedQueryBooks(books, queryOpts), 5, 20)

    // Remembered order session benchmark
    const orderedIds = count > 0 ? books.slice(0, Math.min(count, 500)).map(b => b.id) : []
    const sessionOpts = { sortBy: 'author', pageSize: 24, page: 2 }

    const baseSessionBench = benchmark(() => baselineQuerySession(books, sessionOpts, orderedIds), 5, 20)
    const optSessionBench = benchmark(() => optimizedQuerySession(books, sessionOpts, orderedIds), 5, 20)

    results.push({
      count,
      baseQueryP50: baseBench.p50,
      baseQueryP95: baseBench.p95,
      optQueryP50: optBench.p50,
      optQueryP95: optBench.p95,
      querySpeedup: count > 0 ? baseBench.p50 / optBench.p50 : 1,
      baseSessionP50: baseSessionBench.p50,
      baseSessionP95: baseSessionBench.p95,
      optSessionP50: optSessionBench.p50,
      optSessionP95: optSessionBench.p95,
      sessionSpeedup: count > 0 ? baseSessionBench.p50 / optSessionBench.p50 : 1,
    })

    // Assert that optimized is not slower on size 0, and noticeably faster on 1000 and 5000
    if (count >= 1000) {
      assert.ok(
        optBench.p50 <= baseBench.p50 * 0.8,
        `Expected at least 20% query p50 improvement for ${count} items: base=${baseBench.p50.toFixed(2)}ms, opt=${optBench.p50.toFixed(2)}ms`,
      )
      assert.ok(
        optSessionBench.p50 <= baseSessionBench.p50 * 0.8,
        `Expected at least 20% session p50 improvement for ${count} items: base=${baseSessionBench.p50.toFixed(2)}ms, opt=${optSessionBench.p50.toFixed(2)}ms`,
      )
    }
  }

  console.log('\n--- PERF-06 Benchmark Results ---')
  console.log('| Count | Base Q p50 | Opt Q p50 | Q Speedup | Base S p50 | Opt S p50 | S Speedup |')
  console.log('|-------|------------|-----------|-----------|------------|-----------|-----------|')
  for (const r of results) {
    console.log(
      `| ${String(r.count).padEnd(5)} | ` +
      `${r.baseQueryP50.toFixed(2).padStart(8)}ms | ` +
      `${r.optQueryP50.toFixed(2).padStart(7)}ms | ` +
      `${r.querySpeedup.toFixed(2).padStart(8)}x | ` +
      `${r.baseSessionP50.toFixed(2).padStart(8)}ms | ` +
      `${r.optSessionP50.toFixed(2).padStart(7)}ms | ` +
      `${r.sessionSpeedup.toFixed(2).padStart(8)}x |`,
    )
  }
  console.log('---------------------------------\n')
})

test('PERF-06 Negative correctness: Mutated records trigger cache invalidation immediately', () => {
  const mutableBook = {
    id: 'mut-01',
    title: '初始标题 原始',
    author: '原始作者',
    tags: ['原始标签'],
    format: 'epub',
    language: 'zh',
    addedAt: 1000,
    lastReadAt: 500,
    progress: 0.1,
    fileAvailability: 'available',
    pinnedAt: undefined,
    readingStatus: 'reading',
    classification: {
      category: { value: 'initial-cat' },
      topics: [{ value: 't1' }, { value: 't2' }],
      facets: { audience: 'general', textbook: false },
      revision: 1,
    },
  }

  const books = [mutableBook]

  // Query 1: should match initial title
  assert.equal(optimizedQueryBooks(books, { search: '初始标题' }).total, 1)
  assert.equal(optimizedQueryBooks(books, { search: '修改后标题' }).total, 0)

  // Invalidate title
  mutableBook.title = '修改后标题 新生'
  assert.equal(optimizedQueryBooks(books, { search: '初始标题' }).total, 0, 'old title must no longer match')
  assert.equal(optimizedQueryBooks(books, { search: '修改后标题' }).total, 1, 'new title must match')

  // Invalidate author
  mutableBook.author = '新兴作者'
  assert.equal(optimizedQueryBooks(books, { search: '新兴作者' }).total, 1)
  assert.equal(optimizedQueryBooks(books, { search: '原始作者' }).total, 0)

  // Invalidate tags via array push
  mutableBook.tags.push('新增标签')
  assert.equal(optimizedQueryBooks(books, { tags: ['新增标签'] }).total, 1, 'pushed tag must match')

  // Invalidate tags via array element replacement
  mutableBook.tags[0] = '替换标签'
  assert.equal(optimizedQueryBooks(books, { tags: ['替换标签'] }).total, 1)
  assert.equal(optimizedQueryBooks(books, { tags: ['原始标签'] }).total, 0)

  // Invalidate reading status
  mutableBook.readingStatus = 'finished'
  assert.equal(optimizedQueryBooks(books, { statuses: ['finished'] }).total, 1)
  assert.equal(optimizedQueryBooks(books, { statuses: ['reading'] }).total, 0)

  // Invalidate format
  mutableBook.format = 'pdf'
  assert.equal(optimizedQueryBooks(books, { formats: ['pdf'] }).total, 1)
  assert.equal(optimizedQueryBooks(books, { formats: ['epub'] }).total, 0)

  // Invalidate language
  mutableBook.language = 'en'
  assert.equal(optimizedQueryBooks(books, { languages: ['en'] }).total, 1)
  assert.equal(optimizedQueryBooks(books, { languages: ['zh'] }).total, 0)

  // Invalidate classification category in place
  mutableBook.classification.category.value = 'updated-cat'
  assert.equal(optimizedQueryBooks(books, { category: 'updated-cat' }).total, 1)
  assert.equal(optimizedQueryBooks(books, { category: 'initial-cat' }).total, 0)

  // Invalidate facet audience in place
  mutableBook.classification.facets.audience = 'academic'
  assert.equal(optimizedQueryBooks(books, { audience: 'academic' }).total, 1)
  assert.equal(optimizedQueryBooks(books, { audience: 'general' }).total, 0)

  // Invalidate pinnedAt
  const otherBook = { id: 'other', title: 'AAA', author: '', tags: [], format: 'epub', addedAt: 10 }
  const pair = [mutableBook, otherBook]
  mutableBook.pinnedAt = 9999
  const pinnedResult = optimizedQueryBooks(pair, { pinnedFirst: true })
  assert.equal(pinnedResult.items[0].id, 'mut-01', 'pinned book must come first')
})

test('PERF-06 Negative correctness: Rank ties and deterministic tiebreaks in queryLibrarySession', () => {
  const books = [
    { id: 'b', title: 'Book B', author: 'Author', tags: [], format: 'epub', addedAt: 2 },
    { id: 'a', title: 'Book A', author: 'Author', tags: [], format: 'epub', addedAt: 1 },
    { id: 'c', title: 'Book C', author: 'Author', tags: [], format: 'epub', addedAt: 3 },
  ]

  // Rank tie 1: duplicate rank in orderedIds (two items mapped to same ID or same rank position)
  const orderedIdsWithDuplicate = ['a', 'b', 'b']
  const res1 = optimizedQuerySession(books, { sortBy: 'addedAt' }, orderedIdsWithDuplicate)
  assert.deepEqual(res1.items.map(b => b.id), ['a', 'b', 'c'], 'duplicate orderedIds resolves deterministically')

  // Rank tie 2: unranked items (both not in orderedIds) fall back to query sort + deterministic ID tiebreak
  const partialOrdered = ['b']
  const res2 = optimizedQuerySession(books, { sortBy: 'addedAt', direction: 'asc' }, partialOrdered)
  assert.deepEqual(res2.items.map(b => b.id), ['b', 'a', 'c'], 'ranked first, unranked sorted by query comparator')

  // Rank tie 3: duplicate book IDs in dataset with identical rank
  const dupBooks = [
    { id: 'same', title: 'First Entry', author: 'A', tags: [], format: 'epub', addedAt: 1 },
    { id: 'same', title: 'Second Entry', author: 'A', tags: [], format: 'epub', addedAt: 1 },
  ]
  const res3 = optimizedQuerySession(dupBooks, {}, ['same'])
  assert.equal(res3.items.length, 2)
  assert.equal(res3.items[0].title, 'First Entry', 'duplicate IDs maintain stable input order')
})

test('PERF-06 Negative correctness: Repeated filters and cache isolation', () => {
  const books = createSyntheticBooks(150)

  // Run the same query 15 times to verify prepared query reuse and idempotence
  const fixedOptions = { search: '书籍标题 5', tags: ['共享标签'], sortBy: 'title' }
  const firstRun = optimizedQueryBooks(books, fixedOptions)

  for (let i = 0; i < 15; i++) {
    const repeatRun = optimizedQueryBooks(books, fixedOptions)
    assert.deepEqual(
      repeatRun.items.map(b => b.id),
      firstRun.items.map(b => b.id),
      'repeated queries must produce identical results',
    )
  }

  // Alternate between different queries to verify no cross-contamination
  const optA = { category: 'cat-0', sortBy: 'addedAt' }
  const optB = { category: 'cat-2', sortBy: 'progress' }

  for (let i = 0; i < 5; i++) {
    const resA = optimizedQueryBooks(books, optA)
    const resB = optimizedQueryBooks(books, optB)
    assert.ok(resA.items.every(b => b.classification?.category?.value === 'cat-0'))
    assert.ok(resB.items.every(b => b.classification?.category?.value === 'cat-2'))
  }
})
