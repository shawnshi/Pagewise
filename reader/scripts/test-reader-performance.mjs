import test from 'node:test'
import assert from 'node:assert/strict'
import { queryLibraryBooks } from '../src/services/libraryQuery.ts'
import { createReaderActivity, isReaderPath } from '../src/services/readerActivity.ts'
import { createRouter, createMemoryHistory } from 'vue-router'
import { watch } from 'vue'
import { installObserver } from './perf-five-stage.mjs'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

test('query options and in-place classification remain live across repeated queries', () => {
  const book = { id: 'a', title: 'Alpha', author: '', tags: ['first'], format: 'txt', addedAt: 1,
    classification: { category: { value: 'fiction' }, topics: ['one', 'two'] } }
  const options = { search: 'Alpha' }
  assert.equal(queryLibraryBooks([book], options).total, 1)
  options.search = 'missing'
  assert.equal(queryLibraryBooks([book], options).total, 0)
  const complete = { classificationStatus: 'complete' }
  assert.equal(queryLibraryBooks([book], complete).total, 1)
  book.classification.topics.pop()
  assert.equal(queryLibraryBooks([book], complete).total, 0)
})

test('single committed-route owner: restored EPUB/TXT/PDF, replacement, abort, failure and disposal', async () => {
  for (const initial of ['/read/epub', '/read/txt', '/read-paper/pdf', '/read-pdf/pdf']) {
    const changes = [], owner = createReaderActivity(active => changes.push(active))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: {} }] })
    const stop = watch(() => router.currentRoute.value.fullPath, key => owner.commit(key, router.currentRoute.value.path), { immediate: true, flush: 'sync' })
    await router.push(initial); assert.deepEqual(changes, [true])
    const oldFailure = owner.captureFailure()
    await router.push('/read/new'); oldFailure(); assert.deepEqual(changes, [true], 'stale old failure cleared newer reader')
    const remove = router.beforeEach(to => to.path === '/library' ? false : undefined)
    await router.push('/library'); assert.equal(router.currentRoute.value.path, '/read/new'); assert.deepEqual(changes, [true], 'aborted exit unpaused current reader')
    remove()
    const fail = owner.captureFailure(); fail(); fail(); assert.deepEqual(changes, [true, false], 'failed-open error route stays paused or released twice')
    await router.push('/read-paper/another'); assert.deepEqual(changes, [true, false, true]); fail(); assert.deepEqual(changes, [true, false, true])
    await router.push('/library'); owner.dispose(); owner.dispose(); assert.deepEqual(changes, [true, false, true, false]); stop()
  }
  assert.equal(isReaderPath('/reading'), false)
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /createReaderActivity\(active => folderLibrary\.setReadingActive\(active\)\)/)
  assert.match(app, /watch\(\(\) => route.fullPath,[\s\S]*?immediate: true, flush: 'sync'/)
  for (const view of ['ReaderView.vue', 'PdfReaderView.vue']) {
    const source = await readFile(new URL('../src/views/' + view, import.meta.url), 'utf8')
    assert.match(source, /inject\(readerActivityKey/); assert.match(source, /watch\(error, value => \{ if \(value\) reportReaderFailure\(\) \}\)/)
    assert.doesNotMatch(source, /setReadingActive\(/, 'competing route owner')
  }
})

test('benchmark eink profile is explicit and default does not silently enable saved preference', () => {
  for (const profile of ['default', 'eink']) {
    let saved
    const context = vm.createContext({ window: { addEventListener() {} }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: { setItem(_key, value) { saved = JSON.parse(value) } } })
    vm.runInContext(`(${installObserver.toString()})({settingsVersion:16,profile:${JSON.stringify(profile)}})`, context)
    assert.equal(saved.readingMode?.eink?.enabled, profile === 'eink' ? true : undefined)
  }
})
