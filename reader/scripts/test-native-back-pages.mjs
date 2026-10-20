import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { claimNativeBack } from '../src/composables/useNativeBack.ts'

const source = name => readFileSync(new URL(`../src/views/${name}`, import.meta.url), 'utf8')

test('page-level Back never steals an existing owner and removes only itself', () => {
  const host = {}
  const calls = []
  const first = claimNativeBack(host, () => { calls.push('first'); return true })
  const second = claimNativeBack(host, () => { calls.push('second'); return false })
  first.install()
  const owned = host.__pagewiseReaderBack
  second.install()
  assert.equal(host.__pagewiseReaderBack, owned, 'a second page must not overwrite the active owner')
  assert.equal(host.__pagewiseReaderBack(), true)
  assert.deepEqual(calls, ['first'])
  // 更具体的 owner (阅读页) 接管后, 旧页面的 dispose 不能删除别人的处理器。
  const reader = () => true
  host.__pagewiseReaderBack = reader
  first.dispose()
  assert.equal(host.__pagewiseReaderBack, reader)
  second.dispose()
  assert.equal(host.__pagewiseReaderBack, reader, 'unowned slots cannot delete a newer owner')
})

test('a disposed page slot stops consuming Back even if the host keeps the reference', () => {
  const host = {}
  let calls = 0
  const slot = claimNativeBack(host, () => { calls++; return true })
  slot.install()
  const consume = host.__pagewiseReaderBack
  assert.equal(consume(), true)
  slot.dispose()
  assert.equal(consume(), false, 'a stale reference must report unhandled so the host can fall back')
  assert.equal(calls, 1)
})

test('a page slot that declines lets the native fallback run', () => {
  const host = {}
  const slot = claimNativeBack(host, () => false)
  slot.install()
  assert.equal(host.__pagewiseReaderBack(), false)
  slot.dispose()
  assert.equal(host.__pagewiseReaderBack, undefined)
})

test('library, notes and detail pages route Back through the shared page slot', () => {
  const library = source('LibraryView.vue')
  assert.match(library, /useNativeBack\(dismissLibraryLayer\)/, 'LibraryView delegates Esc/Back dismissal to one layer stack')
  for (const layer of ['filterDraft', 'showTagModal', 'manageMode']) {
    assert.match(library, new RegExp(`if \\(${layer}\\.value\\)`), `LibraryView layer ${layer} is dismissible`)
  }
  assert.doesNotMatch(library, /showTagManage|openTagManage/, 'retired global tag manager is not a Back layer')

  const notes = source('NotesView.vue')
  assert.match(notes, /useNativeBack\(\(\) => \{/, 'NotesView registers a page Back handler')
  assert.match(notes, /if \(deletingNote\.value\) \{ deletingNote\.value = null; return true \}/)
  assert.match(notes, /if \(editingNoteId\.value\) \{ cancelEditing\(\); return true \}/)

  const detail = source('BookDetailView.vue')
  assert.match(detail, /useNativeBack\(\(\) => \{/, 'BookDetailView registers a page Back handler')
  assert.match(detail, /if \(showRelink\.value\) \{ showRelink\.value = false; return true \}/)
  const goBack = detail.match(/function goBack\(\) \{([\s\S]*?)\n\}/)
  assert.ok(goBack, 'goBack is present')
  assert.match(goBack[1], /restorableView\(window\.history\.state\?\.back\)/, 'Back uses the origin route when restorable')
  assert.match(goBack[1], /router\.back\(\)/, 'Back retreats in history instead of always opening the library')
})
