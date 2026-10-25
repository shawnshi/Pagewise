/**
 * Android 本地存储实现 (Tauri 2):
 *  - 书籍与封面以原始文件形式存放在应用数据目录 books/ covers/ 下
 *  - 元数据与原生设置/导入共用 Android SQLite, 不再混用 bundled sqlx
 */
import type {
  AnnotationRec, BookClassificationUpdate, BookDescriptionSnapshot, BookReadingStatusSnapshot, ReadingStatus, LegacyBookTagsUpdate, BooklistRec, BooklistWantedRec, BookMeta, CatalogSourceRec, LibraryStorage, LocalFileRef, NewBookMeta,
} from './types'
import { BUILTIN_SOURCES, getLibraryRoot, newId } from './types'
import { RecommendationError, RecommendationStatusConflictError, validateRecommendationStatusUpdate } from '../services/bookRecommendations.ts'
import { BookDescriptionConflictError, validateBookDescriptionUpdate } from '../services/bookDescription.ts'
import { isReadingStatus, normalizeReadingStatus } from '../services/readingStatus'
import { prepareClassificationUpdates, rejectClassificationPatch, validatedBookClassification } from '../services/bookTagActions'
import { parseClassification } from '../services/bookClassification'
import { readReferencedFile, validateSourceRef, validateAvailability } from './sourceFile'
import { openNativeSqlDatabase } from '../services/nativeSqlDatabase'

type SqlDatabase = {
  execute(sql: string, values?: unknown[]): Promise<{ rowsAffected: number }>
  select<T>(sql: string, values?: unknown[]): Promise<T>
  classify(updates: readonly unknown[]): Promise<{ rowsAffected: number }>
}

import { blobChunks } from './blobStream'
import { toBase64Chunk } from '../services/base64'

/** 超过该大小的复制导入改用 ReadableStream, 避免整本数组穿过 IPC。 */
const LARGE_WRITE_BYTES = 8 * 1024 * 1024

interface BookRow {
  id: string
  title: string
  author: string
  format: string
  file_name: string
  description: string | null
  language: string | null
  tags: string
  classification: string | null
  added_at: number
  last_read_at: number | null
  location: string | null
  progress: number | null
  source: string | null
  reading_status: string | null
  publisher: string | null
  publication_date: string | null
  source_ref: string | null
  file_availability: string | null
  has_cover: number
  reading_seconds: number | null
  pinned_at: number | null
  kind: string | null
}

const rowToMeta = (r: BookRow): BookMeta => validatedBookClassification({
  id: r.id,
  title: r.title,
  author: r.author,
  format: r.format as BookMeta['format'],
  fileName: r.file_name,
  description: r.description ?? undefined,
  language: r.language ?? undefined,
  publisher: r.publisher ?? undefined,
  publicationDate: r.publication_date ?? undefined,
  sourceRef: r.source_ref == null ? undefined : validateSourceRef(JSON.parse(r.source_ref)),
  fileAvailability: validateAvailability(r.file_availability),
  tags: JSON.parse(r.tags || '[]'),
  classification: r.classification == null ? undefined : parseClassification(JSON.parse(r.classification)),
  addedAt: r.added_at,
  lastReadAt: r.last_read_at ?? undefined,
  location: r.location ?? undefined,
  progress: r.progress ?? undefined,
  source: r.source ?? undefined,
  readingStatus: normalizeReadingStatus(r.reading_status),
  hasCover: !!r.has_cover,
  readingSeconds: r.reading_seconds ?? 0,
  pinnedAt: r.pinned_at ?? undefined,
  kind: r.kind === 'paper' ? 'paper' : 'book',
})

const META_COLUMNS: Record<string, string> = {
  title: 'title',
  format: 'format',
  addedAt: 'added_at',
  author: 'author',
  fileName: 'file_name',
  description: 'description',
  language: 'language',
  publisher: 'publisher',
  publicationDate: 'publication_date',
  fileAvailability: 'file_availability',
  lastReadAt: 'last_read_at',
  location: 'location',
  progress: 'progress',
  source: 'source',
  readingStatus: 'reading_status',
  readingSeconds: 'reading_seconds',
  pinnedAt: 'pinned_at',
  kind: 'kind',
}

export class TauriStorage implements LibraryStorage {
  readonly kind = 'filesystem' as const
  private db!: SqlDatabase
  private fs!: typeof import('@tauri-apps/plugin-fs')
  /** 自定义书库根目录, 空为默认应用数据目录 */
  private root = ''

  /** 相对路径 → fs 插件的 (path, options); 自定义根目录时用绝对路径 */
  private loc(rel: string): [string, { baseDir?: number }] {
    return this.root
      ? [`${this.root}/${rel}`, {}]
      : [rel, { baseDir: this.fs.BaseDirectory.AppData }]
  }

  async init() {
    this.fs = await import('@tauri-apps/plugin-fs')
    this.root = getLibraryRoot().replace(/\/+$/, '')
    this.db = await openNativeSqlDatabase(this.root, `
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL,
        file_name TEXT NOT NULL,
        description TEXT,
        language TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        added_at INTEGER NOT NULL,
        last_read_at INTEGER,
        location TEXT,
        progress REAL,
        source TEXT,
        reading_status TEXT,
        has_cover INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        cfi TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        note TEXT,
        color TEXT NOT NULL DEFAULT 'yellow',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booklists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booklist_items (
        booklist_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (booklist_id, book_id)
      );
      CREATE INDEX IF NOT EXISTS idx_booklist_items_booklist
        ON booklist_items(booklist_id);
      CREATE INDEX IF NOT EXISTS idx_booklist_items_book
        ON booklist_items(book_id);
      CREATE TABLE IF NOT EXISTS booklist_wanted (
        id TEXT PRIMARY KEY,
        booklist_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        isbn TEXT,
        year INTEGER,
        note TEXT,
        original_title TEXT,
        original_author TEXT,
        added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_booklist_wanted_booklist
        ON booklist_wanted(booklist_id);
    `)

    for (const dir of ['books', 'covers']) {
      const [path, opts] = this.loc(dir)
      if (!(await this.fs.exists(path, opts))) {
        await this.fs.mkdir(path, { ...opts, recursive: true })
      }
    }

    // Inspect before ALTER: duplicate columns are harmless; other migration failures are not.
    const migrations = [
      ['PRAGMA table_info(sources)', [
        "ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'opds'",
        'ALTER TABLE sources ADD COLUMN username TEXT', 'ALTER TABLE sources ADD COLUMN password TEXT',
        'ALTER TABLE sources ADD COLUMN updated_at INTEGER',
      ]],
      ['PRAGMA table_info(annotations)', ["ALTER TABLE annotations ADD COLUMN kind TEXT NOT NULL DEFAULT 'highlight'"]],
      ['PRAGMA table_info(books)', [
        'ALTER TABLE books ADD COLUMN reading_seconds INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE books ADD COLUMN pinned_at INTEGER', "ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'book'",
        'ALTER TABLE books ADD COLUMN reading_status TEXT', 'ALTER TABLE books ADD COLUMN publisher TEXT',
        'ALTER TABLE books ADD COLUMN publication_date TEXT', 'ALTER TABLE books ADD COLUMN source_ref TEXT',
        'ALTER TABLE books ADD COLUMN file_availability TEXT',
        'ALTER TABLE books ADD COLUMN classification TEXT',
      ]],
    ] as const
    for (const [query, statements] of migrations) {
      const columns = await this.db.select<Array<{ name: string }>>(query)
      for (const ddl of statements) {
        if (!columns.some(column => column.name === ddl.split(' ')[5])) await this.db.execute(ddl)
      }
    }

    // 内置书源与代码中的清单同步 (处理内置源的增删调整)
    const builtinUrls = BUILTIN_SOURCES.map(s => s.url)
    const rows = await this.db.select<Array<{ id: string; url: string; builtin: number }>>(
      'SELECT id, url, builtin FROM sources')
    for (const row of rows) {
      if (row.builtin && !builtinUrls.includes(row.url)) {
        await this.db.execute('DELETE FROM sources WHERE id = $1', [row.id])
      }
    }
    const existingUrls = new Set(rows.map(r => r.url))
    for (const s of BUILTIN_SOURCES) {
      if (!existingUrls.has(s.url)) {
        await this.db.execute(
          'INSERT INTO sources (id, title, url, kind, builtin, added_at) VALUES ($1, $2, $3, $4, 1, $5)',
          [newId(), s.title, s.url, s.kind, Date.now()])
      }
    }
  }

  private bookPath = (id: string, fileName: string) => {
    const ext = fileName.toLowerCase().endsWith('.fb2.zip')
      ? 'fb2.zip'
      : fileName.split('.').pop() || 'bin'
    return `books/${id}.${ext}`
  }
  private coverPath = (id: string) => `covers/${id}.jpg`

  async listBooks() {
    const rows = await this.db.select<BookRow[]>(
      'SELECT * FROM books ORDER BY added_at DESC')
    return rows.map(rowToMeta)
  }

  async listRecommendationBooks(): Promise<BookMeta[]> {
    const books:BookMeta[]=[]
    let after:string|null=null
    for (;;) {
      const rows:BookRow[]=await this.db.select<BookRow[]>(
        `SELECT id,title,author,format,file_name,substr(description,1,2048) AS description,language,tags,classification,
         added_at,last_read_at,progress,reading_status,has_cover,kind,reading_seconds,publisher,publication_date,file_availability,
         NULL AS location,NULL AS source_ref,NULL AS source,NULL AS pinned_at
         FROM books WHERE $1 IS NULL OR id > $1 ORDER BY id LIMIT 128`,[after])
      books.push(...rows.map(rowToMeta))
      if(books.length>10_000)throw new RecommendationError('library_limit')
      if(rows.length<128)return books
      const last:string=rows.at(-1)!.id
      if(last===after)throw new RecommendationError('invalid_library')
      after=last
    }
  }

  async getBook(id: string) {
    const rows = await this.db.select<BookRow[]>(
      'SELECT * FROM books WHERE id = $1', [id])
    return rows[0] ? rowToMeta(rows[0]) : undefined
  }

  async addBook(meta: NewBookMeta, file: Blob, cover?: Blob) {
    if (meta.sourceRef) throw new Error('Use addReferencedBook for source documents')
    return this.insertBook(meta, file, cover)
  }

  async addReferencedBook(meta: NewBookMeta & { sourceRef: NonNullable<BookMeta['sourceRef']> }, cover?: Blob) {
    validateSourceRef(meta.sourceRef)
    return this.insertBook(meta, undefined, cover)
  }

  /** 大文件: base64 分块写入 cache, 再由原生一次性发布到 books/。 */
  private async writeLargeBookFile(id: string, fileName: string, file: Blob) {
    const { invoke } = await import('@tauri-apps/api/core')
    const relative = `cache/import-${crypto.randomUUID()}.bin`
    await invoke('begin_import_file', { path: relative })
    try {
      const reader = blobChunks(file).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await invoke('append_import_file', { path: relative, data: toBase64Chunk(value) })
      }
      await invoke('publish_import_file', { path: relative, target: this.bookPath(id, fileName) })
    } finally {
      await invoke('delete_import_file', { path: relative }).catch(() => { /* 发布成功或原生已清理 */ })
    }
  }

  private async insertBook(meta: NewBookMeta, file?: Blob, cover?: Blob) {
    meta = validatedBookClassification(meta)
    if (meta.readingStatus !== undefined && !isReadingStatus(meta.readingStatus)) throw new Error('Invalid reading status')
    validateAvailability(meta.fileAvailability)
    const id = newId()
    if (file) {
      if (file.size > LARGE_WRITE_BYTES) {
        await this.writeLargeBookFile(id, meta.fileName, file)
      } else {
        const [path, opts] = this.loc(this.bookPath(id, meta.fileName))
        await this.fs.writeFile(path, new Uint8Array(await file.arrayBuffer()), opts)
      }
    }
    if (cover) {
      const [path, opts] = this.loc(this.coverPath(id))
      await this.fs.writeFile(path, new Uint8Array(await cover.arrayBuffer()), opts)
    }
    await this.db.execute(
      `INSERT INTO books (id, title, author, format, file_name, description, language,
        tags, added_at, last_read_at, location, progress, source, has_cover, kind,
        reading_seconds, pinned_at, reading_status, publisher, publication_date, source_ref, file_availability, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [id, meta.title, meta.author, meta.format, meta.fileName,
        meta.description ?? null, meta.language ?? null, JSON.stringify(meta.tags),
        meta.addedAt, meta.lastReadAt ?? null, meta.location ?? null,
        meta.progress ?? null, meta.source ?? null, cover ? 1 : 0,
        meta.kind === 'paper' ? 'paper' : 'book',
        Math.round(meta.readingSeconds ?? 0), meta.pinnedAt || null, meta.readingStatus ?? null,
        meta.publisher ?? null, meta.publicationDate ?? null,
        meta.sourceRef ? JSON.stringify(meta.sourceRef) : null, meta.fileAvailability ?? null,
        meta.classification ? JSON.stringify(meta.classification) : null])
    return id
  }

  async updateBookDescription(id: string, expected: BookDescriptionSnapshot, description: string): Promise<void> {
    validateBookDescriptionUpdate(id, expected, description)
    // Single statement: a concurrent metadata/description edit must yield zero writes, not a stale overwrite.
    const result = await this.db.execute(
      `UPDATE books SET description = $1 WHERE id = $2 AND title = $3 AND author = $4
       AND COALESCE(publisher, '') = $5 AND COALESCE(publication_date, '') = $6 AND COALESCE(description, '') = $7`,
      [description, id, expected.title, expected.author, expected.publisher, expected.publicationDate, expected.description],
    )
    if (result.rowsAffected === 0) throw new BookDescriptionConflictError()
    if (result.rowsAffected !== 1) throw new Error('Unexpected description update result')
  }

  async updateBookReadingStatus(id:string,expected:BookReadingStatusSnapshot,status:ReadingStatus):Promise<void> {
    validateRecommendationStatusUpdate(id,expected,status)
    const result=await this.db.execute(
      `UPDATE books SET reading_status=$1 WHERE id=$2
       AND (CASE WHEN reading_status='unread' THEN 'unmarked' ELSE reading_status END) IS $3
       AND last_read_at IS $4 AND progress IS $5`,
      [status,id,expected.readingStatus,expected.lastReadAt,expected.progress])
    if(result.rowsAffected===0)throw new RecommendationStatusConflictError()
    if(result.rowsAffected!==1)throw new RecommendationError('commit_outcome_unknown')
  }

  async updateBook(id: string, patch: Partial<Omit<BookMeta, 'id'>>) {
    rejectClassificationPatch(patch)
    const hasTags = Object.prototype.hasOwnProperty.call(patch, 'tags')
    if (hasTags && (await this.getBook(id))?.classification) throw new Error('Use updateBookClassifications')
    if (patch.readingStatus !== undefined && !isReadingStatus(patch.readingStatus)) throw new Error('Invalid reading status')
    if (patch.sourceRef !== undefined) validateSourceRef(patch.sourceRef)
    validateAvailability(patch.fileAvailability)
    // 文件路径的扩展名取自 fileName: 同步改了文件名 (扩展名不同) 时把文件挪到新路径
    let staleFile: { path: string; opts: { baseDir?: number } } | undefined
    if (typeof patch.fileName === 'string') {
      const old = await this.getBook(id)
      const from = old && !old.sourceRef && this.bookPath(id, old.fileName)
      const to = this.bookPath(id, patch.fileName)
      if (from && from !== to) {
        const [fromPath, fromOpts] = this.loc(from)
        const [toPath, toOpts] = this.loc(to)
        try {
          // 原生复制不在 JS 保留整本书字节; 大文件改名不再形成 40 MB 数组。
          await this.fs.copyFile(fromPath, toPath, {
            ...(fromOpts.baseDir !== undefined ? { fromPathBaseDir: fromOpts.baseDir as any } : {}),
            ...(toOpts.baseDir !== undefined ? { toPathBaseDir: toOpts.baseDir as any } : {}),
          })
          // 旧的先保留: 数据库提交失败时仍能按原路径定位文件。
          staleFile = { path: fromPath, opts: fromOpts }
        } catch { /* 原文件缺失时仍允许仅更新元数据 */ }
      }
    }
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'tags' || key === 'sourceRef') {
        sets.push(`${key === 'tags' ? 'tags' : 'source_ref'} = $${values.length + 1}`)
        values.push(JSON.stringify(value))
      } else if (Object.prototype.hasOwnProperty.call(META_COLUMNS, key)) {
        sets.push(`${META_COLUMNS[key]} = $${values.length + 1}`)
        values.push(value ?? null)
      }
    }
    if (!sets.length) return
    values.push(id)
    const result = await this.db.execute(
      `UPDATE books SET ${sets.join(', ')} WHERE id = $${values.length}${hasTags ? ' AND classification IS NULL' : ''}`, values)
    if (result.rowsAffected === 0) throw new Error('Book not found')
    if (staleFile) {
      // 提交成功后才清理旧路径; 失败时最多留下一个未引用的副本, 不丢原文件。
      await this.fs.remove(staleFile.path, staleFile.opts).catch(() => { /* 旧文件残留不影响使用 */ })
    }
  }

  async incrementReadingSeconds(id: string, seconds: number) {
    const delta = Math.round(Number(seconds))
    if (!Number.isFinite(delta) || delta <= 0) throw new Error('Invalid reading seconds')
    // 单条 UPDATE 完成读-加-写, 与进度/元数据更新只触碰各自列。
    const result = await this.db.execute(
      'UPDATE books SET reading_seconds = coalesce(reading_seconds, 0) + $1 WHERE id = $2', [delta, id])
    if (result.rowsAffected === 0) throw new Error('Book not found')
    const rows = await this.db.select<Array<{ reading_seconds: number | null }>>(
      'SELECT reading_seconds FROM books WHERE id = $1', [id])
    return Math.max(0, Math.round(rows[0]?.reading_seconds ?? 0))
  }

  async updateBookClassifications(updates: readonly BookClassificationUpdate[], legacyUpdates: readonly LegacyBookTagsUpdate[] = []) {
    const prepared = prepareClassificationUpdates(updates, legacyUpdates)
    if (!prepared.length) return
    // Native transaction checks every CAS gate before updating any row, including API24/32 engines without MATERIALIZED.
    const result = await this.db.classify(prepared)
    if (result.rowsAffected !== prepared.length) throw new Error('Book classification conflict')
  }

  async deleteBook(id: string) {
    const meta = await this.getBook(id)
    // 先删书目行: 后续清理失败最多留下不可见的孤立关系行, 不会出现“批注已消失、书还在”的状态。
    await this.db.execute('DELETE FROM books WHERE id = $1', [id])
    await this.db.execute('DELETE FROM annotations WHERE book_id = $1', [id])
      .catch(error => console.warn('Pagewise: annotation cleanup failed', error))
    await this.db.execute('DELETE FROM booklist_items WHERE book_id = $1', [id])
      .catch(error => console.warn('Pagewise: booklist cleanup failed', error))
    if (meta) {
      if (!meta.sourceRef) {
        const [bookPath, bookOpts] = this.loc(this.bookPath(id, meta.fileName))
        await this.fs.remove(bookPath, bookOpts).catch(() => { /* 文件缺失不阻塞删除 */ })
      }
      if (meta.hasCover) {
        const [coverPath, coverOpts] = this.loc(this.coverPath(id))
        await this.fs.remove(coverPath, coverOpts).catch(() => { /* 同上 */ })
      }
    }
  }

  async getBookFile(id: string) {
    const meta = await this.getBook(id)
    if (!meta) throw new Error('书籍不存在')
    if (meta.sourceRef) return readReferencedFile(meta.sourceRef)
    const [path, opts] = this.loc(this.bookPath(id, meta.fileName))
    const bytes = await this.fs.readFile(path, opts)
    return new Blob([bytes.buffer as ArrayBuffer])
  }

  async getBookFileRef(id: string): Promise<LocalFileRef | undefined> {
    const meta = await this.getBook(id)
    if (!meta || meta.sourceRef) return undefined
    const rel = this.bookPath(id, meta.fileName)
    return { kind: 'local-file', root: this.root, rel, blob: () => this.getBookFile(id) }
  }

  async getCoverUrl(id: string) {
    const meta = await this.getBook(id)
    if (!meta?.hasCover) return undefined
    const [path, opts] = this.loc(this.coverPath(id))
    const bytes = await this.fs.readFile(path, opts)
    // Each caller owns this new URL; storage must not revoke a displayed cover.
    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }))
  }

  async listBooklists() {
    const rows = await this.db.select<Array<{
      id: string
      name: string
      created_at: number
      updated_at: number
    }>>('SELECT * FROM booklists ORDER BY created_at DESC')
    return rows.map((row): BooklistRec => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async createBooklist(name: string, opts: { id?: string; createdAt?: number } = {}) {
    const id = opts.id ?? newId()
    const now = Date.now()
    await this.db.execute(
      'INSERT OR REPLACE INTO booklists (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)',
      [id, name, opts.createdAt ?? now, now])
    return id
  }

  async renameBooklist(id: string, name: string) {
    await this.db.execute(
      'UPDATE booklists SET name = $1, updated_at = $2 WHERE id = $3',
      [name, Date.now(), id])
  }

  async deleteBooklist(id: string) {
    await this.db.execute('DELETE FROM booklist_items WHERE booklist_id = $1', [id])
    await this.db.execute('DELETE FROM booklist_wanted WHERE booklist_id = $1', [id])
    await this.db.execute('DELETE FROM booklists WHERE id = $1', [id])
  }

  async listBooklistBookIds(booklistId: string) {
    const rows = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM booklist_items WHERE booklist_id = $1 ORDER BY added_at',
      [booklistId])
    return rows.map(row => row.book_id)
  }

  async listBooklistItems(booklistId: string) {
    const rows = await this.db.select<Array<{ book_id: string; added_at: number }>>(
      'SELECT book_id, added_at FROM booklist_items WHERE booklist_id = $1 ORDER BY added_at',
      [booklistId])
    return rows.map(row => ({ bookId: row.book_id, addedAt: row.added_at }))
  }

  async addBooksToBooklist(booklistId: string, bookIds: string[], opts: { addedAt?: number } = {}) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    const now = Date.now()
    const start = opts.addedAt ?? now
    for (const [index, bookId] of uniqueIds.entries()) {
      await this.db.execute(
        `INSERT OR IGNORE INTO booklist_items (booklist_id, book_id, added_at)
         VALUES ($1, $2, $3)`,
        [booklistId, bookId, start + index])
    }
    await this.db.execute(
      'UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, booklistId])
  }

  async removeBooksFromBooklist(booklistId: string, bookIds: string[]) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    for (const bookId of uniqueIds) {
      await this.db.execute(
        'DELETE FROM booklist_items WHERE booklist_id = $1 AND book_id = $2',
        [booklistId, bookId])
    }
    await this.db.execute(
      'UPDATE booklists SET updated_at = $1 WHERE id = $2',
      [Date.now(), booklistId])
  }

  async listBooklistWanted() {
    const rows = await this.db.select<Array<{
      id: string; booklist_id: string; title: string; author: string; isbn: string | null; year: number | null
      note: string | null; original_title: string | null; original_author: string | null; added_at: number
    }>>('SELECT * FROM booklist_wanted ORDER BY added_at')
    return rows.map((row): BooklistWantedRec => {
      const rec: BooklistWantedRec = {
        id: row.id, booklistId: row.booklist_id, title: row.title, author: row.author ?? '', addedAt: row.added_at,
      }
      if (row.isbn) rec.isbn = row.isbn
      if (row.year != null) rec.year = row.year
      if (row.note) rec.note = row.note
      if (row.original_title) rec.originalTitle = row.original_title
      if (row.original_author) rec.originalAuthor = row.original_author
      return rec
    })
  }

  async putBooklistWanted(recs: BooklistWantedRec[]) {
    if (!recs.length) return
    for (const rec of recs) {
      await this.db.execute(
        `INSERT OR REPLACE INTO booklist_wanted
          (id, booklist_id, title, author, isbn, year, note, original_title, original_author, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [rec.id, rec.booklistId, rec.title, rec.author ?? '', rec.isbn ?? null, rec.year ?? null, rec.note ?? null,
          rec.originalTitle ?? null, rec.originalAuthor ?? null, rec.addedAt])
    }
    const now = Date.now()
    for (const id of new Set(recs.map(rec => rec.booklistId))) {
      await this.db.execute('UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, id])
    }
  }

  async deleteBooklistWanted(ids: string[]) {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    const now = Date.now()
    for (const id of unique) {
      const rows = await this.db.select<Array<{ booklist_id: string }>>(
        'SELECT booklist_id FROM booklist_wanted WHERE id = $1', [id])
      await this.db.execute('DELETE FROM booklist_wanted WHERE id = $1', [id])
      if (rows[0]) await this.db.execute('UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, rows[0].booklist_id])
    }
  }

  async listAnnotations(bookId: string) {
    const rows = await this.db.select<Array<{
      id: string; book_id: string; kind: string | null; cfi: string; text: string
      note: string | null; color: string; created_at: number
    }>>('SELECT * FROM annotations WHERE book_id = $1 ORDER BY created_at', [bookId])
    return rows.map(r => ({
      id: r.id, bookId: r.book_id,
      kind: (r.kind ?? 'highlight') as AnnotationRec['kind'],
      cfi: r.cfi, text: r.text,
      note: r.note ?? undefined, color: r.color, createdAt: r.created_at,
    }))
  }

  async listAllAnnotations(): Promise<AnnotationRec[]> {
    const rows = await this.db.select<Array<{
      id: string; book_id: string; kind: string | null; cfi: string; text: string
      note: string | null; color: string; created_at: number
    }>>('SELECT * FROM annotations ORDER BY created_at DESC')
    return rows.map(r => ({
      id: r.id, bookId: r.book_id,
      kind: (r.kind ?? 'highlight') as AnnotationRec['kind'],
      cfi: r.cfi, text: r.text,
      note: r.note ?? undefined, color: r.color, createdAt: r.created_at,
    }))
  }

  async addAnnotation(a: Omit<AnnotationRec, 'id'> & { id?: string }) {
    const id = a.id ?? newId()
    await this.db.execute(
      `INSERT OR REPLACE INTO annotations (id, book_id, kind, cfi, text, note, color, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, a.bookId, a.kind ?? 'highlight', a.cfi, a.text, a.note ?? null, a.color, a.createdAt])
    return id
  }

  async updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>) {
    if (patch.note !== undefined) {
      await this.db.execute('UPDATE annotations SET note = $1 WHERE id = $2', [patch.note ?? null, id])
    }
    if (patch.color !== undefined) {
      await this.db.execute('UPDATE annotations SET color = $1 WHERE id = $2', [patch.color, id])
    }
  }

  async deleteAnnotation(id: string) {
    await this.db.execute('DELETE FROM annotations WHERE id = $1', [id])
  }

  async listSources() {
    const rows = await this.db.select<Array<{
      id: string; title: string; url: string; kind: string; builtin: number
      added_at: number; updated_at: number | null; username: string | null; password: string | null
    }>>('SELECT * FROM sources ORDER BY added_at')
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      url: r.url,
      kind: (r.kind || 'opds') as CatalogSourceRec['kind'],
      builtin: !!r.builtin,
      addedAt: r.added_at,
      updatedAt: r.updated_at ?? undefined,
      username: r.username ?? undefined,
      password: r.password ?? undefined,
    }))
  }

  async addSource(s: Omit<CatalogSourceRec, 'id'>) {
    const id = newId()
    await this.db.execute(
      `INSERT INTO sources (id, title, url, kind, builtin, added_at, username, password, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, s.title, s.url, s.kind, s.builtin ? 1 : 0, s.addedAt,
        s.username ?? null, s.password ?? null, s.updatedAt ?? null])
    return id
  }

  async updateSource(id: string, s: Omit<CatalogSourceRec, 'id' | 'builtin'>) {
    await this.db.execute(
      `UPDATE sources SET title = $1, url = $2, kind = $3, added_at = $4, username = $5, password = $6,
       updated_at = $7 WHERE id = $8`,
      [s.title, s.url, s.kind, s.addedAt, s.username || null, s.password || null, s.updatedAt ?? null, id])
  }

  async deleteSource(id: string) {
    await this.db.execute('DELETE FROM sources WHERE id = $1', [id])
  }
}


/** 目标文件夹是否已有轻阅书库 */
export async function hasLibraryAt(root: string): Promise<boolean> {
  const fs = await import('@tauri-apps/plugin-fs')
  return fs.exists(`${root.replace(/\/+$/, '')}/lightread.db`)
}

/**
 * 把当前书库复制到新文件夹 (db + 书籍 + 封面).
 * 完成后由调用方写入 libraryRoot 设置并整页重载.
 */
export async function migrateLibraryTo(
  newRoot: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const fs = await import('@tauri-apps/plugin-fs')
  const root = newRoot.replace(/\/+$/, '')
  const currentRoot = getLibraryRoot().replace(/\/+$/, '')
  const srcLoc = (rel: string): [string, { baseDir?: number }] =>
    currentRoot ? [`${currentRoot}/${rel}`, {}] : [rel, { baseDir: fs.BaseDirectory.AppData }]
  // SQLite 主库在 AppConfig (macOS 上与 AppData 同目录, 其他平台不同)
  const srcDbLoc = (rel: string): [string, { baseDir?: number }] =>
    currentRoot ? [`${currentRoot}/${rel}`, {}] : [rel, { baseDir: fs.BaseDirectory.AppConfig }]

  for (const dir of ['books', 'covers']) {
    if (!(await fs.exists(`${root}/${dir}`))) {
      await fs.mkdir(`${root}/${dir}`, { recursive: true })
    }
  }

  onProgress?.('复制索引数据库…')
  for (const dbFile of ['lightread.db', 'lightread.db-wal', 'lightread.db-shm']) {
    const [src, opts] = srcDbLoc(dbFile)
    if (await fs.exists(src, opts)) {
      const bytes = await fs.readFile(src, opts)
      await fs.writeFile(`${root}/${dbFile}`, bytes)
    }
  }

  for (const dir of ['books', 'covers']) {
    const [srcDir, opts] = srcLoc(dir)
    if (!(await fs.exists(srcDir, opts))) continue
    const entries = await fs.readDir(srcDir, opts)
    let done = 0
    for (const entry of entries) {
      if (!entry.isFile) continue
      onProgress?.(`复制 ${dir} (${++done}/${entries.length})…`)
      const [srcFile, srcOpts] = srcLoc(`${dir}/${entry.name}`)
      const bytes = await fs.readFile(srcFile, srcOpts)
      await fs.writeFile(`${root}/${dir}/${entry.name}`, bytes)
    }
  }
  onProgress?.('迁移完成')
}
