import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const android = path.join(root, 'src-tauri/android')
const owners = ['NativeStateStore.kt', 'NativeImportDatabase.kt', 'NativeLibraryRepository.kt']

test('every canonical Android database open uses the non-destructive authority', () => {
  for (const name of owners) {
    const text = fs.readFileSync(path.join(android, name), 'utf8')
    assert.doesNotMatch(text, /SQLiteDatabase\.open(?:OrCreateDatabase|Database)\(/, name)
    assert.match(text, /CanonicalDatabase\.open\(/, name)
  }
})

test('corruption handler fails instead of allowing Android default file deletion', () => {
  const text = fs.readFileSync(path.join(android, 'CanonicalDatabase.kt'), 'utf8')
  assert.match(text, /DatabaseErrorHandler/)
  assert.match(text, /library_database_corrupt/)
  assert.match(text, /throw CanonicalDatabaseFailure/)
  assert.doesNotMatch(text, /deleteDatabase|\.delete\(|\.deleteRecursively\(/)
  assert.doesNotMatch(text, /openOrCreateDatabase/)
})

test('create permission is explicit, missing initialized files do not silently become empty DBs', () => {
  const text = fs.readFileSync(path.join(android, 'CanonicalDatabase.kt'), 'utf8')
  assert.match(text, /create: Boolean = false/)
  assert.match(text, /library_database_missing/)
  assert.match(text, /CREATE_IF_NECESSARY/)
  assert.match(text, /ENABLE_WRITE_AHEAD_LOGGING/)
  assert.match(text, /if \(create\)/)
})
