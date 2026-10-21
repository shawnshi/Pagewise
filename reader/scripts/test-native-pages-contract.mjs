import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !extname(specifier)) { const p = fileURLToPath(new URL(specifier + '.ts', context.parentURL)); if (existsSync(p)) return next(pathToFileURL(p).href, context) } return next(specifier, context) } })
const { createNativeManagementActions } = await import('../src/services/nativeManagementActions.ts')
const { createNativeSettingsActions } = await import('../src/services/nativeSettingsEditing.ts')
const { createNativeStatsActions } = await import('../src/services/nativeStatsActions.ts')
const { createNativeLibraryActions } = await import('../src/services/nativeLibraryActions.ts')
const { createNativeBookTocActions } = await import('../src/services/nativeBookTocAction.ts')
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const set = (text, start, end) => new Set([...text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start))).matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m => m[1]))
test('actual production action factories exactly match native allowlist and satisfy ready requirements without reading data', () => {
  const actions = { ...createNativeManagementActions(), ...createNativeSettingsActions({}, {}), ...createNativeStatsActions(), ...createNativeLibraryActions(), ...createNativeBookTocActions() }
  const allowed = set(source('../src-tauri/android/NativeManagementDispatcher.kt'), 'val WEB_ACTIONS', 'private val MANUAL_FILES')
  const host = source('../src-tauri/android/NativeManagementHost.kt')
  const required = new Set([...host.slice(host.indexOf('private val REQUIRED_ACTIONS')).matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m => m[1]))
  assert.deepEqual(new Set(Object.keys(actions)), allowed)
  for (const name of required) assert.equal(typeof actions[name], 'function', name)
})
test('native panels are Android Views and use protected shared actions rather than alternate data stores or web wrappers', () => {
  for (const file of ['NativeLibraryPanel.kt', 'NativeStatsPanel.kt', 'NativeSettingsPanel.kt', 'NativeNoteEditor.kt']) {
    const content = source('../src-tauri/android/' + file)
    assert.doesNotMatch(content, /android\.webkit|WebView\(|SQLiteDatabase|SharedPreferences/)
  }
  for (const file of ['nativeStatsActions.ts', 'nativeLibraryActions.ts', 'nativeBookTocAction.ts']) assert.doesNotMatch(source('../src/services/' + file), /localStorage\.|indexedDB\./)
  assert.ok(source('../src-tauri/android/NativeClassificationEditor.kt').includes('put("confirmLockedChanges", lockedChanges.isChecked)'))
})
test('session-scoped visibility ticket is allowed by both protected protocol endpoints; frame bridge remains capability-only', () => {
  assert.match(source('../src-tauri/src/native_pages.rs'), /"visibilityTicket"/)
  assert.match(source('../src-tauri/android/NativePagesPlugin.kt'), /"visibilityTicket"/)
  const activity = source('../src-tauri/android/MainActivity.kt')
  assert.doesNotMatch(activity, /@JavascriptInterface\s+fun (?:nativePage|settings|book|reply|show)\s*\(/)
})
