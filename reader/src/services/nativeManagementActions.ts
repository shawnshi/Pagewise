/** Non-UI actions. Register only on the authenticated Tauri-root/native-page dispatcher. */
import type { BookMeta, LibraryStorage } from '../storage/types.ts'
import type { DraftEnv, NoteDraftContext } from './noteDrafts.ts'
import type { RestoreProgress } from './backup'
import type { ImportResult } from './importer'
import type { useFolderLibrary } from './folderLibrary'
import type { NativeSettingsRecovery } from '../stores/settings'
import {
  BOOK_CATEGORIES, createClassification, parseClassification, getTaggingMetadata,
  type BookClassification, type BookClassTag,
} from './bookClassification.ts'
import { saveBookClassification } from './bookTagActions.ts'
import { saveNoteDraft, loadNoteDraft, listDrafts, discardNoteDraft } from './noteDrafts.ts'
import { ARCHIVE_LIMITS } from './boundedArchive.ts'
import { SUPPORTED_EXTS } from './format.ts'

export type NativeManagementHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
type Folder = Pick<ReturnType<typeof useFolderLibrary>, 'status' | 'rescan' | 'relinkCandidates' | 'relink'>
type Storage = LibraryStorage
type ReadHandle = { read(bytes: Uint8Array): Promise<number | null>; close(): Promise<void> }

/** Injection is limited to canonical services and platform IO, never native request payloads. */
export interface NativeManagementDependencies {
  settingsReady(): Promise<NativeSettingsRecovery>
  storage(): Promise<Storage>
  folder(): Folder | Promise<Folder>
  selectFolder(): Promise<{ id: string; label: string; permission: 'granted' | 'lost' } | null>
  pick(kind: 'books' | 'backup'): Promise<string[] | null>
  openRead(path: string): Promise<ReadHandle>
  importUris(paths: string[], source?: string): Promise<ImportResult[]>
  generate(book: BookMeta): Promise<BookClassification>
  exportArchive(): Promise<'saved' | 'cancelled'>
  restore(file: File): Promise<RestoreProgress>
  draftEnv?: DraftEnv
  now(): number
  token(): string
}

const defaults: NativeManagementDependencies = {
  async settingsReady() {
    const { hasNativeState, stateError } = await import('./nativeState.ts')
    if (!hasNativeState()) throw stateError('native_state_required')
    const s = (await import('../stores/settings')).useSettings()
    // Refresh also performs receipt-only recovery after a rejected settings queue.
    const report = await s.reloadNativeSettings()
    if (!report.unsavedPaths.length && !report.failedCommits.length) await s.flushNativeSettings()
    return report
  },
  storage: async () => (await import('../storage')).getStorage(),
  folder: async () => (await import('./folderLibrary')).useFolderLibrary(),
  selectFolder: async () => (await import('./monitoredFolder')).selectMonitoredFolder(),
  async pick(kind) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    let chosen: string | string[] | null
    try {
      chosen = await open({ multiple: kind === 'books', directory: false,
        filters: [{ name: kind === 'books' ? 'Books' : 'OKF ZIP', extensions: kind === 'books' ? SUPPORTED_EXTS : ['zip', 'lightread'] }] })
    } catch (error) {
      // Android dialog cancellation rejects instead of resolving null.
      if (/cancel/i.test(error instanceof Error ? error.message : String(error))) return null
      throw error
    }
    return chosen === null ? null : typeof chosen === 'string' ? [chosen] : chosen
  },
  openRead: async path => (await import('@tauri-apps/plugin-fs')).open(path, { read: true }),
  importUris: async (paths, source) => (await import('./nativeBookImport.ts')).importNativeUriFiles(paths, source),
  generate: async book => (await import('./bookTagging.ts')).generateBookClassification(book),
  async exportArchive() {
    const { exportLibraryArchiveToDevice } = await import('./archiveExport')
    const { exportBackupToSink, LIBRARY_ARCHIVE_EXTENSION } = await import('./backup')
    return exportLibraryArchiveToDevice(`Pagewise-${new Date().toISOString().slice(0, 10)}${LIBRARY_ARCHIVE_EXTENSION}`, exportBackupToSink)
  },
  restore: async file => (await import('./backup')).importBackup(file),
  now: () => Date.now(), token: () => crypto.randomUUID(),
}

const fail = (code: string) => Object.assign(new Error(code), { code })
const clone = <T>(value: T): T => structuredClone(value)
function text(p: Record<string, unknown>, key: string): string {
  const value = p[key]
  if (typeof value !== 'string' || !value || value.length > 4096) throw fail('invalid_payload')
  return value
}
const errorCodes = new Set(['busy', 'permission_denied', 'invalid_reference', 'resource_limit', 'unsupported_library_root',
  'invalid_receipt', 'unavailable', 'not_found', 'cancelled', 'interrupted', 'native_state_required',
  'settings_recovery_required', 'unconfigured', 'insufficient-material', 'invalid-output', 'network', 'conflict',
  'invalid_payload', 'session_expired', 'session_capacity', 'confirmation_required', 'locked_change_confirmation_required',
  'revision_mismatch', 'source_changed', 'payload_too_large', 'invalid_read', 'restore_selection_required'])
function safeCode(error: unknown): string {
  if (error instanceof Error && error.message === 'Book classification conflict') return 'conflict'
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && errorCodes.has(error.code)) return error.code
  return 'operation_failed'
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function recoveryReport(report: NativeSettingsRecovery): Record<string, unknown> {
  // failedCommits values may include API keys; disclose affected paths, never send values to widgets.
  return { unsavedPaths: report.unsavedPaths, failedCommits: report.failedCommits.map(item => ({ paths: Object.keys(item) })),
    failedCommitCount: report.failedCommits.length, valuesRetainedBySettingsOwner: true }
}

export function createNativeManagementActions(injected: Partial<NativeManagementDependencies> = {}): Record<string, NativeManagementHandler> {
  const deps = { ...defaults, ...injected }
  const edits = new Map<string, { at: number; original: BookMeta; draft: BookClassification; unknown: boolean }>()
  let backup: { token: string; at: number; file: File; unknown: boolean } | undefined
  const active = new Set<string>()
  const ttl = 15 * 60_000
  async function folder(): Promise<Folder> { return deps.folder() }
  function prune() {
    for (const [key, value] of edits) if (deps.now() - value.at > ttl) edits.delete(key)
    if (backup && deps.now() - backup.at > ttl) backup = undefined
  }
  async function ready() {
    const report = await deps.settingsReady()
    if (report.unsavedPaths.length || report.failedCommits.length) {
      return { ok: false, code: 'settings_recovery_required', recovery: recoveryReport(report) }
    }
  }
  async function book(id: string) {
    const found = await (await deps.storage()).getBook(id)
    if (!found) throw fail('not_found')
    return clone(found)
  }
  function session(p: Record<string, unknown>) {
    const token = text(p, 'sessionToken'), edit = edits.get(token)
    if (!edit) throw fail('session_expired')
    if (edit.original.id !== text(p, 'bookId')) throw fail('invalid_payload')
    return { token, edit }
  }
  function context(token: string, edit: NonNullable<ReturnType<typeof edits.get>>) {
    return { sessionToken: token, bookId: edit.original.id, classification: clone(edit.draft),
      originalClassification: edit.original.classification ? clone(edit.original.classification) : createClassification(edit.original.tags),
      expectedRevision: edit.original.classification?.revision ?? 0, metadata: getTaggingMetadata(edit.original),
      sourceDescription: edit.original.description ?? '', evidencePolicy: 'description-only-validated-by-bookTagging',
      categories: BOOK_CATEGORIES, saved: false, expiresAt: edit.at + ttl }
  }
  function candidate(p: Record<string, unknown>, edit: NonNullable<ReturnType<typeof edits.get>>) {
    let next: BookClassification
    try { next = parseClassification(p.classification) } catch { throw fail('invalid_payload') }
    if (next.revision !== (edit.original.classification?.revision ?? 0)) throw fail('revision_mismatch')
    // A client cannot manufacture AI provenance. Only unchanged values from the service snapshot retain it.
    const provenance = (tag: BookClassTag | null, previous: BookClassTag | null): BookClassTag | null => tag && ({ ...tag,
      source: tag.source === 'manual' ? 'manual' : previous?.value === tag.value ? previous.source : 'manual' })
    next.category = provenance(next.category, edit.draft.category)
    next.feature = provenance(next.feature, edit.draft.feature)
    next.topics = next.topics.map(tag => ({ ...tag, source: tag.source === 'manual' ? 'manual'
      : edit.draft.topics.find(old => old.value === tag.value)?.source ?? 'manual' }))
    const lockedChanged = (old: BookClassTag | null, current: BookClassTag | null) => old?.locked && (!current || current.value !== old.value || !current.locked)
    if ((lockedChanged(edit.draft.category, next.category) || lockedChanged(edit.draft.feature, next.feature)
      || edit.draft.topics.some(old => lockedChanged(old, next.topics.find(tag => tag.value === old.value) ?? null)))
      && p.confirmLockedChanges !== true) throw fail('locked_change_confirmation_required')
    return next
  }
  function status(f: Folder): Record<string, unknown> {
    const s = f.status.value
    // Folder owner sometimes captures provider exception text; never forward raw errors/URIs.
    return { ...s, error: s.error ? 'folder_operation_failed' : null }
  }
  async function annotation(p: Record<string, unknown>): Promise<{ ctx: NoteDraftContext; note: Awaited<ReturnType<Storage['listAnnotations']>>[number]; format?: string }> {
    const bookId = text(p, 'bookId'), id = text(p, 'id')
    const store = await deps.storage()
    const note = (await store.listAnnotations(bookId)).find(value => value.id === id && value.bookId === bookId)
    if (!note) throw fail('not_found')
    const metadata = await store.getBook(bookId)
    return { ctx: { bookId, contextId: `anno:${id}`, quote: note.text, sourceLoc: note.cfi }, note, format: metadata?.format }
  }
  function wrap(name: string, run: NativeManagementHandler, settings = true): NativeManagementHandler {
    return async payload => {
      if (!object(payload)) return { ok: false, code: 'invalid_payload' }
      // No transparent retries or sharing ambiguous mutations; concurrent requests receive a truthful busy result.
      let key = name
      if (name.startsWith('classification') || name === 'aiClassify') key = 'classification'
      if (name.startsWith('noteDraft')) key = 'noteDraft'
      if (active.has(key)) return { ok: false, code: 'busy',
        ...(name === 'noteDraftSave' && typeof payload.text === 'string' ? { textRecoverable: payload.text } : {}) }
      active.add(key)
      try {
        prune()
        if (settings) {
          const blocked = await ready()
          if (blocked) return { ...blocked, ...(name === 'noteDraftSave' && typeof payload.text === 'string' ? { textRecoverable: payload.text } : {}) }
        }
        return await run(payload)
      } catch (error) {
        return { ok: false, code: safeCode(error), ...(name === 'noteDraftSave' && typeof payload.text === 'string' ? { textRecoverable: payload.text } : {}) }
      } finally { active.delete(key) }
    }
  }

  return {
    importBooks: wrap('importBooks', async () => {
      const paths = await deps.pick('books')
      if (!paths?.length) return { cancelled: true }
      await deps.storage()
      try {
        const results = await deps.importUris(paths, '本地导入')
        if (results.length !== paths.length) throw fail('invalid_receipt')
        const imported = results.filter(item => item.ok).length
        return { ok: imported === results.length, code: imported === results.length ? 'imported' : imported ? 'partial_import' : 'import_failed',
          imported, total: results.length, results: results.map(item => ({ ok: item.ok, fileName: item.fileName, bookId: item.bookId,
            ...(item.ok ? {} : { code: item.error && errorCodes.has(item.error) ? item.error : 'item_failed' }) })) }
      } catch (error) { return { ok: false, code: safeCode(error), outcome: 'unknown', recoveryOwner: 'nativeBookImport', retryAutomatically: false } }
    }),
    selectFolder: wrap('selectFolder', async () => {
      const selected = await deps.selectFolder()
      if (!selected) return { cancelled: true }
      const f = await folder()
      await f.rescan()
      const snapshot = status(f)
      return { ok: snapshot.state === 'idle', code: snapshot.state === 'idle' ? 'folder_selected' : 'folder_incomplete', status: snapshot }
    }),
    recheckFolder: wrap('recheckFolder', async () => {
      const f = await folder(); await f.rescan()
      const snapshot = status(f)
      return { ok: snapshot.state === 'idle', code: snapshot.state === 'idle' ? 'folder_checked' : 'folder_incomplete', status: snapshot }
    }),
    fileJobStatus: wrap('fileJobStatus', async () => ({ ok: true, code: 'folder_status', status: status(await folder()),
      scope: 'folder-owner-snapshot', durableJobReceipt: false }), false),
    relinkBook: wrap('relinkBook', async p => ({ ok: true, code: 'relink_candidates', bookId: text(p, 'bookId'),
      ...await (await folder()).relinkCandidates(text(p, 'bookId')) })),
    relinkBookCommit: wrap('relinkBookCommit', async p => {
      if (p.confirmSameEdition !== true) throw fail('confirmation_required')
      try { await (await folder()).relink(text(p, 'bookId'), text(p, 'folderId'), text(p, 'documentId'), true) }
      catch (error) { return { ok: false, code: safeCode(error), outcome: 'unknown', retryAutomatically: false } }
      return { ok: true, code: 'relinked' }
    }),
    backupExport: wrap('backupExport', async () => {
      const result = await deps.exportArchive()
      return result === 'cancelled' ? { cancelled: true } : { ok: true, code: 'backup_exported' }
    }),
    backupImport: wrap('backupImport', async p => {
      if (p.mode === 'discard') {
        if (!backup || backup.token !== text(p, 'token')) throw fail('session_expired')
        backup = undefined; return { ok: true, code: 'selection_discarded' }
      }
      if (p.mode === 'commit') {
        if (p.confirm !== true) throw fail('confirmation_required')
        if (!backup || backup.token !== text(p, 'token')) throw fail('session_expired')
        if (backup.unknown) return { ok: false, code: 'restore_outcome_unknown', retryAutomatically: false }
        backup.unknown = true
        try {
          const progress = await deps.restore(backup.file)
          backup = undefined
          return { ok: true, code: 'backup_restored', progress }
        } catch (error) {
          // ArchiveRestoreError deliberately reports confirmed progress, not rollback or failed-call atomicity.
          const sourceProgress = error instanceof Error && error.name === 'ArchiveRestoreError' && 'progress' in error && object(error.progress) ? error.progress : undefined
          const partial = sourceProgress !== undefined
          const progress: Record<string, number> = {}
          if (sourceProgress) {
            for (const key of ['books', 'annotations', 'sources', 'booklists', 'booklistItems', 'wanted', 'readingLog']) {
              const count = sourceProgress[key]
              if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) progress[key] = count
            }
          }
          return { ok: false, code: partial ? 'partial_restore' : safeCode(error),
            ...(partial ? { progress } : {}), outcome: 'unknown', rollbackPerformed: false, retryAutomatically: false }
        }
      }
      if (p.mode !== undefined && p.mode !== 'preview') throw fail('invalid_payload')
      if (backup) return { ok: false, code: 'restore_selection_required', token: backup.token }
      const paths = await deps.pick('backup')
      if (!paths?.length) return { cancelled: true }
      if (paths.length !== 1) throw fail('invalid_payload')
      const path = paths[0]
      if (!path) throw fail('invalid_payload')
      const handle = await deps.openRead(path)
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      try {
        for (;;) {
          const bytes = new Uint8Array(Math.min(1024 * 1024, ARCHIVE_LIMITS.archiveBytes + 1 - size))
          const n = await handle.read(bytes)
          if (n === null || n === 0) break
          if (!Number.isInteger(n) || n < 0 || n > bytes.length) throw fail('invalid_read')
          size += n
          if (size > ARCHIVE_LIMITS.archiveBytes) throw fail('payload_too_large')
          chunks.push(bytes.slice(0, n))
        }
      } finally { await handle.close() }
      const file = new File(chunks, 'selected.okf.zip', { type: 'application/zip' })
      backup = { token: deps.token(), at: deps.now(), file, unknown: false }
      return { ok: true, code: 'backup_preview', token: backup.token, size, fileName: file.name,
        contentValidated: false, previewKind: 'selection-metadata-only', requiresExplicitCommit: true, expiresAt: backup.at + ttl }
    }),
    classificationGet: wrap('classificationGet', async p => {
      if (edits.size >= 16) throw fail('session_capacity')
      const original = await book(text(p, 'bookId')), token = deps.token()
      const edit = { original, at: deps.now(), draft: original.classification ? parseClassification(original.classification) : createClassification(original.tags), unknown: false }
      edits.set(token, edit)
      return { ok: true, code: 'classification_draft', ...context(token, edit) }
    }),
    aiClassify: wrap('aiClassify', async p => {
      const { token, edit } = session(p)
      if (edit.unknown) return { ok: false, code: 'classification_outcome_unknown', retryAutomatically: false }
      const input = p.classification === undefined ? parseClassification(edit.draft) : candidate(p, edit)
      // Retain unsaved manual input even if generation fails; the service only fills missing values.
      edit.draft = input
      try {
        edit.draft = await deps.generate({ ...clone(edit.original), classification: clone(input) })
        return { ok: true, code: 'classification_generated', ...context(token, edit) }
      } catch (error) { return { ok: false, code: safeCode(error), ...context(token, edit) } }
    }),
    classificationSave: wrap('classificationSave', async p => {
      if (p.confirmSave !== true) throw fail('confirmation_required')
      const { token, edit } = session(p)
      if (edit.unknown) return { ok: false, code: 'classification_outcome_unknown', retryAutomatically: false }
      const next = candidate(p, edit)
      edit.draft = next
      try {
        const saved = await saveBookClassification(await deps.storage(), edit.original, next)
        edits.delete(token)
        return { ok: true, code: 'classification_saved', bookId: edit.original.id, classification: saved, saved: true }
      } catch (error) {
        const code = safeCode(error)
        edit.unknown = code !== 'conflict'
        return { ok: false, code, ...context(token, edit), outcome: code === 'conflict' ? 'not_committed' : 'unknown', retryAutomatically: false }
      }
    }),
    noteDraftList: wrap('noteDraftList', async p => ({ ok: true, code: 'drafts', drafts: listDrafts(p.bookId === undefined ? undefined : text(p, 'bookId'), deps.draftEnv) }), false),
    noteDraftGet: wrap('noteDraftGet', async p => {
      const { ctx, note, format } = await annotation(p), result = loadNoteDraft(ctx, deps.draftEnv)
      if (result.success) return { ok: true, code: 'draft_recovered', draft: result.draft, context: ctx, format, savedNote: note.note ?? '' }
      if (result.error === 'not_found') return { ok: true, code: 'no_draft', context: ctx, format, text: note.note ?? '' }
      return { ok: false, code: result.error, context: ctx, format, savedNote: note.note ?? '', originalPayloadRetained: true }
    }),
    noteDraftSave: wrap('noteDraftSave', async p => {
      if (typeof p.text !== 'string') throw fail('invalid_payload')
      const { ctx, format } = await annotation(p), result = saveNoteDraft(ctx, p.text, deps.draftEnv)
      return result.success ? { ok: true, code: 'draft_saved', draft: result.draft, format, savedAnnotation: false }
        : { ok: false, code: result.error, textRecoverable: result.textRecoverable }
    }),
    noteDraftDiscard: wrap('noteDraftDiscard', async p => {
      if (p.confirmDiscard !== true) throw fail('confirmation_required')
      // Orphaned drafts remain explicitly discardable even after their annotation was removed.
      const ctx = { bookId: text(p, 'bookId'), contextId: `anno:${text(p, 'id')}` }
      const result = discardNoteDraft(ctx, deps.draftEnv)
      return { ok: result.success, code: result.success ? 'draft_discarded' : 'draft_discard_failed' }
    }, false),
  }
}
