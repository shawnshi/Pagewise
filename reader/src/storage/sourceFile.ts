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

export async function readReferencedFile(ref: BookSourceRef): Promise<Blob> {
  validateSourceRef(ref)
  const { readMonitoredFile } = await import('../services/monitoredFolder')
  const bytes = await readMonitoredFile(ref.folderId, ref.documentId)
  return new Blob([new Uint8Array(bytes)])
}
