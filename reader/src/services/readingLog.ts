/**
 * 阅读记录: 按天、按书记录阅读秒数 (GitHub #7).
 *
 * 存在独立的 IndexedDB `lightread-stats` 里 (与书库、同步基线分开), 每行一个
 * `${device}|${day}|${ref}`:
 * - `ref = id:<本地 bookId>`: 本机阅读时记下 (library.addReadingTime 调用 recordReading).
 * - `ref = h:<内容 hash>`: 同步落地的记录 (别的设备读的, 或本机缺失、由同步补回的差额).
 * 同步时按 hash 聚合成 SyncDoc.readingLog (G-Counter, 合并取每个叶子的较大值), 规则见 docs/sync.md.
 *
 * 本模块顶层不依赖 vue / pinia / 书库; 存储、设备 id、书架均可注入, 可在 node 里测试.
 */
import type Dexie from 'dexie'
import type { Table } from 'dexie'
import { createReadingIdentity, type ReadingIdentity } from './localReadingIdentity.ts'
import { sortBooks, type DailyMap, type DayBook } from './readingStats.ts'

export type { DailyMap, DayBook, DayEntry } from './readingStats.ts'

export interface ReadingLogRow {
  /** `${device}|${day}|${ref}`，ref = `id:<本地 bookId>`（本机记录）或 `h:<内容 hash>`（同步来的记录） */
  key: string
  /** Stable local device identity, including records written by earlier versions. */
  device: string
  /** 本地日期 YYYY-MM-DD (记录发生时设备的本地时区) */
  day: string
  bookId?: string
  hash?: string
  /** 书名快照: 书被删后仍能显示 */
  title: string
  kind: 'book' | 'paper'
  seconds: number
  updatedAt: number
}

/** Historical archive shape: device → day → content hash → seconds. */
export type ReadingLogDoc = Record<string, Record<string, Record<string, number>>>

/** 对一行累加秒数 (不存在则创建) */
export interface ReadingLogDelta {
  device: string
  day: string
  /** `id:<bookId>` 或 `h:<hash>` */
  ref: string
  title: string
  kind: 'book' | 'paper'
  seconds: number
}

export interface ReadingLogStore {
  all(): Promise<ReadingLogRow[]>
  /** 在一个事务里逐行累加 */
  add(deltas: ReadingLogDelta[], now: number): Promise<void>
  /** 按 key 合并, 取秒数较大的一行 (导入备份); 返回有变化的行数 */
  putMax(rows: ReadingLogRow[]): Promise<number>
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export const rowKey = (device: string, day: string, ref: string) => `${device}|${day}|${ref}`

/** 本地日期 YYYY-MM-DD (设备当前时区) */
export function localDay(ts: number = Date.now()): string {
  const d = new Date(ts)
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const normKind = (k: unknown): 'book' | 'paper' => (k === 'paper' ? 'paper' : 'book')

function rowFromDelta(d: ReadingLogDelta, prev: ReadingLogRow | undefined, now: number): ReadingLogRow {
  const row: ReadingLogRow = {
    key: rowKey(d.device, d.day, d.ref),
    device: d.device,
    day: d.day,
    title: d.title || prev?.title || '',
    kind: d.kind,
    seconds: (prev?.seconds ?? 0) + d.seconds,
    updatedAt: now,
  }
  if (d.ref.startsWith('id:')) row.bookId = d.ref.slice(3)
  else if (d.ref.startsWith('h:')) row.hash = d.ref.slice(2)
  return row
}

/** 校验并规范化一行 (备份导入等外部数据); 无效返回 null */
export function normalizeRow(value: unknown): ReadingLogRow | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.key !== 'string') return null
  const i = v.key.indexOf('|')
  const j = i < 0 ? -1 : v.key.indexOf('|', i + 1)
  if (i <= 0 || j < 0) return null
  const device = v.key.slice(0, i)
  const day = v.key.slice(i + 1, j)
  const ref = v.key.slice(j + 1)
  const seconds = Number(v.seconds)
  if (!DAY_RE.test(day) || !Number.isFinite(seconds) || seconds <= 0) return null
  const row: ReadingLogRow = {
    key: v.key,
    device,
    day,
    title: typeof v.title === 'string' ? v.title : '',
    kind: normKind(v.kind),
    seconds,
    updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : 0,
  }
  if (ref.startsWith('id:') && ref.length > 3) row.bookId = ref.slice(3)
  else if (ref.startsWith('h:') && ref.length > 2) row.hash = ref.slice(2)
  else return null
  return row
}

// ---- 存储实现 ----

/** 内存实现 (测试用) */
export function createMemoryReadingLogStore(initial: ReadingLogRow[] = []): ReadingLogStore {
  const rows = new Map(initial.map(r => [r.key, structuredClone(r)]))
  return {
    async all() { return [...rows.values()].map(r => structuredClone(r)) },
    async add(deltas, now) {
      for (const d of deltas) {
        if (!(d.seconds > 0)) continue
        const key = rowKey(d.device, d.day, d.ref)
        rows.set(key, rowFromDelta(d, rows.get(key), now))
      }
    },
    async putMax(list) {
      let changed = 0
      for (const r of list) {
        const prev = rows.get(r.key)
        if (prev && prev.seconds >= r.seconds) continue
        rows.set(r.key, structuredClone(r))
        changed++
      }
      return changed
    },
  }
}

/** IndexedDB 实现 (Dexie 按需加载), 库名 `lightread-stats` */
export function createDexieReadingLogStore(): ReadingLogStore {
  type Db = Dexie & { log: Table<ReadingLogRow, string> }
  let dbPromise: Promise<Db> | null = null
  const db = () => {
    dbPromise ??= import('dexie').then(({ default: DexieCtor }) => {
      const d = new DexieCtor('lightread-stats') as Db
      d.version(1).stores({ log: 'key, day' })
      return d
    }).catch(err => {
      dbPromise = null
      throw err
    })
    return dbPromise
  }
  return {
    async all() {
      return (await db()).log.toArray()
    },
    async add(deltas, now) {
      const d = await db()
      await d.transaction('rw', d.log, async () => {
        for (const delta of deltas) {
          if (!(delta.seconds > 0)) continue
          const key = rowKey(delta.device, delta.day, delta.ref)
          await d.log.put(rowFromDelta(delta, await d.log.get(key), now))
        }
      })
    },
    async putMax(list) {
      const d = await db()
      return d.transaction('rw', d.log, async () => {
        let changed = 0
        for (const r of list) {
          const prev = await d.log.get(r.key)
          if (prev && prev.seconds >= r.seconds) continue
          await d.log.put(r)
          changed++
        }
        return changed
      })
    },
  }
}

// ---- 同步用的纯函数 ----

/** 行对应的内容 hash: h 行自带, id 行查 hash 缓存; 查不到返回 undefined (不参与同步) */
function hashOfRow(row: ReadingLogRow, hashes: ReadonlyMap<string, string>): string | undefined {
  if (row.hash) return row.hash
  return row.bookId ? hashes.get(row.bookId) : undefined
}

/**
 * 本地记录 → SyncDoc.readingLog: 每个 (设备, 日期, hash) = 该设备该天映射到该 hash 的
 * id 行之和 + h 行. 没有 hash 的 id 行 (书已删且从未算过 hash) 留在本地, 不上传.
 */
export function aggregateReadingLog(
  rows: readonly ReadingLogRow[],
  hashes: ReadonlyMap<string, string>,
): ReadingLogDoc {
  const out: ReadingLogDoc = {}
  for (const row of rows) {
    const hash = hashOfRow(row, hashes)
    if (!hash || !(row.seconds > 0)) continue
    const days = (out[row.device] ??= {})
    const books = (days[row.day] ??= {})
    books[hash] = (books[hash] ?? 0) + row.seconds
  }
  return out
}

/** 合并结果比本地已有的多出的部分 (要补进 h 行的差额) */
export function planReadingLogLanding(
  merged: ReadingLogDoc | undefined,
  local: ReadingLogDoc,
): Array<{ device: string; day: string; hash: string; seconds: number }> {
  const out: Array<{ device: string; day: string; hash: string; seconds: number }> = []
  for (const device of Object.keys(merged ?? {}).sort()) {
    const days = merged![device]
    for (const day of Object.keys(days).sort()) {
      if (!DAY_RE.test(day)) continue
      for (const hash of Object.keys(days[day]).sort()) {
        const want = days[day][hash]
        const have = local[device]?.[day]?.[hash] ?? 0
        if (Number.isFinite(want) && want > have) out.push({ device, day, hash, seconds: want - have })
      }
    }
  }
  return out
}

// ---- 带依赖的实例 ----

export interface ShelfBook {
  id: string
  title: string
  kind?: 'book' | 'paper'
  addedAt?: number
}

export interface ReadingLogDeps {
  store: ReadingLogStore
  /** Local identity and historical book-content mapping. */
  identity: ReadingIdentity
  /** 当前书架 (loadDaily 用来判断书还在不在、取最新书名); 不提供则视 id 行的书都在 */
  listBooks?: () => Promise<ShelfBook[]>
  now?: () => number
}

export interface ReadingLog {
  list(): Promise<ReadingLogRow[]>
  recordReading(book: { id: string; title: string; kind?: 'book' | 'paper' }, seconds: number, at?: number): Promise<void>
  loadDaily(): Promise<DailyMap>
  onChange(cb: () => void): () => void
  /** 导入备份: 按 key 取较大值合并; 返回有变化的行数 */
  importRows(rows: unknown[]): Promise<number>
}

export function createReadingLog(deps: ReadingLogDeps): ReadingLog {
  const now = deps.now ?? Date.now
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const cb of [...listeners]) {
      try { cb() } catch (err) { console.warn('[readingLog] listener failed', err) }
    }
  }

  return {
    async recordReading(book, seconds, at) {
      const s = Math.round(seconds)
      if (!(s > 0) || !book.id) return
      const device = await deps.identity.getDeviceId()
      const ts = at ?? now()
      await deps.store.add([{
        device,
        day: localDay(ts),
        ref: `id:${book.id}`,
        title: book.title,
        kind: normKind(book.kind),
        seconds: s,
      }], ts)
      emit()
    },

    list: () => deps.store.all(),

    async importRows(rows) {
      const valid = rows.map(normalizeRow).filter((r): r is ReadingLogRow => r !== null)
      if (!valid.length) return 0
      const changed = await deps.store.putMax(valid)
      if (changed) emit()
      return changed
    },

    async loadDaily() {
      const [rows, hashes] = await Promise.all([deps.store.all(), deps.identity.getHashes()])
      let shelf: ShelfBook[] | null = null
      if (deps.listBooks) {
        try { shelf = await deps.listBooks() } catch (err) { console.warn('[readingLog] listBooks failed', err) }
      }
      const live = shelf ? new Map(shelf.map(b => [b.id, b])) : null
      // hash → 书架上规范的那本 (同内容多本时取 addedAt 最早)
      const liveByHash = new Map<string, ShelfBook>()
      if (shelf) {
        const sorted = [...shelf].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id))
        for (const b of sorted) {
          const h = hashes.get(b.id)
          if (h && !liveByHash.has(h)) liveByHash.set(h, b)
        }
      } else {
        for (const [id, h] of [...hashes].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (!liveByHash.has(h)) liveByHash.set(h, { id, title: '' })
        }
      }

      const daily: DailyMap = {}
      const byDay = new Map<string, Map<string, DayBook>>()
      for (const row of rows) {
        if (!(row.seconds > 0) || !DAY_RE.test(row.day)) continue
        const hash = hashOfRow(row, hashes)
        let liveId: string | undefined = hash ? liveByHash.get(hash)?.id : undefined
        if (!liveId && row.bookId && (!live || live.has(row.bookId))) liveId = row.bookId
        const key = liveId ? `id:${liveId}` : hash ? `h:${hash}` : `t:${row.title}`
        const shelfBook = liveId ? live?.get(liveId) : undefined
        const books = byDay.get(row.day) ?? new Map<string, DayBook>()
        byDay.set(row.day, books)
        const prev = books.get(key)
        if (prev) {
          prev.seconds += row.seconds
          if (!prev.title && row.title) prev.title = row.title
        } else {
          const b: DayBook = {
            key,
            title: shelfBook?.title || row.title,
            kind: shelfBook ? normKind(shelfBook.kind) : row.kind,
            seconds: row.seconds,
          }
          if (liveId) b.bookId = liveId
          books.set(key, b)
        }
      }
      for (const day of [...byDay.keys()].sort()) {
        const books = sortBooks([...byDay.get(day)!.values()])
        daily[day] = { seconds: books.reduce((s, b) => s + b.seconds, 0), books }
      }
      return daily
    },

    onChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
}

// ---- 应用里的默认实例 ----

let instance: ReadingLog | null = null

function defaultLog(): ReadingLog {
  instance ??= createReadingLog({
    store: createDexieReadingLogStore(),
    identity: createReadingIdentity(),
    listBooks: async () => {
      const { getStorage } = await import('../storage/index.ts')
      return (await getStorage()).listBooks()
    },
  })
  return instance
}

/** 记一笔 (library.addReadingTime 调用) */
export function recordReading(
  book: { id: string; title: string; kind?: 'book' | 'paper' },
  seconds: number,
  at?: number,
): Promise<void> {
  return defaultLog().recordReading(book, seconds, at)
}

export function listReadingLog(): Promise<ReadingLogRow[]> {
  return defaultLog().list()
}

/** UI 用: 按天聚合 (同一天同一本书跨设备合并; hash 记录能映射回本地书时给出 bookId) */
export function loadDaily(): Promise<DailyMap> {
  return defaultLog().loadDaily()
}

/** 订阅变化 (记录、同步落地、导入后触发), 返回取消函数 */
export function onReadingLogChange(cb: () => void): () => void {
  return defaultLog().onChange(cb)
}

/** 导入备份里的记录 (按 key 取较大值) */
export function importReadingLogRows(rows: unknown[]): Promise<number> {
  return defaultLog().importRows(rows)
}
