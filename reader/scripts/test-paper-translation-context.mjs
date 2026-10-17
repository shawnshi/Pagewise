import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  extractAbstractCandidate,
  loadPaperTranslationContext,
  parseGeneratedPaperTranslationContext,
  savePaperTranslationContext,
} from '../src/services/paperTranslationContext.ts'
import {
  TARGET_LANGUAGES,
  loadTargetLanguage,
  resolveTargetLanguage,
  saveTargetLanguage,
} from '../src/services/translationLanguages.ts'

function createMemoryStorage() {
  const values = new Map()
  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
  }
}

beforeEach(() => {
  globalThis.localStorage = createMemoryStorage()
})

test('resolves ordinary translation target languages and preserves the legacy preference', () => {
  localStorage.setItem('lightread-babeldoc-target-language', 'ja')
  assert.equal(loadTargetLanguage(), 'ja')
  assert.deepEqual(
    TARGET_LANGUAGES.map(language => language.code),
    ['zh', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it', 'ru'],
  )
  assert.deepEqual(resolveTargetLanguage('ja'), {
    code: 'ja',
    englishName: 'Japanese',
    labelKey: 'paper.bdLanguageJa',
  })
  assert.equal(resolveTargetLanguage('unsupported').code, 'zh')
  assert.equal(saveTargetLanguage('fr'), 'fr')
  assert.equal(loadTargetLanguage(), 'fr')
})

test('extracts Abstract without Keywords or Introduction', () => {
  const abstract = extractAbstractCandidate([
    'A Study of Stable Terms\n\nAbstract\nNeural repre-\n sentations remain consistent across domains.\n\nKeywords: translation, terminology\n\n1 Introduction\nBody text.',
  ])

  assert.equal(abstract, 'Neural representations remain consistent across domains.')
})

test('does not guess a context when no Abstract heading exists', () => {
  assert.equal(extractAbstractCandidate(['Introduction\nThis paper studies translation.']), '')
})

test('parses the required bilingual response and rejects incomplete output', () => {
  assert.deepEqual(
    parseGeneratedPaperTranslationContext(
      '<<<ENGLISH>>>\nRepaired paper text.\n<<<TRANSLATION>>>\n修复后的论文文本。\n<<<END>>>',
    ),
    { english: 'Repaired paper text.', translation: '修复后的论文文本。' },
  )
  assert.throws(
    () => parseGeneratedPaperTranslationContext('<<<ENGLISH>>>\nEnglish only'),
    /双语背景/,
  )
  assert.throws(
    () => parseGeneratedPaperTranslationContext(
      '<<<ENGLISH>>>\nComplete English.\n<<<TRANSLATION>>>\n完整译文。',
    ),
    /双语背景/,
  )
})

test('keeps the context version stable when unchanged and increments it after edits', () => {
  const first = savePaperTranslationContext('paper-1', {
    source: 'Abstract source',
    english: 'Processed English',
    translation: '中文参考',
    targetLanguage: 'zh',
  })
  const unchanged = savePaperTranslationContext('paper-1', {
    source: 'Abstract source',
    english: 'Processed English',
    translation: '中文参考',
    targetLanguage: 'zh',
  })
  const changed = savePaperTranslationContext('paper-1', {
    source: 'Abstract source',
    english: 'Processed English',
    translation: '更新后的中文参考',
    targetLanguage: 'zh',
  })

  assert.equal(unchanged.updatedAt, first.updatedAt)
  assert.ok(changed.updatedAt > first.updatedAt)
  assert.deepEqual(loadPaperTranslationContext('paper-1'), changed)
})

test('stores approved context independently for each target language', () => {
  const chinese = savePaperTranslationContext('paper-multi', {
    source: 'Shared source',
    english: 'Processed English',
    translation: '中文术语',
    targetLanguage: 'zh',
  })
  const japanese = savePaperTranslationContext('paper-multi', {
    source: 'Shared source',
    english: 'Processed English',
    translation: '日本語の用語',
    targetLanguage: 'ja',
  })

  assert.deepEqual(loadPaperTranslationContext('paper-multi', 'zh'), chinese)
  assert.deepEqual(loadPaperTranslationContext('paper-multi', 'ja'), japanese)
  assert.equal(loadPaperTranslationContext('paper-multi', 'de'), null)
})

test('reports persistence failures instead of approving an unsaved context', () => {
  globalThis.localStorage = {
    getItem() {
      return null
    },
    setItem() {
      throw new Error('quota exceeded')
    },
  }

  assert.throws(
    () => savePaperTranslationContext('paper-2', {
      source: 'Source',
      english: 'English',
      translation: '中文',
      targetLanguage: 'zh',
    }),
    /quota exceeded/,
  )
})
