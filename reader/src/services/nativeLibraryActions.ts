/** Native UI adapter over the existing canonical library/query/session/classification services. No new persistent owner. */
import type { BookMeta, LibraryStorage } from '../storage/types.ts'
import { BOOK_CATEGORIES, createClassification, normalizeTagName } from './bookClassification.ts'
import { saveBookClassification } from './bookTagActions.ts'
import { FORMAT_LABELS, isSupportedBookFormat } from './format.ts'
import { countLibraryCategories, getCachedBookNorm, type LibraryQueryOptions } from './libraryQuery.ts'
import { DEFAULT_LIBRARY_SESSION, loadLibrarySession, queryLibrarySession, saveLibrarySession, VALID_SORTS, type LibrarySessionState } from './librarySession.ts'
import { READING_STATUSES, resolveReadingStatus } from './readingStatus.ts'
import { jsonObject, stateError } from './nativeState.ts'
import type { NativeManagementHandler } from './nativeManagementActions.ts'
interface Dependencies {
  storage(): Promise<LibraryStorage>
  session(): LibrarySessionState
  saveSession(value: Partial<LibrarySessionState>): void
  settingsReady(): Promise<void>
  now(): number
  token(): string
}
const defaults: Dependencies = {
  storage: async () => (await import('../storage/index.ts')).getStorage(), session: loadLibrarySession, saveSession: saveLibrarySession,
  settingsReady: async () => { const s = (await import('../stores/settings.ts')).useSettings(); const r = await s.reloadNativeSettings(); if (r.unsavedPaths.length || r.failedCommits.length) throw stateError('native_settings_unsaved') },
  now: Date.now, token: () => crypto.randomUUID(),
}
const strings = new Set(['keyword', 'formatFilter', 'languageFilter', 'categoryFilter', 'audienceFilter', 'workCountryFilter', 'workPeriodFilter', 'activeBooklistId', 'lastViewedBookId'])
const enums: Record<string, readonly unknown[]> = { sortBy: VALID_SORTS, tagMode: ['and', 'or'], statusFilter: ['', ...READING_STATUSES], availabilityFilter: ['', 'available', 'unavailable', 'missing', 'permission-denied'], classificationStatusFilter: ['', 'all', 'complete', 'incomplete', 'unclassified'], textbookFilter: ['', 'all', 'true', 'false', 'unknown'], ancientTextFilter: ['', 'all', 'true', 'false', 'unknown'] }
function sessionPatch(value: unknown): Partial<LibrarySessionState> {
  const p = jsonObject(value)
  for (const [k, v] of Object.entries(p)) {
    if (strings.has(k)) { if (typeof v !== 'string' || v.length > 4096) throw stateError('invalid_payload') }
    else if (Object.hasOwn(enums, k)) { if (!enums[k]!.includes(v)) throw stateError('invalid_payload') }
    else if (k === 'page' || k === 'pageSize') { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > (k === 'pageSize' ? 500 : 1_000_000)) throw stateError('invalid_payload') }
    else if (k === 'tagFilter' || k === 'orderedBookIds') { if (!Array.isArray(v) || v.length > 10000 || v.some(x => typeof x !== 'string' || !x || x.length > 4096)) throw stateError('invalid_payload') }
    else if (k === 'returnedFromReader') { if (typeof v !== 'boolean') throw stateError('invalid_payload') }
    else throw stateError('invalid_payload')
  }
  return p as Partial<LibrarySessionState>
}
function options(s: LibrarySessionState, reading: boolean): LibraryQueryOptions {
  return { search: s.keyword, tags: s.tagFilter, tagMode: s.tagMode, category: s.categoryFilter || undefined,
    classificationStatus: s.classificationStatusFilter || undefined, audience: s.audienceFilter || undefined, textbook: s.textbookFilter, ancientText: s.ancientTextFilter,
    workCountry: s.workCountryFilter || undefined, workPeriod: s.workPeriodFilter || undefined,
    formats: s.formatFilter ? [s.formatFilter] : [], languages: s.languageFilter ? [s.languageFilter] : [], statuses: s.statusFilter ? [s.statusFilter] : undefined,
    availability: s.availabilityFilter, sortBy: reading ? 'lastRead' : s.sortBy === 'recent' ? 'lastRead' : s.sortBy === 'added' ? 'addedAt' : s.sortBy === 'published' ? 'publicationDate' : s.sortBy,
    pinnedFirst: !reading, page: s.page, pageSize: s.pageSize }
}
export function createNativeLibraryActions(injected: Partial<Dependencies> = {}): Record<string, NativeManagementHandler> {
  const deps = { ...defaults, ...injected }, selections = new Map<string, { ids: string[]; expires: number }>()
  let tagBusy = false
  return {
    libraryBookInfo: async p => {
      if (typeof p.bookId !== 'string' || !p.bookId) throw stateError('invalid_payload')
      const book = await (await deps.storage()).getBook(p.bookId)
      if (!book) throw stateError('book_not_found')
      return { ok: true, effectiveReadingStatus: resolveReadingStatus(book).effective ?? 'unmarked', supported: isSupportedBookFormat(book.format) }
    },
    librarySessionGet: async () => ({ ok: true, session: deps.session(), defaults: DEFAULT_LIBRARY_SESSION, categories: BOOK_CATEGORIES }),
    librarySessionSave: async p => {
      const patch = sessionPatch(p.session)
      if (p.selectionToken !== undefined) {
        if (typeof p.selectionToken !== 'string') throw stateError('invalid_payload')
        const selection = selections.get(p.selectionToken)
        if (!selection || selection.expires < deps.now()) throw stateError('stale_library_selection')
        if (typeof patch.lastViewedBookId !== 'string' || !selection.ids.includes(patch.lastViewedBookId)) throw stateError('book_not_found')
        patch.orderedBookIds = selection.ids.slice(0, 10_000)
      }
      deps.saveSession(patch)
      // Existing session owner can retain memory-only state on storage failure; never call this a durable book/settings receipt.
      return { ok: true, session: deps.session(), durability: 'existing-session-owner-not-a-book-settings-receipt' }
    },
    libraryPage: async p => {
      if (p.mode !== 'library' && p.mode !== 'reading') throw stateError('invalid_payload')
      if (Object.keys(p).some(k => !['mode', 'tab', 'session', 'restore'].includes(k))) throw stateError('invalid_payload')
      const reading = p.mode === 'reading', tab = p.tab ?? 'reading'
      const tabs = ['reading', 'recent', 'wanted', 'paused', 'finished', 'abandoned']
      if (typeof tab !== 'string' || !tabs.includes(tab) || (p.restore !== undefined && typeof p.restore !== 'boolean')) throw stateError('invalid_payload')
      const state = { ...(reading ? { ...DEFAULT_LIBRARY_SESSION, sortBy: 'recent' as const } : deps.session()), ...sessionPatch(p.session ?? {}) }
      const storage = await deps.storage(), books = await storage.listBooks()
      const inTab = (book: BookMeta, key: string) => key === 'recent' ? typeof book.lastReadAt === 'number' && book.lastReadAt > 0 : resolveReadingStatus(book).effective === key
      const base = reading ? books.filter(b => inTab(b, tab)) : books
      const opt = options(state, reading)
      // Keep the original ReadingView ordering (lastReadAt ?? addedAt); Library keeps its existing pinned/sort/session policy.
      const ordered = reading ? [...base].sort((a, b) => tab === 'recent' ? (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) : (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt)).map(b => b.id) : state.orderedBookIds
      const full = queryLibrarySession(base, { ...opt, page: 1, pageSize: Math.max(1, base.length) }, ordered)
      if (p.restore === true && state.lastViewedBookId) { const index = full.items.findIndex(b => b.id === state.lastViewedBookId); if (index >= 0) state.page = Math.floor(index / state.pageSize) + 1 }
      const result = queryLibrarySession(base, { ...opt, page: state.page }, ordered)
      const token = deps.token()
      for (const [id, old] of selections) if (old.expires < deps.now() || selections.size >= 4) selections.delete(id)
      selections.set(token, { ids: full.items.map(b => b.id), expires: deps.now() + 5 * 60_000 })
      const facets: Record<string, Array<{ value: string; label: string; count: number }>> = {}
      const facet = (name: string, values: (b: BookMeta) => string[], labels?: Record<string, string>) => {
        const counts = new Map<string, number>()
        for (const b of books) for (const v of new Set(values(b).filter(Boolean))) counts.set(v, (counts.get(v) ?? 0) + 1)
        facets[name] = [...counts].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([value, count]) => ({ value, label: labels?.[value] ?? value, count }))
      }
      const categoryLabels = Object.fromEntries(BOOK_CATEGORIES.map(c => [c.id, c.label]))
      facets.categoryFilter = [...countLibraryCategories(books)].map(([value, count]) => ({ value, label: value === '__unclassified__' ? '未分类' : categoryLabels[value] ?? value, count }))
      facet('tagFilter', b => (b.tags ?? []).filter(t => !Object.values(categoryLabels).includes(t)))
      facet('formatFilter', b => [b.format], FORMAT_LABELS); facet('languageFilter', b => b.language ? [b.language] : [])
      facet('audienceFilter', b => b.classification?.facets?.audience ? [b.classification.facets.audience] : [])
      facet('workCountryFilter', b => b.classification?.facets?.workCountry ? [b.classification.facets.workCountry] : [])
      facet('workPeriodFilter', b => b.classification?.facets?.workPeriod ? [b.classification.facets.workPeriod] : [])
      const view = result.items.map(b => ({ id: b.id, title: b.title, author: b.author, publisher: b.publisher ?? '', publicationDate: b.publicationDate ?? '', format: b.format, language: b.language, source: b.source, tags: b.tags,
        classification: b.classification, progress: b.progress, readingSeconds: b.readingSeconds, readingStatus: b.readingStatus,
        effectiveReadingStatus: resolveReadingStatus(b).effective ?? 'unmarked', fileAvailability: b.fileAvailability ?? 'unknown',
        addedAt: b.addedAt, lastReadAt: b.lastReadAt, pinnedAt: b.pinnedAt, hasCover: b.hasCover, supported: isSupportedBookFormat(b.format),
        classificationComplete: getCachedBookNorm(b).isComplete }))
      const output = { ok: true, ...result, items: view, selectionToken: token, facets, session: { ...state, page: result.page },
        tabCounts: Object.fromEntries(tabs.map(t => [t, books.filter(b => inTab(b, t)).length])), allCount: books.length,
        readingSeconds: books.reduce((n, b) => n + (b.readingSeconds ?? 0), 0) }
      if (new TextEncoder().encode(JSON.stringify(output)).length > 1024 * 1024) throw stateError('resource_limit')
      return output
    },
    librarySelectionPage: async p => {
      if (typeof p.token !== 'string' || !Number.isSafeInteger(p.offset) || Number(p.offset) < 0 || !Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 500) throw stateError('invalid_payload')
      const selection = selections.get(p.token)
      if (!selection || selection.expires < deps.now()) throw stateError('stale_library_selection')
      const offset = Number(p.offset), limit = Number(p.limit)
      return { ok: true, ids: selection.ids.slice(offset, offset + limit), total: selection.ids.length }
    },
    libraryTagBatch: async p => {
      if (tagBusy) throw stateError('busy')
      if (typeof p.operation !== 'string' || !['add', 'clear'].includes(p.operation) || !Array.isArray(p.items) || !p.items.length || p.items.length > 128) throw stateError('invalid_payload')
      if (p.operation === 'clear' && p.confirmLockedChanges !== true) throw stateError('confirmation_required')
      const tags = p.operation === 'add' && Array.isArray(p.tags) ? p.tags : []
      if (p.operation === 'add' && (!tags.length || tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 4096))) throw stateError('invalid_payload')
      const items = p.items.map(raw => { const item = jsonObject(raw); if (typeof item.id !== 'string' || !Array.isArray(item.expectedTags) || item.expectedTags.some(t => typeof t !== 'string') || !Number.isSafeInteger(item.expectedRevision) || Number(item.expectedRevision) < 0) throw stateError('invalid_payload'); return item })
      if (new Set(items.map(i => i.id)).size !== items.length) throw stateError('invalid_payload')
      tagBusy = true
      try {
        await deps.settingsReady(); const storage = await deps.storage(); let unknown = false, halted = false, succeeded = 0
        const results: Array<Record<string, unknown>> = []
        for (const item of items) {
          if (halted) { results.push({ id: item.id, ok: false, code: 'not_run' }); continue }
          let original: BookMeta | undefined
          try { original = await storage.getBook(String(item.id)) }
          catch { halted = true; results.push({ id: item.id, ok: false, code: 'book_read_failed' }); continue }
          if (!original) { results.push({ id: item.id, ok: false, code: 'book_not_found' }); continue }
          if ((original.classification?.revision ?? 0) !== item.expectedRevision || JSON.stringify(original.tags) !== JSON.stringify(item.expectedTags)) { results.push({ id: item.id, ok: false, code: 'book_conflict' }); continue }
          if (p.operation === 'add' && original.classification) { results.push({ id: item.id, ok: false, code: 'classification_required' }); continue }
          try {
            if (p.operation === 'clear') await saveBookClassification(storage, original, createClassification(original.classification?.legacyTags ?? original.tags))
            else await storage.updateBookClassifications([], [{ id: original.id, expectedTags: original.tags, tags: [...new Set([...original.tags, ...tags.map(t => normalizeTagName(String(t)))])] }])
            succeeded++; results.push({ id: item.id, ok: true })
          } catch (error) {
            const conflict = error instanceof Error && error.message === 'Book classification conflict'
            unknown = !conflict; halted = unknown; results.push({ id: item.id, ok: false, code: conflict ? 'book_conflict' : 'write_outcome_unknown' })
          }
        }
        return { ok: succeeded === items.length, succeeded, failed: items.length - succeeded, results, outcomeUnknown: unknown }
      } finally { tagBusy = false }
    },
  }
}
