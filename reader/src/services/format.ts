import type { BookFormat } from '../storage/types'

const EXT_MAP: Record<string, BookFormat> = {
  epub: 'epub',
  mobi: 'mobi',
  pdf: 'pdf',
  txt: 'txt',
  md: 'md',
  markdown: 'md',
}

export const SUPPORTED_EXTS = Object.keys(EXT_MAP)
export const SUPPORTED_FORMATS: readonly BookFormat[] = [...new Set(Object.values(EXT_MAP))]

export const ACCEPT = SUPPORTED_EXTS.map(e => '.' + e).join(',')

/** Stored legacy formats remain valid metadata, but cannot be opened or imported. */
export function isSupportedBookFormat(value: unknown): value is BookFormat {
  return typeof value === 'string' && SUPPORTED_FORMATS.includes(value as BookFormat)
}

export function detectFormat(fileName: string): BookFormat | null {
  const name = fileName.toLowerCase()
  const ext = name.split('.').pop() ?? ''
  return Object.prototype.hasOwnProperty.call(EXT_MAP, ext) ? EXT_MAP[ext] : null
}

/** foliate-view 直接支持的格式 (其余走转换或专用阅读器) */
export function isFoliateNative(format: BookFormat): boolean {
  return ['epub', 'mobi'].includes(format)
}

/** 文本类格式: 导入时动态转换为 EPUB 后交给 foliate-view */
export function isTextLike(format: BookFormat): boolean {
  return ['txt', 'md'].includes(format)
}

/** 可转换为 EPUB 的流式格式; PDF 为固定版式, 不转换。 */
export const EPUB_CONVERTIBLE: readonly BookFormat[] = ['mobi', 'txt', 'md']

export function canConvertToEpub(format: BookFormat | null | undefined): boolean {
  return !!format && EPUB_CONVERTIBLE.includes(format)
}

export const FORMAT_LABELS: Record<BookFormat, string> = {
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
  azw: 'AZW',
  fb2: 'FB2',
  fbz: 'FB2',
  cbz: '漫画',
  cbr: '漫画',
  djvu: 'DjVu',
  pdf: 'PDF',
  txt: 'TXT',
  html: 'HTML',
  md: 'Markdown',
}
