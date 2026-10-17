export interface CoverUrlCacheOptions {
  /** Transfers exclusive ownership of each newly created URL, even after abort.
   * Must eventually settle; honor signal when possible. Never return a shared URL.
   * Undefined means no cover; I/O failures must reject. */
  load(id: string, signal: AbortSignal): Promise<string | undefined>
  /** Synchronous, non-throwing URL.revokeObjectURL equivalent. */
  revoke(url: string): void
  maxEntries?: number
  maxConcurrent?: number
}

export interface CoverUrlLease {
  /** Cancellation (release/dispose before settlement) resolves undefined.
   * Load failures reject. A settled URL is valid only while this lease is held. */
  ready: Promise<string | undefined>
  release(): void
}

interface Subscriber {
  resolve(url: string | undefined): void
  reject(error: unknown): void
}
interface Entry {
  id: string
  state: 'queued' | 'loading' | 'ready'
  controller: AbortController
  subscribers: Set<Subscriber>
  url?: string
  touched: number
}

/**
 * Sole owner of loaded object URLs. Capacity includes queued/loading entries;
 * when every slot is leased, acquire rejects via ready (RangeError), not an
 * unbounded overflow queue. Only idle entries are LRU-evicted.
 * dispose cancels pending leases but retains already published URLs until their
 * last release. Cancelled loaders still occupy physical concurrency until settled.
 */
export function createCoverUrlCache(options: CoverUrlCacheOptions) {
  const { load, revoke, maxEntries = 32, maxConcurrent = 2 } = options
  for (const value of [maxEntries, maxConcurrent]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Cache limits must be positive safe integers')
  }
  const entries = new Map<string, Entry>()
  let running = 0
  let clock = 0
  let disposed = false

  function remove(entry: Entry) {
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    entry.controller.abort()
    if (entry.url !== undefined) {
      const url = entry.url
      entry.url = undefined
      revoke(url)
    }
  }

  function pump() {
    if (disposed) return
    for (const entry of entries.values()) {
      if (running >= maxConcurrent) break
      if (entry.state !== 'queued') continue
      entry.state = 'loading'
      running++
      void Promise.resolve().then(() => {
        if (entry.controller.signal.aborted) return undefined
        return load(entry.id, entry.controller.signal)
      }).then(url => {
        if (disposed || entries.get(entry.id) !== entry || entry.subscribers.size === 0) {
          if (url !== undefined) revoke(url)
          return
        }
        entry.state = 'ready'
        entry.url = url
        for (const subscriber of entry.subscribers) subscriber.resolve(url)
      }, error => {
        for (const subscriber of entry.subscribers) subscriber.reject(error)
        remove(entry)
      }).finally(() => {
        running--
        pump()
      })
    }
  }

  function acquire(id: string): CoverUrlLease {
    if (disposed) return { ready: Promise.resolve(undefined), release() {} }
    let entry = entries.get(id)
    if (!entry) {
      if (entries.size >= maxEntries) {
        let oldest: Entry | undefined
        for (const candidate of entries.values()) {
          if (!candidate.subscribers.size && (!oldest || candidate.touched < oldest.touched)) oldest = candidate
        }
        if (oldest) remove(oldest)
        else return { ready: Promise.reject(new RangeError('Cover cache capacity is fully leased')), release() {} }
      }
      entry = { id, state: 'queued', controller: new AbortController(), subscribers: new Set(), touched: ++clock }
      entries.set(id, entry)
    }
    const owned = entry
    let subscriber: Subscriber
    const ready = new Promise<string | undefined>((resolve, reject) => {
      subscriber = { resolve, reject }
      owned.subscribers.add(subscriber)
      if (owned.state === 'ready') resolve(owned.url)
    })
    owned.touched = ++clock
    let released = false
    pump()
    return {
      ready,
      release() {
        if (released) return
        released = true
        owned.subscribers.delete(subscriber)
        subscriber.resolve(undefined)
        owned.touched = ++clock
        if (!owned.subscribers.size && (disposed || owned.state !== 'ready')) remove(owned)
      },
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const entry of entries.values()) {
      if (entry.state !== 'ready') {
        for (const subscriber of entry.subscribers) subscriber.resolve(undefined)
        entry.subscribers.clear()
        remove(entry)
      } else if (!entry.subscribers.size) remove(entry)
    }
  }

  function stats() {
    let queued = 0
    let references = 0
    let urls = 0
    for (const entry of entries.values()) {
      if (entry.state === 'queued') queued++
      references += entry.subscribers.size
      if (entry.url !== undefined) urls++
    }
    return { entries: entries.size, queued, loading: running, references, urls, disposed }
  }
  return { acquire, dispose, stats }
}
