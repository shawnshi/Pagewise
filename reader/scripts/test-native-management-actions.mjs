import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, dirname, extname } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

// Production services stay real. Only AI transport and native/platform dependencies are synthetic.
const forbidNetwork = () => { throw new Error('Outbound networking prohibited in native action tests') }
globalThis.fetch = forbidNetwork
http.request = http.get = https.request = https.get = net.connect = net.createConnection = forbidNetwork
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './ai.ts' && context.parentURL?.endsWith('/bookTagging.ts')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(`
        export const aiConfigured = () => true;
        export async function* chatStream() { globalThis.__aiCalls++; yield globalThis.__aiResponse; }
      `), shortCircuit: true }
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !extname(specifier)) {
      const candidate = fileURLToPath(new URL(specifier + '.ts', context.parentURL))
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context)
    }
    return next(specifier, context)
  },
})
const { createNativeManagementActions } = await import('../src/services/nativeManagementActions.ts')
const { createClassification, parseClassification, getTaggingMetadata } = await import('../src/services/bookClassification.ts')
const { classificationMetadataMatches } = await import('../src/services/bookTagActions.ts')
const { generateBookClassification } = await import('../src/services/bookTagging.ts')
const { buildDraftKey, loadNoteDraft, saveNoteDraft } = await import('../src/services/noteDrafts.ts')
const { ARCHIVE_LIMITS } = await import('../src/services/boundedArchive.ts')

class MemoryStorage {
  map = new Map()
  quota = false
  getItem(k) { return this.map.get(k) ?? null }
  setItem(k, v) { if (this.quota) throw Object.assign(new Error('PRIVATE storage detail'), { name: 'QuotaExceededError' }); this.map.set(k, v) }
  removeItem(k) { this.map.delete(k) }
  keys() { return [...this.map.keys()] }
}
const makeBook = () => ({ id: 'b1', title: 'Synthetic book', author: 'Synthetic author', format: 'epub', fileName: 'synthetic.epub',
  tags: ['original manual legacy'], addedAt: 1, hasCover: false,
  description: '这本书研究计算机算法与程序设计，介绍算法的复杂度分析和计算机系统的组织结构，通过实验展示程序设计的方法及其实际应用。' })
function fixture() {
  let current = makeBook(), now = 10, tokenCounter = 0
  const journal = new MemoryStorage(), writes = [], calls = []
  const notes = [{ id: 'a1', bookId: 'b1', cfi: 'epubcfi(/6/2)', text: 'ORIGINAL QUOTE', note: 'saved thought', color: 'yellow', createdAt: 1 }]
  const folder = { status: { value: { state: 'idle', folderLabel: 'Synthetic folder', indexed: 2, unavailable: 0, generation: 1, error: null } },
    async rescan() { calls.push('rescan') },
    async relinkCandidates(id) { calls.push(['candidates', id]); return { folderId: 'f1', files: [{ documentId: 'd1', name: 'same.epub', relativePath: 'same.epub', size: 10, modifiedAt: 1 }] } },
    async relink(...args) { calls.push(['relink', ...args]) },
  }
  const storage = {
    async getBook(id) { calls.push('getBook'); return id === current.id ? structuredClone(current) : undefined },
    async listAnnotations(id) { calls.push('listAnnotations'); return notes.filter(a => a.bookId === id).map(a => ({ ...a })) },
    async updateBookClassifications(updates) {
      calls.push('classificationWrite')
      const item = updates[0]
      assert.equal(item.id, current.id)
      assert.deepEqual(item.expectedMetadata, getTaggingMetadata(makeBook()))
      if (item.expectedRevision !== (current.classification?.revision ?? 0)
        || !classificationMetadataMatches(current, item.expectedMetadata)
        || (item.expectedTags && JSON.stringify(item.expectedTags) !== JSON.stringify(current.tags))) throw new Error('Book classification conflict')
      writes.push(structuredClone(item)); current.classification = structuredClone(item.classification)
    },
  }
  const deps = {
    async settingsReady() { calls.push('settings'); return { unsavedPaths: [], failedCommits: [] } },
    async storage() { return storage }, folder: () => folder,
    async selectFolder() { return { id: 'f1', label: 'Synthetic folder', permission: 'granted' } },
    async pick(kind) { calls.push(['pick', kind]); return kind === 'books' ? ['content://synthetic/book'] : ['content://synthetic/archive'] },
    async openRead() { let done = false; return { async read(out) { if (done) return null; done = true; out.set([1, 2, 3]); return 3 }, async close() { calls.push('closed') } } },
    async importUris(paths, source) { calls.push(['import', paths, source]); return [{ ok: true, fileName: 'synthetic.epub', bookId: 'new-book' }] },
    generate: generateBookClassification,
    async exportArchive() { return 'saved' },
    async restore(file) { calls.push(['restore', file.size]); assert.ok(file instanceof File); assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]); return { books: 1, annotations: 0, sources: 0, booklists: 0, booklistItems: 0, wanted: 0, readingLog: 0 } },
    draftEnv: { storage: journal, now: () => now }, now: () => now, token: () => `synthetic-token-${++tokenCounter}`,
  }
  const actions = (overrides = {}) => createNativeManagementActions({ ...deps, ...overrides })
  return { deps, actions, storage, folder, journal, writes, notes, calls, get book() { return current }, advance(ms) { now += ms } }
}
const payload = (draft, extra = {}) => ({ bookId: 'b1', sessionToken: draft.sessionToken, classification: structuredClone(draft.classification), ...extra })

test('stable action set: no invented export or second provider selector', () => {
  assert.deepEqual(Object.keys(fixture().actions()).sort(), ['importBooks', 'selectFolder', 'recheckFolder', 'fileJobStatus', 'relinkBook', 'relinkBookCommit',
    'backupExport', 'backupImport', 'classificationGet', 'aiClassify', 'classificationSave', 'noteDraftList', 'noteDraftGet', 'noteDraftSave', 'noteDraftDiscard'].sort())
})
test('settings recovery blocks dependent IO, discloses paths/count, never keys or empty success', async () => {
  const f = fixture(), a = f.actions({ settingsReady: async () => ({ unsavedPaths: [['reader', 'fontSize']], failedCommits: [{ aiApiKey: 'PRIVATE_KEY' }] }) })
  const result = await a.importBooks({})
  assert.equal(result.code, 'settings_recovery_required')
  assert.equal(result.recovery.failedCommitCount, 1)
  assert.deepEqual(result.recovery.failedCommits, [{ paths: ['aiApiKey'] }])
  assert.equal(JSON.stringify(result).includes('PRIVATE_KEY'), false)
  assert.deepEqual(f.calls, [])
})
test('canonical refresh/flush dependency is awaited before picker; paths come ONLY from picker', async () => {
  const f = fixture(), a = f.actions()
  const r = await a.importBooks({ paths: ['content://untrusted/request/path'] })
  assert.equal(r.code, 'imported')
  assert.equal(f.calls[0], 'settings')
  assert.deepEqual(f.calls.find(x => Array.isArray(x) && x[0] === 'import'), ['import', ['content://synthetic/book'], '本地导入'])
})
test('cancelled import/folder/backup choices never produce success', async () => {
  const a = fixture().actions({ pick: async () => null, selectFolder: async () => null, exportArchive: async () => 'cancelled' })
  for (const name of ['importBooks', 'selectFolder', 'backupImport', 'backupExport']) assert.deepEqual(await a[name]({}), { cancelled: true })
})
test('import partial results and unknown exceptions are not success or raw errors', async () => {
  const partial = fixture().actions({ pick: async () => ['content://synthetic/one', 'content://synthetic/two'],
    importUris: async () => [{ ok: true, fileName: 'one', bookId: 'b' }, { ok: false, fileName: 'two', error: 'PRIVATE raw error' }] })
  const result = await partial.importBooks({})
  assert.equal(result.code, 'partial_import'); assert.equal(result.imported, 1)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  const failed = await fixture().actions({ importUris: async () => { throw new Error('PRIVATE') } }).importBooks({})
  assert.equal(failed.outcome, 'unknown'); assert.equal(failed.retryAutomatically, false)
})
test('simultaneous user imports are busy, not duplicate billing/IO/replay', async () => {
  let release, count = 0
  const pending = new Promise(resolve => { release = resolve })
  const a = fixture().actions({ importUris: async () => { count++; await pending; return [] } })
  const first = a.importBooks({})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await a.importBooks({})).code, 'busy')
  release(); assert.equal((await first).code, 'invalid_receipt'); assert.equal(count, 1)
})
test('folder scan state/error is truthful; relink demands explicit same-edition confirmation', async () => {
  const f = fixture(), a = f.actions()
  assert.equal((await a.recheckFolder({})).code, 'folder_checked')
  f.folder.status.value = { ...f.folder.status.value, state: 'error', error: 'PRIVATE_PROVIDER_DETAIL' }
  const scan = await a.selectFolder({})
  assert.equal(scan.ok, false); assert.equal(scan.status.error, 'folder_operation_failed')
  assert.equal((await a.fileJobStatus({})).durableJobReceipt, false)
  const query = await a.relinkBook({ bookId: 'b1' }); assert.equal(query.files[0].documentId, 'd1')
  assert.equal((await a.relinkBookCommit({ bookId: 'b1', folderId: 'f1', documentId: 'd1' })).code, 'confirmation_required')
  assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === 'relink'), false)
  assert.equal((await a.relinkBookCommit({ bookId: 'b1', folderId: 'f1', documentId: 'd1', confirmSameEdition: true })).code, 'relinked')
})
test('classification explicit Save uses real helper revision/metadata/legacy CAS; invalid data never writes', async () => {
  const f = fixture(), a = f.actions(), draft = await a.classificationGet({ bookId: 'b1' })
  assert.equal((await a.classificationSave(payload(draft))).code, 'confirmation_required')
  const invalid = payload(draft, { confirmSave: true }); invalid.classification.topics = [{ value: '儿童', source: 'manual', locked: false }]
  assert.equal((await a.classificationSave(invalid)).code, 'invalid_payload'); assert.equal(f.writes.length, 0)
  const save = payload(draft, { confirmSave: true })
  save.classification.topics.push({ value: '算法', source: 'ai', locked: false })
  const result = await a.classificationSave(save)
  assert.equal(result.code, 'classification_saved'); assert.equal(result.classification.revision, 1)
  assert.equal(result.classification.topics[0].source, 'manual')
  assert.deepEqual(f.writes[0].expectedTags, ['original manual legacy'])
  assert.equal((await a.classificationSave(save)).code, 'session_expired')
})
test('locked changes are explicitly gated; failed save preserves editor draft and does not retry unknown outcome', async () => {
  const f = fixture(); f.book.classification = createClassification(f.book.tags)
  f.book.classification.category = { value: 'computing-ai', locked: true, source: 'manual' }
  const a = f.actions(), draft = await a.classificationGet({ bookId: 'b1' })
  const request = payload(draft, { confirmSave: true }); request.classification.category = null
  assert.equal((await a.classificationSave(request)).code, 'locked_change_confirmation_required')
  let calls = 0
  f.storage.updateBookClassifications = async () => { calls++; throw new Error('PRIVATE_DB_FAILURE') }
  const failed = await a.classificationSave({ ...request, confirmLockedChanges: true })
  assert.equal(failed.outcome, 'unknown'); assert.equal(failed.classification.category, null)
  assert.equal((await a.classificationSave({ ...request, confirmLockedChanges: true })).code, 'classification_outcome_unknown')
  assert.equal(calls, 1); assert.equal(JSON.stringify(failed).includes('PRIVATE_DB_FAILURE'), false)
})
test('real save helper rejects concurrent metadata/revision changes', async () => {
  const f = fixture(), a = f.actions(), draft = await a.classificationGet({ bookId: 'b1' })
  f.book.title = 'Concurrent title'
  const r = await a.classificationSave(payload(draft, { confirmSave: true }))
  assert.equal(r.code, 'conflict'); assert.equal(r.outcome, 'not_committed'); assert.equal(f.writes.length, 0)
})
test('real AI service fills missing fields, retains original manual values, never persists before explicit Save', async () => {
  const f = fixture(), a = f.actions(), draft = await a.classificationGet({ bookId: 'b1' })
  const request = payload(draft)
  request.classification.topics.push({ value: '算法', source: 'manual', locked: true })
  globalThis.__aiCalls = 0
  globalThis.__aiResponse = JSON.stringify({ status: 'classified', category: { value: 'computing-ai', evidence: '研究计算机算法与程序设计' },
    topics: [{ value: '系统结构', evidence: '计算机系统的组织结构' }], feature: null, facets: {} })
  const generated = await a.aiClassify(request)
  assert.equal(generated.code, 'classification_generated'); assert.equal(globalThis.__aiCalls, 1)
  assert.equal(generated.saved, false); assert.equal(f.writes.length, 0)
  assert.deepEqual(generated.classification.topics[0], request.classification.topics[0])
  assert.equal(generated.classification.topics[1].source, 'ai')
  assert.equal(generated.sourceDescription, f.book.description)
  assert.deepEqual(generated.originalClassification.legacyTags, f.book.tags)
  const saved = await a.classificationSave(payload(generated, { confirmSave: true }))
  assert.equal(saved.classification.topics[1].source, 'ai'); assert.equal(f.writes.length, 1)
})
test('real AI malformed/ungrounded response fails once; manual editor input is recoverable, no writes', async () => {
  const f = fixture(), a = f.actions(), draft = await a.classificationGet({ bookId: 'b1' })
  const request = payload(draft); request.classification.topics.push({ value: '算法', source: 'manual', locked: false })
  globalThis.__aiCalls = 0; globalThis.__aiResponse = JSON.stringify({ status: 'classified', category: { value: 'computing-ai', evidence: 'NOT IN SOURCE' }, topics: [], feature: null, facets: {} })
  const failed = await a.aiClassify(request)
  assert.equal(failed.code, 'invalid-output'); assert.equal(globalThis.__aiCalls, 1); assert.equal(f.writes.length, 0)
  assert.deepEqual(failed.classification.topics, request.classification.topics)
})
test('session expiry/capacity bounded without evicting another unsaved draft', async () => {
  const f = fixture(), a = f.actions(); const draft = await a.classificationGet({ bookId: 'b1' })
  for (let i = 1; i < 16; i++) assert.equal((await a.classificationGet({ bookId: 'b1' })).ok, true)
  assert.equal((await a.classificationGet({ bookId: 'b1' })).code, 'session_capacity')
  f.advance(16 * 60_000)
  assert.equal((await a.aiClassify(payload(draft))).code, 'session_expired')
})
test('existing note drafts recover; canonical book/annotation supply exact context/quote/CFI/format; no annotation writes', async () => {
  const f = fixture(), a = f.actions()
  saveNoteDraft({ bookId: 'b1', contextId: 'anno:a1', quote: 'ORIGINAL QUOTE', sourceLoc: 'epubcfi(/6/2)' }, 'existing draft', f.deps.draftEnv)
  const r = await a.noteDraftGet({ bookId: 'b1', id: 'a1' })
  assert.equal(r.code, 'draft_recovered'); assert.equal(r.draft.text, 'existing draft'); assert.equal(r.format, 'epub')
  const save = await a.noteDraftSave({ bookId: 'b1', id: 'a1', text: 'new draft', quote: 'FORGED', sourceLoc: 'FORGED' })
  assert.equal(save.savedAnnotation, false); assert.equal(save.draft.quote, 'ORIGINAL QUOTE'); assert.equal(save.draft.sourceLoc, 'epubcfi(/6/2)')
  assert.equal(f.notes[0].note, 'saved thought'); assert.equal(f.notes[0].text, 'ORIGINAL QUOTE')
  assert.equal((await a.noteDraftList({})).drafts.length, 1)
  assert.equal((await a.noteDraftDiscard({ bookId: 'b1', id: 'a1' })).code, 'confirmation_required')
  assert.equal((await a.noteDraftDiscard({ bookId: 'b1', id: 'a1', confirmDiscard: true })).code, 'draft_discarded')
  assert.equal(loadNoteDraft({ bookId: 'b1', contextId: 'anno:a1' }, f.deps.draftEnv).error, 'not_found')
})
test('draft failures preserve text; corrupt/query failures never become empty datasets; no raw errors', async () => {
  const f = fixture(), a = f.actions(); f.journal.quota = true
  const r = await a.noteDraftSave({ bookId: 'b1', id: 'a1', text: 'RECOVER_ME' })
  assert.equal(r.code, 'quota_exceeded'); assert.equal(r.textRecoverable, 'RECOVER_ME')
  f.journal.quota = false; f.journal.setItem(buildDraftKey('b1', 'anno:a1'), '{bad JSON')
  assert.equal((await a.noteDraftGet({ bookId: 'b1', id: 'a1' })).code, 'corrupt_payload')
  const list = await a.noteDraftList({}); assert.equal(list.ok, false); assert.equal('drafts' in list, false)
  f.storage.listAnnotations = async () => { throw new Error('PRIVATE_DB_FAILURE') }
  const failed = await a.noteDraftGet({ bookId: 'b1', id: 'a1' })
  assert.equal(failed.ok, false); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false)
})
test('draft Save busy or settings failures retain input; discard cannot race an in-flight save', async () => {
  const f = fixture()
  let release
  const pending = new Promise(resolve => { release = resolve })
  const a = f.actions({ storage: async () => { await pending; return f.storage } })
  const saving = a.noteDraftSave({ bookId: 'b1', id: 'a1', text: 'FIRST' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await a.noteDraftSave({ bookId: 'b1', id: 'a1', text: 'SECOND' })).textRecoverable, 'SECOND')
  assert.equal((await a.noteDraftDiscard({ bookId: 'b1', id: 'a1', confirmDiscard: true })).code, 'busy')
  release(); assert.equal((await saving).code, 'draft_saved')
  const blocked = f.actions({ settingsReady: async () => ({ unsavedPaths: [['reader']], failedCommits: [] }) })
  assert.equal((await blocked.noteDraftSave({ bookId: 'b1', id: 'a1', text: 'RECOVER' })).textRecoverable, 'RECOVER')
})
test('backup metadata-only preview is noncommitting, commit requires matching token + explicit confirm, truthful real File', async () => {
  const f = fixture(), a = f.actions(), preview = await a.backupImport({ mode: 'preview' })
  assert.equal(preview.code, 'backup_preview'); assert.equal(preview.contentValidated, false); assert.equal(preview.size, 3)
  assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === 'restore'), false)
  assert.ok(f.calls.includes('closed'))
  assert.equal((await a.backupImport({ mode: 'commit', token: preview.token })).code, 'confirmation_required')
  assert.equal((await a.backupImport({ mode: 'commit', token: 'wrong', confirm: true })).code, 'session_expired')
  const result = await a.backupImport({ mode: 'commit', token: preview.token, confirm: true })
  assert.equal(result.code, 'backup_restored'); assert.equal(result.progress.books, 1)
  assert.equal((await a.backupImport({ mode: 'commit', token: preview.token, confirm: true })).code, 'session_expired')
})
test('backup bounded reads reject >64 MiB and release handles, never use readFile/unbounded buffers', async () => {
  let closed = 0, requested = 0
  const a = fixture().actions({ openRead: async () => ({ async read(bytes) { requested += bytes.length; return bytes.length }, async close() { closed++ } }) })
  const result = await a.backupImport({})
  assert.equal(result.code, 'payload_too_large'); assert.equal(closed, 1)
  assert.equal(requested, ARCHIVE_LIMITS.archiveBytes + 1)
})
test('partial restore reports confirmed progress + unknown failed commit; no rollback/replay claim', async () => {
  let calls = 0
  const a = fixture().actions({ restore: async () => { calls++; throw Object.assign(new Error('PRIVATE failing record'), { name: 'ArchiveRestoreError', progress: { books: 1, annotations: 0, rawData: 'PRIVATE_PROGRESS' } }) } })
  const preview = await a.backupImport({})
  const request = { mode: 'commit', token: preview.token, confirm: true }
  const failed = await a.backupImport(request)
  assert.equal(failed.code, 'partial_restore'); assert.deepEqual(failed.progress, { books: 1, annotations: 0 })
  assert.equal(failed.outcome, 'unknown'); assert.equal(failed.rollbackPerformed, false)
  assert.equal(JSON.stringify(failed).includes('PRIVATE'), false)
  assert.equal((await a.backupImport(request)).code, 'restore_outcome_unknown'); assert.equal(calls, 1)
  assert.equal((await a.backupImport({ mode: 'discard', token: preview.token })).code, 'selection_discarded')
})
test('scoped TypeScript check uses real declarations, no shared build/cache writes', async () => {
  const ts = (await import('typescript')).default
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const file = resolve(root, 'src/services/nativeManagementActions.ts')
  const options = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, noUnusedLocals: true, noUnusedParameters: true,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['vite/client'], noUncheckedIndexedAccess: true }
  const host = ts.createCompilerHost(options)
  const program = ts.createProgram([file], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => !d.file || resolve(d.file.fileName) === file)
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n' })
  const cache = resolve(root, '../.cache/native-management-actions')
  mkdirSync(cache, { recursive: true }); writeFileSync(resolve(cache, 'typecheck.txt'), formatted || 'Adapter scoped typecheck: 0 diagnostics\n')
  assert.equal(diagnostics.length, 0, formatted)
})

test('production defaults delegate to canonical owners, never mount pages or create DB/journal', () => {
  const source = readFileSync(new URL('../src/services/nativeManagementActions.ts', import.meta.url), 'utf8')
  for (const required of ['importNativeUriFiles(paths, source)', 'generateBookClassification(book)', 'reloadNativeSettings()', 'flushNativeSettings()', 'exportBackupToSink', 'importBackup(file)', 'selectMonitoredFolder()', 'useFolderLibrary()']) assert.ok(source.includes(required), required)
  for (const forbidden of ['createApp(', 'indexedDB.open', 'new Dexie', 'localStorage.setItem', '@JavascriptInterface', 'console.', 'readFile(']) assert.equal(source.includes(forbidden), false, forbidden)
  assert.doesNotThrow(() => parseClassification(createClassification(['manual original'])))
})
