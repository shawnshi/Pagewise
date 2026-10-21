import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = name => readFileSync(new URL('../src-tauri/android/' + name, import.meta.url), 'utf8')
test('R2-02: actual detail render binds pin/unpin and retained original source fields', () => {
  const controller = source('NativePagesController.kt')
  const render = controller.split('private fun renderBook(')[1].split('private fun bookToc(')[0]
  assert.match(render, /book\.isNull\("pinnedAt"\).*?"置顶".*?"取消置顶"/s)
  assert.match(render, /patchBook\(\s*book,[\s\S]*?put\("pinnedAt",[\s\S]*?JSONObject\.NULL/)
  assert.match(render, /"文件名" to book\.optString\("fileName"\)/)
  assert.match(render, /"源相对路径" to \(book\.optJSONObject\("sourceRef"\)\?\.optString\("relativePath"\)/)
  assert.match(controller, /"文件名" to "Original filename"/)
  assert.match(controller, /"源相对路径" to "Source-relative path"/)
  const remove = controller.split('private fun removeBook(')[1].split('private fun book(')[0]
  assert.match(remove, /source_linked_book/)
})
test('R2-03: confirmed individual and batch pin paths invalidate existing session order before refresh', () => {
  const controller = source('NativePagesController.kt')
  const patch = controller.split('private fun patchBook(')[1].split('private fun status(')[0]
  assert.match(patch, /call\("library\.bookPatch"[\s\S]*?if \(patch\.has\("pinnedAt"\)\)[\s\S]*?call\("action\.librarySessionSave"[\s\S]*?put\("orderedBookIds", JSONArray\(\)\)[\s\S]*?refresh\(\)/)
  const panel = source('NativeLibraryPanel.kt').split('private fun mutate(')[1].split('private fun report(')[0]
  assert.match(panel, /operation == "pin" && succeeded > 0/)
  assert.match(panel, /state\.library\.put\("orderedBookIds", JSONArray\(\)\)/)
  assert.match(panel, /settled\("action\.librarySessionSave"[\s\S]*?put\("orderedBookIds", JSONArray\(\)\)/)
})
test('R2-04: editor delegates error disclosure without altering the canonical replay fence', () => {
  const editor = source('NativeClassificationEditor.kt')
  assert.match(editor, /nativeClassificationFailureStatus\(action == "classificationSave"/)
  assert.doesNotMatch(editor, /state\.text = "未保存，当前输入仍保留。"/)
  const adapter = readFileSync(new URL('../src/services/nativeManagementActions.ts', import.meta.url), 'utf8')
  assert.match(adapter, /if \(edit\.unknown\) return \{ ok: false, code: 'classification_outcome_unknown', retryAutomatically: false \}/)
})
