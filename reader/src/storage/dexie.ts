/** Web 端存储实现: IndexedDB (Dexie), 书籍与封面以 Blob 存库 */
import Dexie, { type Table } from 'dexie'
import type {
  AnnotationRec, BooklistRec, BooklistWantedRec, BookMeta, CatalogSourceRec, LibraryStorage, NewBookMeta,
} from './types'
import { BUILTIN_SOURCES, newId } from './types'
import { readReferencedFile, validateSourceRef, validateAvailability } from './sourceFile'

interface BookRow extends BookMeta {
  /** Safari 的 IndexedDB 存 Blob 会报错, 统一存 ArrayBuffer */
  file?: ArrayBuffer
  cover?: ArrayBuffer
}

interface BooklistItemRow {
  booklistId: string
  bookId: string
  addedAt: number
}

/** 兼容旧数据 (Chromium 时期可能存的是 Blob) */
const toBlob = (data: ArrayBuffer | Blob, type?: string): Blob =>
  data instanceof Blob ? data : new Blob([data], type ? { type } : undefined)

class LightReadDB extends Dexie {
  books!: Table<BookRow, string>
  annotations!: Table<AnnotationRec, string>
  sources!: Table<CatalogSourceRec, string>
  booklists!: Table<BooklistRec, string>
  booklistItems!: Table<BooklistItemRow, [string, string]>
  booklistWanted!: Table<BooklistWantedRec, string>

  constructor() {
    super('lightread')
    this.version(1).stores({
      books: 'id, title, author, format, addedAt, lastReadAt',
      annotations: 'id, bookId, createdAt',
      sources: 'id, url, addedAt',
    })
    this.version(2).stores({
      books: 'id, title, author, format, addedAt, lastReadAt',
      annotations: 'id, bookId, createdAt',
      sources: 'id, url, addedAt',
      booklists: 'id, name, createdAt, updatedAt',
      booklistItems: '[booklistId+bookId], booklistId, bookId, addedAt',
    })
    // 3: 书单的「待找」条目 (还不在藏书里的书), 见 docs/booklists.md
    this.version(3).stores({
      books: 'id, title, author, format, addedAt, lastReadAt',
      annotations: 'id, bookId, createdAt',
      sources: 'id, url, addedAt',
      booklists: 'id, name, createdAt, updatedAt',
      booklistItems: '[booklistId+bookId], booklistId, bookId, addedAt',
      booklistWanted: 'id, booklistId, addedAt',
    })
  }
}

const stripBlobs = ({ file, cover, ...meta }: BookRow): BookMeta => meta

export class DexieStorage implements LibraryStorage {
  readonly kind = 'indexeddb' as const
  private db = new LightReadDB()

  async init() {
    // 内置书源与代码中的清单同步 (处理内置源的增删调整)
    const builtinUrls = new Set(BUILTIN_SOURCES.map(s => s.url))
    const existing = await this.db.sources.toArray()
    for (const s of existing) {
      if (s.builtin && !builtinUrls.has(s.url)) await this.db.sources.delete(s.id)
    }
    const existingUrls = new Set(existing.map(s => s.url))
    for (const s of BUILTIN_SOURCES) {
      if (!existingUrls.has(s.url)) {
        await this.db.sources.add({ ...s, id: newId(), builtin: true, addedAt: Date.now() })
      }
    }
  }

  async listBooks() {
    const rows = await this.db.books.orderBy('addedAt').reverse().toArray()
    return rows.map(stripBlobs)
  }

  async getBook(id: string) {
    const row = await this.db.books.get(id)
    return row ? stripBlobs(row) : undefined
  }

  async addBook(meta: NewBookMeta, file: Blob, cover?: Blob) {
    if (meta.sourceRef) throw new Error('Use addReferencedBook for source documents')
    validateAvailability(meta.fileAvailability)
    const id = newId()
    await this.db.books.add({
      ...meta,
      id,
      hasCover: !!cover,
      file: await file.arrayBuffer(),
      cover: cover ? await cover.arrayBuffer() : undefined,
    })
    return id
  }

  async addReferencedBook(meta: NewBookMeta & { sourceRef: NonNullable<BookMeta['sourceRef']> }, cover?: Blob) {
    const sourceRef = validateSourceRef(meta.sourceRef)
    validateAvailability(meta.fileAvailability)
    const id = newId()
    await this.db.books.add({ ...meta, sourceRef, id, hasCover: !!cover,
      cover: cover ? await cover.arrayBuffer() : undefined })
    return id
  }

  async updateBook(id: string, patch: Partial<Omit<BookMeta, 'id'>>) {
    if (patch.sourceRef !== undefined) validateSourceRef(patch.sourceRef)
    validateAvailability(patch.fileAvailability)
    const changed = await this.db.books.update(id, patch)
    if (!changed) throw new Error('Book not found')
  }

  async deleteBook(id: string) {
    await this.db.transaction(
      'rw',
      this.db.books,
      this.db.annotations,
      this.db.booklistItems,
      async () => {
      await this.db.books.delete(id)
      await this.db.annotations.where('bookId').equals(id).delete()
      await this.db.booklistItems.where('bookId').equals(id).delete()
    })
  }

  async getBookFile(id: string) {
    const row = await this.db.books.get(id)
    if (!row) throw new Error('书籍不存在')
    if (row.sourceRef) return readReferencedFile(row.sourceRef)
    if (!row.file) throw new Error('Book file is missing or corrupt')
    return toBlob(row.file)
  }

  async getCoverUrl(id: string) {
    const row = await this.db.books.get(id)
    if (!row?.cover) return undefined
    // Transfers exclusive ownership; the caller releases the URL.
    return URL.createObjectURL(toBlob(row.cover, 'image/jpeg'))
  }

  async listBooklists() {
    return this.db.booklists.orderBy('createdAt').reverse().toArray()
  }

  async createBooklist(name: string, opts: { id?: string; createdAt?: number } = {}) {
    const id = opts.id ?? newId()
    const now = Date.now()
    await this.db.booklists.put({ id, name, createdAt: opts.createdAt ?? now, updatedAt: now })
    return id
  }

  async renameBooklist(id: string, name: string) {
    await this.db.booklists.update(id, { name, updatedAt: Date.now() })
  }

  async deleteBooklist(id: string) {
    await this.db.transaction('rw', this.db.booklists, this.db.booklistItems, this.db.booklistWanted, async () => {
      await this.db.booklistItems.where('booklistId').equals(id).delete()
      await this.db.booklistWanted.where('booklistId').equals(id).delete()
      await this.db.booklists.delete(id)
    })
  }

  async listBooklistBookIds(booklistId: string) {
    const rows = await this.db.booklistItems
      .where('booklistId').equals(booklistId)
      .sortBy('addedAt')
    return rows.map(row => row.bookId)
  }

  async listBooklistItems(booklistId: string) {
    const rows = await this.db.booklistItems
      .where('booklistId').equals(booklistId)
      .sortBy('addedAt')
    return rows.map(({ bookId, addedAt }) => ({ bookId, addedAt }))
  }

  async addBooksToBooklist(booklistId: string, bookIds: string[], opts: { addedAt?: number } = {}) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    const now = Date.now()
    const start = opts.addedAt ?? now
    await this.db.transaction('rw', this.db.booklists, this.db.booklistItems, async () => {
      await this.db.booklistItems.bulkPut(
        uniqueIds.map((bookId, index) => ({ booklistId, bookId, addedAt: start + index })))
      await this.db.booklists.update(booklistId, { updatedAt: now })
    })
  }

  async removeBooksFromBooklist(booklistId: string, bookIds: string[]) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    await this.db.transaction('rw', this.db.booklists, this.db.booklistItems, async () => {
      await this.db.booklistItems.bulkDelete(uniqueIds.map(bookId => [booklistId, bookId]))
      await this.db.booklists.update(booklistId, { updatedAt: Date.now() })
    })
  }

  async listBooklistWanted() {
    return this.db.booklistWanted.orderBy('addedAt').toArray()
  }

  async putBooklistWanted(recs: BooklistWantedRec[]) {
    if (!recs.length) return
    const now = Date.now()
    await this.db.transaction('rw', this.db.booklists, this.db.booklistWanted, async () => {
      await this.db.booklistWanted.bulkPut(recs.map(rec => ({ ...rec })))
      for (const id of new Set(recs.map(rec => rec.booklistId))) {
        await this.db.booklists.update(id, { updatedAt: now })
      }
    })
  }

  async deleteBooklistWanted(ids: string[]) {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    await this.db.transaction('rw', this.db.booklists, this.db.booklistWanted, async () => {
      const rows = (await this.db.booklistWanted.bulkGet(unique)).filter(Boolean) as BooklistWantedRec[]
      await this.db.booklistWanted.bulkDelete(unique)
      const now = Date.now()
      for (const id of new Set(rows.map(row => row.booklistId))) {
        await this.db.booklists.update(id, { updatedAt: now })
      }
    })
  }

  async listAnnotations(bookId: string) {
    return this.db.annotations.where('bookId').equals(bookId).sortBy('createdAt')
  }

  async listAllAnnotations(): Promise<AnnotationRec[]> {
    try {
      return await this.db.annotations.orderBy('createdAt').reverse().toArray()
    } catch {
      const all = await this.db.annotations.toArray()
      return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    }
  }

  async addAnnotation(a: Omit<AnnotationRec, 'id'> & { id?: string }) {
    const id = a.id ?? newId()
    await this.db.annotations.put({ ...a, id })
    return id
  }

  async updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>) {
    await this.db.annotations.update(id, patch)
  }

  async deleteAnnotation(id: string) {
    await this.db.annotations.delete(id)
  }

  async listSources() {
    return this.db.sources.orderBy('addedAt').toArray()
  }

  async addSource(s: Omit<CatalogSourceRec, 'id'>) {
    const id = newId()
    await this.db.sources.add({ ...s, id })
    return id
  }

  async updateSource(id: string, s: Omit<CatalogSourceRec, 'id' | 'builtin'>) {
    const cur = await this.db.sources.get(id)
    if (!cur) return
    const next: CatalogSourceRec = {
      id, builtin: cur.builtin, title: s.title, url: s.url, kind: s.kind, addedAt: s.addedAt,
    }
    if (s.updatedAt !== undefined) next.updatedAt = s.updatedAt
    if (s.username) next.username = s.username
    if (s.password) next.password = s.password
    await this.db.sources.put(next)
  }

  async deleteSource(id: string) {
    await this.db.sources.delete(id)
  }
}
