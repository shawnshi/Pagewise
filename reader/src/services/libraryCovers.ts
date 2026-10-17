import { getStorage } from '../storage/index.ts'
import { createCoverUrlCache, type CoverUrlLease } from './coverUrlCache.ts'

let pool: ReturnType<typeof createCoverUrlCache> | undefined

/** The library page and visible statistics thumbnails share one app-lifetime pool. */
export function acquireLibraryCover(id: string): CoverUrlLease {
  pool ??= createCoverUrlCache({
    maxEntries: 32,
    maxConcurrent: 2,
    load: async (bookId, signal) => {
      const storage = await getStorage()
      return signal.aborted ? undefined : storage.getCoverUrl(bookId)
    },
    revoke: url => URL.revokeObjectURL(url),
  })
  return pool.acquire(id)
}

export function disposeLibraryCovers(): void {
  pool?.dispose()
  pool = undefined
}
