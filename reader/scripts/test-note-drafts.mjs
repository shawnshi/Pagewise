// 笔记草稿服务纯单元测试 (Node.js test runner)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  saveNoteDraft,
  loadNoteDraft,
  removeNoteDraft,
  discardNoteDraft,
  listDrafts,
  isSavedAnnotation,
  isNoteDraft,
  createDebouncedDraftSaver,
  buildDraftKey,
  NOTE_DRAFT_VERSION,
  MAX_DRAFT_TEXT_LENGTH,
} from '../src/services/noteDrafts.ts'

// 可控内存存储适配器, 注入测试环境, 不读写实际 localStorage
class MockStorage {
  constructor() {
    this.store = new Map()
    this.quotaExceeded = false
    this.disabled = false
  }

  getItem(key) {
    if (this.disabled) throw new Error('Storage is disabled')
    return this.store.get(key) ?? null
  }

  setItem(key, value) {
    if (this.disabled) throw new Error('Storage is disabled')
    if (this.quotaExceeded) {
      const err = new Error('Quota exceeded')
      err.name = 'QuotaExceededError'
      err.code = 22
      throw err
    }
    this.store.set(key, String(value))
  }

  removeItem(key) {
    if (this.disabled) throw new Error('Storage is disabled')
    this.store.delete(key)
  }

  keys() {
    return Array.from(this.store.keys())
  }

  get length() {
    return this.store.size
  }

  key(index) {
    return Array.from(this.store.keys())[index] ?? null
  }
}

test('正常保存并读取草稿: 保留原文引用、来源位置与版本号', () => {
  const storage = new MockStorage()
  let fakeTime = 1700000000000
  const env = { storage, now: () => fakeTime }

  const ctx = {
    bookId: 'book-1',
    contextId: 'anno-42',
    quote: '这是一段被划线的原文引文',
    sourceLoc: 'epubcfi(/6/4!/4/2/1:0)',
  }

  const saveRes = saveNoteDraft(ctx, '我在这里记录的第一条想法', env)
  assert.equal(saveRes.success, true)
  assert.equal(saveRes.draft.text, '我在这里记录的第一条想法')
  assert.equal(saveRes.draft.quote, '这是一段被划线的原文引文')
  assert.equal(saveRes.draft.sourceLoc, 'epubcfi(/6/4!/4/2/1:0)')
  assert.equal(saveRes.draft.version, NOTE_DRAFT_VERSION)
  assert.equal(saveRes.draft.isDraft, true)
  assert.equal(saveRes.draft.updatedAt, fakeTime)

  const loadRes = loadNoteDraft(ctx, env)
  assert.equal(loadRes.success, true)
  assert.equal(loadRes.draft.text, '我在这里记录的第一条想法')
  assert.equal(loadRes.draft.quote, '这是一段被划线的原文引文')
  assert.equal(loadRes.draft.sourceLoc, 'epubcfi(/6/4!/4/2/1:0)')
})

test('上下文隔离: 不同书籍或不同选区上下文不得互串草稿', () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 1000 }

  const ctxA = { bookId: 'book-A', contextId: 'sel-1', quote: 'A' }
  const ctxB = { bookId: 'book-B', contextId: 'sel-1', quote: 'B' }
  const ctxA2 = { bookId: 'book-A', contextId: 'sel-2', quote: 'A2' }

  saveNoteDraft(ctxA, 'A 的草稿', env)

  // 跨书籍读取: 不应存在
  const resB = loadNoteDraft(ctxB, env)
  assert.equal(resB.success, false)
  assert.equal(resB.error, 'not_found')

  // 同书籍不同上下文读取: 不应存在
  const resA2 = loadNoteDraft(ctxA2, env)
  assert.equal(resA2.success, false)
  assert.equal(resA2.error, 'not_found')

  // 正确上下文读取
  const resA = loadNoteDraft(ctxA, env)
  assert.equal(resA.success, true)
  assert.equal(resA.draft.text, 'A 的草稿')
})

test('原文引文与想法正文分离: 修改笔记正文不覆盖原文引用', () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 2000 }
  const ctx = {
    bookId: 'book-x',
    contextId: 'ctx-x',
    quote: '不可修改的原作者名句',
  }

  saveNoteDraft(ctx, '初次想法', env)
  // 二次更新编辑内容
  saveNoteDraft(ctx, '深入思考后的二次想法', env)

  const loadRes = loadNoteDraft(ctx, env)
  assert.equal(loadRes.success, true)
  assert.equal(loadRes.draft.text, '深入思考后的二次想法')
  assert.equal(loadRes.draft.quote, '不可修改的原作者名句')
})

test('草稿与正式笔记分离: 严禁把草稿判定为已保存笔记', () => {
  const draft = {
    isDraft: true,
    version: 1,
    bookId: 'b1',
    contextId: 'c1',
    text: '草稿',
    updatedAt: 100,
  }

  const annotation = {
    id: 'anno-1',
    bookId: 'b1',
    cfi: 'cfi-1',
    text: '原文',
    note: '已持久化想法',
    color: 'yellow',
    createdAt: 100,
  }

  assert.equal(isNoteDraft(draft), true)
  assert.equal(isSavedAnnotation(draft), false, '草稿绝不能被标为正式保存标注')
  assert.equal(isSavedAnnotation(annotation), true)
  assert.equal(isNoteDraft(annotation), false)
})

test('存储写入失败时 (配额超限 / 存储被禁用): 用户输入在返回结果中完全可恢复', () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 3000 }
  const ctx = { bookId: 'b1', contextId: 'c1' }
  const preciousText = '这是用户辛苦敲击的珍贵想法，哪怕存储配额满了也绝不能丢'

  // 1. 模拟配额已满
  storage.quotaExceeded = true
  const quotaRes = saveNoteDraft(ctx, preciousText, env)
  assert.equal(quotaRes.success, false)
  assert.equal(quotaRes.error, 'quota_exceeded')
  assert.equal(quotaRes.textRecoverable, preciousText, '配额超限必须返回可恢复文本')

  // 2. 模拟存储整体禁用
  storage.quotaExceeded = false
  storage.disabled = true
  const disRes = saveNoteDraft(ctx, preciousText, env)
  assert.equal(disRes.success, false)
  assert.equal(disRes.error, 'storage_unavailable')
  assert.equal(disRes.textRecoverable, preciousText, '存储不可用必须返回可恢复文本')
})

test('损坏的载荷处理: JSON 损坏或结构非法时不崩溃, 且绝不清空不相关键', () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 4000 }

  // 写入一条正常的邻居草稿
  const neighborCtx = { bookId: 'b-neighbor', contextId: 'c-neighbor' }
  saveNoteDraft(neighborCtx, '邻居草稿很安全', env)

  // 构造一条被损坏的草稿 (非法 JSON)
  const corruptKey = buildDraftKey('b-bad', 'c-bad')
  storage.store.set(corruptKey, '{ this is corrupted json!@#$')

  const badCtx = { bookId: 'b-bad', contextId: 'c-bad' }
  const loadBad = loadNoteDraft(badCtx, env)
  assert.equal(loadBad.success, false)
  assert.equal(loadBad.error, 'corrupt_payload')
  assert.ok(loadBad.rawPayload.includes('corrupted json'))

  // 损坏键依然保留在存储中以供取证, 且绝不损坏邻居
  assert.ok(storage.store.has(corruptKey), '损坏的键未被盲目清除')
  const loadNeighbor = loadNoteDraft(neighborCtx, env)
  assert.equal(loadNeighbor.success, true)
  assert.equal(loadNeighbor.draft.text, '邻居草稿很安全')
})

test('版本不匹配处理: 未来版本草稿安全拒绝, 不冲刷不相关键', () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 5000 }

  const futureKey = buildDraftKey('b-future', 'c-future')
  storage.store.set(futureKey, JSON.stringify({
    version: 999,
    bookId: 'b-future',
    contextId: 'c-future',
    text: '来自未来的草稿',
  }))

  const res = loadNoteDraft({ bookId: 'b-future', contextId: 'c-future' }, env)
  assert.equal(res.success, false)
  assert.equal(res.error, 'version_mismatch')
})

test('成功保存后移除草稿与显式放弃草稿: 只删除自身, 不波及其他草稿', () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 6000 }

  const ctx1 = { bookId: 'b1', contextId: 'c1' }
  const ctx2 = { bookId: 'b2', contextId: 'c2' }

  saveNoteDraft(ctx1, '草稿 1', env)
  saveNoteDraft(ctx2, '草稿 2', env)

  assert.equal(listDrafts(undefined, env).length, 2)

  // 模拟笔记持久化成功, 移除草稿 1
  removeNoteDraft(ctx1, env)
  assert.equal(loadNoteDraft(ctx1, env).success, false)
  assert.equal(loadNoteDraft(ctx2, env).success, true, '草稿 2 依然完好')

  // 显式放弃草稿 2
  discardNoteDraft(ctx2, env)
  assert.equal(loadNoteDraft(ctx2, env).success, false)
  assert.equal(listDrafts(undefined, env).length, 0)
})

test('防抖草稿保存器 (DebouncedDraftSaver): 延迟合并写入与即时 flush', async () => {
  const storage = new MockStorage()
  const env = { storage, now: () => 7000 }
  const ctx = { bookId: 'b-debounce', contextId: 'c-debounce' }

  let savedCount = 0
  const saver = createDebouncedDraftSaver(ctx, {
    delayMs: 30,
    env,
    onSaved() {
      savedCount++
    },
  })

  // 连续打字
  saver.save('第一字')
  saver.save('第一句话')
  saver.save('完整的一段文字')
  assert.equal(saver.isPending(), true)
  assert.equal(saver.getRecoverableText(), '完整的一段文字')

  // 即时 flush
  const flushRes = saver.flush()
  assert.equal(flushRes?.success, true)
  assert.equal(flushRes?.draft.text, '完整的一段文字')
  assert.equal(saver.isPending(), false)
  assert.equal(savedCount, 1)

  // 验证确实存入了底层存储
  const loaded = loadNoteDraft(ctx, env)
  assert.equal(loaded.success, true)
  assert.equal(loaded.draft.text, '完整的一段文字')
})
