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
const UNKNOWN_METADATA_RECHECK = 5 * 60_000
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

export function createFolderLibrary(deps: FolderLibraryDependencies) {
  const status = shallowRef<FolderLibraryStatus>({
    state: 'unconfigured', folderLabel: '', indexed: 0, unavailable: 0, generation: 0, error: null,
  })
  let epoch = 0
  let pending = false
  let pendingForce = false
  const rechecks = new Map<string, { signature: string; at: number }>()
  let running: Promise<void> | undefined
  let subscribers = 0
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let lastForegroundScan = 0
  let readingActive = false

  async function scan(force: boolean) {
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
        rechecks.clear()
        pending = true
        pendingForce = true
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
      const known = new Map<string, BookMeta[]>()
      for (const book of books.filter(book => book.sourceRef?.folderId === folder!.id)) {
        const id = book.sourceRef!.documentId
        known.set(id, [...(known.get(id) ?? []), book])
      }
      const seen = new Set<string>()
      for (const file of listing.files.slice(0, MAX_FILES)) {
        if (!current()) return
        if (!file.documentId || seen.has(file.documentId)) { errors.push('Invalid or duplicate source identity'); continue }
        seen.add(file.documentId)
        const format = detectFormat(file.name)
        if (!format) continue
        const linked = known.get(file.documentId) ?? []
        const book = linked[0]
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
        const cacheKey = JSON.stringify([folder.id, file.documentId])
        const signature = JSON.stringify([sourceRef.version, file.name, file.relativePath])
        const remembered = rechecks.get(cacheKey)
        const unknownMetadata = file.size === null || file.modifiedAt === null
        const elapsed = remembered ? Date.now() - remembered.at : Infinity
        // Providers without version hints still get periodic content checks, but not on every poll.
        const unknownDue = unknownMetadata && (force || remembered?.signature !== signature
          || elapsed < 0 || elapsed >= UNKNOWN_METADATA_RECHECK)
        const mustParse = !book || linked.some(item => item.sourceRef?.version !== sourceRef.version
          || item.fileAvailability !== 'available') || unknownDue
        let parsed: Awaited<ReturnType<typeof prepareBookImport>> | undefined
        if (mustParse) {
          // Do not mark unseen sources missing when a foreground reader defers the pass.
          if (readingActive) { pending = true; publish('idle'); return }
          try {
            const bytes = await deps.readMonitoredFile(folder.id, file.documentId)
            if (!current()) return
            if (readingActive) { pending = true; publish('idle'); return }
            if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Unsupported source size')
            parsed = await deps.prepareBookImport(new File([new Uint8Array(bytes)], file.name), folder.label)
          } catch (error) {
            if (!current()) return
            errors.push(`${file.name}: ${errorMessage(error)}`)
            const code = errorCode(error)
            if (code === 'not_found' || code === 'permission_denied') {
              for (const item of linked) await update(item, { fileAvailability: code === 'not_found' ? 'missing' : 'permission-denied' })
            }
            continue
          }
        }
        if (!current()) return
        if (book) {
          for (const item of linked) {
            if (mustParse || item.fileName !== file.name || item.sourceRef?.relativePath !== file.relativePath
              || item.fileAvailability !== 'available') {
              // A user-confirmed relink may share a file; each record retains its own history.
              await update(item, { sourceRef, fileName: file.name, format, fileAvailability: 'available' })
            }
          }
        } else if (parsed) {
          if (!await ensureActive() || !current()) return
          const id = await storage.addReferencedBook({ ...parsed.meta, sourceRef, fileAvailability: 'available' }, parsed.cover)
          books.push({ ...parsed.meta, id, hasCover: !!parsed.cover, sourceRef, fileAvailability: 'available' })
          changed = true
        }
        if (parsed && current() && unknownMetadata) {
          rechecks.delete(cacheKey)
          if (rechecks.size >= MAX_FILES) {
            const oldest = rechecks.keys().next().value
            if (oldest !== undefined) rechecks.delete(oldest)
          }
          rechecks.set(cacheKey, { signature, at: Date.now() })
        } else if (!unknownMetadata) rechecks.delete(cacheKey)
      }
      // Partial/truncated/error results cannot prove that an unseen document disappeared.
      if (listing.complete && !errors.length) {
        for (const book of [...known.values()].flat()) {
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

  function requestScan(force: boolean): Promise<void> {
    pending = true
    pendingForce ||= force
    if (readingActive) return running ?? Promise.resolve()
    if (!running) {
      running = (async () => {
        try {
          // Hints request one follow-up, not cancellation of already confirmed writes.
          while (pending && !readingActive) {
            const force = pendingForce
            pending = false
            pendingForce = false
            await scan(force)
          }
        } finally { running = undefined }
      })()
    }
    return running
  }

  function rescan(): Promise<void> { return requestScan(true) }

  /** Integration owner sets this for reader routes; a deferred pass resumes on exit. */
  function setReadingActive(active: boolean) {
    if (readingActive === active) return
    readingActive = active
    if (!active && pending) void rescan()
  }

  async function chooseFolder() {
    try {
      const selected = await deps.selectMonitoredFolder()
      if (!selected) return
      epoch++
      rechecks.clear()
      await rescan()
    } catch (error) {
      status.value = { ...status.value, state: 'error', error: errorMessage(error) }
    }
  }

  function foreground() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (Date.now() - lastForegroundScan < 15_000) return
    lastForegroundScan = Date.now()
    void requestScan(false)
  }

  function start() {
    subscribers++
    if (subscribers === 1) {
      unsubscribe = deps.subscribeMonitoredFolderChanges(() => { void rescan() })
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
      pendingForce = false
      rechecks.clear()
      if (status.value.state === 'scanning') status.value = { ...status.value, state: 'idle' }
    }
  }

  async function relinkCandidates(bookId: string) {
    const folder = await deps.getMonitoredFolder()
    if (!folder || folder.permission !== 'granted') throw new Error('Folder permission unavailable')
    const book = await (await deps.getStorage()).getBook(bookId)
    if (!book?.sourceRef) throw new Error('Referenced book required')
    const listing = await deps.listMonitoredFiles(folder.id)
    if (!listing.complete || listing.errors.length || listing.files.length > MAX_FILES) {
      throw new Error(listing.errors.map(item => item.message || item.code).join('; ') || 'Folder enumeration incomplete')
    }
    const ids = new Set<string>()
    for (const file of listing.files) {
      if (!file.documentId || ids.has(file.documentId)) throw new Error('Invalid or duplicate source identity')
      ids.add(file.documentId)
    }
    return { folderId: folder.id, files: listing.files.filter(file => detectFormat(file.name) === book.format
      && (file.size === null || (Number.isFinite(file.size) && file.size > 0 && file.size <= MAX_FILE_BYTES))) }
  }

  async function relink(bookId: string, folderId: string, documentId: string, confirmedSameEdition: boolean) {
    if (!confirmedSameEdition) throw new Error('Same-edition confirmation required')
    if (running) throw new Error('Folder operation in progress; try again after scanning')
    const token = epoch
    const operation = async () => {
      const storage = await deps.getStorage()
      const book = await storage.getBook(bookId)
      if (!book?.sourceRef) throw new Error('Referenced book required')
      const original = JSON.stringify(book.sourceRef)
      const candidates = await relinkCandidates(bookId)
      if (candidates.folderId !== folderId) throw new Error('Monitored folder changed')
      const file = candidates.files.find(item => item.documentId === documentId)
      if (!file) throw new Error('Candidate file unavailable')
      const bytes = await deps.readMonitoredFile(folderId, documentId)
      if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Unsupported source size')
      const parsed = await deps.prepareBookImport(new File([new Uint8Array(bytes)], file.name))
      if (parsed.meta.format !== book.format) throw new Error('Book format mismatch')
      const fresh = await relinkCandidates(bookId)
      const verified = fresh.files.find(item => item.documentId === documentId)
      const current = await storage.getBook(bookId)
      if (token !== epoch || fresh.folderId !== folderId || !verified
        || verified.size !== file.size || verified.modifiedAt !== file.modifiedAt
        || verified.relativePath !== file.relativePath || verified.name !== file.name
        || JSON.stringify(current?.sourceRef) !== original) throw new Error('Source changed; select the file again')
      // Only the source pointer is replaced; bibliography, classifications and reading data are untouched.
      await storage.updateBook(bookId, { sourceRef: { folderId, documentId, relativePath: file.relativePath,
        version: JSON.stringify([file.size, file.modifiedAt]) }, fileName: file.name, fileAvailability: 'available' })
      status.value = { ...status.value, generation: status.value.generation + 1 }
    }
    running = operation()
    try { await running } finally {
      running = undefined
      if (pending) void rescan()
    }
  }

  return { status: readonly(status), chooseFolder, rescan, start, setReadingActive, relinkCandidates, relink }
}

let singleton: ReturnType<typeof createFolderLibrary> | undefined
export function useFolderLibrary() {
  if (!singleton) singleton = createFolderLibrary({ getStorage, prepareBookImport, getMonitoredFolder,
    selectMonitoredFolder, listMonitoredFiles, readMonitoredFile, subscribeMonitoredFolderChanges })
  return singleton
}
