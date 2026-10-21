/** Android owns parsing, covers and SQLite commits after the staged batch is admitted. */
import { invoke } from '@tauri-apps/api/core'
import { blobChunks } from '../storage/blobStream.ts'
import { getLibraryRoot } from '../storage/types.ts'
import { toBase64Chunk } from './base64.ts'
import { withNativeFileJob } from './nativeFileJobs.ts'
import type { FileJobKind } from './nativeFileJobs.ts'
import type { ImportResult, LazyImportFile, MetaOverrides } from './importer'

export interface NativeBatchSummary {
  total: number; done: number; imported: number; updated: number; skipped: number; failed: number
  complete: boolean; finished?: boolean
  results: ImportResult[]
  errors: { fileName: string; code: string }[]
}
const fail = (code: string) => Object.assign(new Error(code), { code })
const UUID = /^[a-f0-9-]{36}$/
const INPUT = /^cache\/import-[a-f0-9-]{36}\.bin$/
const PENDING = 'pagewise-native-import-batch-v1'
type Journal = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type Item = { path: string; fileName: string; overrides?: MetaOverrides }
interface PendingBatch {
  version: 1; id: string; identity: string; phase: 'preparing' | 'submitted' | 'resolved'
  names: string[]; positions: number[]; early: [number, ImportResult][]; paths: string[]
  request: { items: Item[]; source: string; libraryRoot: string }
  result?: ImportResult[]
}
export function supportsNativeBookImport(): boolean {
  const host = typeof window === 'undefined' ? undefined : window as Window & { LightReadInsets?: { nativeBookImportVersion?: () => number } }
  return host?.LightReadInsets?.nativeBookImportVersion?.() === 1
}
export function validateNativeBatch(value: unknown): NativeBatchSummary {
  if (!value || typeof value !== 'object') throw fail('invalid_receipt')
  const r = value as NativeBatchSummary
  for (const key of ['total', 'done', 'imported', 'updated', 'skipped', 'failed'] as const) {
    if (!Number.isSafeInteger(r[key]) || r[key] < 0 || r[key] > 5000) throw fail('invalid_receipt')
  }
  if (r.done > r.total || r.imported + r.updated + r.skipped + r.failed !== r.done || typeof r.complete !== 'boolean'
    || (r.finished !== undefined && typeof r.finished !== 'boolean')
    || !Array.isArray(r.results) || r.results.length > 128 || !Array.isArray(r.errors) || r.errors.length > 32) throw fail('invalid_receipt')
  for (const item of r.results) {
    if (!item || typeof item.ok !== 'boolean' || typeof item.fileName !== 'string' || item.fileName.length > 255
      || (item.ok ? typeof item.bookId !== 'string' || !UUID.test(item.bookId) : typeof item.error !== 'string')) throw fail('invalid_receipt')
  }
  for (const error of r.errors) if (!error || typeof error.fileName !== 'string' || typeof error.code !== 'string') throw fail('invalid_receipt')
  if (r.complete && (r.done !== r.total || r.failed !== 0 || r.errors.length !== 0)) throw fail('invalid_receipt')
  return r
}
type Job = (kind: FileJobKind, input: { folderId: string; documentId?: string; request?: Record<string, unknown> }, consume: (result: unknown) => Promise<NativeBatchSummary>, progress?: (value: unknown) => void) => Promise<NativeBatchSummary>
export interface NativeImportByteSource {
  sourceKind: 'uri'
  uri: string
  name: string
  size: number
  lastModified: number
  chunks(): AsyncIterable<Uint8Array>
}
export type NativeImportInput = File | NativeImportByteSource
export function createNativeBookImportClient(deps: {
  job: Job; stage(file: NativeImportInput, path: string): Promise<string>; cleanup(path: string): Promise<void>; libraryRoot(): string
  journal?: Journal; cleanupBatch?(id: string, paths: string[]): Promise<void>; cancelBatch?(id: string): Promise<void>
}) {
  const memory = new Map<string, string>()
  const journal: Journal = deps.journal ?? { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v) }, removeItem: k => { memory.delete(k) } }
  let submitting = false
  function save(batch: PendingBatch) {
    const text = JSON.stringify(batch)
    if (text.length > 2 * 1024 * 1024) throw fail('resource_limit')
    journal.setItem(PENDING, text)
  }
  function pending(): PendingBatch | null {
    const text = journal.getItem(PENDING)
    if (!text) return null
    if (text.length > 2 * 1024 * 1024) throw fail('invalid_receipt')
    let value: PendingBatch
    try { value = JSON.parse(text) } catch { throw fail('invalid_receipt') }
    if (!value || value.version !== 1 || !UUID.test(value.id) || typeof value.identity !== 'string'
      || !['preparing', 'submitted', 'resolved'].includes(value.phase) || !Array.isArray(value.names) || value.names.length > 128
      || value.names.some(name => typeof name !== 'string') || !Array.isArray(value.paths) || value.paths.length > 128 || value.paths.some(path => !INPUT.test(path))
      || !value.request || !Array.isArray(value.request.items) || value.request.items.length > 128
      || !Array.isArray(value.positions) || !Array.isArray(value.early)) throw fail('invalid_receipt')
    const validPosition = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < value.names.length
    const validResult = (r: ImportResult, name: string) => r && typeof r.ok === 'boolean' && r.fileName === name
      && (r.ok ? typeof r.bookId === 'string' && UUID.test(r.bookId) : typeof r.error === 'string')
    if (typeof value.request.source !== 'string' || value.request.libraryRoot !== ''
      || new Set(value.paths).size !== value.paths.length || value.positions.length !== value.request.items.length
      || value.positions.some(n => !validPosition(n)) || new Set(value.positions).size !== value.positions.length) throw fail('invalid_receipt')
    const assigned = new Map<number, string>()
    for (const [i, item] of value.request.items.entries()) {
      if (!item || typeof item.fileName !== 'string' || !value.paths.includes(item.path)) throw fail('invalid_receipt')
      assigned.set(value.positions[i], item.fileName)
    }
    if (new Set(value.request.items.map(item => item.path)).size !== value.request.items.length) throw fail('invalid_receipt')
    for (const entry of value.early) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validPosition(entry[0]) || assigned.has(entry[0])
        || !validResult(entry[1], value.names[entry[0]]) || entry[1].ok) throw fail('invalid_receipt')
      assigned.set(entry[0], value.names[entry[0]])
    }
    if (value.phase !== 'preparing' && assigned.size !== value.names.length) throw fail('invalid_receipt')
    if (value.phase === 'resolved' && (!Array.isArray(value.result) || value.result.length !== value.names.length
      || value.result.some((r, i) => !validResult(r, assigned.get(i)!)))) throw fail('invalid_receipt')
    return value
  }
  async function cleanup(batch: PendingBatch) {
    if (deps.cleanupBatch) await deps.cleanupBatch(batch.id, batch.paths)
    else for (const path of batch.paths) await deps.cleanup(path)
    journal.removeItem(PENDING)
  }
  function combine(batch: PendingBatch, result: NativeBatchSummary, stopped?: string): ImportResult[] {
    const items = batch.request.items
    if (result.total !== items.length || result.results.length !== result.done || result.updated !== 0
      || result.results.filter(r => !r.ok).length !== result.failed
      || result.results.some((r, i) => r.fileName !== items[i].fileName)
      || (!stopped && result.done !== items.length)) throw fail('invalid_receipt')
    const all = new Map(batch.early)
    for (let i = 0; i < items.length; i++) all.set(batch.positions[i], result.results[i] ?? { ok: false, fileName: items[i].fileName, error: stopped! })
    return batch.names.map((_, index) => all.get(index) ?? (() => { throw fail('invalid_receipt') })())
  }
  async function resumeBatch(batch: PendingBatch, onProgress?: (done: number, total: number, current: string) => void): Promise<ImportResult[] | null> {
    if (batch.phase === 'preparing') { await cleanup(batch); return null }
    if (batch.phase !== 'resolved') {
      let result: NativeBatchSummary
      let stopped: string | undefined
      try {
        result = await deps.job('import', { folderId: 'app-import', documentId: batch.id, request: batch.request }, async value => validateNativeBatch(value), value => {
          const p = validateNativeBatch(value)
          onProgress?.(batch.early.length + p.done, batch.names.length, p.results.at(-1)?.fileName ?? '')
        })
      } catch (error) {
        const e = error as { code?: string; progress?: unknown; progressError?: string }
        if (e.progressError) throw error
        if (e.progress !== undefined && validateNativeBatch(e.progress).finished) result = validateNativeBatch(e.progress)
        else if (['cancelled', 'timeout', 'background_start_denied'].includes(e.code ?? '')) {
          stopped = e.code
          result = e.progress !== undefined ? validateNativeBatch(e.progress) : { total: batch.request.items.length, done: 0, imported: 0, updated: 0, skipped: 0, failed: 0, complete: false, results: [], errors: [] }
        } else throw error
      }
      batch.result = combine(batch, result, stopped)
      batch.phase = 'resolved'
      // Preserve the result before releasing anything; a rebuilt WebView can finish this exact request.
      save(batch)
    }
    const result = batch.result
    if (!Array.isArray(result) || result.length !== batch.names.length) throw fail('invalid_receipt')
    try { await cleanup(batch) } catch (error) { console.error('Native batch input cleanup pending', error) }
    onProgress?.(batch.names.length, batch.names.length, '')
    return result
  }
  async function index(folderId: string, force: boolean): Promise<NativeBatchSummary> {
    if (deps.libraryRoot()) throw fail('unsupported_library_root')
    return deps.job('index', { folderId, request: { force, libraryRoot: '' } }, async value => validateNativeBatch(value))
  }
  async function resume(onProgress?: (done: number, total: number, current: string) => void) {
    if (deps.libraryRoot()) throw fail('unsupported_library_root')
    if (submitting) throw fail('busy')
    submitting = true
    try { const batch = pending(); return batch ? await resumeBatch(batch, onProgress) : null } finally { submitting = false }
  }
  async function abandon() {
    if (submitting) throw fail('busy')
    const batch = pending()
    if (!batch) return
    await deps.cancelBatch?.(batch.id)
    await cleanup(batch) // Native cleanup rejects while any worker can still consume these inputs.
  }
  async function files(inputs: Iterable<NativeImportInput | LazyImportFile>, source = '本地导入', overrides?: MetaOverrides,
    onProgress?: (done: number, total: number, current: string) => void): Promise<ImportResult[]> {
    if (deps.libraryRoot()) throw fail('unsupported_library_root')
    if (submitting) throw fail('busy')
    submitting = true
    try {
      const list = Array.from(inputs)
      if (list.length > 128) throw fail('resource_limit')
      if (!list.length) return []
      // Metadata identifies a retry of an unresolved UI request; it is not content deduplication.
      const identity = JSON.stringify([source, overrides ?? null, list.map(f => 'load' in f ? [f.name] : 'sourceKind' in f ? [f.name, f.size, f.lastModified, f.sourceKind, f.uri] : [f.name, f.size, f.lastModified])])
      const previous = pending()
      if (previous) {
        const result = await resumeBatch(previous, previous.identity === identity ? onProgress : undefined)
        if (previous.identity === identity && result) return result
        if (pending()) throw fail('native_batch_pending')
      }
      const batch: PendingBatch = { version: 1, id: crypto.randomUUID(), identity, phase: 'preparing', names: list.map(f => f.name), positions: [], early: [], paths: [], request: { items: [], source, libraryRoot: '' } }
      save(batch)
      let bytes = 0
      for (const [position, candidate] of list.entries()) {
        onProgress?.(batch.early.length, list.length, candidate.name)
        try {
          const file = 'load' in candidate ? await candidate.load() : candidate
          if (file.size > 1024 ** 3 || bytes + file.size > 1024 ** 3) throw fail('resource_limit')
          const path = `cache/import-${crypto.randomUUID()}.bin`
          batch.paths.push(path); save(batch) // Own the path before upload, including a lost upload response.
          // A failed/lost response can still leave a full file at this owned path.
          bytes += file.size
          const staged = await deps.stage(file, path)
          if (staged !== path) throw fail('invalid_receipt')
          batch.request.items.push({ path, fileName: file.name, ...(overrides ? { overrides } : {}) })
          batch.positions.push(position)
        } catch (error) {
          batch.early.push([position, { ok: false, fileName: candidate.name, error: error instanceof Error ? error.message : '文件暂存失败' }])
        }
        save(batch)
      }
      if (!batch.request.items.length) { batch.phase = 'resolved'; batch.result = batch.names.map((_, i) => new Map(batch.early).get(i)!); save(batch) }
      else { batch.phase = 'submitted'; save(batch) }
      return (await resumeBatch(batch, onProgress)) ?? []
    } finally { submitting = false }
  }
  return { index, files, resume, abandon }
}

export async function stageNativeImportInput(file: NativeImportInput, path: string,
  send: (command: string, args: Record<string, unknown>) => Promise<unknown> = invoke): Promise<string> {
  await send('begin_import_file', { path })
  const reader = 'sourceKind' in file ? null : blobChunks(file).getReader()
  const chunks = 'sourceKind' in file ? file.chunks() : (async function* () {
    try { for (;;) { const { done, value } = await reader!.read(); if (done) break; yield value } }
    finally { reader!.releaseLock() }
  })()
  let copied = 0
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > 2 * 1024 * 1024 || copied + chunk.byteLength > file.size) throw fail('source_changed')
    copied += chunk.byteLength
    await send('append_import_file', { path, data: toBase64Chunk(chunk) })
  }
  if (copied !== file.size) throw fail('source_changed')
  return path
}

export interface NativeUriHandle {
  stat(): Promise<{ size: number; mtime: Date | null; isDirectory: boolean }>
  read(buffer: Uint8Array): Promise<number | null>
  close(): Promise<void>
}
export interface NativeUriImportIo {
  name(path: string): Promise<string>
  open(path: string): Promise<NativeUriHandle>
}

/** Actual URI/file handles, never a fabricated File or a whole-book JS allocation. */
export async function prepareNativeUriInputs(paths: string[], io: NativeUriImportIo): Promise<NativeImportByteSource[]> {
  if (!Array.isArray(paths) || paths.length > 128 || paths.some(path => typeof path !== 'string' || !path || path.length > 16384)) throw fail('resource_limit')
  const result: NativeImportByteSource[] = []
  let bytes = 0
  const stamp = (stat: { size: number; mtime: Date | null; isDirectory: boolean }) => {
    const time = stat.mtime?.getTime() ?? 0
    if (stat.isDirectory || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > 1024 ** 3 || !Number.isFinite(time)) throw fail('invalid_file_metadata')
    return { size: stat.size, time }
  }
  for (const uri of paths) {
    const name = await io.name(uri)
    if (!name || name.length > 255 || /[\u0000/\\]/.test(name)) throw fail('invalid_file_name')
    const probe = await io.open(uri)
    let metadata: { size: number; time: number }
    try { metadata = stamp(await probe.stat()) } finally { await probe.close() }
    bytes += metadata.size
    if (bytes > 1024 ** 3) throw fail('resource_limit')
    result.push({
      sourceKind: 'uri', uri, name, size: metadata.size, lastModified: metadata.time,
      async *chunks() {
        const handle = await io.open(uri)
        try {
          const first = stamp(await handle.stat())
          if (first.size !== metadata.size || first.time !== metadata.time) throw fail('source_changed')
          let read = 0
          for (;;) {
            const buffer = new Uint8Array(256 * 1024)
            const count = await handle.read(buffer)
            if (count === null || count === 0) break
            if (!Number.isInteger(count) || count < 0 || count > buffer.byteLength || read + count > metadata.size) throw fail('source_changed')
            read += count
            yield buffer.subarray(0, count)
          }
          const last = stamp(await handle.stat())
          if (read !== metadata.size || last.size !== metadata.size || last.time !== metadata.time) throw fail('source_changed')
        } finally { await handle.close() }
      },
    })
  }
  return result
}

export async function importNativeUriFiles(paths: string[], source = '本地导入'): Promise<ImportResult[]> {
  if (!supportsNativeBookImport()) throw fail('unavailable')
  const [{ basename }, fs] = await Promise.all([import('@tauri-apps/api/path'), import('@tauri-apps/plugin-fs')])
  const inputs = await prepareNativeUriInputs(paths, { name: basename, open: path => fs.open(path, { read: true }) })
  return native.files(inputs, source)
}
const native = createNativeBookImportClient({
  job: (kind, input, consume, progress) => withNativeFileJob(kind, input, consume, progress), stage: stageNativeImportInput,
  cleanup: path => invoke('delete_import_file', { path }), libraryRoot: getLibraryRoot,
  journal: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) },
  cleanupBatch: async (id, paths) => {
    const result = await invoke<{ id: string; state: string }>('monitored_file_job', { action: 'cleanupImport', payload: { id, paths } })
    if (result.id !== id || result.state !== 'released') throw fail('invalid_receipt')
  },
  cancelBatch: async id => { await invoke('monitored_file_job', { action: 'cancelImport', payload: { id } }) },
})
export const indexNativeFolder = native.index
export const importNativeFiles = native.files
export const resumeNativeImports = native.resume
export const abandonNativeImports = native.abandon
export async function inspectNativeBook(folderId: string, documentId: string, fileName: string): Promise<string> {
  return withNativeFileJob('inspect', { folderId, documentId, request: { fileName } }, async value => {
    if (!value || typeof value !== 'object' || !('format' in value) || !['epub', 'mobi', 'pdf', 'txt', 'md'].includes(String(value.format))) throw fail('invalid_receipt')
    return String(value.format)
  })
}
