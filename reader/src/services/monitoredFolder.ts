/** Read-only SAF IO. Browser preview has no persistent directory capability. */
export interface MonitoredFolderDescriptor {
  id: string
  label: string
  permission: 'granted' | 'lost'
}
export interface MonitoredFileDescriptor {
  documentId: string
  name: string
  relativePath: string
  size: number | null
  modifiedAt: number | null
}
export interface MonitoredFolderListing {
  files: MonitoredFileDescriptor[]
  complete: boolean
  errors: Array<{ code: string; message?: string }>
}
export type MonitoredFolderErrorCode = 'permission_denied' | 'not_found' | 'unavailable' | 'invalid_reference' | 'io_error' | 'busy'
export class MonitoredFolderError extends Error {
  readonly code: MonitoredFolderErrorCode
  constructor(code: MonitoredFolderErrorCode, message: string = code) { super(message); this.name = 'MonitoredFolderError'; this.code = code }
}

export const MONITORED_FOLDER_LIMITS = { files: 5000, depth: 8, readBytes: 64 * 1024 * 1024 } as const
const supported = /\.(epub|mobi|pdf|txt|md|markdown)$/i
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value)
const folderId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
function invalid(): never { throw new MonitoredFolderError('invalid_reference') }
function badResponse(): never { throw new MonitoredFolderError('io_error', 'Invalid folder provider response') }
function descriptor(value: unknown): MonitoredFolderDescriptor | null {
  if (value === null) return null
  if (!object(value) || !folderId(value.id) || !opaque(value.label) || (value.permission !== 'granted' && value.permission !== 'lost')) return badResponse()
  return { id: value.id, label: value.label, permission: value.permission }
}
function file(value: unknown): MonitoredFileDescriptor {
  if (!object(value) || !opaque(value.documentId) || !opaque(value.name) || /[\\/]/.test(value.name) || !opaque(value.relativePath)) return badResponse()
  const parts = value.relativePath.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part)) || parts.at(-1) !== value.name || parts.length > MONITORED_FOLDER_LIMITS.depth + 1) return badResponse()
  const numeric = (n: unknown): n is number | null => n === null || (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
  if (!numeric(value.size) || !numeric(value.modifiedAt)) return badResponse()
  return { documentId: value.documentId, name: value.name, relativePath: value.relativePath, size: value.size, modifiedAt: value.modifiedAt }
}
function normalize(error: unknown): MonitoredFolderError {
  if (error instanceof MonitoredFolderError) return error
  if (object(error)) {
    switch (error.code) {
      case 'permission_denied': case 'not_found': case 'unavailable':
      case 'invalid_reference': case 'io_error': case 'busy':
        return new MonitoredFolderError(error.code)
      case 'resource_limit': return new MonitoredFolderError('unavailable', 'File exceeds the monitored-folder read limit')
    }
  }
  return new MonitoredFolderError('io_error')
}

/** Transport seam for deterministic host tests; production never accepts arbitrary paths/URIs. */
export interface MonitoredFolderTransport {
  get(): Promise<unknown>
  select(): Promise<unknown>
  list(folderId: string): Promise<unknown>
  read(folderId: string, documentId: string): Promise<Uint8Array>
  watch(listener: () => void): Promise<() => void>
}
export function createMonitoredFolderService(transport: MonitoredFolderTransport) {
  const listeners = new Set<() => void>()
  let pendingSelection = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchPending = false
  let stopWatch: (() => void) | undefined
  const notify = () => {
    if (!listeners.size || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      for (const listener of [...listeners]) if (listeners.has(listener)) listener()
    }, 250)
  }
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action() } catch (error) { throw normalize(error) }
  }
  return {
    getMonitoredFolder: () => run(async () => descriptor(await transport.get())),
    selectMonitoredFolder: () => run(async () => {
      if (pendingSelection) throw new MonitoredFolderError('busy')
      pendingSelection = true
      try {
        const result = descriptor(await transport.select())
        if (result !== null) notify()
        return result
      } finally { pendingSelection = false }
    }),
    listMonitoredFiles: (id: string) => run(async (): Promise<MonitoredFolderListing> => {
      if (!folderId(id)) invalid()
      const result = await transport.list(id)
      if (!object(result) || !Array.isArray(result.files) || result.files.length > MONITORED_FOLDER_LIMITS.files || typeof result.complete !== 'boolean' || !Array.isArray(result.errors) || result.errors.length > 32) return badResponse()
      const files = result.files.map(file)
      if (new Set(files.map(f => f.documentId)).size !== files.length) return badResponse()
      const errors = result.errors.map(value => {
        if (!object(value) || typeof value.code !== 'string' || !/^[a-z_]{1,64}$/.test(value.code)) return badResponse()
        return { code: value.code }
      })
      if (!result.complete && !errors.length) errors.push({ code: 'incomplete' })
      return { files: files.filter(f => supported.test(f.name)), complete: result.complete && !errors.length, errors }
    }),
    readMonitoredFile: (id: string, documentId: string) => run(async () => {
      if (!folderId(id) || !opaque(documentId)) invalid()
      const bytes = await transport.read(id, documentId)
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MONITORED_FOLDER_LIMITS.readBytes) return badResponse()
      return bytes
    }),
    subscribeMonitoredFolderChanges(listener: () => void) {
      if (listeners.size >= 32) throw new MonitoredFolderError('busy', 'Too many folder subscriptions')
      // Each subscription owns its callback even if the same function is supplied twice.
      const entry = () => listener()
      listeners.add(entry)
      if (!watchPending && !stopWatch) {
        watchPending = true
        void transport.watch(notify).then(stop => {
          watchPending = false
          if (!listeners.size) stop()
          else stopWatch = stop
        }, () => { watchPending = false; notify() })
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(entry)
        if (!listeners.size) {
          stopWatch?.(); stopWatch = undefined
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
        }
      }
    },
  }
}

const native = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export function monitoredFolderCapabilities() {
  return { supported: native(), persistence: native() ? 'android-saf' : 'none', changes: native() ? 'foreground-best-effort' : 'none' } as const
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!native()) throw new MonitoredFolderError('unavailable', 'Persistent folders require the Android app')
  return (await import('@tauri-apps/api/core')).invoke<T>(command, args)
}
let observerUpdates: Promise<unknown> = Promise.resolve()
function updateObserver(enabled: boolean) {
  const next = observerUpdates.then(() => invoke('watch_monitored_folder', { enabled }))
  // Serialize teardown before the next registration, including during rapid stop/start.
  observerUpdates = next.catch(() => {})
  return next
}
const service = createMonitoredFolderService({
  get: () => native() ? invoke('get_monitored_folder') : Promise.resolve(null),
  select: () => invoke('select_monitored_folder'),
  list: id => invoke('list_monitored_files', { folderId: id }),
  read: async (id, documentId) => {
    const result = await invoke<{ data: string }>('read_monitored_file', { folderId: id, documentId })
    if (!object(result) || typeof result.data !== 'string' || result.data.length > Math.ceil(MONITORED_FOLDER_LIMITS.readBytes / 3) * 4) return badResponse()
    const decoded = atob(result.data)
    return Uint8Array.from(decoded, char => char.charCodeAt(0))
  },
  watch: async listener => {
    if (!native()) return () => {}
    const visible = () => { if (document.visibilityState === 'visible') listener() }
    window.addEventListener('pagewise-monitored-folder-change', listener)
    document.addEventListener('visibilitychange', visible)
    let stopped = false
    // Native observer registration is best-effort; foreground rescans remain the oracle.
    const registration = updateObserver(true)
    void registration.catch(() => { if (!stopped) listener() })
    return () => {
      stopped = true
      window.removeEventListener('pagewise-monitored-folder-change', listener)
      document.removeEventListener('visibilitychange', visible)
      void updateObserver(false).catch(() => {})
    }
  },
})
export const { getMonitoredFolder, selectMonitoredFolder, listMonitoredFiles, readMonitoredFile, subscribeMonitoredFolderChanges } = service
