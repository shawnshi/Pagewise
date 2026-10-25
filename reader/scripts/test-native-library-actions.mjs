import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !extname(specifier)) { const p = fileURLToPath(new URL(specifier + '.ts', context.parentURL)); if (existsSync(p)) return next(pathToFileURL(p).href, context) }
  return next(specifier, context)
} })
const { createNativeLibraryActions } = await import('../src/services/nativeLibraryActions.ts')
const { DEFAULT_LIBRARY_SESSION } = await import('../src/services/librarySession.ts')
const { queryLibraryBooks } = await import('../src/services/libraryQuery.ts')
const { createClassification, BOOK_CATEGORIES } = await import('../src/services/bookClassification.ts')
const book = (id, extra = {}) => ({ id, title: 'Book ' + id, author: 'Author', format: 'epub', fileName: id + '.epub', tags: ['legacy'], addedAt: 1, hasCover: false, readingSeconds: 40, ...extra })
function fixture(initial) {
  let books = initial ?? Array.from({ length: 65 }, (_, i) => book(String(i), { title: 'Book ' + String(i).padStart(3, '0'), addedAt: i + 1, format: i % 2 ? 'epub' : 'pdf', language: i % 3 ? 'en' : 'zh', tags: i % 2 ? ['odd'] : ['even'] }))
  let session = structuredClone(DEFAULT_LIBRARY_SESSION), now = 100, token = 0
  const calls = [], flags = { readFail: '', writeFail: '' }
  const storage = {
    async listBooks() { return structuredClone(books) },
    async getBook(id) { calls.push(['read', id]); if (id === flags.readFail) throw new Error('synthetic database failure'); return structuredClone(books.find(b => b.id === id)) },
    async updateBookClassifications(updates, legacy = []) {
      for (const item of [...updates, ...legacy]) {
        calls.push(['write', item.id]); if (item.id === flags.writeFail) throw new Error('synthetic lost acknowledgement')
        const current = books.find(b => b.id === item.id)
        if (item.classification) current.classification = structuredClone(item.classification)
        else { assert.deepEqual(current.tags, item.expectedTags); current.tags = [...item.tags] }
      }
    },
  }
  const actions = createNativeLibraryActions({ storage: async () => storage, session: () => structuredClone(session), saveSession: p => { calls.push(['session']); session = { ...session, ...structuredClone(p) } }, settingsReady: async () => {}, now: () => now, token: () => 'token-' + ++token })
  return { actions, calls, flags, storage, get books() { return books }, replace: value => { books = value }, setSession: value => { session = { ...session, ...value } }, advance: () => { now += 300001 } }
}

test('opening one book resolves its full navigation order in one session command', async () => {
  const f = fixture(Array.from({ length: 2243 }, (_, i) => book(String(i))))
  const page = await f.actions.libraryPage({ mode: 'library', session: { sortBy: 'title', page: 1, pageSize: 12 } })
  const expected = []
  for (let offset = 0; offset < 2243; offset += 500) expected.push(...(await f.actions.librarySelectionPage({ token: page.selectionToken, offset, limit: 500 })).ids)
  const id = page.items[0].id
  const saved = await f.actions.librarySessionSave({ selectionToken: page.selectionToken, session: { lastViewedBookId: id, returnedFromReader: true, orderedBookIds: [] } })
  assert.deepEqual(saved.session.orderedBookIds, expected)
  assert.equal(saved.session.lastViewedBookId, id)
  assert.equal(f.calls.filter(c => c[0] === 'session').length, 1)
})

test('stale or foreign selection cannot save a partial/new navigation order', async () => {
  const f = fixture()
  const page = await f.actions.libraryPage({ mode: 'library' })
  await assert.rejects(() => f.actions.librarySessionSave({ selectionToken: page.selectionToken, session: { lastViewedBookId: 'foreign' } }), e => e.code === 'book_not_found')
  f.advance()
  await assert.rejects(() => f.actions.librarySessionSave({ selectionToken: page.selectionToken, session: { lastViewedBookId: page.items[0].id } }), e => e.code === 'stale_library_selection')
  assert.equal(f.calls.filter(c => c[0] === 'session').length, 0)
})
test('book detail uses the canonical status/format policy without inferring completion from progress', async () => {
  const f = fixture([book('legacy', { progress: 1 }), book('history', { lastReadAt: 10 })])
  assert.equal((await f.actions.libraryBookInfo({ bookId: 'legacy' })).effectiveReadingStatus, 'unmarked')
  assert.equal((await f.actions.libraryBookInfo({ bookId: 'history' })).effectiveReadingStatus, 'reading')
  await assert.rejects(f.actions.libraryBookInfo({ bookId: 'missing' }), /book_not_found/)
})
test('library page placeholders carry publisher and publication date without changing canonical metadata', async () => {
  const original = book('meta', { publisher: 'Synthetic Publisher', publicationDate: '2021-03-04', readingStatus: 'reading', lastReadAt: 10 })
  const f = fixture([original])
  for (const mode of ['library', 'reading']) {
    const page = await f.actions.libraryPage({ mode, tab: 'reading', session: { page: 1 } })
    assert.equal(page.items[0].publisher, 'Synthetic Publisher')
    assert.equal(page.items[0].publicationDate, '2021-03-04')
    assert.equal(page.items[0].id, 'meta')
  }
  assert.equal(f.books[0].publisher, original.publisher)
  assert.equal(f.books[0].publicationDate, original.publicationDate)
  assert.equal(f.calls.filter(call => call[0] === 'session' || call[0] === 'write').length, 0, 'Display metadata must not save session or books')
  const missing = fixture([book('missing')])
  const result = await missing.actions.libraryPage({ mode: 'library', session: {} })
  assert.equal(result.items[0].publisher, '')
  assert.equal(result.items[0].publicationDate, '')
})

test('global canonical query sort/filter precede pagination; no second Kotlin interpretation', async () => {
  const f = fixture(), r = await f.actions.libraryPage({ mode: 'library', session: { keyword: 'Book', formatFilter: 'epub', languageFilter: 'en', sortBy: 'title', page: 2, pageSize: 12 } })
  const oracle = queryLibraryBooks(f.books, { search: 'Book', formats: ['epub'], languages: ['en'], sortBy: 'title', pinnedFirst: true, page: 2, pageSize: 12 })
  assert.equal(r.total, oracle.total); assert.deepEqual(r.items.map(b => b.id), oracle.items.map(b => b.id)); assert.equal(r.allCount, 65)
  assert.equal(r.items.some(b => b.fileAvailability === 'available'), false, 'unknown legacy availability must not become verified available')
})
test('all six reading tabs retain exact explicit/legacy status, recent predicate and addedAt fallback ordering', async () => {
  const f = fixture([book('a', { readingStatus: 'reading', lastReadAt: 10 }), book('b', { lastReadAt: 50 }), book('c', { progress: 1 }), book('d', { readingStatus: 'paused', lastReadAt: 60 }), book('e', { readingStatus: 'finished', lastReadAt: 70 }), book('f', { readingStatus: 'abandoned', lastReadAt: 80 }), book('g', { readingStatus: 'wanted', addedAt: 100 }), book('h', { readingStatus: 'wanted', lastReadAt: 20 })])
  for (const [tab, ids] of Object.entries({ reading: ['b', 'a'], recent: ['f', 'e', 'd', 'b', 'h', 'a'], wanted: ['g', 'h'], paused: ['d'], finished: ['e'], abandoned: ['f'] })) {
    const r = await f.actions.libraryPage({ mode: 'reading', tab }); assert.deepEqual(r.items.map(b => b.id), ids); assert.equal(r.tabCounts[tab], ids.length)
  }
})
test('taxonomy/category/topic/feature/uncategorized filters and facet counts use existing domain contracts', async () => {
  const c = createClassification(['legacy']); c.category = { value: BOOK_CATEGORIES[0].id, source: 'manual', locked: true }; c.topics = [{ value: 'alpha', source: 'manual', locked: false }, { value: 'beta', source: 'manual', locked: false }]; c.facets = { ...c.facets, audience: '大众', textbook: true, ancientText: false, workCountry: '中国', workPeriod: '当代' }
  const f = fixture([book('classified', { classification: c, tags: ['alpha', 'beta'] }), book('legacy')])
  const r = await f.actions.libraryPage({ mode: 'library', session: { categoryFilter: BOOK_CATEGORIES[0].id, textbookFilter: 'true', workCountryFilter: '中国', classificationStatusFilter: 'complete' } })
  assert.equal(r.total, 1); assert.equal(r.items[0].id, 'classified')
  assert.equal(r.facets.categoryFilter.find(x => x.value === '__unclassified__').count, 1)
  assert.equal(r.facets.tagFilter.find(x => x.value === 'alpha').count, 1)
})
test('stable result-order and last-viewed book restoration survive reader updates', async () => {
  const f = fixture(); const ids = [...f.books].reverse().map(b => b.id)
  f.setSession({ sortBy: 'recent', orderedBookIds: ids, lastViewedBookId: '40', page: 1, pageSize: 12, returnedFromReader: true })
  f.books.find(b => b.id === '0').lastReadAt = 99999
  const r = await f.actions.libraryPage({ mode: 'library', restore: true })
  assert.equal(r.page, 3); assert.ok(r.items.some(b => b.id === '40'))
  assert.equal(f.calls.some(x => x[0] === 'session'), false, 'readonly page does not silently rewrite session')
})
for (const mode of ['single', 'batch']) test(`remembered open/back order is invalidated only after explicit ${mode} pin/unpin`, async () => {
  const f = fixture([book('a', { addedAt: 3 }), book('b', { addedAt: 2 }), book('c', { addedAt: 1 })])
  f.setSession({ orderedBookIds: ['a', 'b', 'c'], lastViewedBookId: 'b', keyword: 'Book', pageSize: 12, returnedFromReader: true })
  assert.deepEqual((await f.actions.libraryPage({ mode: 'library', restore: true })).items.map(b => b.id), ['a', 'b', 'c'])
  // Synthetic confirmed CAS outcomes; the real repository CAS is separately exercised by the host suite.
  for (const b of f.books) if (b.id === 'c' || (mode === 'batch' && b.id === 'b')) b.pinnedAt = 100
  await f.actions.librarySessionSave({ session: { orderedBookIds: [] } })
  const pinned = await f.actions.libraryPage({ mode: 'library' })
  assert.equal(pinned.items[0].id, mode === 'batch' ? 'b' : 'c')
  assert.equal(pinned.session.lastViewedBookId, 'b'); assert.equal(pinned.session.keyword, 'Book')
  for (const b of f.books) delete b.pinnedAt
  await f.actions.librarySessionSave({ session: { orderedBookIds: [] } })
  assert.deepEqual((await f.actions.libraryPage({ mode: 'library' })).items.map(b => b.id), ['a', 'b', 'c'])
})
test('selection snapshot pages all filtered IDs across >128 books and is immutable when catalog changes', async () => {
  const f = fixture(Array.from({ length: 300 }, (_, i) => book('b' + i, { addedAt: i })))
  const r = await f.actions.libraryPage({ mode: 'library' })
  f.replace([book('new')])
  const a = await f.actions.librarySelectionPage({ token: r.selectionToken, offset: 0, limit: 256 }), b = await f.actions.librarySelectionPage({ token: r.selectionToken, offset: 256, limit: 256 })
  assert.equal(a.total, 300); assert.equal(new Set([...a.ids, ...b.ids]).size, 300); assert.equal([...a.ids, ...b.ids].includes('new'), false)
  f.advance(); await assert.rejects(f.actions.librarySelectionPage({ token: r.selectionToken, offset: 0, limit: 256 }), /stale_library_selection/)
})
for (const session of [{ sortBy: 'bad' }, { tagFilter: [1] }, { page: -1 }, { pageSize: 0 }, { statusFilter: 'bad' }, { returnedFromReader: 'yes' }, { classificationStatusFilter: ['complete'] }, { aiApiKey: 'out-of-scope' }]) test(`reject invalid UI session edit ${JSON.stringify(session)} without save`, async () => {
  const f = fixture(); await assert.rejects(f.actions.librarySessionSave({ session }), /invalid_payload/); assert.equal(f.calls.length, 0)
})
test('UI session uses the same existing owner and does not claim a durable book/settings commit', async () => {
  const f = fixture(); const r = await f.actions.librarySessionSave({ session: { pageSize: 24 } })
  assert.equal(r.session.pageSize, 24); assert.match(r.durability, /not-a-book-settings-receipt/)
})
const item = b => ({ id: b.id, expectedTags: b.tags, expectedRevision: b.classification?.revision ?? 0 })
test('batch legacy tags preserve counters/files/IDs and reject structured or stale snapshots', async () => {
  const f = fixture([book('a'), book('b', { classification: createClassification([]) }), book('c')])
  const r = await f.actions.libraryTagBatch({ operation: 'add', tags: ['manual'], items: [item(f.books[0]), item(f.books[1]), { ...item(f.books[2]), expectedTags: ['stale'] }] })
  assert.equal(r.succeeded, 1); assert.equal(r.failed, 2); assert.equal(r.outcomeUnknown, false)
  assert.deepEqual(f.books[0].tags, ['legacy', 'manual']); assert.equal(f.books[0].readingSeconds, 40); assert.equal(f.books[0].fileName, 'a.epub')
  assert.equal(r.results[1].code, 'classification_required'); assert.equal(r.results[2].code, 'book_conflict')
})
test('batch unknown write halts later IDs and reports committed prefix instead of rollback/fake failure', async () => {
  const f = fixture([book('a'), book('b'), book('c')]); f.flags.writeFail = 'b'
  const r = await f.actions.libraryTagBatch({ operation: 'add', tags: ['manual'], items: f.books.map(item) })
  assert.equal(r.succeeded, 1); assert.equal(r.outcomeUnknown, true); assert.equal(r.results[2].code, 'not_run')
  assert.equal(f.calls.some(x => x[0] === 'read' && x[1] === 'c'), false)
})
test('batch read failure after a committed prefix preserves truthful partial results', async () => {
  const f = fixture([book('a'), book('b'), book('c')]); f.flags.readFail = 'b'
  const r = await f.actions.libraryTagBatch({ operation: 'add', tags: ['manual'], items: f.books.map(item) })
  assert.equal(r.succeeded, 1); assert.equal(r.outcomeUnknown, false); assert.equal(r.results[1].code, 'book_read_failed'); assert.equal(r.results[2].code, 'not_run')
})
test('clearing classification requires explicit locked-change consent and uses original CAS owner', async () => {
  const c = createClassification(['legacy']); const f = fixture([book('a', { classification: c })])
  const payload = { operation: 'clear', items: [item(f.books[0])] }
  await assert.rejects(f.actions.libraryTagBatch(payload), /confirmation_required/)
  const r = await f.actions.libraryTagBatch({ ...payload, confirmLockedChanges: true }); assert.equal(r.succeeded, 1); assert.equal(f.books[0].classification.revision, c.revision + 1)
})
