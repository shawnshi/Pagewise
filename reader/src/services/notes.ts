/**
 * 全局笔记业务编排服务 (Global Notes Service)
 * 
 * 核心契约:
 * 1. 固定两次批量查询: listAllAnnotations + listBooks; 时间与内存随标注数量增长,
 *    严禁产生 4000 次按书循环查询。
 * 2. 真实持久化与错误反馈: 编辑与删除必须走现有存储接口, 错误如实透传, 绝不伪造成功。
 * 3. 严格保留选区原文 (text) 与位置 (cfi), 仅修改想法正文 (note) 或颜色 (color)。
 * 4. 原书缺失容错: 当标注指向的书籍已被移除时, 呈现清晰的缺失源占位, 禁用跳转, 绝不崩溃。
 * 5. 统一跳转路由生成:
 *    - 论文/PDF: `/read-paper/:id?loc=...`
 *    - 普通图书: `/read/:id?loc=...`
 */

import type { BookMeta, LibraryStorage } from '../storage/types.ts'
import { removeNoteDraft, type DraftEnv } from './noteDrafts.ts'

export interface GlobalNoteItem {
  id: string
  bookId: string
  bookTitle: string
  bookAuthor: string
  bookFormat?: string
  bookSource?: string
  kind: 'highlight' | 'bookmark'
  cfi: string
  /** 选区原文 (严格保留) */
  text: string
  /** 用户想法 / 笔记正文 */
  note?: string
  color: string
  createdAt: number
  isPaper: boolean
  /** 原书是否在书库中缺失 (例如书籍被删除后遗留的标注) */
  sourceMissing: boolean
  /** 原书跳转 URL (缺失时为空字符串) */
  readerJumpUrl: string
}

export type NoteFilterKind = 'all' | 'thoughts' | 'highlights' | 'bookmarks'

/**
 * 根据书籍元数据生成正确定位跳转 URL
 */
export function resolveReaderJumpUrl(book: BookMeta | undefined, cfi: string): string {
  if (!book || !book.id) return ''
  const isPaper = book.kind === 'paper' || book.format === 'pdf'
  const path = isPaper ? `/read-paper/${encodeURIComponent(book.id)}` : `/read/${encodeURIComponent(book.id)}`
  return cfi ? `${path}?loc=${encodeURIComponent(cfi)}` : path
}

/**
 * 聚合全库标注与关联书籍信息 (仅发起 2 次全局查询)
 */
export async function loadGlobalNotes(storage: LibraryStorage): Promise<GlobalNoteItem[]> {
  if (typeof storage.listAllAnnotations !== 'function') {
    throw new Error('storage_list_all_unsupported')
  }

  // 并行拉取全库标注与全库书籍, 绝不按书遍历
  const [annotations, books] = await Promise.all([
    storage.listAllAnnotations(),
    storage.listBooks(),
  ])

  const bookMap = new Map<string, BookMeta>()
  for (const b of books) {
    if (b?.id) bookMap.set(b.id, b)
  }

  const items: GlobalNoteItem[] = []
  for (const a of annotations) {
    if (!a || !a.id) continue
    const book = bookMap.get(a.bookId)
    const sourceMissing = !book
    const isPaper = Boolean(book && (book.kind === 'paper' || book.format === 'pdf'))

    items.push({
      id: a.id,
      bookId: a.bookId,
      bookTitle: book?.title || '已从书库移除的书籍',
      bookAuthor: book?.author || '未知作者',
      bookFormat: book?.format,
      bookSource: book?.source,
      kind: a.kind ?? 'highlight',
      cfi: a.cfi || '',
      text: a.text || '',
      note: a.note,
      color: a.color || 'yellow',
      createdAt: a.createdAt || 0,
      isPaper,
      sourceMissing,
      readerJumpUrl: resolveReaderJumpUrl(book, a.cfi),
    })
  }

  // 默认按时间倒序排列 (最新的在前)
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 内存关键词搜索与分类筛选
 */
export function filterGlobalNotes(
  items: GlobalNoteItem[],
  query: string,
  kindFilter: NoteFilterKind = 'all',
): GlobalNoteItem[] {
  const q = query.trim().toLowerCase()

  return items.filter(item => {
    // 类别筛选
    if (kindFilter === 'thoughts') {
      if (!item.note || !item.note.trim()) return false
    } else if (kindFilter === 'highlights') {
      if (item.kind !== 'highlight') return false
    } else if (kindFilter === 'bookmarks') {
      if (item.kind !== 'bookmark') return false
    }

    // 关键词筛选
    if (!q) return true

    const textMatch = item.text.toLowerCase().includes(q)
    const noteMatch = (item.note || '').toLowerCase().includes(q)
    const titleMatch = item.bookTitle.toLowerCase().includes(q)
    const authorMatch = item.bookAuthor.toLowerCase().includes(q)

    return textMatch || noteMatch || titleMatch || authorMatch
  })
}

/**
 * 更新想法内容 (严格保留原文选区 text 与 cfi, 成功后清除草稿)
 */
export async function updateNoteThought(
  storage: LibraryStorage,
  noteId: string,
  bookId: string,
  newThoughtText: string,
  env?: DraftEnv,
): Promise<{ success: boolean; message?: string }> {
  const safeText = typeof newThoughtText === 'string' ? newThoughtText.trim() : ''
  // 调用现有存储接口进行持久化
  await storage.updateAnnotation(noteId, {
    note: safeText || undefined,
  })
  // 清理失败不能把已提交笔记误报为保存失败。
  return removeNoteDraft({ bookId, contextId: `anno:${noteId}` }, env)
}

/**
 * 删除标注 (通过现有存储接口, 成功后清除残留草稿)
 */
export async function deleteGlobalNote(
  storage: LibraryStorage,
  noteId: string,
  bookId: string,
  env?: DraftEnv,
): Promise<ReturnType<typeof removeNoteDraft>> {
  await storage.deleteAnnotation(noteId)
  return removeNoteDraft({ bookId, contextId: `anno:${noteId}` }, env)
}
