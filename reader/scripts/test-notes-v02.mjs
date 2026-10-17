// 全局笔记聚合与操作纯单元测试 (Node.js test runner)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  loadGlobalNotes,
  filterGlobalNotes,
  resolveReaderJumpUrl,
  updateNoteThought,
  deleteGlobalNote,
} from '../src/services/notes.ts'
import { saveNoteDraft, loadNoteDraft } from '../src/services/noteDrafts.ts'

class MockNotesStorage {
  constructor() {
    this.books = []
    this.annotations = []
    this.callCounts = {
      listAllAnnotations: 0,
      listBooks: 0,
      listAnnotations: 0,
      updateAnnotation: 0,
      deleteAnnotation: 0,
    }
    this.hasListAll = true
  }

  async listBooks() {
    this.callCounts.listBooks++
    return [...this.books]
  }

  async listAllAnnotations() {
    if (!this.hasListAll) throw new Error('not supported')
    this.callCounts.listAllAnnotations++
    return [...this.annotations]
  }

  async listAnnotations(bookId) {
    this.callCounts.listAnnotations++
    return this.annotations.filter(a => a.bookId === bookId)
  }

  async updateAnnotation(id, patch) {
    this.callCounts.updateAnnotation++
    const idx = this.annotations.findIndex(a => a.id === id)
    if (idx === -1) throw new Error('Annotation not found')
    this.annotations[idx] = { ...this.annotations[idx], ...patch }
  }

  async deleteAnnotation(id) {
    this.callCounts.deleteAnnotation++
    this.annotations = this.annotations.filter(a => a.id !== id)
  }
}

class SimpleMockStorage {
  constructor() {
    this.map = new Map()
  }
  getItem(k) { return this.map.get(k) ?? null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
  keys() { return Array.from(this.map.keys()) }
}

test('O(1) 聚合查询: 面对大量书籍时仅调用 2 次存储, 严禁发起 4000 次按书查询', async () => {
  const storage = new MockNotesStorage()

  // 构造 4000 本书
  for (let i = 1; i <= 4000; i++) {
    storage.books.push({
      id: `book-${i}`,
      title: `测试书籍 ${i}`,
      author: `作者 ${i}`,
      format: 'epub',
      tags: [],
      addedAt: 1000 + i,
      hasCover: false,
    })
  }

  // 构造 50 条分散在不同书籍的标注
  for (let i = 1; i <= 50; i++) {
    storage.annotations.push({
      id: `anno-${i}`,
      bookId: `book-${i * 10}`,
      cfi: `cfi-${i}`,
      text: `选中文本 ${i}`,
      note: i % 2 === 0 ? `想法 ${i}` : undefined,
      color: 'yellow',
      createdAt: 2000 + i,
    })
  }

  const items = await loadGlobalNotes(storage)

  assert.equal(items.length, 50)
  assert.equal(storage.callCounts.listAllAnnotations, 1, '仅调用 1 次 listAllAnnotations')
  assert.equal(storage.callCounts.listBooks, 1, '仅调用 1 次 listBooks')
  assert.equal(storage.callCounts.listAnnotations, 0, '绝对禁止调用 listAnnotations 进行 4000 次循环查询')

  // 验证映射字段正确
  const first = items[0] // 倒序排在首位的是最新的
  assert.equal(first.id, 'anno-50')
  assert.equal(first.bookTitle, '测试书籍 500')
  assert.equal(first.bookAuthor, '作者 500')
  assert.equal(first.sourceMissing, false)
  assert.equal(first.readerJumpUrl, '/read/book-500?loc=cfi-50')
})

test('原书缺失容错 (missing original source): 书籍被删后标注依然安全展示并呈现占位, 跳转安全禁用', async () => {
  const storage = new MockNotesStorage()
  storage.books = [
    { id: 'b1', title: '存世之书', author: '某作者', format: 'epub', tags: [], addedAt: 100, hasCover: false },
  ]
  storage.annotations = [
    { id: 'a1', bookId: 'b1', cfi: 'cfi-1', text: '存世内容', color: 'yellow', createdAt: 100 },
    { id: 'a2', bookId: 'b-deleted', cfi: 'cfi-2', text: '孤儿标注原文', note: '仍保留的想法', color: 'blue', createdAt: 200 },
  ]

  const items = await loadGlobalNotes(storage)
  assert.equal(items.length, 2)

  const orphan = items.find(x => x.id === 'a2')
  assert.ok(orphan)
  assert.equal(orphan.sourceMissing, true, '标记为原书已缺失')
  assert.equal(orphan.bookTitle, '已从书库移除的书籍')
  assert.equal(orphan.readerJumpUrl, '', '原书缺失时跳转链接为空')
  assert.equal(orphan.text, '孤儿标注原文')
  assert.equal(orphan.note, '仍保留的想法')
})

test('阅读跳转路由契约 (resolveReaderJumpUrl)', () => {
  // 普通 EPUB 图书
  const epubBook = { id: 'novel-1', format: 'epub', title: '小说', author: 'A', tags: [], addedAt: 1, hasCover: false }
  assert.equal(resolveReaderJumpUrl(epubBook, 'epubcfi(/6/2)'), '/read/novel-1?loc=epubcfi(%2F6%2F2)')

  // 论文 / PDF
  const pdfBook = { id: 'paper-1', format: 'pdf', title: '论文', author: 'B', tags: [], addedAt: 1, hasCover: false }
  assert.equal(resolveReaderJumpUrl(pdfBook, 'page=3'), '/read-paper/paper-1?loc=page%3D3')

  // 书籍缺失
  assert.equal(resolveReaderJumpUrl(undefined, 'any-cfi'), '')
})

test('关键词检索与分类过滤 (filterGlobalNotes)', () => {
  const items = [
    { id: '1', bookId: 'b1', bookTitle: '红楼梦', bookAuthor: '曹雪芹', kind: 'highlight', cfi: 'c1', text: '满纸荒唐言', note: '一绝', color: 'red', createdAt: 1, isPaper: false, sourceMissing: false, readerJumpUrl: '/read/b1' },
    { id: '2', bookId: 'b2', bookTitle: '三体', bookAuthor: '刘慈欣', kind: 'highlight', cfi: 'c2', text: '消灭人类暴政', note: '', color: 'yellow', createdAt: 2, isPaper: false, sourceMissing: false, readerJumpUrl: '/read/b2' },
    { id: '3', bookId: 'b3', bookTitle: '设计模式', bookAuthor: 'GoF', kind: 'bookmark', cfi: 'c3', text: '', note: undefined, color: 'blue', createdAt: 3, isPaper: false, sourceMissing: false, readerJumpUrl: '/read/b3' },
  ]

  // 按关键词匹配原文
  const hitText = filterGlobalNotes(items, '荒唐')
  assert.equal(hitText.length, 1)
  assert.equal(hitText[0].id, '1')

  // 按关键词匹配书名
  const hitTitle = filterGlobalNotes(items, '三体')
  assert.equal(hitTitle.length, 1)
  assert.equal(hitTitle[0].id, '2')

  // 按分类: 仅有想法的笔记
  const thoughts = filterGlobalNotes(items, '', 'thoughts')
  assert.equal(thoughts.length, 1)
  assert.equal(thoughts[0].id, '1')

  // 按分类: 书签
  const bookmarks = filterGlobalNotes(items, '', 'bookmarks')
  assert.equal(bookmarks.length, 1)
  assert.equal(bookmarks[0].id, '3')
})

test('更新想法内容: 仅修改 note, 严格保留原文选区 text 与 cfi, 且成功后清除草稿', async () => {
  const storage = new MockNotesStorage()
  storage.annotations = [
    { id: 'anno-edit', bookId: 'book-1', cfi: 'cfi-fixed', text: '原选区文字必须锁定不变', note: '旧想法', color: 'yellow', createdAt: 100 },
  ]

  const mockLocal = new SimpleMockStorage()
  const env = { storage: mockLocal, now: () => 100 }

  // 模拟先产生草稿
  const ctx = { bookId: 'book-1', contextId: 'anno:anno-edit' }
  saveNoteDraft(ctx, '新写但尚未提交的想法草稿', env)
  assert.equal(loadNoteDraft(ctx, env).success, true)

  // 执行正式保存
  await updateNoteThought(storage, 'anno-edit', 'book-1', '最终保存的想法正文', env)

  // 验证存储中的记录
  const updated = storage.annotations.find(a => a.id === 'anno-edit')
  assert.equal(updated.note, '最终保存的想法正文')
  assert.equal(updated.text, '原选区文字必须锁定不变', '原文引文必须保持原样')
  assert.equal(updated.cfi, 'cfi-fixed', 'CFI 必须保持原样')

  // 验证草稿已被清除
  assert.equal(loadNoteDraft(ctx, env).success, false)
})

test('删除标注: 真实调用存储删除, 且成功后清理草稿', async () => {
  const storage = new MockNotesStorage()
  storage.annotations = [
    { id: 'anno-del', bookId: 'book-1', cfi: 'cfi-1', text: '待删内容', color: 'yellow', createdAt: 100 },
  ]
  const mockLocal = new SimpleMockStorage()
  const env = { storage: mockLocal, now: () => 100 }
  const ctx = { bookId: 'book-1', contextId: 'anno:anno-del' }
  saveNoteDraft(ctx, '残留草稿', env)

  await deleteGlobalNote(storage, 'anno-del', 'book-1', env)

  assert.equal(storage.annotations.length, 0)
  assert.equal(loadNoteDraft(ctx, env).success, false)
})

test('后端不支持全局接口时抛出明确异常, 绝不伪造空数据或降级到 4000 次按书查询', async () => {
  const storage = new MockNotesStorage()
  storage.listAllAnnotations = undefined // 缺少该方法

  await assert.rejects(
    async () => {
      await loadGlobalNotes(storage)
    },
    /storage_list_all_unsupported/,
    '必须抛出明确的结构化不支持异常',
  )
})
