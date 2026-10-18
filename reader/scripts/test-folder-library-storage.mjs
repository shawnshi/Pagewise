import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from './vite-isolated.mjs'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const root = resolve(import.meta.dirname, '..')
const databases = new Map()
let browser, server, base, temp
const virtualNative = `
export const MONITORED_FOLDER_LIMITS = {files:5000,depth:8,readBytes:64*1024*1024};
export const getMonitoredFolder = async () => window.__nativeFolder ?? null;
export const selectMonitoredFolder = async () => window.__nativeSelection ?? null;
export const listMonitoredFiles = async () => ({files:[],complete:true,errors:[]});
export const readMonitoredFile = async (folder,id) => window.__sourceReader(folder,id);
export const subscribeMonitoredFolderChanges = () => () => {};
`
const virtualSql = `export default {load: async () => ({
  execute: (sql,values) => window.__hostSql(window.__dbKey,'execute',sql,values??[],!!window.__blockMigration),
  select: (sql,values) => window.__hostSql(window.__dbKey,'select',sql,values??[],false)
})};`
const virtualFs = `
export const BaseDirectory = {AppData:1};
export const exists = async p => window.__files.has(p);
export const mkdir = async p => { window.__files.set(p,null) };
export const writeFile = async (p,b) => { window.__files.set(p,Array.from(b)); window.__writes.push(p) };
export const readFile = async p => { if (!window.__files.has(p)) throw Error('ENOENT'); return Uint8Array.from(window.__files.get(p)) };
export const remove = async p => {window.__removed.push(p); window.__files.delete(p)};
`
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'pagewise-metadata-'))
  server = await createServer({
    root, configFile: false, logLevel: 'error', cacheDir: resolve(root, '../.cache/v03/vite'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'dexie'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{ name: 'synthetic-metadata-contract', enforce: 'pre',
      resolveId(source) {
        if (/(?:^|\/)monitoredFolder(?:\.ts)?$/.test(source)) return '\0metadata-native'
        if (source === '@tauri-apps/plugin-sql') return '\0metadata-sql'
        if (source === '@tauri-apps/plugin-fs') return '\0metadata-fs'
      },
      load(id) { return ({ '\0metadata-native': virtualNative, '\0metadata-sql': virtualSql, '\0metadata-fs': virtualFs })[id] },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url === '/__metadata_test') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic metadata QA</title>') }
        else next()
      }) },
    }],
  })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), args: ['--disable-background-networking'] })
})
after(async () => {
  await browser?.close()
  await server?.close()
  for (const db of databases.values()) db.close()
  if (temp) await rm(temp, { recursive: true, force: true })
})

async function isolated(run, { legacy = false } = {}) {
  const key = crypto.randomUUID()
  const path = join(temp, `${key}.sqlite`)
  const db = new DatabaseSync(path)
  databases.set(key, db)
  if (legacy) db.exec(`CREATE TABLE books (
    id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',format TEXT NOT NULL,
    file_name TEXT NOT NULL,description TEXT,language TEXT,tags TEXT NOT NULL DEFAULT '[]',added_at INTEGER NOT NULL,
    last_read_at INTEGER,location TEXT,progress REAL,source TEXT,has_cover INTEGER NOT NULL DEFAULT 0,
    kind TEXT,reading_status TEXT);
    INSERT INTO books(id,title,author,format,file_name,tags,added_at,location,progress,kind,reading_status)
    VALUES('legacy','Old Paper','Writer','pdf','old.pdf','["manual"]',1,'42',0.5,'paper','unknown');`)
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort('blockedbyclient'))
  await context.exposeFunction('__hostSql', (dbKey, operation, sql, values, fail) => {
    if (fail && sql === 'ALTER TABLE books ADD COLUMN publisher TEXT') throw Error('Synthetic migration denied')
    const database = databases.get(dbKey)
    const bindings = Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]))
    if (operation === 'select') return values.length ? database.prepare(sql).all(bindings) : database.prepare(sql).all()
    if (!values.length) { database.exec(sql); return { rowsAffected: 0 } }
    const result = database.prepare(sql).run(bindings)
    return { rowsAffected: Number(result.changes) }
  })
  const page = await context.newPage()
  await page.goto(`${base}/__metadata_test`)
  await page.evaluate(async key => {
    window.__dbKey = key
    window.__files = new Map(); window.__writes = []; window.__removed = []
    window.__sourceReader = async () => new TextEncoder().encode('source bytes')
    window.__modules = {
      ...await import('/src/storage/dexie.ts'), ...await import('/src/storage/tauri.ts'),
      ...await import('/src/services/folderLibrary.ts'), ...await import('/src/services/bibliographicMetadata.ts'),
      ...await import('/src/services/importer.ts'),
    }
  }, key)
  try { return await run(page, { key, db, path }) } finally { await context.close() }
}

function epub(date = '2001-03', extra = '') {
  return Array.from(zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'package.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic</dc:identifier><dc:title>Embedded Title</dc:title><dc:creator>Embedded Author</dc:creator><dc:language>zh</dc:language><dc:publisher>Synthetic Press</dc:publisher><dc:date>${date}</dc:date><dc:subject>History</dc:subject><dc:subject>Science</dc:subject>${extra}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`),
    'chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body><p>Synthetic text</p></body></html>'),
  }))
}

test('real EPUB parser preserves embedded bibliography and date precision; invalid input fails visibly', async () => {
  await isolated(async page => {
    const result = await page.evaluate(async fixtures => {
      const { readBookMetadata, normalizeBibliographicMetadata, importFile } = window.__modules
      const records = []
      for (const bytes of fixtures) records.push(await readBookMetadata(new File([Uint8Array.from(bytes)], 'not-a-publisher-2099.epub')))
      const mobi = normalizeBibliographicMetadata({ title: 'MOBI', author: ['A', 'B'], publisher: 'Mobi Press', published: '1997', subject: ['x', 'x', 'y'] })
      const unknown = normalizeBibliographicMetadata({ published: 123, publisher: null })
      const malformed = await importFile(new File(['bad archive'], 'broken.epub'))
      return { records, mobi, unknown, malformed }
    }, [epub('2001'), epub('2001-03'), epub('2001-03-09')])
    assert.deepEqual(result.records.map(x => x.publicationDate), ['2001', '2001-03', '2001-03-09'])
    for (const record of result.records) {
      assert.equal(record.publisher, 'Synthetic Press'); assert.equal(record.author, 'Embedded Author')
      assert.equal(record.title, 'Embedded Title'); assert.deepEqual(record.tags, ['History', 'Science'])
    }
    assert.equal(result.mobi.publicationDate, '1997'); assert.deepEqual(result.mobi.tags, ['x', 'y'])
    assert.equal(result.mobi.author, 'A, B'); assert.equal(result.unknown.publicationDate, undefined)
    assert.equal(result.malformed.ok, false)
  })
})

for (const backend of ['DexieStorage', 'TauriStorage']) {
  test(`${backend}: referenced/copy persistence, reopen, source errors, notes and inert archives survive`, async () => {
    await isolated(async (page, host) => {
      const first = await page.evaluate(async backend => {
        const storage = new window.__modules[backend](); await storage.init()
        const meta = { title: 'Synthetic', author: 'A', format: 'txt', fileName: 'a.txt', addedAt: 2, tags: ['manual'],
          publisher: 'Press', publicationDate: '1988-07', location: 'epubcfi(/6/2)', progress: 0.4, readingStatus: 'paused', kind: 'paper' }
        const copied = await storage.addBook(meta, new Blob(['managed bytes']))
        const sourceRef = { folderId: 'folder', documentId: 'stable-doc', relativePath: 'nested/a.txt', version: '[10,1]' }
        const referenced = await storage.addReferencedBook({ ...meta, sourceRef, fileAvailability: 'available' })
        await storage.addAnnotation({ bookId: referenced, cfi: 'note-cfi', text: 'quote', note: 'preserve', color: 'yellow', createdAt: 3 })
        const bl = await storage.createBooklist('Archive only'); await storage.addBooksToBooklist(bl, [referenced])
        await storage.putBooklistWanted([{ id: 'wanted', booklistId: bl, title: 'Wanted', author: '', addedAt: 4 }])
        window.__stored = { copied, referenced, bl }
        window.__store = storage
        return { ...window.__stored, writes: window.__writes, fileEntries: Array.from(window.__files) }
      }, backend)
      if (backend === 'TauriStorage') {
        assert.equal(first.writes.filter(p => p.startsWith('books/')).length, 1, 'source contents must not be copied')
        databases.get(host.key).close(); databases.set(host.key, new DatabaseSync(host.path))
      }
      await page.reload(); await page.evaluate(async ({ backend, key, stored }) => {
        window.__dbKey = key; window.__files = new Map(stored.fileEntries); window.__writes = []; window.__removed = []
        window.__sourceReader = async () => new TextEncoder().encode('fresh source')
        const { [backend]: Storage } = await import(backend === 'TauriStorage' ? '/src/storage/tauri.ts' : '/src/storage/dexie.ts')
        window.__store = new Storage(); await window.__store.init(); window.__stored = stored
      }, { backend, key: host.key, stored: first })
      const reopened = await page.evaluate(async () => {
        const s = window.__store, { referenced, bl, copied } = window.__stored
        const row = await s.getBook(referenced)
        const bytes = await (await s.getBookFile(referenced)).text()
        const fileRef = await s.getBookFileRef?.(referenced)
        window.__sourceReader = async () => { throw Object.assign(Error('grant revoked'), { code: 'permission_denied' }) }
        let error; try { await s.getBookFile(referenced) } catch (e) { error = e.code }
        const notes = await s.listAnnotations(referenced)
        const wanted = await s.listBooklistWanted(), items = await s.listBooklistBookIds(bl)
        const copiedText = await (await s.getBookFile(copied)).text()
        await s.updateBook(referenced, { publisher: 'Corrected', publicationDate: '1988', sourceRef: { ...row.sourceRef, relativePath: 'renamed.txt' } })
        const updated = await s.getBook(referenced)
        await s.deleteBook(referenced)
        return { row, bytes, fileRef, error, notes, wanted, items, copiedText, updated, removed: window.__removed }
      })
      assert.equal(reopened.row.publisher, 'Press'); assert.equal(reopened.row.publicationDate, '1988-07')
      assert.equal(reopened.row.kind, 'paper'); assert.equal(reopened.row.readingStatus, 'paused'); assert.equal(reopened.row.progress, 0.4)
      assert.equal(reopened.bytes, 'fresh source'); assert.equal(reopened.fileRef, undefined)
      assert.equal(reopened.error, 'permission_denied'); assert.equal(reopened.notes[0].note, 'preserve')
      assert.equal(reopened.wanted[0].id, 'wanted'); assert.deepEqual(reopened.items, [first.referenced])
      assert.equal(reopened.copiedText, 'managed bytes'); assert.equal(reopened.updated.publisher, 'Corrected')
      assert.equal(reopened.updated.publicationDate, '1988'); assert.deepEqual(reopened.updated.tags, ['manual'])
      assert.equal(reopened.removed.length, 0, 'deleting reference must not touch source filesystem')
    }, { legacy: backend === 'TauriStorage' })
  })
}

test('host SQLite migrates legacy paper rows idempotently and surfaces migration failures', async () => {
  await isolated(async page => {
    const result = await page.evaluate(async () => {
      window.__blockMigration = true
      const { TauriStorage } = window.__modules
      let error; try { await new TauriStorage().init() } catch (e) { error = e.message }
      window.__blockMigration = false
      const storage = new TauriStorage(); await storage.init(); await storage.init()
      const legacy = await storage.getBook('legacy')
      await storage.updateBook('legacy', { publisher: 'Added', publicationDate: '1901' })
      window.__files.set('books/legacy.pdf', [1, 2, 3])
      const bytes = Array.from(new Uint8Array(await (await storage.getBookFile('legacy')).arrayBuffer()))
      const updated = await storage.getBook('legacy')
      return { error, legacy, updated, bytes }
    })
    assert.match(result.error, /migration denied/); assert.equal(result.legacy.kind, 'paper')
    assert.equal(result.legacy.location, '42'); assert.equal(result.legacy.readingStatus, undefined)
    assert.equal(result.legacy.publisher, undefined); assert.equal(result.updated.publicationDate, '1901')
    assert.deepEqual(result.bytes, [1, 2, 3]); assert.deepEqual(result.updated.tags, ['manual'])
  }, { legacy: true })
})

for (const backend of ['DexieStorage', 'TauriStorage']) {
  test(`${backend}: explicit relink preserves both records, notes and progress through rescan/reopen`, () => isolated(async page => {
    const result = await page.evaluate(async backend => {
      const { createFolderLibrary, prepareBookImport } = window.__modules
      const storage = new window.__modules[backend](); await storage.init()
      const content = new TextEncoder().encode('The same edition, restored from a new source path.\nChapter one.').buffer
      let files = [{ documentId: 'new-document', name: 'restored.txt', relativePath: 'moved/restored.txt', size: content.byteLength, modifiedAt: 20 }]
      const base = { kind: 'book', title: 'Manual title', author: 'Manual author', format: 'txt', tags: ['Keep'], addedAt: 1, progress: .42, readingSeconds: 600, readingStatus: 'paused', location: 'chapter-1', lastReadAt: 12 }
      const originalId = await storage.addReferencedBook({ ...base, fileName: 'old.txt', sourceRef: { folderId: 'old-folder', documentId: 'old-document', relativePath: 'old.txt', version: 'old' } })
      await storage.updateBook(originalId, { fileAvailability: 'missing' })
      const indexedId = await storage.addReferencedBook({ ...base, title: 'Existing entry', progress: .1, fileName: 'restored.txt', sourceRef: { folderId: 'folder', documentId: 'new-document', relativePath: 'moved/restored.txt', version: JSON.stringify([content.byteLength, 20]) } })
      for (const id of [originalId, indexedId]) await storage.addAnnotation({ id: `note-${id}`, bookId: id, kind: 'highlight', cfi: 'chapter-1', text: 'Quote', note: `Keep ${id}`, color: '#000000', createdAt: 1 })
      const controller = createFolderLibrary({ getStorage: async () => storage, prepareBookImport,
        getMonitoredFolder: async () => ({ id: 'folder', name: 'Books', permission: 'granted' }), selectMonitoredFolder: async () => null,
        listMonitoredFiles: async () => ({ files, complete: true, errors: [] }), readMonitoredFile: async () => content,
        subscribeMonitoredFolderChanges: () => () => {} })
      const before = await storage.getBook(originalId)
      let unconfirmed = ''; try { await controller.relink(originalId, 'folder', 'new-document', false) } catch (e) { unconfirmed = e.message }
      const rejected = await storage.getBook(originalId)
      await controller.relink(originalId, 'folder', 'new-document', true)
      const linked = await storage.getBook(originalId)
      await controller.rescan()
      const count = (await storage.listBooks()).length
      files = []; await controller.rescan()
      const missing = (await storage.listBooks()).map(x => x.fileAvailability)
      files = [{ documentId: 'new-document', name: 'restored.txt', relativePath: 'moved/restored.txt', size: content.byteLength, modifiedAt: 21 }]
      await controller.rescan()
      const reopened = new window.__modules[backend](); await reopened.init()
      const books = await reopened.listBooks()
      return { originalId, indexedId, before, rejected, unconfirmed, linked, count, missing, books,
        originalNotes: await reopened.listAnnotations(originalId), otherNotes: await reopened.listAnnotations(indexedId) }
    }, backend)
    assert.match(result.unconfirmed, /confirmation/)
    assert.deepEqual(result.rejected, result.before)
    assert.equal(result.linked.id, result.originalId); assert.equal(result.linked.title, 'Manual title')
    assert.equal(result.linked.progress, .42); assert.equal(result.linked.location, 'chapter-1')
    assert.equal(result.linked.readingStatus, 'paused'); assert.deepEqual(result.linked.tags, ['Keep'])
    assert.equal(result.linked.sourceRef.documentId, 'new-document'); assert.equal(result.count, 2)
    assert.deepEqual(result.missing, ['missing', 'missing'])
    assert.ok(result.books.every(x => x.fileAvailability === 'available'))
    assert.ok(result.books.every(x => x.sourceRef.version.endsWith(',21]')))
    assert.equal(result.originalNotes[0].note, `Keep ${result.originalId}`); assert.equal(result.otherNotes[0].note, `Keep ${result.indexedId}`)
  }))

  test(`${backend}: partial listing, stale file/folder and parser failure cannot replace the old source`, () => isolated(async page => {
    const results = await page.evaluate(async backend => {
      const { createFolderLibrary, prepareBookImport } = window.__modules
      const storage = new window.__modules[backend](); await storage.init()
      const content = new TextEncoder().encode('A restored text file.').buffer
      const initial = { id: 'protected', kind: 'book', title: 'Protected', author: '', format: 'txt', tags: [], addedAt: 1, fileName: 'old.txt', sourceRef: { folderId: 'folder', documentId: 'old', relativePath: 'old.txt', version: 'old' } }
      const protectedId = await storage.addReferencedBook(initial)
      const before = await storage.getBook(protectedId)
      const outcomes = []
      for (const mode of ['incomplete', 'duplicate', 'stale-file', 'stale-folder', 'parser', 'scan-error']) {
        let folderId = 'folder', modifiedAt = 1
        const file = () => ({ documentId: 'new', name: 'new.txt', relativePath: 'new.txt', size: content.byteLength, modifiedAt })
        const controller = createFolderLibrary({ getStorage: async () => storage,
          prepareBookImport: async file => { if (mode === 'parser') throw new Error('injected parse failure'); return prepareBookImport(file) },
          getMonitoredFolder: async () => ({ id: folderId, name: 'Books', permission: 'granted' }), selectMonitoredFolder: async () => null,
          listMonitoredFiles: async () => { if (mode === 'scan-error') throw new Error('injected enumeration failure'); return { files: mode === 'duplicate' ? [file(), file()] : [file()], complete: mode !== 'incomplete', errors: [] } },
          readMonitoredFile: async () => { if (mode === 'stale-file') modifiedAt++; if (mode === 'stale-folder') folderId = 'changed'; return content },
          subscribeMonitoredFolderChanges: () => () => {} })
        let error = ''; try {
          if (mode === 'scan-error') { await controller.rescan(); error = controller.status.value.error }
          else await controller.relink(protectedId, 'folder', 'new', true)
        } catch (e) { error = e.message }
        outcomes.push({ mode, error, after: await storage.getBook(protectedId) })
      }
      return { before, outcomes }
    }, backend)
    assert.ok(results.before, 'baseline book must exist')
    for (const outcome of results.outcomes) {
      assert.ok(outcome.error, outcome.mode)
      assert.deepEqual(outcome.after, results.before, outcome.mode)
    }
  }))
}

async function setupController(page) {
  await page.evaluate(async () => {
    const { DexieStorage, createFolderLibrary } = window.__modules
    const storage = new DexieStorage(); await storage.init()
    const provider = { folder: null, selected: null, files: [], complete: true, errors: [], reads: 0, parses: 0,
      enumerations: 0, active: 0, peak: 0, subscriptions: 0, listeners: new Set(), readError: null, listError: null }
    const deps = {
      getStorage: async () => storage,
      getMonitoredFolder: async () => provider.folder,
      selectMonitoredFolder: async () => { if (provider.selected) provider.folder = provider.selected; return provider.selected },
      listMonitoredFiles: async () => {
        provider.enumerations++; provider.active++; provider.peak = Math.max(provider.peak, provider.active); provider.onList?.()
        try { if (provider.listError) throw Object.assign(Error('enumeration failed'), { code: provider.listError })
          if (provider.waitList) await provider.waitList
          return { files: provider.files.map(x => ({ ...x })), complete: provider.complete, errors: provider.errors }
        } finally { provider.active-- }
      },
      readMonitoredFile: async () => { provider.reads++; provider.onRead?.(); if (provider.waitRead) await provider.waitRead
        if (provider.readError) throw Object.assign(Error('read failed'), { code: provider.readError })
        return new TextEncoder().encode('synthetic bytes') },
      prepareBookImport: async file => { provider.parses++; provider.onParse?.(); if (provider.waitParse) await provider.waitParse
        return { meta: { title: 'Embedded', author: 'Author', publisher: 'Press', publicationDate: '2001', tags: ['embedded'],
          format: 'txt', fileName: file.name, addedAt: 1, kind: 'book' } } },
      subscribeMonitoredFolderChanges: fn => { provider.subscriptions++; provider.listeners.add(fn); return () => { provider.subscriptions--; provider.listeners.delete(fn) } },
    }
    window.__provider = provider; window.__store = storage; window.__controller = createFolderLibrary(deps)
    window.__file = { documentId: 'stable-doc', name: 'a.txt', relativePath: 'nested/a.txt', size: 15, modifiedAt: 1 }
  })
}

test('folder indexing: config/cancel, repeat/update/rename/missing/regrant preserve manual fields and history', async () => {
  await isolated(async page => {
    await setupController(page)
    const result = await page.evaluate(async () => {
      const p = window.__provider, s = window.__store, c = window.__controller
      await c.rescan(); const initial = { ...c.status.value, enumerations: p.enumerations }
      await c.chooseFolder(); const canceled = c.status.value.state
      p.selected = { id: 'f', label: 'Synthetic folder', permission: 'granted' }; p.files = [{ ...window.__file }]
      await c.chooseFolder(); const first = (await s.listBooks())[0]
      await s.updateBook(first.id, { title: 'Manual title', author: 'Manual author', publisher: 'Manual press', publicationDate: '1900-02',
        tags: ['manual'], location: 'cfi', progress: 0.5, readingStatus: 'paused', readingSeconds: 17 })
      await s.addAnnotation({ bookId: first.id, cfi: 'cfi', text: 'q', note: 'keep', color: 'yellow', createdAt: 1 })
      await c.rescan(); const repeatReads = p.reads
      p.files[0].name = 'renamed.txt'; p.files[0].relativePath = 'new/renamed.txt'
      await c.rescan(); const renameReads = p.reads
      p.files[0].modifiedAt = 2; await c.rescan(); const changedReads = p.reads
      const preserved = await s.getBook(first.id)
      p.files = []; p.complete = false; p.errors = [{ code: 'io_error' }]; await c.rescan()
      const partial = { ...c.status.value, availability: (await s.getBook(first.id)).fileAvailability }
      p.complete = true; p.errors = []; await c.rescan(); const missing = await s.getBook(first.id)
      p.folder.permission = 'lost'; await c.rescan(); const denied = { ...c.status.value, availability: (await s.getBook(first.id)).fileAvailability }
      p.folder.permission = 'granted'; p.files = [{ ...window.__file, modifiedAt: 2 }]; await c.rescan()
      const final = await s.getBook(first.id), notes = await s.listAnnotations(first.id), books = await s.listBooks()
      return { initial, canceled, repeatReads, renameReads, changedReads, preserved, partial, missing, denied, final, notes, count: books.length, state: c.status.value }
    })
    assert.equal(result.initial.state, 'unconfigured'); assert.equal(result.initial.enumerations, 0); assert.equal(result.canceled, 'unconfigured')
    assert.equal(result.repeatReads, 1); assert.equal(result.renameReads, 1); assert.equal(result.changedReads, 2)
    assert.equal(result.count, 1); assert.equal(result.final.id, result.preserved.id)
    for (const row of [result.preserved, result.missing, result.final]) {
      assert.equal(row.title, 'Manual title'); assert.equal(row.author, 'Manual author'); assert.equal(row.publisher, 'Manual press')
      assert.equal(row.publicationDate, '1900-02'); assert.deepEqual(row.tags, ['manual']); assert.equal(row.location, 'cfi')
      assert.equal(row.progress, 0.5); assert.equal(row.readingStatus, 'paused'); assert.equal(row.readingSeconds, 17)
    }
    assert.equal(result.partial.state, 'partial'); assert.equal(result.partial.availability, 'available')
    assert.equal(result.missing.fileAvailability, 'missing'); assert.equal(result.denied.state, 'permission-denied')
    assert.equal(result.denied.availability, 'permission-denied'); assert.equal(result.final.fileAvailability, 'available')
    assert.equal(result.notes[0].note, 'keep'); assert.equal(result.state.state, 'idle'); assert.ok(result.state.generation >= 4)
  })
})

test('folder failures: incomplete enumeration, dependency crash, unknown versions and size bounds remain honest', async () => {
  await isolated(async page => {
    await setupController(page)
    const result = await page.evaluate(async () => {
      const p = window.__provider, s = window.__store, c = window.__controller
      p.folder = { id: 'f', label: 'Fake', permission: 'granted' }; p.files = [{ ...window.__file }]; await c.rescan()
      const first = (await s.listBooks())[0]
      p.files = []; p.listError = 'io_error'; await c.rescan()
      const crashed = { ...c.status.value, book: await s.getBook(first.id) }; p.listError = null
      p.files = [{ ...window.__file, modifiedAt: 2 }]; p.readError = 'permission_denied'; await c.rescan()
      const denied = await s.getBook(first.id); p.readError = null
      p.files[0].size = null; p.files[0].modifiedAt = null; await c.rescan(); const before = p.reads
      await c.rescan(); const unknownReads = p.reads - before
      p.files = [{ ...window.__file, size: 200 * 1024 * 1024 }]; const reads = p.reads; await c.rescan()
      return { crashed, denied, unknownReads, boundReads: p.reads - reads, boundState: c.status.value.state, count: (await s.listBooks()).length }
    })
    assert.equal(result.crashed.state, 'error'); assert.equal(result.crashed.book.fileAvailability, 'available')
    assert.equal(result.denied.fileAvailability, 'permission-denied'); assert.equal(result.denied.sourceRef.version, '[15,1]')
    assert.equal(result.unknownReads, 1); assert.equal(result.boundReads, 0); assert.equal(result.boundState, 'partial'); assert.equal(result.count, 1)
  })
})

test('serial/coalesced indexer rejects stale folder and disposed parse results; lifecycle is ref-counted', async () => {
  await isolated(async page => {
    await setupController(page)
    const result = await page.evaluate(async () => {
      const p = window.__provider, c = window.__controller, s = window.__store
      p.folder = { id: 'old', label: 'Old', permission: 'granted' }; p.files = [{ ...window.__file }]
      let release
      p.waitRead = new Promise(resolve => { release = resolve })
      const readStarted = new Promise(resolve => { p.onRead = resolve })
      const intervals = new Set(), originalSet = window.setInterval, originalClear = window.clearInterval
      let timersCreated = 0
      window.setInterval = (...args) => { const id = originalSet(...args); intervals.add(id); timersCreated++; return id }
      window.clearInterval = id => { intervals.delete(id); return originalClear(id) }
      const stop1 = c.start(), stop2 = c.start(); const subscriptions = p.subscriptions
      const running = c.rescan(); await readStarted
      for (let i = 0; i < 10; i++) void c.rescan()
      p.folder = { id: 'new', label: 'New', permission: 'granted' }; p.files = []
      for (const listener of p.listeners) listener()
      p.waitRead = null; release(); await running
      const staleCount = (await s.listBooks()).length
      stop1(); stop1(); const remaining = p.subscriptions
      p.files = [{ ...window.__file }]
      let releaseParse; p.waitParse = new Promise(resolve => { releaseParse = resolve })
      const parseStarted = new Promise(resolve => { p.onParse = resolve })
      const disposedScan = c.rescan(); await parseStarted; stop2(); releaseParse(); await disposedScan
      window.setInterval = originalSet; window.clearInterval = originalClear
      return { subscriptions, remaining, subscriptionsAfter: p.subscriptions, staleCount, count: (await s.listBooks()).length,
        peak: p.peak, enumerations: p.enumerations, timersCreated, timersRemaining: intervals.size, state: c.status.value }
    })
    assert.equal(result.subscriptions, 1); assert.equal(result.remaining, 1); assert.equal(result.subscriptionsAfter, 0)
    assert.equal(result.staleCount, 0); assert.equal(result.count, 0); assert.equal(result.peak, 1)
    assert.ok(result.enumerations <= 3, `coalescing failed: ${result.enumerations}`)
    assert.notEqual(result.state.state, 'scanning'); assert.equal(result.timersCreated, 1); assert.equal(result.timersRemaining, 0)
  })
})

for (const backend of ['DexieStorage', 'TauriStorage']) {
  test(`${backend}: real parser -> folder index -> referenced open is a no-copy end-to-end path`, async () => {
    await isolated(async page => {
      const bytes = epub('1972-05')
      const result = await page.evaluate(async ({ bytes, backend }) => {
        const { createFolderLibrary, prepareBookImport } = window.__modules
        const storage = new window.__modules[backend](); await storage.init()
        const folder = { id: 'actual-pipeline', label: 'Synthetic EPUB tree', permission: 'granted' }
        let reads = 0
        const read = async () => { reads++; return Uint8Array.from(bytes) }
        window.__sourceReader = read
        const c = createFolderLibrary({
          getStorage: async () => storage, getMonitoredFolder: async () => folder, selectMonitoredFolder: async () => folder,
          listMonitoredFiles: async () => ({ files: [{ documentId: 'epub-id', name: 'book.epub', relativePath: 'nested/book.epub', size: bytes.length, modifiedAt: 1 }], complete: true, errors: [] }),
          readMonitoredFile: read, subscribeMonitoredFolderChanges: () => () => {}, prepareBookImport,
        })
        await c.chooseFolder(); await c.rescan()
        const books = await storage.listBooks(); const content = Array.from(new Uint8Array(await (await storage.getBookFile(books[0].id)).arrayBuffer()))
        const recordCount = backend === 'DexieStorage' ? await new Promise((resolve, reject) => {
          const request = indexedDB.open('lightread')
          request.onsuccess = () => { const db = request.result; const get = db.transaction('books').objectStore('books').get(books[0].id)
            get.onsuccess = () => { const result = get.result; db.close(); resolve(result.file === undefined) }; get.onerror = () => reject(get.error) }
          request.onerror = () => reject(request.error)
        }) : window.__writes.every(path => !path.startsWith('books/'))
        return { books, content, reads, noCopy: recordCount, status: c.status.value }
      }, { bytes, backend })
      assert.equal(result.books.length, 1); assert.equal(result.books[0].publisher, 'Synthetic Press')
      assert.equal(result.books[0].publicationDate, '1972-05'); assert.deepEqual(result.books[0].tags, ['History', 'Science'])
      assert.equal(result.reads, 2, 'one index parse and one live open; repeat scan must not reparse')
      assert.equal(result.noCopy, true); assert.deepEqual(result.content, bytes); assert.equal(result.status.state, 'idle')
    })
  })
}

test('bounded file count never marks unseen source missing, and foreground lifecycle has no background scans', async () => {
  await isolated(async page => {
    await setupController(page)
    const result = await page.evaluate(async () => {
      const p = window.__provider, c = window.__controller, s = window.__store
      p.folder = { id: 'f', label: 'Fake', permission: 'granted' }; p.files = [{ ...window.__file }]; await c.rescan()
      const book = (await s.listBooks())[0]
      p.files = Array.from({ length: 5001 }, (_, i) => ({ ...window.__file, documentId: `unsupported-${i}`, name: 'skip.bin' }))
      await c.rescan(); const truncated = { ...c.status.value, availability: (await s.getBook(book.id)).fileAvailability }
      p.files = []
      let tick; const originalSet = window.setInterval, originalClear = window.clearInterval, originalNow = Date.now
      window.setInterval = callback => { tick = callback; return 123 }
      let cleared = 0; window.clearInterval = id => { if (id === 123) cleared++ }
      const stop = c.start(); await c.rescan(); const startScans = p.enumerations
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      Date.now = () => originalNow() + 120_000; tick(); await Promise.resolve(); const hiddenScans = p.enumerations
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      window.dispatchEvent(new Event('focus')); await c.rescan(); const foregroundScans = p.enumerations
      stop(); const stopped = p.enumerations; window.dispatchEvent(new Event('focus')); await Promise.resolve()
      window.setInterval = originalSet; window.clearInterval = originalClear; Date.now = originalNow
      return { truncated, startScans, hiddenScans, foregroundScans, stopped, afterStop: p.enumerations, cleared }
    })
    assert.equal(result.truncated.state, 'partial'); assert.equal(result.truncated.availability, 'available')
    assert.equal(result.startScans, result.hiddenScans); assert.ok(result.foregroundScans > result.hiddenScans)
    assert.equal(result.stopped, result.afterStop); assert.equal(result.cleared, 1)
  })
})

test('amendment 01: lost config notifications cannot commit stale parse or missing results; changed IDs never name-merge notes', async () => {
  await isolated(async page => {
    await setupController(page)
    const result = await page.evaluate(async () => {
      const p = window.__provider, c = window.__controller, s = window.__store
      p.folder = { id: 'old', label: 'Old', permission: 'granted' }; p.files = [{ ...window.__file }]
      await c.rescan(); const original = (await s.listBooks())[0]
      await s.addAnnotation({ bookId: original.id, cfi: 'original-cfi', text: 'q', note: 'original-note', color: 'yellow', createdAt: 1 })
      p.files = [{ ...window.__file, documentId: 'different-id' }]; await c.rescan()
      const second = (await s.listBooks()).find(book => book.id !== original.id)
      const originalNotes = await s.listAnnotations(original.id), secondNotes = await s.listAnnotations(second.id)
      p.files = []; p.errors = [{ code: 'io_error' }]; p.complete = true; await c.rescan()
      const errorCompleteAvailability = (await s.getBook(second.id)).fileAvailability
      p.errors = []
      let releaseList; p.waitList = new Promise(resolve => { releaseList = resolve })
      const listStarted = new Promise(resolve => { p.onList = resolve })
      const listing = c.rescan(); await listStarted
      p.folder = { id: 'new', label: 'New', permission: 'granted' }
      p.waitList = null; releaseList(); await listing
      const oldAvailability = (await s.getBook(second.id)).fileAvailability
      p.files = [{ ...window.__file }]
      let releaseParse; p.waitParse = new Promise(resolve => { releaseParse = resolve })
      const parseStarted = new Promise(resolve => { p.onParse = resolve })
      const parsing = c.rescan(); await parseStarted
      p.folder = { id: 'newer', label: 'Newer', permission: 'granted' }; p.files = []
      p.waitParse = null; releaseParse(); await parsing
      return { original, second, originalNotes, secondNotes, errorCompleteAvailability, oldAvailability,
        books: await s.listBooks(), status: c.status.value, subscriptions: p.subscriptions }
    })
    assert.notEqual(result.original.id, result.second.id)
    assert.equal(result.originalNotes[0].note, 'original-note'); assert.equal(result.secondNotes.length, 0)
    assert.equal(result.errorCompleteAvailability, 'available', 'complete=true with errors must not mark unseen missing')
    assert.equal(result.oldAvailability, 'available', 'silent folder switch invalidates old missing decisions')
    assert.equal(result.books.length, 2, 'silent folder switch invalidates old parsed additions')
    assert.equal(result.status.folderLabel, 'Newer'); assert.equal(result.status.state, 'idle'); assert.equal(result.subscriptions, 0)
  })
})
