import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareAndroidProject } from './prepare-android-project.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')
const source = read('src-tauri/android/MonitoredFolderPlugin.kt')
const bridge = read('src-tauri/src/monitored_folder.rs')
const generated = 'src-tauri/gen/android'
const plugin = `${generated}/app/src/main/java/io/pagewise/reader/MonitoredFolderPlugin.kt`
const strings = `${generated}/app/src/main/res/values/strings.xml`
function fixture() {
  const temp = resolve(root, '../.cache/performance-20261019/native-prepare')
  mkdirSync(temp, { recursive: true })
  const base = mkdtempSync(join(temp, 'monitored-folder-prepare-'))
  const put = (path, value) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), value) }
  for (const path of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/android/MainActivity.kt', 'src-tauri/android/MonitoredFolderPlugin.kt']) put(path, read(path))
  cpSync(join(root, 'src-tauri/icons/android'), join(base, 'src-tauri/icons/android'), { recursive: true })
  put(`${generated}/buildSrc/src/main/java/io/pagewise/reader/kotlin/BuildTask.kt`, 'val executable = """npm""";\nval args = listOf("run", "--", "tauri", "android", "android-studio-script");\n')
  put(strings, '<resources><string name="app_name">old</string><string name="main_activity_title">old</string></resources>')
  put(`${generated}/app/src/main/AndroidManifest.xml`, '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" /></application></manifest>')
  return { base, put, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}
function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return [path.slice(directory.length), readFileSync(path).toString('base64')]
  }))
}

test('new SAF template copies atomically with existing activity and remains idempotent', () => {
  const f = fixture()
  try {
    prepareAndroidProject(f.base)
    assert.equal(readFileSync(join(f.base, plugin), 'utf8'), source)
    assert.equal(readFileSync(join(f.base, `${generated}/app/src/main/java/io/pagewise/reader/MainActivity.kt`), 'utf8'), read('src-tauri/android/MainActivity.kt'))
    const before = snapshot(join(f.base, generated))
    prepareAndroidProject(f.base)
    assert.deepEqual(snapshot(join(f.base, generated)), before)
  } finally { f.cleanup() }
})

test('failure after new plugin copy restores existing bytes and removes the new template', () => {
  const f = fixture()
  try {
    const before = snapshot(join(f.base, generated))
    let copied = false
    assert.throws(() => prepareAndroidProject(f.base, { replace(from, to) {
      if (to === join(f.base, strings)) throw new Error('after plugin failure')
      renameSync(from, to)
      if (to === join(f.base, plugin)) copied = true
    } }), /after plugin failure/)
    assert.equal(copied, true)
    assert.equal(existsSync(join(f.base, plugin)), false)
    assert.deepEqual(snapshot(join(f.base, generated)), before)
  } finally { f.cleanup() }
})

test('invalid native template fails before any generated write', () => {
  const f = fixture()
  try {
    f.put('src-tauri/android/MonitoredFolderPlugin.kt', 'package wrong.identity\n@TauriPlugin class MonitoredFolderPlugin')
    const before = snapshot(join(f.base, generated))
    assert.throws(() => prepareAndroidProject(f.base), /Invalid monitored-folder template/)
    assert.deepEqual(snapshot(join(f.base, generated)), before)
  } finally { f.cleanup() }
})

// These are source checks only. They do not claim provider/device execution.
test('native source has a read-only grant boundary and no caller-controlled path API', () => {
  assert.match(source, /Intent\.ACTION_OPEN_DOCUMENT_TREE/)
  assert.match(source, /takePersistableUriPermission\(uri, Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/)
  assert.doesNotMatch(source, /FLAG_GRANT_WRITE_URI_PERMISSION|MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|createDocument|deleteDocument|renameDocument|openOutputStream/)
  assert.match(source, /DocumentsContract\.isChildDocument\(resolver, root, document\)/)
  assert.match(source, /openFileDescriptor\(document, "r", cancellation\)/)
  assert.match(source, /folder\.id != id/)
  assert.match(source, /persistedUriPermissions/)
  assert.match(source, /"lost"/)
  assert.match(source, /RESULT_CANCELED\) \{\s*selecting\.set\(false\)\s*invoke\.resolve\(folderResult\(null\)\)/)
  assert.match(source, /SHA-256/)
  assert.match(source, /preferences\.edit\(\)\.putString\("selected"/)
  assert.doesNotMatch(source, /evaluateJavascript\([^\n]*\$|addJavascriptInterface/)
})

test('nullable folder responses use an explicit envelope; invalid envelopes remain errors', () => {
  assert.match(source, /private fun folderResult\(folder: Folder\?\): JSObject/)
  assert.match(source, /\.put\("folder", folder\?\.let \{ describe\(it\) \} \?: JSONObject\.NULL\)/)
  assert.match(source, /invoke\.resolve\(folderResult\(stored\(\)\)\)/)
  assert.match(source, /folderResult\(folder\)/)
  assert.match(bridge, /object\.len\(\) == 1/)
  assert.match(bridge, /object\.remove\("folder"\)/)
  assert.match(bridge, /folder\.is_null\(\) \|\| folder\.is_object\(\)/)
  assert.match(bridge, /_ => Err\(error\("io_error"\)\)/)
  assert.match(bridge, /folder_result\(call\(app, "get", json!\(\{\}\)\)\.await\?\)/)
  assert.match(bridge, /folder_result\(call\(app, "select", json!\(\{\}\)\)\.await\?\)/)
})

test('enumeration and observer lifetimes are bounded and errors are not hidden as complete', () => {
  for (const text of ['5000', 'directory.depth >= 8', '15000', 'CancellationSignal', 'EXTRA_LOADING', 'resource_limit', 'provider_loading', 'errorCodes.isEmpty()', 'ByteArray(65536)', '64L * 1024 * 1024']) assert.ok(source.includes(text), text)
  assert.match(source, /synchronized\(admission\)/)
  assert.match(source, /ArrayBlockingQueue<Runnable>\(1\)/)
  assert.match(source, /work\(invoke, lane = interactiveLane\)/)
  assert.match(source, /enumerationLane\.working \|\| interactiveLane\.working \|\| selecting\.get\(\)/)
  assert.match(source, /selection = true, timeoutReject = false/)
  assert.match(source, /authorized\(folder\.id\)/)
  assert.match(source, /override fun onPause\(\)/)
  assert.match(source, /override fun onDestroy\(activity: AppCompatActivity\)/)
  assert.match(source, /executor\.shutdownNow\(\)/)
  assert.match(source, /unregisterContentObserver/)
  assert.match(source, /handler\.removeCallbacks\(signalChange\)/)
  assert.match(source, /descriptor\.close\(\)/)
  assert.match(bridge, /spawn_blocking/)
  assert.match(bridge, /PluginInvokeError::InvokeRejected/)
  const lib = read('src-tauri/src/lib.rs')
  for (const command of ['get_monitored_folder', 'select_monitored_folder', 'list_monitored_files', 'read_monitored_file', 'watch_monitored_folder']) assert.ok(lib.includes(`monitored_folder::${command}`), command)
})
