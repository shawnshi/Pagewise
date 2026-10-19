import type { BookSourceRef, FileAvailability } from './types'

export function validateSourceRef(value: unknown): BookSourceRef {
  if (!value || typeof value !== 'object') throw new Error('Invalid book source reference')
  const ref = value as Record<string, unknown>
  if (typeof ref.folderId !== 'string' || !ref.folderId
    || typeof ref.documentId !== 'string' || !ref.documentId
    || typeof ref.relativePath !== 'string' || typeof ref.version !== 'string') {
    throw new Error('Invalid book source reference')
  }
  return { folderId: ref.folderId, documentId: ref.documentId, relativePath: ref.relativePath, version: ref.version }
}

export function validateAvailability(value: unknown): FileAvailability | undefined {
  if (value == null) return undefined
  if (value === 'available' || value === 'missing' || value === 'permission-denied') return value
  throw new Error('Invalid file availability')
}

/**
 * Android SAF 原生适配器同一时间只允许一个 list/read/watch；后台扫描仍在进行时，
 * 打开书会瞬时收到 busy。这里按短退避重试，不把一次正常竞争变成“打开失败”。
 */
export const BUSY_RETRY_MS: readonly number[] = [120, 250, 500, 800, 1200, 1600]

/** 纯重试策略 (可单测): 只重试带 code='busy' 的错误, 其他错误立即上抛。 */
export async function retryWhileBusy<T>(
  run: () => Promise<T>,
  delays: readonly number[] = BUSY_RETRY_MS,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code !== 'busy' || attempt >= delays.length) throw error
      await sleep(delays[attempt])
    }
  }
}

export async function readReferencedFile(ref: BookSourceRef): Promise<Blob> {
  validateSourceRef(ref)
  const { readMonitoredFile } = await import('../services/monitoredFolder')
  const bytes = await retryWhileBusy(() => readMonitoredFile(ref.folderId, ref.documentId))
  return new Blob([new Uint8Array(bytes)])
}
