/**
 * 点睛阅读的本地缓存 (docs/dianjing-reading.md §6.5): IndexedDB 库 `lightread-dianjing`。
 * 网页、Tauri webview、Android WebView 都有 IndexedDB; 打不开 (隐私模式、配额) 时退回内存, 不影响阅读。
 *
 * stores:
 *  - chunks:   key = cacheKey(...) → ChunkRecord (校验后的条目 + 位置 + 要句原文片段)
 *  - sections: key = sectionKey(...) → SectionSummary (章首要义)
 *  - feedback: key = `${bookId}:${itemId}` → FeedbackRecord (不是重点 / 已采纳)
 * 键都以 `${bookId}:` 开头, 便于按书前缀列出 (脉络、速读) 与清除本书缓存。
 */
import type { DjItem, PointItem } from './protocol.ts'

export interface ChunkRecord {
  key: string
  bookId: string
  section: number
  chunkIndex: number
  chunkHash: string
  model: string
  promptVersion: string
  /** 本块正文字数 (密度预算) */
  chars: number
  /** 本块第一段 / 最后一段 (脉络排序、位置判断) */
  firstBlock: number
  lastBlock: number
  items: DjItem[]
  /** 要句原文 (按 id; 速读 / 脉络在未加载的章节也能显示), 截断到 160 字 */
  texts: Record<string, string>
  /** 每句长度 (按 `${block}.${sentence}`), 密度预算用 */
  lengths: Record<string, number>
  /** 模型给出的体裁判断 (首块) */
  fiction?: boolean
  /** 这一块的 AI 重点词可用 (dj2 起; 旧记录没有, 按不可用处理) */
  kw?: boolean
  /** 流完整结束 (中断的块不写缓存, 这里恒为 true) */
  complete: true
  at: number
}

export interface SectionSummary {
  key: string
  bookId: string
  section: number
  /** 生成要义时覆盖的块 hash 拼接的 hash (内容变了就作废) */
  basis: string
  text: string
  points: PointItem[]
  at: number
}

export interface FeedbackRecord {
  key: string
  bookId: string
  itemId: string
  action: 'dismiss' | 'adopt'
  at: number
}

export const DB_NAME = 'lightread-dianjing'
const DB_VERSION = 1

export function cacheKey(bookId: string, section: number, chunkHash: string, model: string, promptVersion: string): string {
  return `${bookId}:${section}:${chunkHash}:${model}:${promptVersion}`
}

export function sectionKey(bookId: string, section: number, promptVersion: string): string {
  return `${bookId}:s${section}:${promptVersion}`
}

export function feedbackKey(bookId: string, itemId: string): string {
  return `${bookId}:${itemId}`
}

/** 按书前缀的键区间 [bookId:, bookId:￿] */
export function bookRange(bookId: string): [string, string] {
  return [`${bookId}:`, `${bookId}:￿`]
}

type StoreName = 'chunks' | 'sections' | 'feedback'

export interface DjCache {
  get<T>(store: StoreName, key: string): Promise<T | undefined>
  put<T extends { key: string }>(store: StoreName, value: T): Promise<void>
  listBook<T>(store: StoreName, bookId: string): Promise<T[]>
  clearBook(bookId: string): Promise<void>
  /** 估算占用 (字节, JSON 长度) */
  size(): Promise<number>
}

/** 内存实现 (测试、IndexedDB 不可用时) */
export function createMemoryCache(): DjCache {
  const stores: Record<StoreName, Map<string, any>> = { chunks: new Map(), sections: new Map(), feedback: new Map() }
  return {
    async get(store, key) { return stores[store].get(key) },
    async put(store, value) { stores[store].set(value.key, value) },
    async listBook(store, bookId) {
      const [a, b] = bookRange(bookId)
      return [...stores[store].entries()].filter(([k]) => k >= a && k <= b).map(([, v]) => v)
    },
    async clearBook(bookId) {
      const [a, b] = bookRange(bookId)
      for (const m of Object.values(stores)) for (const k of [...m.keys()]) if (k >= a && k <= b) m.delete(k)
    },
    async size() {
      let n = 0
      for (const m of Object.values(stores)) for (const v of m.values()) n += JSON.stringify(v).length
      return n
    },
  }
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION)
    open.onupgradeneeded = () => {
      const db = open.result
      for (const name of ['chunks', 'sections', 'feedback']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' })
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(new Error('blocked'))
  })
}

export function createIdbCache(): DjCache {
  let dbp: Promise<IDBDatabase> | null = null
  let fallback: DjCache | null = null
  const db = () => (dbp ??= openDb())
  const withStore = async <T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db()
    return req(fn(d.transaction(store, mode).objectStore(store)))
  }
  const safe = async <T>(fn: () => Promise<T>, mem: (c: DjCache) => Promise<T>): Promise<T> => {
    if (fallback) return mem(fallback)
    try {
      return await fn()
    } catch {
      fallback ??= createMemoryCache()
      return mem(fallback)
    }
  }
  return {
    get: (store, key) => safe(() => withStore(store, 'readonly', s => s.get(key)), c => c.get(store, key)),
    put: (store, value) => safe(async () => { await withStore(store, 'readwrite', s => s.put(JSON.parse(JSON.stringify(value)))) }, c => c.put(store, value)),
    listBook: (store, bookId) => safe(() => {
      const [a, b] = bookRange(bookId)
      return withStore(store, 'readonly', s => s.getAll(IDBKeyRange.bound(a, b)))
    }, c => c.listBook(store, bookId)),
    clearBook: bookId => safe(async () => {
      const [a, b] = bookRange(bookId)
      for (const store of ['chunks', 'sections', 'feedback'] as StoreName[]) {
        await withStore(store, 'readwrite', s => s.delete(IDBKeyRange.bound(a, b)))
      }
    }, c => c.clearBook(bookId)),
    size: () => safe(async () => {
      let n = 0
      for (const store of ['chunks', 'sections', 'feedback'] as StoreName[]) {
        const all = await withStore(store, 'readonly', s => s.getAll())
        for (const v of all as unknown[]) n += JSON.stringify(v).length
      }
      return n
    }, c => c.size()),
  }
}

let shared: DjCache | null = null
/** 全局缓存实例 (惰性打开) */
export function getDjCache(): DjCache {
  if (!shared) shared = typeof indexedDB === 'undefined' ? createMemoryCache() : createIdbCache()
  return shared
}

/** 测试用: 替换全局实例 */
export function setDjCache(c: DjCache | null) { shared = c }
