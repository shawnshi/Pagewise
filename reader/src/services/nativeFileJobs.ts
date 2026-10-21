/** Native service owns IO. Polling observes it; suspended/destroyed WebViews do not cancel the job. */
import { invoke } from '@tauri-apps/api/core'

export type FileJobKind = 'list' | 'read' | 'inspect' | 'index' | 'import'
interface JobInput { folderId: string; documentId?: string; request?: Record<string, unknown> }
interface Receipt {
  id: string
  kind: FileJobKind
  folderId: string
  documentId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  code: string
  result?: unknown
  progress?: unknown
  progressError?: string
}
type Call = (action: string, payload: Record<string, unknown>) => Promise<unknown>
type Journal = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const JOURNAL = 'pagewise-native-file-jobs-v1'
const RELEASES = 'pagewise-native-file-releases-v1'
const UUID = /^[a-f0-9-]{36}$/
const failure = (code: string) => Object.assign(new Error(`Native file job: ${code}`), { code })

export function supportsNativeFileJobs(): boolean {
  const host = typeof window === 'undefined' ? undefined : window as Window & { LightReadInsets?: { nativeFileJobsVersion?: () => number } }
  return host?.LightReadInsets?.nativeFileJobsVersion?.() === 1
}

export function createNativeFileJobClient(call: Call, journal: Journal, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  // A read receipt owns a temp file, so consumers of the same document must not share it.
  const active = new Set<string>()
  function pending(): Record<string, string> {
    const text = journal.getItem(JOURNAL)
    if (!text) return {}
    let value: unknown
    try { value = JSON.parse(text) } catch { throw failure('invalid_receipt') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16
      || Object.values(value).some(id => typeof id !== 'string' || !UUID.test(id))) throw failure('invalid_receipt')
    return value as Record<string, string>
  }
  function releases(): string[] {
    const raw = journal.getItem(RELEASES)
    let value: unknown
    try { value = raw ? JSON.parse(raw) : [] } catch { throw failure('invalid_receipt') }
    if (!Array.isArray(value) || value.length > 16 || value.some(id => typeof id !== 'string' || !UUID.test(id))) throw failure('invalid_receipt')
    return value
  }
  function forget(id: string) {
    const saved = pending()
    for (const [key, value] of Object.entries(saved)) if (value === id) delete saved[key]
    if (Object.keys(saved).length) journal.setItem(JOURNAL, JSON.stringify(saved))
    else journal.removeItem(JOURNAL)
  }
  async function release(id: string) {
    await call('ack', { id })
    forget(id)
    const remaining = releases().filter(value => value !== id)
    if (remaining.length) journal.setItem(RELEASES, JSON.stringify(remaining))
    else journal.removeItem(RELEASES)
  }
  function receipt(value: unknown, id: string, kind: FileJobKind, input: JobInput): Receipt {
    if (!value || typeof value !== 'object') throw failure('invalid_receipt')
    const item = value as Receipt
    if (item.id !== id || item.kind !== kind || item.folderId !== input.folderId || item.documentId !== (input.documentId ?? '')
      || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(item.state)
      || typeof item.code !== 'string') throw failure('invalid_receipt')
    if (item.state === 'succeeded' && !Object.hasOwn(item, 'result')) throw failure('invalid_receipt')
    return item
  }
  async function run<T>(kind: FileJobKind, input: JobInput, consume: (result: unknown) => Promise<T>, signal?: AbortSignal, onProgress?: (progress: unknown) => void): Promise<T> {
    const key = JSON.stringify([kind, input.folderId, input.documentId ?? '', ...(kind === 'index' ? [!!input.request?.force] : kind === 'inspect' ? [input.request ?? {}] : [])])
    if (active.has(key)) throw failure('busy')
    active.add(key)
    let id = '', terminal = false
    try {
      if (signal?.aborted) throw failure('cancelled')
      // One bounded reconnect pass. Cleanup failure blocks new admission instead of filling native slots.
      for (const previous of releases()) await release(previous)
      if (kind === 'inspect') {
        for (const [previousKey, previousId] of Object.entries(pending())) {
          if (previousKey === key) continue
          let envelope: unknown
          try { envelope = JSON.parse(previousKey) } catch { continue }
          if (!Array.isArray(envelope) || envelope[0] !== kind || envelope[1] !== input.folderId || envelope[2] !== (input.documentId ?? '')) continue
          // Cancel the obsolete read, but retain its identity durably until physical ACK succeeds.
          try {
            receipt(await call('status', { id: previousId }), previousId, kind, input)
            await call('cancel', { id: previousId })
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'not_found') {
              forget(previousId) // Native confirms there is no remaining job to release.
              continue
            }
            throw error
          }
          const queued = releases()
          if (!queued.includes(previousId)) {
            if (queued.length >= 16) throw failure('busy')
            journal.setItem(RELEASES, JSON.stringify([...queued, previousId]))
          }
          forget(previousId)
          await release(previousId)
        }
      }
      const saved = pending()
      const isNew = saved[key] === undefined
      id = saved[key] ?? crypto.randomUUID()
      if (isNew && Object.keys(saved).length >= 16) throw failure('busy')
      saved[key] = id
      // Persist before admission: a lost start ACK can reconnect to the same id without repeating IO.
      journal.setItem(JOURNAL, JSON.stringify(saved))
      let response: unknown
      try { response = await call('start', { id, kind, ...input }) } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        // Only a new request plus an explicit pre-admission rejection proves no job exists.
        // A lost response or a rejected reconnect must keep its original identity.
        if (isNew && ['busy', 'permission_denied', 'invalid_reference', 'resource_limit', 'unsupported_library_root'].includes(String(code))) {
          forget(id)
          throw Object.assign(failure(String(code)), { admissionRejected: true, cause: error })
        }
        throw error
      }
      let current = receipt(response, id, kind, input)
      const deadline = Date.now() + (kind === 'index' || kind === 'import' ? 930_000 : 130_000)
      while (current.state === 'queued' || current.state === 'running') {
        if (current.progress !== undefined) onProgress?.(current.progress)
        if (signal?.aborted) {
          await call('cancel', { id })
          throw failure('cancelled')
        }
        if (Date.now() >= deadline) throw failure('unavailable')
        await wait(250)
        current = receipt(await call('status', { id }), id, kind, input)
      }
      terminal = true
      if (current.progress !== undefined) onProgress?.(current.progress)
      if (current.state !== 'succeeded') throw Object.assign(failure(current.code || current.state), { progress: current.progress, progressError: current.progressError })
      return await consume(current.result)
    } finally {
      active.delete(key)
      if (terminal) {
        try {
          // Transfer to a durable release journal before dropping the live-job pointer.
          // A lost cleanup ACK must neither replay consumed bytes nor lose the cleanup identity.
          const queued = releases()
          if (!queued.includes(id)) {
            if (queued.length >= 16) throw failure('busy')
            queued.push(id)
            journal.setItem(RELEASES, JSON.stringify(queued))
          }
          forget(id)
          await release(id)
        } catch (error) {
          // Never turn an IO failure into success, or replace it with a cleanup failure.
          console.error('Native file job receipt cleanup failed', error)
        }
      }
    }
  }
  return { run }
}

let client: ReturnType<typeof createNativeFileJobClient> | undefined
export function withNativeFileJob<T>(kind: FileJobKind, input: JobInput, consume: (result: unknown) => Promise<T>, onProgress?: (progress: unknown) => void): Promise<T> {
  client ??= createNativeFileJobClient((action, payload) => invoke('monitored_file_job', { action, payload }), localStorage)
  return client.run(kind, input, consume, undefined, onProgress)
}
