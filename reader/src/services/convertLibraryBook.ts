/**
 * 藏书里的书「转换为 EPUB」: 转换后作为新书加入藏书 (元数据 / 封面 / 标签 / 书单归属沿用),
 * 原书保留. 阅读进度按百分比带过去 (位置 CFI 与划线无法可靠映射, 不迁移).
 */
import { getStorage, type NewBookMeta } from '../storage'
import { canConvertToEpub, convertBookToEpub, ConvertError, type ConvertProgress } from './bookToEpub'
import { t } from '../i18n'

export interface ConvertedBook {
  bookId: string
  title: string
  /** 原书的划线/书签数 (CFI 无法可靠映射, 留在原书) */
  annotations: number
}

async function storedCover(storage: Awaited<ReturnType<typeof getStorage>>, id: string): Promise<Blob | undefined> {
  const url = await storage.getCoverUrl(id)
  if (!url) throw new Error('Cover file is missing')
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Cover read failed: ${response.status} ${response.statusText}`)
    const blob = await response.blob()
    if (!blob.size) throw new Error('Cover file is empty')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function convertLibraryBook(
  bookId: string,
  onProgress?: (p: ConvertProgress) => void,
): Promise<ConvertedBook> {
  const storage = await getStorage()
  const meta = await storage.getBook(bookId)
  if (!meta) throw new Error(t('convert.missing'))
  if (!canConvertToEpub(meta.format)) throw new ConvertError('unsupported')
  const file = await storage.getBookFile(bookId)
  const cover = meta.hasCover ? await storedCover(storage, bookId) : undefined

  const result = await convertBookToEpub(file, {
    fileName: meta.fileName,
    onProgress,
    meta: { title: meta.title, author: meta.author, description: meta.description, language: meta.language },
    cover,
  })

  const newMeta: NewBookMeta = {
    title: meta.title || result.title,
    author: meta.author || result.author,
    format: 'epub',
    fileName: result.fileName,
    description: meta.description || result.description,
    language: meta.language || result.language,
    tags: [...(meta.tags ?? [])],
    addedAt: Date.now(),
    source: meta.source,
    kind: meta.kind,
  }
  // 只带百分比: 阅读页没有位置时按比例定位 (ReaderView)
  if (meta.progress && meta.progress > 0) {
    newMeta.progress = meta.progress
    if (meta.lastReadAt) newMeta.lastReadAt = meta.lastReadAt
  }
  const newId = await storage.addBook(newMeta, result.epub, cover ?? result.cover)

  // 书单归属: 原书在哪些书单里, 新书也加进去
  try {
    for (const list of await storage.listBooklists()) {
      const ids = await storage.listBooklistBookIds(list.id)
      if (ids.includes(bookId)) await storage.addBooksToBooklist(list.id, [newId])
    }
  } catch (e) {
    console.warn('[convert] booklist membership', e)
  }
  let annotations = 0
  try { annotations = (await storage.listAnnotations(bookId)).length } catch { /* 忽略 */ }
  return { bookId: newId, title: newMeta.title, annotations }
}

/** 转换失败的提示文案 */
export function convertErrorText(error: unknown): string {
  if (error instanceof ConvertError) {
    if (error.code === 'drm') return t('convert.errDrm')
    if (error.code === 'unsupported') return t('convert.errUnsupported')
    if (error.code === 'empty') return t('convert.errEmpty')
    return t('convert.errParse')
  }
  const msg = (error as any)?.message
  return msg ? t('convert.failedMsg', { msg }) : t('convert.errParse')
}
