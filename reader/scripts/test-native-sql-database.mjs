import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { NativeSqlDatabase, splitSqlStatements } from '../src/services/nativeSqlDatabase.ts'

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8')

test('Android storage has no runtime sqlx SQL-plugin opener or permission', () => {
  assert.doesNotMatch(source('../src/storage/tauri.ts'), /@tauri-apps\/plugin-sql|Database\.load/)
  assert.doesNotMatch(source('../src-tauri/src/lib.rs'), /\.plugin\(tauri_plugin_sql/)
  assert.doesNotMatch(source('../src-tauri/capabilities/default.json'), /"sql:/)
  assert.match(source('../src-tauri/android/NativeStatePlugin.kt'), /NativeSqlDatabase\(context, requestedRoot, action == "sql\.initialize"\)/)
})

test('SQL splitter preserves quoted semicolons/escapes and removes comments', () => {
  assert.deepEqual(splitSqlStatements(`-- before\nCREATE TABLE t(x TEXT DEFAULT 'a;''b'); /* ; */ INSERT INTO t VALUES ('x;');`), ["CREATE TABLE t(x TEXT DEFAULT 'a;''b')", "INSERT INTO t VALUES ('x;')"])
  assert.throws(() => splitSqlStatements("SELECT 'unterminated"), /Invalid SQL/)
  assert.throws(() => splitSqlStatements('SELECT 1 /* unfinished'), /Invalid SQL/)
})

test('typed bindings, root identity, and result envelope use existing native_state IPC', async () => {
  const calls = []
  const db = new NativeSqlDatabase('/task/synthetic-root', async (command, args) => {
    calls.push({ command, args }); return { rows: [{ id: 'b', value: 0.27, empty: null }] }
  })
  const rows = await db.select('SELECT $1 AS value', [0.27, true, null, '中文'])
  assert.deepEqual(rows, [{ id: 'b', value: 0.27, empty: null }])
  assert.deepEqual(calls, [{ command: 'native_state', args: { action: 'sql.select', libraryRoot: '/task/synthetic-root', payload: { sql: 'SELECT $1 AS value', values: [0.27, true, null, '中文'] } } }])
})

test('multi-DDL initialization is one native transaction, not independent command commits', async () => {
  const calls = []
  const db = new NativeSqlDatabase('', async (_, args) => { calls.push(args); return { rowsAffected: 0 } })
  await db.execute('CREATE TABLE a(x); CREATE INDEX ai ON a(x);')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'sql.batch')
  assert.deepEqual(calls[0].payload.statements, ['CREATE TABLE a(x)', 'CREATE INDEX ai ON a(x)'])
  await assert.rejects(() => db.execute('UPDATE a SET x=$1; DELETE FROM a', ['x']), /Invalid SQL/)
  await assert.rejects(() => db.select('SELECT 1; SELECT 2'), /Invalid SQL/)
  assert.equal(calls.length, 1)
})

test('write and classification unknown outcomes are preserved, never automatically replayed', async () => {
  for (const action of ['execute', 'classify', 'initialize']) {
    let attempts = 0
    const failure = { code: 'activity_changed_outcome_unknown' }
    const db = new NativeSqlDatabase('', async () => { attempts++; throw failure })
    await assert.rejects(() => action === 'execute' ? db.execute('UPDATE books SET progress=$1 WHERE id=$2', [0.27, 'synthetic']) : action === 'initialize' ? db.initialize('CREATE TABLE IF NOT EXISTS books(id TEXT)') : db.classify([{ id: 'synthetic' }]), error => error === failure)
    assert.equal(attempts, 1)
  }
})

test('bootstrap schema is sent as one explicit transaction before the ready probe', async () => {
  const calls = []
  const db = new NativeSqlDatabase('', async (_, args) => { calls.push(args); return { rowsAffected: 0 } })
  await db.initialize('CREATE TABLE IF NOT EXISTS books(id TEXT); CREATE TABLE IF NOT EXISTS annotations(id TEXT);')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'sql.initialize')
  assert.equal(calls[0].payload.statements.length, 2)
  const facade = source('../src/services/nativeSqlDatabase.ts')
  assert.ok(facade.indexOf('await database.initialize(schema)') < facade.indexOf("await database.select('SELECT 1 AS ready')"))
  assert.match(source('../src/storage/tauri.ts'), /openNativeSqlDatabase\(this.root, `/)
})

test('classification delegates one complete prepared batch without MATERIALIZED/JSON1 dialect assumptions', async () => {
  const prepared = [{ id: 'a', expectedRevision: 0, expectedTags: ['old'], expectedMetadata: { title: 'A', author: '' }, classification: { revision: 1 }, tags: ['new'] }, { id: 'b', classification: null, expectedTags: [], tags: ['legacy'] }]
  const calls = []
  const db = new NativeSqlDatabase('', async (_, args) => { calls.push(args); return { rowsAffected: 2 } })
  assert.deepEqual(await db.classify(prepared), { rowsAffected: 2 })
  assert.deepEqual(calls[0].payload.updates, prepared)
  assert.equal(calls[0].action, 'sql.classify')
  const kotlin = source('../src-tauri/android/NativeSqlDatabase.kt')
  assert.match(kotlin, /beginTransactionNonExclusive/)
  assert.ok(kotlin.indexOf('prepared.add(update)') < kotlin.indexOf('for (update in prepared)'))
  assert.match(kotlin, /expectedMetadata/)
  assert.match(kotlin, /expectedTags/)
  assert.match(kotlin, /commit_outcome_unknown/)
  assert.doesNotMatch(source('../src/storage/tauri.ts'), /WITH changes AS MATERIALIZED|json_extract/)
})
