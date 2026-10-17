import { getStorage, type NewBookMeta } from '../storage'
import { detectFormat } from './format'
import { readBookMetadata } from './bibliographicMetadata'

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

/** Shared parser path for copied imports and referenced folder documents. */
export async function prepareBookImport(file: File, source = '本地导入', overrides?: MetaOverrides) {
  const format = detectFormat(file.name)
  if (!format) throw new Error('不支持的格式')
  const { cover, ...bibliography } = await readBookMetadata(file, format)
  const meta: NewBookMeta = {
    ...bibliography, format, fileName: file.name, addedAt: Date.now(), source,
    kind: overrides?.kind ?? 'book',
  }
  if (overrides?.title) meta.title = overrides.title
  if (overrides?.author) meta.author = overrides.author
  if (overrides?.description) meta.description = overrides.description
  return { meta, cover }
}

/** 导入单个文件到藏书库; overrides 来自书源目录的元数据, 优先于文件内嵌信息 */
export async function importFile(
  file: File,
  source = '本地导入',
  overrides?: MetaOverrides,
): Promise<ImportResult> {
  let prepared: Awaited<ReturnType<typeof prepareBookImport>>
  try {
    prepared = await prepareBookImport(file, source, overrides)
  } catch (error) {
    return { ok: false, fileName: file.name, error: error instanceof Error ? error.message : '文件解析失败' }
  }
  const storage = await getStorage()
  const bookId = await storage.addBook(prepared.meta, file, prepared.cover)
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
