import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate'
import { parse, stringify } from 'yaml'
import { createHarness } from './test-book-tag-storage.mjs'
import { READING_STATUSES, normalizeReadingStatus, resolveReadingStatus } from '../src/services/readingStatus.ts'
import { queryLibraryBooks } from '../src/services/libraryQuery.ts'
import { createClassification, parseClassification } from '../src/services/bookClassification.ts'

const statuses = ['unmarked', 'wanted', 'reading', 'paused', 'finished', 'abandoned']

test('six statuses preserve explicit intent and normalize only legacy unread', () => {
  assert.deepEqual(READING_STATUSES, statuses)
  for (const status of statuses) {
    assert.equal(normalizeReadingStatus(status), status)
    assert.equal(resolveReadingStatus({ readingStatus: status, lastReadAt: 100, progress: 1 }).effective, status)
  }
  assert.equal(normalizeReadingStatus('unread'), 'unmarked')
  assert.equal(normalizeReadingStatus('invalid'), undefined)
  assert.equal(resolveReadingStatus({ progress: 1 }).effective, undefined)
})

test('unmarked filter includes legacy unset records without inventing intent or completion', () => {
  const base = { title: 'Synthetic', author: 'Fixture', format: 'txt', tags: [], addedAt: 1 }
  const books = [{ ...base, id: 'unset' }, { ...base, id: 'progress-only', progress: 1 }, { ...base, id: 'recent', lastReadAt: 100 }, { ...base, id: 'explicit-clear', readingStatus: 'unmarked', lastReadAt: 100 }, { ...base, id: 'abandoned', readingStatus: 'abandoned', lastReadAt: 100 }]
  const before = JSON.stringify(books)
  assert.deepEqual(queryLibraryBooks(books, { statuses: ['unmarked'] }).items.map(book => book.id).sort(), ['explicit-clear', 'progress-only', 'unset'])
  assert.deepEqual(queryLibraryBooks(books, { statuses: ['wanted'] }).items, [])
  assert.deepEqual(queryLibraryBooks(books, { statuses: ['reading'] }).items.map(book => book.id), ['recent'])
  assert.equal(JSON.stringify(books), before)
})

test('RC-DATA-01 baseline classification labels remain readable in topics and features', () => {
  const c = createClassification(['original'])
  c.category = { value: 'science-mathematics', locked: true, source: 'manual' }
  c.topics = [{ value: '天文学', locked: false, source: 'manual' }, { value: '观测方法', locked: false, source: 'manual' }]
  for (const value of ['未标记', '想读', '暂缓', '弃读']) {
    assert.doesNotThrow(() => parseClassification({ ...c, topics: [{ value, locked: true, source: 'manual' }, c.topics[1]] }))
    assert.doesNotThrow(() => parseClassification({ ...c, feature: { value, locked: true, source: 'manual' } }))
  }
})

for (const backend of ['DexieStorage', 'TauriStorage']) test(`${backend}: six-state persistence, legacy migration, explicit clearing and tag preservation`, async () => {
  const h = await createHarness()
  try {
    const result = await h.page.evaluate(async ({ backend, statuses }) => {
      const { normalizeReadingStatus, resolveReadingStatus } = await import('/src/services/readingStatus.ts')
      const { queryLibraryBooks } = await import('/src/services/libraryQuery.ts')
      const { sanitizeSessionState, createFilterDraft, commitFilterDraft } = await import('/src/services/librarySession.ts')
      const storage = new window.modules[backend]()
      window.statusStore = storage
      await storage.init()
      const id = await storage.addBook({ title: 'Synthetic six statuses', author: 'Fixture', format: 'txt', fileName: 'status.txt', tags: ['old'], addedAt: 1, lastReadAt: 100, progress: 1, readingStatus: 'unmarked' }, new Blob(['Synthetic']))
      const draft = window.modules.createClassification(['old'])
      draft.category = { value: 'science-mathematics', locked: true, source: 'manual' }
      draft.topics = ['天文学', '观测方法'].map(value => ({ value, locked: false, source: 'manual' }))
      await window.modules.saveBookClassification(storage, await storage.getBook(id), draft)
      const original = await storage.getBook(id)
      const rows = []
      for (const status of statuses) {
        await storage.updateBook(id, { readingStatus: status })
        const saved = await storage.getBook(id)
        const listed = await storage.listBooks()
        const selected = queryLibraryBooks(listed, { statuses: [status] })
        const session = sanitizeSessionState({ statusFilter: status })
        const committed = commitFilterDraft(createFilterDraft(session))
        rows.push({ expected: status, stored: saved.readingStatus, effective: resolveReadingStatus(saved).effective, matches: selected.total, restored: committed.statusFilter, tagsIntact: JSON.stringify(saved.classification) === JSON.stringify(original.classification) && JSON.stringify(saved.tags) === JSON.stringify(original.tags) })
      }
      let rejected = false
      try { await storage.updateBook(id, { readingStatus: 'unread' }) } catch { rejected = true }
      if (backend === 'DexieStorage') await storage.db.books.update(id, { readingStatus: 'unread' })
      return { id, rows, rejected, legacySession: sanitizeSessionState({ statusFilter: 'unread' }).statusFilter, legacyNormalization: normalizeReadingStatus('unread') }
    }, { backend, statuses })
    assert.equal(result.rejected, true)
    assert.equal(result.legacySession, 'unmarked')
    assert.equal(result.legacyNormalization, 'unmarked')
    for (const row of result.rows) assert.deepEqual(row, { expected: row.expected, stored: row.expected, effective: row.expected, matches: 1, restored: row.expected, tagsIntact: true })
    if (backend === 'TauriStorage') h.db.prepare('UPDATE books SET reading_status = ? WHERE id = ?').run('unread', result.id)
    assert.equal(await h.page.evaluate(async id => (await window.statusStore.getBook(id)).readingStatus, result.id), 'unmarked')
    await h.page.evaluate(async id => window.statusStore.updateBook(id, { readingStatus: 'abandoned' }), result.id)
    if (backend === 'TauriStorage') h.reopenDatabase()
    else await h.page.evaluate(() => window.statusStore.db.close())
    const reopened = await h.page.evaluate(async ({ backend, id }) => {
      const storage = new window.modules[backend]()
      await storage.init()
      const book = await storage.getBook(id)
      return { status: book.readingStatus, locked: book.classification.category.locked, legacy: book.classification.legacyTags }
    }, { backend, id: result.id })
    assert.deepEqual(reopened, { status: 'abandoned', locked: true, legacy: ['old'] })
    const preserved = await h.page.evaluate(async backend => {
      const storage = new window.modules[backend]()
      await storage.init()
      const result = []
      for (const value of ['未标记', '想读', '暂缓', '弃读']) {
        const classification = window.modules.createClassification(['original'])
        classification.category = { value: 'science-mathematics', locked: true, source: 'manual' }
        classification.topics = [{ value, locked: true, source: 'manual' }, { value: '观测方法', locked: false, source: 'manual' }]
        const id = await storage.addBook({ title: 'Synthetic prior classification', author: 'Fixture', format: 'txt', fileName: `${value}.txt`, tags: [], addedAt: 1, classification }, new Blob(['Synthetic']))
        await storage.updateBook(id, { readingStatus: 'wanted' })
        const saved = (await storage.listBooks()).find(book => book.id === id)
        result.push({ value: saved.classification.topics[0].value, locked: saved.classification.topics[0].locked, legacy: saved.classification.legacyTags })
      }
      return result
    }, backend)
    assert.deepEqual(preserved, ['未标记', '想读', '暂缓', '弃读'].map(value => ({ value, locked: true, legacy: ['original'] })))
  } finally { await h.close() }
})

test('manifest and OKF round-trip all six statuses and normalize old unread without guessing wanted', async () => {
  const h = await createHarness()
  try {
    const bytes = await h.page.evaluate(async statuses => {
      const { getStorage } = await import('/src/storage/index.ts')
      const { exportBackup } = await import('/src/services/backup.ts')
      const storage = await getStorage()
      for (const status of statuses) {
        const classification = window.modules.createClassification(['original'])
        classification.category = { value: 'science-mathematics', locked: true, source: 'manual' }
        classification.topics = (status === 'abandoned' ? ['弃读', '观测方法'] : ['未标记', '想读']).map(value => ({ value, locked: true, source: 'manual' }))
        classification.feature = { value: '暂缓', locked: true, source: 'manual' }
        await storage.addBook({ title: `Synthetic ${status}`, author: 'Fixture', format: 'txt', fileName: `${status}.txt`, tags: [], addedAt: 1, readingStatus: status, classification }, new Blob([status]))
      }
      return Array.from(new Uint8Array(await (await exportBackup()).arrayBuffer()))
    }, statuses)
    const original = unzipSync(Uint8Array.from(bytes))
    const readDocument = bytes => { const text = strFromU8(bytes).replace(/\r\n/g, '\n'); const end = text.indexOf('\n---\n', 4); return { meta: parse(text.slice(4, end)), body: text.slice(end + 5) } }
    for (const route of ['manifest', 'okf']) {
      for (const legacy of [false, true]) {
        const entries = { ...original }
        if (route === 'manifest') {
          delete entries['index.md']
          if (legacy) { const manifest = JSON.parse(strFromU8(entries['manifest.json'])); manifest.books.find(book => book.readingStatus === 'unmarked').readingStatus = 'unread'; entries['manifest.json'] = strToU8(JSON.stringify(manifest)) }
        } else if (legacy) {
          const path = Object.keys(entries).find(path => /^books\/[^/]+\.md$/.test(path) && path !== 'books/index.md' && readDocument(entries[path]).meta.reading_state?.status === 'unmarked')
          assert.ok(path)
          const doc = readDocument(entries[path]); doc.meta.reading_state.status = 'unread'; entries[path] = strToU8(`---\n${stringify(doc.meta)}---\n${doc.body}`)
        }
        const restored = await h.page.evaluate(async bytes => {
          const { getStorage } = await import('/src/storage/index.ts')
          const { importBackup } = await import('/src/services/backup.ts')
          const storage = await getStorage()
          for (const book of await storage.listBooks()) await storage.deleteBook(book.id)
          await importBackup(new File([Uint8Array.from(bytes)], 'synthetic-statuses.zip'))
          const books = await storage.listBooks()
          return { states: books.map(book => book.readingStatus).sort(), labels: [...new Set(books.flatMap(book => [...book.classification.topics.map(tag => tag.value), book.classification.feature.value]))].sort(), protected: books.every(book => book.classification.category.locked && book.classification.topics.every(tag => tag.locked) && book.classification.legacyTags[0] === 'original') }
        }, Array.from(zipSync(entries)))
        assert.deepEqual(restored.states, [...statuses].sort())
        assert.deepEqual(restored.labels, ['未标记', '想读', '暂缓', '弃读', '观测方法'].sort())
        assert.equal(restored.protected, true)
      }
    }
  } finally { await h.close() }
})
