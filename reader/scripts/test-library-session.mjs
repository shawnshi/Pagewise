import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('Node environment uses memory adapter by default and never touches global localStorage', () => {
  // Ensure global localStorage is not touched or defined
  assert.equal(typeof globalThis.window, 'undefined')
  clearLibrarySession()

  saveLibrarySession({ keyword: 'NodeTest', page: 3 })
  const loaded = loadLibrarySession()
  assert.equal(loaded.keyword, 'NodeTest')
  assert.equal(loaded.page, 3)

  clearLibrarySession()
  assert.equal(loadLibrarySession().keyword, '')
})

test('custom storage adapter injection for sandboxed testing', () => {
  const mockStorage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null },
    setItem(k, v) { this.data.set(k, v) },
    removeItem(k) { this.data.delete(k) },
  }
  setSessionStorageAdapter(mockStorage)

  saveLibrarySession({ keyword: 'custom-adapter-test', sortBy: 'title', page: 2, pageSize: 24 })
  assert.ok(mockStorage.data.size > 0, 'mockStorage received serialized session')

  const restored = loadLibrarySession()
  assert.equal(restored.keyword, 'custom-adapter-test')
  assert.equal(restored.sortBy, 'title')
  assert.equal(restored.page, 2)
  assert.equal(restored.pageSize, 24)

  setSessionStorageAdapter(null)
})

test('corrupted or malformed session state sanitizes gracefully to safe defaults', () => {
  const corruptInputs = [
    null,
    undefined,
    'not an object',
    12345,
    { page: -10, pageSize: 999, sortBy: 'invalid-sort', tagFilter: 'not an array' },
    { keyword: 12345, statusFilter: 'invalid-status', tagMode: 'unknown' },
    { page: NaN, tagFilter: [123, null, 'validTag'] },
  ]

  for (const input of corruptInputs) {
    const clean = sanitizeSessionState(input)
    assert.ok(clean.page >= 1, `page must be >= 1, got ${clean.page}`)
    assert.ok(clean.pageSize >= 1, `pageSize must be positive integer, got ${clean.pageSize}`)
    assert.ok(['recent', 'added', 'title', 'author', 'progress'].includes(clean.sortBy), `sortBy must be valid, got ${clean.sortBy}`)
    assert.ok(Array.isArray(clean.tagFilter), 'tagFilter must be array')
    assert.ok(clean.tagFilter.every(t => typeof t === 'string'), 'tagFilter items must be strings')
    assert.ok(['unread', 'reading', 'finished', 'paused', ''].includes(clean.statusFilter), `statusFilter must be valid or empty, got ${clean.statusFilter}`)
    assert.ok(clean.tagMode === 'and' || clean.tagMode === 'or')
  }
})

test('transactional filter draft: cancel discards draft, commit applies changes', () => {
  const activeState = {
    tagFilter: ['TagA', 'TagB'],
    tagMode: 'and',
    formatFilter: 'epub',
    languageFilter: 'zh',
    statusFilter: 'reading',
    sortBy: 'recent',
  }

  // 1. Create draft
  const draft = createFilterDraft(activeState)
  assert.deepEqual(draft.tags, ['TagA', 'TagB'])
  assert.equal(draft.tagMode, 'and')
  assert.equal(draft.format, 'epub')

  // 2. Modify draft
  draft.tags.push('NewTag')
  draft.format = 'pdf'
  draft.status = 'finished'
  draft.sortBy = 'title'

  // If user cancels: activeState was never modified!
  assert.deepEqual(activeState.tagFilter, ['TagA', 'TagB'], 'activeState must remain untouched on cancel')
  assert.equal(activeState.formatFilter, 'epub')
  assert.equal(activeState.statusFilter, 'reading')

  // 3. User commits: commitFilterDraft applies draft modifications
  const committed = commitFilterDraft(draft)
  assert.deepEqual(committed.tagFilter, ['TagA', 'TagB', 'NewTag'])
  assert.equal(committed.formatFilter, 'pdf')
  assert.equal(committed.statusFilter, 'finished')
  assert.equal(committed.sortBy, 'title')
})

test('session retains query, page and visible item identity', () => {
  const mockStorage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null },
    setItem(k, v) { this.data.set(k, v) },
    removeItem(k) { this.data.delete(k) },
  }
  setSessionStorageAdapter(mockStorage)

  saveLibrarySession({
    keyword: 'philosophy',
    sortBy: 'author',
    tagFilter: ['重点', '已校对'],
    tagMode: 'or',
    formatFilter: 'epub',
    statusFilter: 'reading',
    page: 4,
    pageSize: 12,
    activeBooklistId: 'list-123',
    lastViewedBookId: 'book-789',
  })

  const restored = loadLibrarySession()
  assert.equal(restored.keyword, 'philosophy')
  assert.equal(restored.sortBy, 'author')
  assert.deepEqual(restored.tagFilter, ['重点', '已校对'])
  assert.equal(restored.tagMode, 'or')
  assert.equal(restored.formatFilter, 'epub')
  assert.equal(restored.statusFilter, 'reading')
  assert.equal(restored.page, 4)
  assert.equal(restored.activeBooklistId, 'list-123')
  assert.equal(restored.lastViewedBookId, 'book-789')

  setSessionStorageAdapter(null)
})
