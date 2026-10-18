import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const panelVuePath = path.resolve(__dirname, '../src/components/BookClassificationPanel.vue')
const detailVuePath = path.resolve(__dirname, '../src/views/BookDetailView.vue')
const libraryVuePath = path.resolve(__dirname, '../src/views/LibraryView.vue')
const zhPath = path.resolve(__dirname, '../src/i18n/zh.ts')
const enPath = path.resolve(__dirname, '../src/i18n/en.ts')

test('BookClassificationPanel.vue exists and includes required test selectors and accessibility features', () => {
  assert.ok(fs.existsSync(panelVuePath), 'BookClassificationPanel.vue must exist')
  const content = fs.readFileSync(panelVuePath, 'utf-8')

  // Required test selectors
  const requiredSelectors = [
    'data-testid="classification-panel"',
    'data-testid="classification-status"',
    'data-testid="btn-generate-classification"',
    'data-testid="btn-save-classification"',
    'data-testid="select-category"',
    'data-testid="topics-list"',
    'data-testid="topic-chip"',
    'data-testid="btn-edit-topic"',
    'data-testid="input-new-topic"',
    'data-testid="btn-add-topic"',
    'data-testid="facets-section"',
    'data-testid="input-facet-audience"',
    'data-testid="select-facet-textbook"',
    'data-testid="select-facet-ancient"',
    'data-testid="input-facet-country"',
    'data-testid="input-facet-period"',
    'data-testid="legacy-tags-section"',
    'data-testid="ai-disclosure-modal"',
    'data-testid="btn-disclosure-confirm"',
    'data-testid="btn-disclosure-cancel"',
    'data-testid="tag-edit-dialog"',
    'data-testid="checkbox-tag-lock"',
    'data-testid="btn-delete-tag"',
  ]

  for (const selector of requiredSelectors) {
    assert.ok(content.includes(selector), `Missing required selector: ${selector}`)
  }

  // Accessible lock indicator text (no color-only / blinking cues)
  assert.ok(content.includes('aria-label="已锁定"'), 'Lock must have accessible text')
  assert.ok(content.includes('[锁]'), 'Lock chip must render visible text marker')

  // Pointerdown and contextmenu for long-press / contextmenu
  assert.ok(content.includes('@contextmenu.prevent'), 'Must support contextmenu event')
  assert.ok(content.includes('@pointerdown'), 'Must support pointerdown gesture')

  // Cancel on unmount
  assert.ok(content.includes('onBeforeUnmount'), 'Must register onBeforeUnmount')
  assert.ok(content.includes('abort()'), 'Must abort pending requests')
})

test('BookClassificationPanel contract logic: generation button text, partial deletion, disclosures', () => {
  const content = fs.readFileSync(panelVuePath, 'utf-8')

  // Empty Generate, incomplete Complete, complete status no regenerate
  assert.ok(content.includes('classification.generate'), 'Must have generate key for empty')
  assert.ok(content.includes('classification.complete'), 'Must have complete key for incomplete')
  assert.ok(content.includes('classification.statusComplete'), 'Must have statusComplete key')

  // Disclosure before network send
  assert.ok(content.includes('showDisclosure'), 'Must require disclosure modal before sending')

  // Does not send body or TOC
  assert.ok(!content.includes('getBookFile'), 'Classification panel must never request book body file')
  assert.ok(!content.includes('loadToc'), 'Classification panel must never parse TOC')

  // Save via saveBookClassification
  assert.ok(content.includes('saveBookClassification'), 'Must call saveBookClassification')
})

test('BookDetailView embeds BookClassificationPanel and refreshes on commits', () => {
  const content = fs.readFileSync(detailVuePath, 'utf-8')

  assert.ok(content.includes('BookClassificationPanel'), 'BookDetailView must import BookClassificationPanel')
  assert.ok(content.includes('<BookClassificationPanel'), 'BookDetailView must render BookClassificationPanel')
  assert.ok(content.includes('@updated="onClassificationUpdated"'), 'Must handle updated event')
  assert.ok(content.includes('library.refresh()'), 'Must refresh library on update')
})

test('LibraryView global manager uses centralized bookTagActions without bypassing structured rules', () => {
  const content = fs.readFileSync(libraryVuePath, 'utf-8')

  // Imports from bookTagActions
  assert.ok(content.includes('mergeLibraryTags'), 'Must import mergeLibraryTags')
  assert.ok(content.includes('removeLibraryTag'), 'Must import removeLibraryTag')
  assert.ok(content.includes('clearBookClassifications'), 'Must import clearBookClassifications')

  // Fixed categories must not be in free-tag manager
  assert.ok(content.includes('BOOK_CATEGORIES'), 'Must import BOOK_CATEGORIES')
  assert.ok(content.includes('categoryLabels'), 'Must filter out fixed categories from free tags')

  // Preview affected and locked count before confirm
  assert.ok(content.includes('affectedBooks'), 'Must calculate affected books')
  assert.ok(content.includes('lockedCount'), 'Must calculate locked tags count')
  assert.ok(content.includes('classification.mergePreview'), 'Must prompt merge preview with affected/locked count')
  assert.ok(content.includes('classification.deleteGlobalConfirm'), 'Must prompt delete confirmation with role/affected/locked')

  assert.ok(content.includes('books.some(book => book.classification)'), 'Free batch tags reject structured selection')
  assert.ok(content.includes('updateBookClassifications([], books.map'), 'Plain batch tags use atomic legacy updates')
})

test('LibraryView filter drawer exposes category and all 5 facets with unknown vs false preservation', () => {
  const content = fs.readFileSync(libraryVuePath, 'utf-8')

  // Category filter in draft & dialog
  assert.ok(content.includes('filterDraft.category'), 'Filter draft must include category')

  // Classification status filter
  assert.ok(content.includes('filterDraft.classificationStatus'), 'Filter draft must include classificationStatus')

  // All 5 facets
  assert.ok(content.includes('filterDraft.audience'), 'Filter draft must include audience')
  assert.ok(content.includes('filterDraft.textbook'), 'Filter draft must include textbook')
  assert.ok(content.includes('filterDraft.ancientText'), 'Filter draft must include ancientText')
  assert.ok(content.includes('filterDraft.workCountry'), 'Filter draft must include workCountry')
  assert.ok(content.includes('filterDraft.workPeriod'), 'Filter draft must include workPeriod')

  // Active chips display
  assert.ok(content.includes('categoryFilter'), 'Active chips must support category')
  assert.ok(content.includes('textbookFilter'), 'Active chips must support textbook')
  assert.ok(content.includes('ancientTextFilter'), 'Active chips must support ancientText')
})

test('i18n zh and en have all matching classification keys', () => {
  const zhContent = fs.readFileSync(zhPath, 'utf-8')
  const enContent = fs.readFileSync(enPath, 'utf-8')

  const requiredKeys = [
    'classification.title',
    'classification.category',
    'classification.topics',
    'classification.feature',
    'classification.facets',
    'classification.audience',
    'classification.textbook',
    'classification.ancientText',
    'classification.workCountry',
    'classification.workPeriod',
    'classification.statusComplete',
    'classification.statusIncomplete',
    'classification.statusUnclassified',
    'classification.generate',
    'classification.complete',
    'classification.locked',
    'classification.disclosureTitle',
    'classification.disclosureText',
    'classification.disclosureConsent',
    'classification.mergeTitle',
    'classification.mergePreview',
    'classification.deleteGlobalConfirm',
  ]

  for (const key of requiredKeys) {
    assert.ok(zhContent.includes(`'${key}'`), `zh.ts must contain key '${key}'`)
    assert.ok(enContent.includes(`'${key}'`), `en.ts must contain key '${key}'`)
  }
})
