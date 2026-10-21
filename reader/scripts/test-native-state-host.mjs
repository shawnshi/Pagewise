import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { root, compile, groovy } from './native-import-test-tools.mjs'
import { platformSources, sqliteOracle } from './native-state-sqlite-host.mjs'

// This executes both production Kotlin files verbatim. No app/device data or
// networking is used; node_modules and Gradle artifacts are read-only inputs.
const store = join(root, 'src-tauri/android/NativeStateStore.kt')
const plugin = join(root, 'src-tauri/android/NativeStatePlugin.kt')
const digest = value => createHash('sha256').update(value).digest('hex')
let assertions = 0
function eq(actual, expected, message) { assertions++; assert.deepEqual(actual, expected, message) }
function ok(value, message) { assertions++; assert.ok(value, message) }
const statement = (sql, args = []) => ({ sql, args })
const row = (i = 0, seconds = 10) => ({
  key: `synthetic-device|2026-10-21|id:${i === 0 ? 'deleted-book' : `book-${i}`}`,
  device: 'synthetic-device', day: '2026-10-21', bookId: i === 0 ? 'deleted-book' : `book-${i}`,
  title: i === 0 ? 'Retained deleted-book snapshot' : `Synthetic title ${i}`,
  kind: 'book', seconds, updatedAt: 123456,
})
const identity = { deviceId: 'synthetic-device', hashes: [['book-1', 'synthetic-hash-1'], ['deleted-book', 'synthetic-hash-deleted']] }
const settings = {
  libraryRoot: '', theme: 'paper', reader: { fontSize: 22, lineHeight: 1.7 },
  ai: { profiles: [{ id: 'own-key-fixture', apiKey: 'SYNTHETIC-NOT-A-REAL-KEY', baseUrl: 'https://invalid.example', model: 'fixture-model' }] },
  tts: { voice: 'synthetic-voice' }, unknownFuture: { keep: ['opaque', null, 3] },
}
const rawSettings = JSON.stringify(settings, null, 2)
const rawIdentity = JSON.stringify(identity)
const RETENTION = 7 * 24 * 60 * 60 * 1000

function hostProcess(classpath, python, out) {
  const process = spawn('java', ['-cp', classpath, 'io.pagewise.reader.StateHostKt', python], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const waiting = []
  let stderr = '', trace = '', closed = false
  process.stderr.on('data', data => { stderr += data })
  const lines = createInterface({ input: process.stdout })
  lines.on('line', line => {
    trace += line + '\n'
    const pending = waiting.shift()
    if (!pending) return
    clearTimeout(pending.timer)
    try { pending.resolve(JSON.parse(line)) } catch (error) { pending.reject(error) }
  })
  const exit = new Promise((resolve, reject) => {
    process.on('error', reject)
    process.on('close', code => {
      closed = true
      writeFileSync(join(out, 'host-output.jsonl'), trace)
      writeFileSync(join(out, 'host-stderr.log'), stderr)
      for (const pending of waiting.splice(0)) { clearTimeout(pending.timer); pending.reject(new Error(`JVM exited ${code}: ${stderr}`)) }
      if (code === 0) resolve()
      else reject(new Error(`JVM exited ${code}: ${stderr}`))
    })
  })
  // Register immediately so process startup failures cannot become unhandled rejections.
  exit.catch(() => {})
  return {
    request(request) {
      if (closed) throw new Error('JVM already closed')
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('JVM request timed out')); process.kill() }, 20000)
        waiting.push({ resolve, reject, timer })
        process.stdin.write(JSON.stringify(request) + '\n')
      })
    },
    async close() { process.stdin.end(); await exit },
  }
}

test('actual NativeStateStore and NativeStatePlugin compile; real SQLite state contracts', { timeout: 180000 }, async t => {
  const out = resolve(root, '../.cache/native-state-host', `${Date.now()}-${process.pid}`)
  mkdirSync(out, { recursive: true })
  const initialHashes = { store: digest(readFileSync(store)), plugin: digest(readFileSync(plugin)) }
  const { python, sources } = platformSources(out)
  const classpath = compile(out, [...sources, store, plugin], groovy())
  let host = hostProcess(classpath, python, out)
  let restartIndex = 0
  async function restart() {
    await host.close()
    const restarted = join(out, `restart-${++restartIndex}`)
    mkdirSync(restarted)
    host = hostProcess(classpath, python, restarted)
  }
  const results = []
  const sql = (fixture, commands, readonly = true) => sqliteOracle(python, fixture.database, commands, { readonly })
  const query = (fixture, text, args = []) => {
    const result = sql(fixture, [statement(text, args)])[0]
    return result.rows.map(values => Object.fromEntries(result.columns.map((key, i) => [key, values[i]])))
  }
  function fixture(name, { seed = true, custom = false } = {}) {
    const directory = join(out, name)
    mkdirSync(directory, { recursive: true })
    const library = custom ? join(directory, 'custom-library') : directory
    mkdirSync(library, { recursive: true })
    const f = { directory, library, database: join(library, 'lightread.db'), root: custom ? library : '' }
    f.files = [
      ['legacy-settings.json', rawSettings],
      ['legacy-identity.json', rawIdentity],
      ['legacy-reading.json', JSON.stringify([row()])],
      ['synthetic-source.epub', 'SYNTHETIC EPUB SOURCE BYTES; NOT A REAL BOOK'],
      ['synthetic-saf-grants.json', '{"persistedUriPermissions":["content://synthetic/read-only"]}'],
    ].map(([name, value]) => { const path = join(directory, name); writeFileSync(path, value); return [path, digest(readFileSync(path))] })
    if (seed) sql(f, [
      statement('CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT,tags TEXT,category TEXT,progress REAL,last_read_at INTEGER,reading_position TEXT,source_ref TEXT,file_name TEXT)'),
      statement('INSERT INTO books VALUES(?,?,?,?,?,?,?,?,?)', ['book-1', 'Existing synthetic book', '["manual-tag","不可改"]', 'manual-category', 0.625, 123456, '{"cfi":"synthetic-cfi"}', '{"folderId":"synthetic-saf","documentId":"book"}', 'synthetic-source.epub']),
      statement('CREATE TABLE annotations(id TEXT PRIMARY KEY,book_id TEXT,type TEXT,content TEXT,location TEXT)'),
      statement('INSERT INTO annotations VALUES(?,?,?,?,?)', ['note-1', 'book-1', 'highlight', 'Synthetic annotation', 'synthetic-cfi']),
      statement('CREATE TABLE manual_categories(id TEXT PRIMARY KEY,name TEXT)'),
      statement('INSERT INTO manual_categories VALUES(?,?)', ['manual-category', '手动分类']),
      statement('CREATE TABLE reading_history(id TEXT PRIMARY KEY,book_id TEXT,seconds INTEGER)'),
      statement('INSERT INTO reading_history VALUES(?,?,?)', ['history-1', 'book-1', 93]),
    ], false)
    return f
  }
  const request = (f, action, payload = {}, extra = {}) => host.request({ directory: f.directory, root: f.root, action, payload, ...extra })
  async function success(f, action, payload = {}, extra = {}) {
    const response = await request(f, action, payload, extra)
    eq(response.ok, true, `${action}: ${JSON.stringify(response)}`)
    return response.result
  }
  async function failure(f, action, payload, code, extra = {}) {
    const response = await request(f, action, payload, extra)
    eq(response.ok, false, `${action} must reject`)
    eq(response.code, code, `${action}: ${JSON.stringify(response)}`)
  }
  const begin = (rows, overrides = {}) => ({ settings: rawSettings, identity: rawIdentity, rows, chunks: Math.ceil(rows / 256), ...overrides })
  const chunk = (ordinal, rows) => ({ ordinal, rows: JSON.stringify(rows) })
  const operation = (body, overrides = {}) => ({ requestId: randomUUID(), createdAt: Date.now(), ...body, ...overrides })
  const add = (seconds = 5) => operation({ now: 987654, deltas: [{ device: 'synthetic-device', day: '2026-10-21', ref: 'id:deleted-book', title: '', kind: 'book', seconds }] })
  const patch = (path, before, after) => ({ path, before: { present: true, value: before }, after: { present: true, value: after } })
  async function ready(f, rows = [row()], overrides = {}) {
    await success(f, 'migrationBegin', begin(rows.length, overrides))
    for (let i = 0; i < rows.length; i += 256) await success(f, 'migrationChunk', chunk(i / 256, rows.slice(i, i + 256)))
    return success(f, 'migrationCommit')
  }
  function unchangedFiles(f) { for (const [path, hash] of f.files) eq(digest(readFileSync(path)), hash, `legacy/source fixture preserved: ${path}`) }
  const seconds = (f, key = row().key) => query(f, 'SELECT seconds FROM native_core_reading WHERE key=?', [key])[0]?.seconds
  async function scenario(name, run) {
    await t.test(name, async () => {
      const before = assertions
      try { await run(); results.push({ name, status: 'passed', assertions: assertions - before }) }
      catch (error) { results.push({ name, status: 'failed', assertions: assertions - before, error: error.stack }); throw error }
    })
  }
  try {
    await scenario('begin/stage/replay/commit/reopen preserves all authorities, source rows and raw files', async () => {
      const f = fixture('preservation')
      const originals = ['books', 'annotations', 'manual_categories', 'reading_history'].map(table => [table, query(f, `SELECT * FROM ${table}`)])
      const rows = Array.from({ length: 257 }, (_, i) => row(i, i + 1))
      eq((await success(f, 'status')).state, 'empty')
      eq((await success(f, 'migrationBegin', begin(rows.length))).state, 'staging')
      eq((await success(f, 'migrationChunk', chunk(0, rows.slice(0, 256)))).replayed, false)
      eq((await success(f, 'status')).stagedRows, 256)
      eq((await success(f, 'migrationBegin', begin(rows.length))).nextChunk, 1)
      eq((await success(f, 'migrationChunk', chunk(0, rows.slice(0, 256)))).replayed, true)
      await success(f, 'migrationChunk', chunk(1, rows.slice(256)))
      eq(query(f, 'SELECT ordinal,fingerprint,rows FROM native_core_chunks ORDER BY ordinal'), [
        { ordinal: 0, fingerprint: digest(JSON.stringify(rows.slice(0, 256))), rows: 256 },
        { ordinal: 1, fingerprint: digest(JSON.stringify(rows.slice(256))), rows: 1 },
      ])
      const committed = await success(f, 'migrationCommit')
      eq(committed.state, 'complete'); eq(committed.rows, 257)
      eq(committed.settings.raw, rawSettings, 'raw settings bytes including own-key profile preserved')
      eq((await success(f, 'settingsGet')).raw, rawSettings)
      eq((await success(f, 'identityGet')).deviceId, identity.deviceId)
      eq((await success(f, 'hashesPage', { after: '' })).rows, [...identity.hashes].sort((a, b) => a[0].localeCompare(b[0])))
      const page = await success(f, 'readingPage', { after: '', limit: 256 })
      eq(page.rows.length, 256)
      const last = await success(f, 'readingPage', { after: page.next, limit: 256 })
      eq(last.rows.length, 1)
      eq([...page.rows, ...last.rows].sort((a, b) => a.key.localeCompare(b.key)), rows.sort((a, b) => a.key.localeCompare(b.key)))
      eq((await success(f, 'migrationCommit')).rows, 257, 'commit replay does not duplicate rows')
      await restart()
      eq((await success(f, 'status', {}, { root: undefined })).state, 'complete', 'locator survives full JVM restart')
      eq((await success(f, 'identityGet', {}, { root: undefined })).deviceId, identity.deviceId)
      for (const [table, original] of originals) eq(query(f, `SELECT * FROM ${table}`), original, `${table} untouched`)
      eq(query(f, 'SELECT settings,identity FROM native_core_migration'), [{ settings: '', identity: '' }])
      eq(query(f, 'SELECT count(*) AS n FROM native_core_stage')[0].n, 0)
      const tables = query(f, "SELECT name FROM sqlite_master WHERE type='table'").map(x => x.name)
      eq(tables.filter(name => !name.startsWith('native_core_')).sort(), originals.map(x => x[0]).sort(), 'no alternate books/library tables')
      unchangedFiles(f)
    })

    await scenario('empty fresh install creates only core tables and keeps generated identity on restart', async () => {
      const f = fixture('fresh', { seed: false })
      await failure(f, 'status', {}, 'migration_not_initialized', { root: undefined })
      eq(existsSync(f.database), false)
      await ready(f, [], { settings: '{}', identity: '{"deviceId":null,"hashes":[]}' })
      const device = (await success(f, 'identityGet')).deviceId
      ok(/^[a-f0-9-]{36}$/.test(device), 'fresh device ID generated')
      await restart()
      eq((await success(f, 'identityGet', {}, { root: undefined })).deviceId, device)
      eq((await success(f, 'readingPage', { after: '', limit: 256 })).rows, [])
      eq((await success(f, 'hashesPage', { after: '' })).rows, [])
      eq(query(f, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'native_core_%'"), [])
      unchangedFiles(f)
    })

    await scenario('partial migration resumes; changed settings, identity, page bytes, order and counts reject atomically', async () => {
      const f = fixture('partial')
      await success(f, 'migrationBegin', begin(257))
      await failure(f, 'migrationCommit', {}, 'migration_incomplete')
      await failure(f, 'settingsGet', {}, 'native_state_not_ready')
      await failure(f, 'migrationChunk', chunk(1, [row(256)]), 'migration_out_of_order')
      await failure(f, 'migrationBegin', begin(257, { settings: JSON.stringify({ ...settings, theme: 'night' }) }), 'migration_source_changed')
      await failure(f, 'migrationBegin', begin(257, { identity: JSON.stringify({ ...identity, deviceId: 'changed-device' }) }), 'migration_source_changed')
      const first = Array.from({ length: 256 }, (_, i) => row(i))
      await success(f, 'migrationChunk', chunk(0, first))
      // Simulated source-page I/O interruption: no call is made for a failed source read.
      eq((await success(f, 'status')).nextChunk, 1)
      await failure(f, 'migrationChunk', { ordinal: 0, rows: JSON.stringify(first, null, 1) }, 'migration_source_changed')
      await failure(f, 'migrationChunk', chunk(1, [first[0]]), 'duplicate_migration_row')
      eq((await success(f, 'status')).stagedRows, 256)
      await failure(f, 'migrationChunk', { ordinal: 1, rows: '{not an array' }, 'invalid_payload')
      await failure(f, 'migrationChunk', chunk(2, [row(256)]), 'invalid_payload')
      await failure(f, 'migrationChunk', chunk(1, []), 'invalid_payload')
      await failure(f, 'migrationChunk', chunk(1, Array.from({ length: 257 }, (_, i) => row(i + 256))), 'invalid_payload')
      await success(f, 'migrationChunk', chunk(1, [row(256)]))
      eq((await success(f, 'migrationCommit')).rows, 257)
      unchangedFiles(f)
      const mismatch = fixture('count-mismatch')
      await failure(mismatch, 'migrationBegin', begin(257, { chunks: 1 }), 'invalid_payload')
      eq((await success(mismatch, 'status')).state, 'empty')
      await success(mismatch, 'migrationBegin', begin(2))
      await success(mismatch, 'migrationChunk', chunk(0, [row()]))
      await failure(mismatch, 'migrationCommit', {}, 'migration_incomplete')
      eq(query(mismatch, 'SELECT count(*) AS n FROM native_core_settings')[0].n, 0)
      eq(query(mismatch, 'SELECT count(*) AS n FROM native_core_reading')[0].n, 0)
    })

    await scenario('corrupt/invalid migration rows and identity reject without partial stage writes', async () => {
      const f = fixture('invalid-rows')
      await failure(f, 'migrationBegin', begin(2, { settings: 'invalid JSON' }), 'invalid_payload')
      await failure(f, 'migrationBegin', begin(2, { identity: JSON.stringify({ deviceId: '', hashes: [] }) }), 'invalid_payload')
      await failure(f, 'migrationBegin', begin(2, { identity: JSON.stringify({ ...identity, hashes: [['a', 'x'], ['a', 'y']] }) }), 'invalid_payload')
      await success(f, 'migrationBegin', begin(2))
      const invalidRows = [
        { ...row(1), seconds: -1 }, { ...row(1), seconds: '3' },
        { ...row(1), key: 'broken' }, { ...row(1), key: 'device|not-a-date|id:book' },
        { ...row(1), key: 'device|2026-10-21|unsupported:book' },
        { ...row(1), updatedAt: 'NaN' }, { ...row(1), title: 'x'.repeat(65537) },
      ]
      for (const invalid of invalidRows) {
        await failure(f, 'migrationChunk', chunk(0, [row(), invalid]), 'invalid_payload')
        eq(query(f, 'SELECT count(*) AS n FROM native_core_stage')[0].n, 0)
        eq(query(f, 'SELECT count(*) AS n FROM native_core_chunks')[0].n, 0)
      }
      await failure(f, 'migrationChunk', chunk(0, [row(), row()]), 'duplicate_migration_row')
      eq(query(f, 'SELECT count(*) AS n FROM native_core_stage')[0].n, 0)
      await success(f, 'migrationChunk', chunk(0, [row(), row(1)]))
      eq((await success(f, 'migrationCommit')).rows, 2)
      await failure(f, 'readingPage', { after: '', limit: 0 }, 'invalid_payload')
      await failure(f, 'readingPage', { after: '', limit: 257 }, 'invalid_payload')
      await failure(f, 'foreignNamespace.write', {}, 'unsupported_action')
      await failure(f, 'readingPage', { after: '', limit: 256 }, 'database_error', { fault: 'query-error' })
      eq((await success(f, 'readingPage', { after: '', limit: 256 })).rows.length, 2, 'source query failure is not an empty page')
    })

    await scenario('missing/unavailable custom root and disappeared canonical DB fail closed with no substitute library', async () => {
      const missing = fixture('root-errors', { seed: false })
      const absent = join(missing.directory, 'does-not-exist')
      await failure(missing, 'status', {}, 'library_root_unavailable', { root: absent })
      eq(existsSync(absent), false); eq(existsSync(missing.database), false)
      const existing = join(missing.directory, 'empty-existing-root'); mkdirSync(existing)
      await failure(missing, 'status', {}, 'library_database_missing', { root: existing })
      eq(readdirSync(existing), [])
      await failure(missing, 'status', {}, 'unsupported_library_root', { root: 'content://synthetic/library' })
      await failure(missing, 'status', {}, 'unsupported_library_root', { root: 'relative/library' })
      const f = fixture('custom-root', { custom: true })
      await ready(f)
      eq((await success(f, 'status', {}, { root: undefined })).state, 'complete')
      await failure(f, 'status', {}, 'library_root_conflict', { root: '' })
      renameSync(f.database, f.database + '.preserved')
      await failure(f, 'status', {}, 'library_database_missing', { root: undefined })
      eq(existsSync(f.database), false); eq(existsSync(join(f.directory, 'lightread.db')), false)
      const normal = fixture('canonical-missing')
      await ready(normal)
      renameSync(normal.database, normal.database + '.preserved')
      await failure(normal, 'status', {}, 'library_database_missing', { root: undefined })
      eq(existsSync(normal.database), false)
      const collision = fixture('schema-collision')
      sql(collision, [statement('CREATE TABLE native_core_settings(wrong_column TEXT)')], false)
      await failure(collision, 'status', {}, 'native_state_schema_mismatch')
    })

    await scenario('settings per-path CAS preserves unrelated edits and rejects conflicts/overlap/prototype/root moves atomically', async () => {
      const f = fixture('settings')
      await ready(f)
      const theme = operation({ patches: [patch(['theme'], 'paper', 'night')] })
      eq((await success(f, 'settingsPatch', theme)).revision, 2)
      const font = operation({ patches: [patch(['reader', 'fontSize'], 22, 25)] })
      const current = await success(f, 'settingsPatch', font)
      eq(current.revision, 3)
      eq(JSON.parse(current.raw), { ...settings, theme: 'night', reader: { ...settings.reader, fontSize: 25 } })
      const conflict = operation({ patches: [patch(['theme'], 'paper', 'gray'), patch(['reader', 'lineHeight'], 1.7, 2)] })
      await failure(f, 'settingsPatch', conflict, 'settings_conflict')
      eq(await success(f, 'settingsGet'), current)
      eq(query(f, 'SELECT id FROM native_core_events WHERE id=?', [conflict.requestId]), [])
      const overlap = operation({ patches: [patch(['reader'], settings.reader, {}), patch(['reader', 'fontSize'], 25, 28)] })
      await failure(f, 'settingsPatch', overlap, 'settings_conflict')
      // A matching ancestor reaches structural validation rather than CAS first.
      overlap.requestId = randomUUID(); overlap.patches[0].before.value = { ...settings.reader, fontSize: 25 }
      await failure(f, 'settingsPatch', overlap, 'invalid_payload')
      for (const path of [[], ['__proto__'], ['safe', 'constructor'], ['prototype'], Array(9).fill('a'), [''], [3]]) {
        await failure(f, 'settingsPatch', operation({ patches: [{ path, before: { present: false }, after: { present: true, value: 1 } }] }), 'invalid_payload')
      }
      for (const path of [['libraryRoot'], ['libraryRoot', 'nested']]) await failure(f, 'settingsPatch', operation({ patches: [patch(path, '', '/other')] }), 'library_move_required')
      eq(await success(f, 'settingsGet'), current)
      const remove = operation({ patches: [{ path: ['unknownFuture'], before: { present: true, value: settings.unknownFuture }, after: { present: false } }] })
      await success(f, 'settingsPatch', remove)
      const insert = operation({ patches: [{ path: ['newNamespace', 'nullable'], before: { present: false }, after: { present: true, value: null } }] })
      const inserted = JSON.parse((await success(f, 'settingsPatch', insert)).raw)
      eq(inserted.newNamespace, { nullable: null }); eq(Object.hasOwn(inserted, 'unknownFuture'), false)
      eq(inserted.ai, settings.ai)
      const receipts = query(f, 'SELECT result FROM native_core_events')
      ok(receipts.every(x => !x.result.includes('SYNTHETIC-NOT-A-REAL-KEY') && !x.result.includes('own-key-fixture')), 'receipts retain revisions, not secret settings snapshots')
      ok(receipts.every(x => Object.keys(JSON.parse(x.result)).join(',') === 'settingsRevision'))
      eq(JSON.parse((await success(f, 'receipt', { requestId: theme.requestId })).result.raw), inserted, 'settings receipt resolves authoritative current state')
      unchangedFiles(f)
    })

    await scenario('same operation replay is exactly once; same ID changed payload conflicts; putMax never decreases', async () => {
      const f = fixture('reading-replay')
      await ready(f)
      const delta = add(5)
      await success(f, 'readingAdd', delta); eq(seconds(f), 15)
      await success(f, 'readingAdd', delta); eq(seconds(f), 15)
      await failure(f, 'readingAdd', { ...delta, deltas: [{ ...delta.deltas[0], seconds: 7 }] }, 'request_conflict')
      eq(seconds(f), 15)
      eq((await success(f, 'receipt', { requestId: delta.requestId })).found, true)
      eq((await success(f, 'readingPage', { after: '', limit: 256 })).rows[0].title, row().title, 'blank delta title retains deleted-book snapshot')
      const lower = operation({ rows: [row(0, 12)] })
      eq((await success(f, 'readingPutMax', lower)).changed, 0); eq(seconds(f), 15)
      eq((await success(f, 'readingPutMax', operation({ rows: [row(0, 15)] }))).changed, 0)
      const higher = operation({ rows: [row(0, 40)] })
      eq((await success(f, 'readingPutMax', higher)).changed, 1); eq(seconds(f), 40)
      eq((await success(f, 'readingPutMax', higher)).changed, 1); eq(seconds(f), 40)
      const invalid = operation({ rows: [row(0, 100), { ...row(1), seconds: -4 }] })
      await failure(f, 'readingPutMax', invalid, 'invalid_payload'); eq(seconds(f), 40)
      const invalidAdd = add(3); invalidAdd.deltas.push({ ...invalidAdd.deltas[0], seconds: -2 })
      await failure(f, 'readingAdd', invalidAdd, 'invalid_payload'); eq(seconds(f), 40)
      eq(query(f, 'SELECT id FROM native_core_events WHERE id IN (?,?)', [invalid.requestId, invalidAdd.requestId]), [])
      eq((await success(f, 'identityGet')).deviceId, identity.deviceId)
    })

    await scenario('unknown mutation COMMIT resolves by receipt for actual commit and actual rollback', async () => {
      const f = fixture('unknown-commit')
      await ready(f)
      for (const [fault, committed] of [['commit-before-ack', true], ['rollback-before-ack', false]]) {
        const before = seconds(f), delta = add(7)
        await failure(f, 'readingAdd', delta, 'commit_outcome_unknown', { fault })
        eq(seconds(f), before + (committed ? 7 : 0), 'independent SQLite sees actual outcome')
        const receipt = await success(f, 'receipt', { requestId: delta.requestId })
        eq(receipt.found, committed)
        eq((await success(f, 'status')).state, 'complete')
        await success(f, 'readingAdd', delta)
        await success(f, 'readingAdd', delta)
        eq(seconds(f), before + 7, 'retry after unknown result is exactly once')
      }
      const before = await success(f, 'settingsGet')
      const changed = operation({ patches: [patch(['theme'], 'paper', 'night')] })
      await failure(f, 'settingsPatch', changed, 'commit_outcome_unknown', { fault: 'commit-before-ack' })
      eq(JSON.parse((await success(f, 'receipt', { requestId: changed.requestId })).result.raw).theme, 'night')
      const rollback = operation({ patches: [patch(['theme'], 'night', 'gray')] })
      await failure(f, 'settingsPatch', rollback, 'commit_outcome_unknown', { fault: 'rollback-before-ack' })
      eq((await success(f, 'receipt', { requestId: rollback.requestId })).found, false)
      eq(JSON.parse((await success(f, 'settingsGet')).raw).theme, 'night')
      eq((await success(f, 'settingsGet')).revision, before.revision + 1)
    })

    await scenario('unknown migration COMMIT uses authoritative staging/complete status before replay', async () => {
      for (const [fault, committed] of [['commit-before-ack', true], ['rollback-before-ack', false]]) {
        const f = fixture(`migration-${fault}`)
        await success(f, 'migrationBegin', begin(1))
        await success(f, 'migrationChunk', chunk(0, [row()]))
        await failure(f, 'migrationCommit', {}, 'commit_outcome_unknown', { fault })
        const status = await success(f, 'status')
        eq(status.state, committed ? 'complete' : 'staging')
        eq(query(f, 'SELECT count(*) AS n FROM native_core_reading')[0].n, committed ? 1 : 0)
        if (!committed) eq(status.stagedRows, 1)
        eq((await success(f, 'migrationCommit')).rows, 1)
        eq((await success(f, 'identityGet')).deviceId, identity.deviceId)
      }
    })

    await scenario('expired receipt pruning does not allow stale ID to reapply an increment', async () => {
      const f = fixture('pruning')
      await ready(f)
      const delta = { ...add(9), createdAt: Date.now() - RETENTION + 5000 }
      await success(f, 'readingAdd', delta)
      eq(seconds(f), 19)
      // Cross the real retention boundary without changing the global clock or
      // the original request. This proves exact replay, not a modified payload.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, delta.createdAt + RETENTION - Date.now() + 100)))
      await success(f, 'readingPutMax', operation({ rows: [] }))
      eq((await success(f, 'receipt', { requestId: delta.requestId })).found, false)
      await failure(f, 'readingAdd', delta, 'stale_request')
      eq(seconds(f), 19)
      await failure(f, 'readingAdd', { ...add(1), createdAt: Date.now() + 700000 }, 'stale_request')
      await failure(f, 'readingAdd', { ...add(1), requestId: 'not-a-uuid' }, 'invalid_payload')
      eq(seconds(f), 19)
    })
  } finally {
    await host.close()
    eq(digest(readFileSync(store)), initialHashes.store, 'production store was not modified during harness run')
    eq(digest(readFileSync(plugin)), initialHashes.plugin, 'production plugin was not modified during harness run')
    writeFileSync(join(out, 'report.json'), JSON.stringify({ assertions, initialHashes, results, boundary: 'JVM Kotlin with synthetic Android/JSON and real Python SQLite; not Android/device acceptance' }, null, 2))
    console.log(`Native state host: ${assertions} assertions; ${results.filter(x => x.status === 'passed').length}/${results.length} scenarios passed; artifacts: ${out}`)
  }
})
