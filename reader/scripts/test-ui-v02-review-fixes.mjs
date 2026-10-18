import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { isReadingStatus, normalizeReadingStatus } from '../src/services/readingStatus.ts'
import * as classification from '../src/services/bookClassification.ts'
const { parseClassification } = classification
import { validateAvailability, validateSourceRef } from '../src/storage/sourceFile.ts'
import { createDebouncedDraftSaver, loadNoteDraft, saveNoteDraft } from '../src/services/noteDrafts.ts'
import { deleteGlobalNote } from '../src/services/notes.ts'

const tauriSource = readFileSync(new URL('../src/storage/tauri.ts', import.meta.url), 'utf8')
function loadActualModule(source, globals) {
  const ast = ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true)
  for (const node of [...ast.statements].reverse()) if (ts.isImportDeclaration(node)) source = source.slice(0, node.pos) + source.slice(node.end)
  const exports = {}
  const context = vm.createContext({ exports, module: { exports }, console, ...globals })
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText, context)
  return context.module.exports
}
const { prepareClassificationUpdates, rejectClassificationPatch, validatedBookClassification } = loadActualModule(
  readFileSync(new URL('../src/services/bookTagActions.ts', import.meta.url), 'utf8'), classification,
)

function sqlAdapter(db, fault = () => {}) {
  const bindings = values => Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value]))
  return {
    async execute(sql, values = []) {
      fault('execute', sql, values)
      if (!values.length) { db.exec(sql); return { rowsAffected: 0 } }
      const result = db.prepare(sql).run(bindings(values))
      return { rowsAffected: result.changes }
    },
    async select(sql, values = []) {
      fault('select', sql, values)
      return values.length ? db.prepare(sql).all(bindings(values)) : db.prepare(sql).all()
    },
  }
}
let id = 0
function nativeStorage(db, fault) {
  const source = tauriSource.replaceAll("import('@tauri-apps/plugin-sql')", 'Promise.resolve(__nativeSql)').replaceAll("import('@tauri-apps/plugin-fs')", 'Promise.resolve(__nativeFs)')
  const { TauriStorage } = loadActualModule(source, {
    __nativeSql: { default: { load: async () => sqlAdapter(db, fault) } },
    __nativeFs: { BaseDirectory: { AppData: 1 }, exists: async () => true, writeFile: async () => {}, mkdir: async () => {}, remove: async () => {} },
    BUILTIN_SOURCES: [], getLibraryRoot: () => '', newId: () => `synthetic-${++id}`, isReadingStatus, normalizeReadingStatus, validateAvailability, validateSourceRef, Uint8Array,
    prepareClassificationUpdates, rejectClassificationPatch, validatedBookClassification, parseClassification,
  })
  return new TauriStorage()
}
function legacySchema(db) {
  const ddl = tauriSource.match(/await this\.db\.execute\(`([\s\S]*?)`\)/)[1].replace(/^\s*reading_status TEXT,?\r?\n/gm, '')
  db.exec(ddl)
  db.exec("INSERT INTO books(id,title,author,format,file_name,tags,added_at,location,progress) VALUES ('legacy','Synthetic legacy','Fixture','epub','fixture.epub','[\"fixture\"]',1,'synthetic-cfi',0.65)")
}
function actualFunction(file, name, context) {
  const { descriptor } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
  const ast = ts.createSourceFile('setup.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === name)
  assert.ok(node, `Actual ${name} exists`)
  return vm.runInContext(ts.transpileModule(`${node.getText(ast)}\n${name}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context)
}
const newBook = { title: 'Synthetic book', author: 'Fixture', format: 'epub', fileName: 'fixture.epub', tags: [], addedAt: 1 }

test('native SQLite reading states survive insert, update, list and an actual close/reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pagewise-state-roundtrip-'))
  const file = join(dir, 'fixture.db')
  let db = new DatabaseSync(file)
  try {
    let storage = nativeStorage(db)
    await storage.init()
    const bookId = await storage.addBook({ ...newBook, readingStatus: 'wanted' }, new Blob(['synthetic']))
    assert.equal((await storage.getBook(bookId)).readingStatus, 'wanted')
    for (const status of ['reading', 'finished', 'paused']) {
      await storage.updateBook(bookId, { readingStatus: status })
      assert.equal((await storage.listBooks())[0].readingStatus, status)
    }
    db.close(); db = new DatabaseSync(file)
    storage = nativeStorage(db); await storage.init()
    assert.equal((await storage.getBook(bookId)).readingStatus, 'paused')
    await storage.updateBook(bookId, { readingStatus: undefined })
    assert.equal((await storage.getBook(bookId)).readingStatus, undefined)
    assert.equal(db.prepare('SELECT reading_status FROM books').get().reading_status, null)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('nullable native migration preserves legacy content/progress and is idempotent', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    legacySchema(db)
    const before = db.prepare('SELECT id,title,author,tags,location,progress FROM books').get()
    const storage = nativeStorage(db); await storage.init(); await storage.init()
    const book = await storage.getBook('legacy')
    assert.equal(book.readingStatus, undefined)
    assert.deepEqual(db.prepare('SELECT id,title,author,tags,location,progress FROM books').get(), before)
    await storage.updateBook('legacy', { readingStatus: 'finished' })
    assert.equal((await storage.getBook('legacy')).readingStatus, 'finished')
    assert.deepEqual(db.prepare('SELECT id,title,author,tags,location,progress FROM books').get(), before)
  } finally { db.close() }
})

for (const operation of ['select', 'execute']) test(`native ${operation} migration failure propagates, rather than pretending initialization succeeded`, async () => {
  const db = new DatabaseSync(':memory:')
  try {
    legacySchema(db)
    const storage = nativeStorage(db, (kind, sql) => {
      if (kind === operation && (operation === 'select' ? /PRAGMA table_info\(books\)/i.test(sql) : /ALTER TABLE books ADD COLUMN reading_status/i.test(sql))) throw new Error('Synthetic readonly schema')
    })
    await assert.rejects(storage.init(), /Synthetic readonly schema/)
  } finally { db.close() }
})

test('native rejects invalid states and missing-book writes without reporting success', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const storage = nativeStorage(db); await storage.init()
    await assert.rejects(storage.updateBook('missing', { readingStatus: 'finished' }), /not found/i)
    await assert.rejects(storage.addBook({ ...newBook, readingStatus: 'not-a-state' }, new Blob(['synthetic'])), /invalid reading status/i)
  } finally { db.close() }
})

for (const remove of [false, true]) test(`actual batch ${remove ? 'delete' : 'state'} retains and retries only failed IDs`, async () => {
  const calls = []; let fail = true
  const backend = {
    async getBook(bookId) { return { ...newBook, id: bookId } },
    async updateBook(bookId) { calls.push(bookId); if (fail && bookId === 'bad') throw new Error('synthetic write failure') },
    async deleteBook(bookId) { calls.push(bookId); if (fail && bookId === 'bad') throw new Error('synthetic delete failure') },
  }
  setActivePinia(createPinia())
  const { useLibrary } = loadActualModule(readFileSync(new URL('../src/stores/library.ts', import.meta.url), 'utf8'), { defineStore, getStorage: async () => backend })
  const library = useLibrary()
  library.books = [{ ...newBook, id: 'ok' }, { ...newBook, id: 'bad' }]
  const selectedIds = ref(new Set(['ok', 'bad']))
  const context = vm.createContext({ selectedIds, library, paperMode: ref(false), confirm: () => true, t: key => key, toast() {} })
  const action = actualFunction('../src/views/LibraryView.vue', remove ? 'batchDelete' : 'batchSetStatus', context)
  await action('finished')
  assert.deepEqual([...selectedIds.value], ['bad'])
  assert.deepEqual(calls, ['ok', 'bad'])
  fail = false
  await action('finished')
  assert.deepEqual(calls, ['ok', 'bad', 'bad'])
  assert.equal(selectedIds.value.size, 0)
  if (remove) assert.equal(library.books.length, 0)
  else assert.ok(library.books.every(book => book.readingStatus === 'finished'))
})

class DraftStorage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
  keys() { return [...this.values.keys()] }
}
for (const { failure, sameNote } of [{ failure: false, sameNote: true }, { failure: true, sameNote: true }, { failure: false, sameNote: false }]) test(`annotation delete failure=${failure}, sameEditor=${sameNote} preserves only surviving drafts`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = { storage: new DraftStorage(), now: () => 1000 }
  const note = { id: 'note-a', bookId: 'book-a', text: 'synthetic quote' }
  const draftContext = { bookId: note.bookId, contextId: `anno:${note.id}` }
  const saver = createDebouncedDraftSaver(draftContext, { delayMs: 30, env })
  saver.save('synthetic pending thought')
  const context = vm.createContext({
    deletingNote: ref(sameNote ? note : { ...note, id: 'note-b' }), isDeleting: ref(false), notes: ref([note]), editingNoteId: ref(note.id), editingText: ref('synthetic pending thought'), editingStatus: ref('pending'), editingErrorMsg: ref(''), activeSaver: saver,
    getStorage: async () => ({ deleteAnnotation: async () => { if (failure) throw new Error('synthetic delete failure') } }),
    deleteGlobalNote: (storage, id, bookId) => deleteGlobalNote(storage, id, bookId, env),
    t: key => key, toast() {}, refreshUnsavedDrafts() {},
  })
  await actualFunction('../src/views/NotesView.vue', 'confirmDelete', context)()
  t.mock.timers.tick(31)
  const draft = loadNoteDraft(draftContext, env).draft
  if (failure || !sameNote) {
    assert.equal(context.editingNoteId.value, note.id)
    assert.equal(context.editingText.value, 'synthetic pending thought')
    assert.equal(draft.text, 'synthetic pending thought')
  } else {
    assert.equal(context.editingNoteId.value, null)
    assert.equal(context.activeSaver, null)
    assert.equal(draft, undefined)
    assert.deepEqual(env.storage.keys(), [])
  }
})

test('formal deletion reports local draft cleanup failure instead of hiding it', async () => {
  const storage = new DraftStorage(); const env = { storage, now: () => 1000 }
  saveNoteDraft({ bookId: 'book-a', contextId: 'anno:note-a' }, 'synthetic', env)
  storage.removeItem = () => { throw new Error('synthetic cleanup failure') }
  const result = await deleteGlobalNote({ deleteAnnotation: async () => {} }, 'note-a', 'book-a', env)
  assert.equal(result.success, false)
  assert.match(result.message, /synthetic cleanup failure/)
})
