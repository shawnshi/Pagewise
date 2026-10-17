import { detectFormat, isFoliateNative } from './format.ts'

type BookOpener<T> = (file: File) => Promise<T>

/**
 * Some mobile document providers fail random reads of a selected File. Retry the
 * ZIP directory read against an owned in-memory copy, without repairing or accepting
 * genuinely truncated archives. Keep the normal path lazy for large books.
 */
export async function openBookWithFileFallback<T>(file: File, openBook: BookOpener<T>): Promise<T> {
  try {
    return await openBook(file)
  } catch (error) {
    if (!(error instanceof Error) || !/^(?:End of central directory|Central directory header) not found$/i.test(error.message)) throw error
    const buffer = await file.arrayBuffer()
    if (buffer.byteLength !== file.size) throw error
    const copy = new File([buffer], file.name, { type: file.type, lastModified: file.lastModified })
    return await openBook(copy)
  }
}

/** Shared opening path for metadata import and the reader. */
export async function makeFoliateBook(file: File) {
  const format = detectFormat(file.name)
  if (!format || !isFoliateNative(format)) throw new Error('Unsupported book format')
  const { makeBook } = await import('foliate-js/view.js')
  return openBookWithFileFallback(file, makeBook)
}
