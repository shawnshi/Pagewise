import type { BookMeta } from '../storage'
import { isSupportedBookFormat } from './format'

/** 仅为当前支持的格式生成阅读路由; 历史元数据仍留在藏书中。 */
export function readerPath(book: Pick<BookMeta, 'id' | 'format'>): string {
  if (!isSupportedBookFormat(book.format)) throw new Error('Unsupported book format')
  if (book.format === 'pdf') return `/read-pdf/${book.id}`
  return `/read/${book.id}`
}
