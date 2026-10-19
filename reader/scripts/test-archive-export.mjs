import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { toBase64Chunk } from '../src/services/base64.ts'
import { blobChunks, WRITE_CHUNK_BYTES } from '../src/storage/blobStream.ts'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('chunked base64 preserves bytes without spreading the whole archive into one call', () => {
  const bytes = new Uint8Array(1024 * 1024 + 3)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff
  assert.equal(toBase64Chunk(bytes), Buffer.from(bytes).toString('base64'))
})

test('large blob writes stream in fixed 2 MB chunks', async () => {
  const size = 5 * 1024 * 1024 + 7
  const source = new Uint8Array(size)
  for (let i = 0; i < size; i++) source[i] = (i * 17) & 0xff
  const blob = new Blob([source])
  const reader = blobChunks(blob).getReader()
  const sizes = []
  const joined = new Uint8Array(size)
  let offset = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    sizes.push(value.byteLength)
    joined.set(value, offset)
    offset += value.byteLength
  }
  assert.deepEqual(sizes, [WRITE_CHUNK_BYTES, WRITE_CHUNK_BYTES, size - 2 * WRITE_CHUNK_BYTES])
  assert.equal(Buffer.compare(Buffer.from(joined), Buffer.from(source)), 0)
})

test('Android export streams the zip to the system save target and only reports success after the native write', () => {
  const settings = read('src/views/SettingsView.vue')
  assert.match(settings, /exportLibraryArchiveToDevice\(fileName, write => exportBackupToSink/)
  assert.match(settings, /result === 'cancelled'/)
  assert.doesNotMatch(settings, /a\.download/, 'the unsupported WebView blob download must not return')

  const service = read('src/services/archiveExport.ts')
  assert.match(service, /plugin-dialog/)
  assert.match(service, /exportLibraryArchiveToDevice/)
  assert.match(service, /begin_export/)
  assert.match(service, /append_export/)
  assert.match(service, /write_export/)
  assert.match(service, /delete_export/)
  assert.match(service, /retryWhileBusy/)
  assert.doesNotMatch(service, /fs\.writeFile/, 'the whole-archive IPC write must not return')

  const backup = read('src/services/backup.ts')
  assert.match(backup, /ZipPassThrough/)
  assert.match(backup, /exportBackupToSink/)
  assert.match(backup, /pendingBytes >= 4 \* 1024 \* 1024/)
  assert.doesNotMatch(backup, /zipSync\(entries/, 'the whole library must not be zipped in one blob')
})

test('large copied imports use the native chunk sink instead of whole arrays', () => {
  const storage = read('src/storage/tauri.ts')
  assert.match(storage, /LARGE_WRITE_BYTES/)
  assert.match(storage, /writeLargeBookFile/)
  assert.match(storage, /begin_import_file/)
  assert.match(storage, /append_import_file/)
  assert.match(storage, /publish_import_file/)
  assert.match(storage, /delete_import_file/)
  assert.match(storage, /toBase64Chunk\(value\)/)
  assert.match(storage, /copyFile\(fromPath, toPath/)
  const capability = JSON.parse(read('src-tauri/capabilities/default.json'))
  const permissions = new Set(capability.permissions.filter(p => typeof p === 'string'))
  assert.ok(permissions.has('fs:allow-copy-file'), 'rename still uses native copyFile')
  assert.ok(!permissions.has('fs:allow-open') && !permissions.has('fs:allow-write'), 'whole-file plugin-fs streaming is no longer needed')
})

test('export writes live in a separate native plugin, not the read-only folder plugin', () => {
  const exportKotlin = read('src-tauri/android/ExportPlugin.kt')
  for (const command of ['fun begin', 'fun append', 'fun write', 'fun delete']) {
    assert.match(exportKotlin, new RegExp(command))
  }
  assert.match(exportKotlin, /\^cache\/export-\[A-Za-z0-9-\]\{1,64\}\\\\.zip\$/)
  assert.match(exportKotlin, /uri\.scheme != "content"/)
  assert.match(exportKotlin, /bytes\.size > 4 \* 1024 \* 1024/)
  const folderKotlin = read('src-tauri/android/MonitoredFolderPlugin.kt')
  assert.doesNotMatch(folderKotlin, /openOutputStream|createDocument|deleteDocument/, 'the source reader must stay read-only')

  const rust = read('src-tauri/src/export_file.rs')
  for (const command of ['begin_export', 'append_export', 'write_export', 'delete_export', 'begin_import_file', 'append_import_file', 'publish_import_file', 'delete_import_file']) {
    assert.match(rust, new RegExp(`pub async fn ${command}`))
  }
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /mod export_file;/)
  assert.match(lib, /export_file::init\(\)/)
  for (const command of ['begin_export', 'append_export', 'write_export', 'delete_export', 'begin_import_file', 'append_import_file', 'publish_import_file', 'delete_import_file']) {
    assert.match(lib, new RegExp(`export_file::${command}`))
  }
  assert.doesNotMatch(lib, /monitored_folder::(begin|append|write|delete)_export/)

  const prepare = read('scripts/prepare-android-project.mjs')
  assert.match(prepare, /ExportPlugin\.kt/)
  assert.match(prepare, /Invalid export template/)
  for (const command of ['fun beginImport', 'fun appendImport', 'fun publishImport', 'fun deleteImport']) {
    assert.match(exportKotlin, new RegExp(command))
  }
  assert.ok(exportKotlin.includes('cache/import-'), 'import temp path uses the cache/import prefix')
  assert.ok(exportKotlin.includes('IMPORT_TARGET'), 'import publish validates a books/ target')
  assert.match(exportKotlin, /File\(activity\.dataDir, path\)/, 'books/ lives under AppData (dataDir), not filesDir')
  assert.doesNotMatch(exportKotlin, /File\(activity\.filesDir, path\)/)
})
