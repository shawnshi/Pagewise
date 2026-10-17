import { isFoliateNative, isTextLike, detectFormat } from './format'
import { makeFoliateBook } from './foliateBook'
import type { BookFormat, NewBookMeta } from '../storage/types'

type ParsedMetadata = Pick<NewBookMeta, 'title' | 'author' | 'tags' | 'description' | 'language' | 'publisher' | 'publicationDate'> & { cover?: Blob }

/** Foliate contributors can contain localized name maps as well as strings. */
function metadataText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(metadataText).filter(Boolean).join(', ')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if ('name' in record) return metadataText(record.name)
  if ('value' in record) return metadataText(record.value)
  // Language maps are the remaining form emitted by Foliate's EPUB parser.
  return Object.values(record).filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean).join(', ')
}

export function normalizeBibliographicMetadata(meta: Record<string, unknown>) {
  const subjects = Array.isArray(meta.subject) ? meta.subject : meta.subject == null ? [] : [meta.subject]
  return {
    title: metadataText(meta.title),
    author: metadataText(meta.author),
    description: metadataText(meta.description) || undefined,
    language: metadataText(meta.language) || undefined,
    publisher: metadataText(meta.publisher) || undefined,
    // Do not parse via Date: that invents month/day/timezone for partial dates.
    publicationDate: typeof meta.published === 'string' ? meta.published.trim() || undefined : undefined,
    tags: [...new Set(subjects.map(metadataText).filter(Boolean))],
  }
}

export async function readBookMetadata(file: File, format: BookFormat | null = detectFormat(file.name)): Promise<ParsedMetadata> {
  if (!format) throw new Error('不支持的格式')
  const base = { title: file.name.replace(/\.[^.]+$/, ''), author: '', tags: [] as string[] }
  if (isFoliateNative(format)) {
    const book = await makeFoliateBook(file)
    try {
      const metadata = normalizeBibliographicMetadata(book.metadata ?? {})
      let cover: Blob | undefined
      try { cover = (await book.getCover?.()) ?? undefined } catch { /* Optional cover failure must not discard valid bibliography. */ }
      return { ...metadata, title: metadata.title || base.title, cover }
    } finally {
      book.destroy?.()
    }
  }
  if (format === 'pdf') {
    const { PdfiumDoc } = await import('./pdfium')
    const doc = await PdfiumDoc.open(await file.arrayBuffer())
    try {
      let cover: Blob | undefined
      if (doc.pages[0]) {
        const img = doc.render(0, 0.6)
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        canvas.getContext('2d')!.putImageData(img, 0, 0)
        cover = await new Promise<Blob | undefined>(resolve =>
          canvas.toBlob(b => resolve(b ?? undefined), 'image/jpeg', 0.8))
      }
      // PDF CreationDate is a file creation timestamp, not a publication date.
      return { ...base, title: doc.meta('Title') || base.title, author: doc.meta('Author'), cover }
    } finally { doc.close() }
  }
  if (isTextLike(format)) {
    const { convertToEpub } = await import('./textToEpub')
    const { title } = await convertToEpub(file, file.name, format as 'txt' | 'md')
    return { ...base, title }
  }
  throw new Error('不支持的格式')
}
