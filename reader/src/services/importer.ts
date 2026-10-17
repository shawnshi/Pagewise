import { getStorage, type NewBookMeta } from '../storage'
import { detectFormat, isFoliateNative, isTextLike } from './format'
import { convertToEpub } from './textToEpub'
import { makeFoliateBook } from './foliateBook'

/** foliate 的 metadata 字段可能是字符串 / 对象 / 数组, 统一压平为字符串 */
function flattenMeta(value: any): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flattenMeta).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    if (typeof value.name === 'string') return value.name
    if (typeof value.value === 'string') return value.value
    const first = Object.values(value).find(v => typeof v === 'string')
    if (typeof first === 'string') return first
  }
  return ''
}

async function extractFoliateMeta(file: File) {
  const book = await makeFoliateBook(file)
  const meta = book.metadata ?? {}
  let cover: Blob | undefined
  try {
    cover = (await book.getCover?.()) ?? undefined
  } catch { /* 无封面不影响导入 */ }
  const result = {
    title: flattenMeta(meta.title),
    author: flattenMeta(meta.author),
    description: flattenMeta(meta.description),
    language: flattenMeta(meta.language),
    cover,
  }
  book.destroy?.()
  return result
}

/** PDF 元数据与封面: PDFium (与阅读器同引擎) */
async function extractPdfMeta(file: File) {
  let title = ''
  let author = ''
  let cover: Blob | undefined
  try {
    const { PdfiumDoc } = await import('./pdfium')
    const doc = await PdfiumDoc.open(await file.arrayBuffer())
    try {
      title = doc.meta('Title')
      author = doc.meta('Author')
      const pg = doc.pages[0]
      if (pg) {
        const img = doc.render(0, 0.6)
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        canvas.getContext('2d')!.putImageData(img, 0, 0)
        cover = await new Promise<Blob | undefined>(resolve =>
          canvas.toBlob(b => resolve(b ?? undefined), 'image/jpeg', 0.8))
      }
    } finally {
      doc.close()
    }
  } catch { /* 解析失败: 文件名兜底, 无封面 */ }
  return { title, author, cover }
}

export interface ImportResult {
  ok: boolean
  fileName: string
  bookId?: string
  error?: string
}

export interface MetaOverrides {
  title?: string
  author?: string
  description?: string
  /** 归属: 论文入「论文」页 */
  kind?: 'book' | 'paper'
}

/** 导入单个文件到藏书库; overrides 来自书源目录的元数据, 优先于文件内嵌信息 */
export async function importFile(
  file: File,
  source = '本地导入',
  overrides?: MetaOverrides,
): Promise<ImportResult> {
  const format = detectFormat(file.name)
  if (!format) return { ok: false, fileName: file.name, error: '不支持的格式' }

  const baseName = file.name.replace(/\.[^.]+$/, '')
  const meta: NewBookMeta = {
    title: baseName,
    author: '',
    format,
    fileName: file.name,
    tags: [],
    addedAt: Date.now(),
    source,
  }
  let cover: Blob | undefined

  try {
    if (isFoliateNative(format)) {
      const m = await extractFoliateMeta(file)
      if (m.title) meta.title = m.title
      meta.author = m.author
      meta.description = m.description || undefined
      meta.language = m.language || undefined
      cover = m.cover
    } else if (format === 'pdf') {
      const m = await extractPdfMeta(file)
      if (m.title) meta.title = m.title
      meta.author = m.author
      cover = m.cover
    } else if (isTextLike(format)) {
      // 仅取标题, 阅读时再实时转换
      const { title } = await convertToEpub(file, file.name, format as 'txt' | 'md')
      meta.title = title
    }
  } catch (e: any) {
    return { ok: false, fileName: file.name, error: e?.message ?? '文件解析失败' }
  }

  if (overrides?.title) meta.title = overrides.title
  if (overrides?.author) meta.author = overrides.author
  if (overrides?.description) meta.description = overrides.description
  meta.kind = overrides?.kind ?? 'book'

  const storage = await getStorage()
  const bookId = await storage.addBook(meta, file, cover)
  return { ok: true, fileName: file.name, bookId }
}

/** 延迟读取的文件 (桌面端选文件夹导入: 导到这一本时才从磁盘读出) */
export interface LazyImportFile {
  name: string
  load(): Promise<File>
}

/** 批量导入 */
export async function importFiles(
  files: Iterable<File | LazyImportFile>,
  source = '本地导入',
  onProgress?: (done: number, total: number, current: string) => void,
  overrides?: MetaOverrides,
): Promise<ImportResult[]> {
  const list = Array.from(files)
  const results: ImportResult[] = []
  let done = 0
  for (const item of list) {
    onProgress?.(done, list.length, item.name)
    try {
      results.push(await importFile('load' in item ? await item.load() : item, source, overrides))
    } catch (error: any) {
      // 单本存储失败也要继续其余文件，并让界面能正常退出进度状态。
      results.push({ ok: false, fileName: item.name, error: error?.message ?? '文件保存失败' })
    }
    done++
  }
  onProgress?.(done, list.length, '')
  return results
}
