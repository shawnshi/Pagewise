import { readonly, shallowRef } from 'vue'
import { getStorage, type BookMeta, type LibraryStorage } from '../storage'
import { detectFormat } from './format'
import { prepareBookImport } from './importer'
import {
  getMonitoredFolder, selectMonitoredFolder, listMonitoredFiles,
  readMonitoredFile, subscribeMonitoredFolderChanges, MONITORED_FOLDER_LIMITS,
  type MonitoredFolderDescriptor as Folder, type MonitoredFileDescriptor as SourceFile,
} from './monitoredFolder'

export interface FolderLibraryStatus {
  state: 'unconfigured' | 'idle' | 'scanning' | 'partial' | 'permission-denied' | 'error'
  folderLabel: string
  indexed: number
  unavailable: number
  generation: number
  error: string | null
}

/** The narrow shared native contract also permits synthetic providers in host tests. */
export interface FolderLibraryDependencies {
  getMonitoredFolder(): Promise<Folder | null>
  selectMonitoredFolder(): Promise<Folder | null>
  listMonitoredFiles(folderId: string): Promise<{ files: SourceFile[]; complete: boolean; errors: Array<{ code: string; message?: string }> }>
  readMonitoredFile(folderId: string, documentId: string): Promise<Uint8Array>
  subscribeMonitoredFolderChanges(listener: () => void): () => void
  getStorage(): Promise<LibraryStorage>
  prepareBookImport: typeof prepareBookImport
}

const MAX_FILES = MONITORED_FOLDER_LIMITS.files
const MAX_FILE_BYTES = MONITORED_FOLDER_LIMITS.readBytes
const FOREGROUND_INTERVAL = 60_000
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

export function createFolderLibrary(deps: FolderLibraryDependencies) {
  const status = shallowRef<FolderLibraryStatus>({
    state: 'unconfigured', folderLabel: '', indexed: 0, unavailable: 0, generation: 0, error: null,
  })
  let epoch = 0
  let pending = false
  let running: Promise<void> | undefined
  let subscribers = 0
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let lastForegroundScan = 0

  async function scan() {
    const token = epoch
    const current = () => token === epoch
    let changed = false
    let books: BookMeta[] = []
    let folder: Folder | null = null
    const publish = (state: FolderLibraryStatus['state'], error: string | null = null) => {
      if (!current()) return
      const indexed = books.filter(book => book.sourceRef?.folderId === folder?.id)
      status.value = { state, folderLabel: folder?.label ?? '', indexed: indexed.length,
        unavailable: indexed.filter(book => book.fileAvailability !== 'available').length,
        generation: status.value.generation, error }
    }
    try {
      const selected = await deps.getMonitoredFolder()
      folder = selected ? { ...selected } : null
      if (!current()) return
      if (!folder) { publish('unconfigured'); return }
      status.value = { ...status.value, state: 'scanning', folderLabel: folder.label, error: null }
      const storage = await deps.getStorage()
      books = await storage.listBooks()
      if (!current()) return
      const ensureActive = async () => {
        if (!current()) return false
        const active = await deps.getMonitoredFolder()
        if (!current()) return false
        if (active?.id === folder!.id && active.permission === folder!.permission) return true
        // Configuration notifications are best-effort; never infer that silence means unchanged.
        epoch++
        pending = true
        return false
      }
      const update = async (book: BookMeta, patch: Partial<BookMeta>) => {
        if (!await ensureActive() || !current()) return
        await storage.updateBook(book.id, patch)
        Object.assign(book, patch)
        changed = true
      }
      const deny = async () => {
        for (const book of books) {
          if (!current()) return
          if (book.sourceRef?.folderId === folder!.id && book.fileAvailability !== 'permission-denied') {
            await update(book, { fileAvailability: 'permission-denied' })
          }
        }
        publish('permission-denied', 'Folder permission lost')
      }
      if (folder.permission === 'lost') { await deny(); return }
      let listing: Awaited<ReturnType<FolderLibraryDependencies['listMonitoredFiles']>>
      try { listing = await deps.listMonitoredFiles(folder.id) } catch (error) {
        if (errorCode(error) === 'permission_denied') { await deny(); return }
        throw error
      }
      if (!await ensureActive()) return
      const errors = listing.errors.map(error => error.message || error.code)
      if (!listing.complete) errors.push('Folder enumeration incomplete')
      if (listing.files.length > MAX_FILES) errors.push(`Folder exceeds ${MAX_FILES} files`)
      const known = new Map(books.filter(book => book.sourceRef?.folderId === folder!.id)
        .map(book => [book.sourceRef!.documentId, book]))
      const seen = new Set<string>()
      for (const file of listing.files.slice(0, MAX_FILES)) {
        if (!current()) return
        if (!file.documentId || seen.has(file.documentId)) { errors.push('Invalid or duplicate source identity'); continue }
        seen.add(file.documentId)
        const format = detectFormat(file.name)
        if (!format) continue
        const book = known.get(file.documentId)
        if (file.size !== null && (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES)) {
          errors.push(`${file.name}: unsupported source size`)
          continue
        }
        if (file.modifiedAt !== null && (!Number.isFinite(file.modifiedAt) || file.modifiedAt < 0)) {
          errors.push(`${file.name}: invalid source timestamp`)
          continue
        }
        const sourceRef = { folderId: folder.id, documentId: file.documentId,
          relativePath: file.relativePath, version: JSON.stringify([file.size, file.modifiedAt]) }
        const mustParse = !book || book.sourceRef?.version !== sourceRef.version
          || file.size === null || file.modifiedAt === null
        let parsed: Awaited<ReturnType<typeof prepareBookImport>> | undefined
        if (mustParse) {
          try {
            const bytes = await deps.readMonitoredFile(folder.id, file.documentId)
            if (!current()) return
            if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Unsupported source size')
            parsed = await deps.prepareBookImport(new File([new Uint8Array(bytes)], file.name), folder.label)
          } catch (error) {
            if (!current()) return
            errors.push(`${file.name}: ${errorMessage(error)}`)
            const code = errorCode(error)
            if (book && (code === 'not_found' || code === 'permission_denied')) {
              await update(book, { fileAvailability: code === 'not_found' ? 'missing' : 'permission-denied' })
            }
            continue
          }
        }
        if (!current()) return
        if (book) {
          if (mustParse || book.fileName !== file.name || book.sourceRef?.relativePath !== file.relativePath
            || book.fileAvailability !== 'available') {
            // Existing bibliography, corrections, reading state and positions belong to the user.
            await update(book, { sourceRef, fileName: file.name, format, fileAvailability: 'available' })
          }
        } else if (parsed) {
          if (!await ensureActive() || !current()) return
          const id = await storage.addReferencedBook({ ...parsed.meta, sourceRef, fileAvailability: 'available' }, parsed.cover)
          books.push({ ...parsed.meta, id, hasCover: !!parsed.cover, sourceRef, fileAvailability: 'available' })
          changed = true
        }
      }
      // Partial/truncated/error results cannot prove that an unseen document disappeared.
      if (listing.complete && !errors.length) {
        for (const book of known.values()) {
          if (!current()) return
          if (!seen.has(book.sourceRef!.documentId) && book.fileAvailability !== 'missing') {
            await update(book, { fileAvailability: 'missing' })
          }
        }
      }
      if (!await ensureActive()) return
      publish(errors.length ? 'partial' : 'idle', errors.length ? errors.slice(0, 5).join('; ') : null)
    } catch (error) {
      publish(errorCode(error) === 'permission_denied' ? 'permission-denied' : 'error', errorMessage(error))
    } finally {
      // Earlier confirmed writes still need a refresh if configuration changed mid-pass.
      if (changed) status.value = { ...status.value, generation: status.value.generation + 1 }
    }
  }

  function rescan(): Promise<void> {
    pending = true
    if (!running) {
      running = (async () => {
        try {
          // One queued pass absorbs all requests received during the current pass.
          while (pending) { pending = false; await scan() }
        } finally { running = undefined }
      })()
    }
    return running
  }

  async function chooseFolder() {
    try {
      const selected = await deps.selectMonitoredFolder()
      if (!selected) return
      epoch++
      await rescan()
    } catch (error) {
      status.value = { ...status.value, state: 'error', error: errorMessage(error) }
    }
  }

  function foreground() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (Date.now() - lastForegroundScan < 15_000) return
    lastForegroundScan = Date.now()
    void rescan()
  }

  function start() {
    subscribers++
    if (subscribers === 1) {
      unsubscribe = deps.subscribeMonitoredFolderChanges(() => { epoch++; void rescan() })
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', foreground)
      if (typeof window !== 'undefined') window.addEventListener('focus', foreground)
      timer = setInterval(foreground, FOREGROUND_INTERVAL)
      lastForegroundScan = Date.now()
      void rescan()
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (--subscribers) return
      unsubscribe?.()
      unsubscribe = undefined
      clearInterval(timer)
      timer = undefined
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', foreground)
      if (typeof window !== 'undefined') window.removeEventListener('focus', foreground)
      epoch++
      pending = false
      if (status.value.state === 'scanning') status.value = { ...status.value, state: 'idle' }
    }
  }

  return { status: readonly(status), chooseFolder, rescan, start }
}

let singleton: ReturnType<typeof createFolderLibrary> | undefined
export function useFolderLibrary() {
  if (!singleton) singleton = createFolderLibrary({ getStorage, prepareBookImport, getMonitoredFolder,
    selectMonitoredFolder, listMonitoredFiles, readMonitoredFile, subscribeMonitoredFolderChanges })
  return singleton
}
