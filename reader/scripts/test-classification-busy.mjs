import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { computed, ref } from 'vue'
import * as classification from '../src/services/bookClassification.ts'
import { createHarness } from './test-book-tag-storage.mjs'

test('delayed SSE locks non-native tag shortcuts and keeps manual draft unchanged until completion', { timeout: 60000 }, async () => {
  const h = await createHarness(), page = h.page
  let release, received, finished, started = false
  const gate = new Promise(resolve => { release = resolve })
  const request = new Promise(resolve => { received = resolve })
  const response = new Promise(resolve => { finished = resolve })
  const description = '这是面向儿童的数学读物，通过几何图形的实例解释数学规律，讨论空间形状与逻辑推理，提供实质性的知识介绍。'
  try {
    await page.context().route('https://fixture.invalid/**', async route => {
      started = true; received()
      try {
        const payload = route.request().postDataJSON(), data = JSON.parse(payload.messages[1].content)
        const entry = value => ({ value, evidence: description })
        const answer = JSON.stringify({ status: 'classified', category: data.requested.category ? entry('science-mathematics') : null,
          topics: Array.from({ length: data.requested.topics }, () => entry('几何')), feature: null, facets: {} })
        await gate
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n` })
      } finally { finished() }
    })
    await page.evaluate(() => localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, language: 'zh', aiProvider: 'deepseek', aiBaseUrl: 'https://fixture.invalid/v1', aiModel: 'fixture', aiApiKey: 'fixture-key', sync: { autoSync: false } })))
    const id = await page.evaluate(async description => {
      const storage = await (await import('/src/storage/index.ts')).getStorage()
      return storage.addBook({ title: 'Busy classification', author: 'Synthetic author', format: 'txt', fileName: 'fixture.txt', tags: ['legacy'], addedAt: 1, description }, new Blob(['Synthetic body never sent']))
    }, description)
    const base = new URL(page.url()).origin
    await page.goto(`${base}/#/book/${id}`)
    await page.getByTestId('classification-panel').waitFor()
    await page.getByTestId('select-category').selectOption('science-mathematics')
    await page.getByTestId('input-new-topic').fill('数学')
    await page.getByTestId('btn-add-topic').click()
    await page.getByTestId('btn-generate-classification').click()
    await request
    assert.equal(await page.getByTestId('ai-disclosure-modal').count(), 0)
    const chip = page.getByTestId('topic-chip').first()
    await chip.focus(); await page.keyboard.press('Enter')
    assert.equal(await page.getByTestId('tag-edit-dialog').count(), 0, 'Enter cannot edit a tag while SSE is pending')
    assert.equal(await chip.getAttribute('aria-disabled'), 'true')
    assert.equal(await chip.getAttribute('tabindex'), '-1')
    await chip.dispatchEvent('contextmenu')
    assert.equal(await page.getByTestId('tag-edit-dialog').count(), 0, 'right-click cannot bypass the busy guard')
    await chip.dispatchEvent('pointerdown', { pointerType: 'touch' })
    await page.waitForTimeout(550)
    await chip.dispatchEvent('pointerup', { pointerType: 'touch' })
    assert.equal(await page.getByTestId('tag-edit-dialog').count(), 0, 'long-press cannot bypass the busy guard')
    assert.equal(await page.getByTestId('btn-save-classification').isDisabled(), true)
    release(); await response
    await page.getByTestId('topic-chip').filter({ hasText: '几何' }).waitFor()
    assert.match(await page.getByTestId('topic-chip').first().innerText(), /数学/)
    assert.equal(await page.getByTestId('topic-chip').first().getAttribute('aria-disabled'), 'false')
    const persisted = await page.evaluate(async id => (await (await import('/src/storage/index.ts')).getStorage()).getBook(id), id)
    assert.equal(persisted.classification, undefined, 'generation remains a draft, not a storage write')
  } finally {
    release()
    if (started) await response
    await h.close()
  }
})

test('pending storage acquisition saves the original book snapshot and cannot overwrite a new book draft', async () => {
  const source = readFileSync(new URL('../src/components/BookClassificationPanel.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const ast = ts.createSourceFile('panel.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
  const method = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveClassification')
  assert.ok(method)
  const a = { id: 'a', title: 'A', author: 'Fixture', format: 'txt', fileName: 'a.txt', tags: ['A legacy'], addedAt: 1, hasCover: false }
  const b = { ...a, id: 'b', title: 'B', tags: ['B legacy'] }
  const original = ref(a), draft = ref(classification.createClassification(a.tags)), saving = ref(false), generating = ref(false)
  const props = { book: a }, writes = [], events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const context = vm.createContext({ original, draft, saving, generating, props, disposed: false,
    busy: computed(() => saving.value || generating.value), dirty: ref(true), editingTag: ref(null),
    getStorage: () => gate, parseClassification: classification.parseClassification, classificationTags: classification.classificationTags,
    validatedDraft: () => classification.parseClassification(draft.value), t: key => key, toast() {}, emit: (...args) => events.push(args),
    saveBookClassification: async (_storage, book, value) => { writes.push({ id: book.id, legacyTags: [...value.legacyTags] }); return { ...value, revision: 1 } },
  })
  const action = vm.runInContext(ts.transpileModule(`${method.getText(ast)}\nsaveClassification`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context)
  const pending = action()
  original.value = b; props.book = b; draft.value = classification.createClassification(b.tags)
  release({}); await pending
  assert.equal(writes[0].id, 'a')
  assert.deepEqual(writes[0].legacyTags, ['A legacy'])
  assert.equal(original.value.id, 'b')
  assert.deepEqual([...draft.value.legacyTags], ['B legacy'])
  assert.equal(events.length, 0, 'a stale save cannot publish an update into a different book view')
  assert.equal(saving.value, false)
})
