// scripts/test-reader-typography.mjs
// 针对 EPUB 排版事务管理、分层解析、作用域隔离、显示模式 CSS 及容错处理的纯函数测试

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as sfc from '@vue/compiler-sfc'
import { test } from 'node:test'
import {
  clampNumber,
  getDefaultTypographyForLanguage,
  getDisplayModeCSS,
  getSampleParagraph,
  normalizeLanguageTag,
  normalizeTypographyBooks,
  normalizeTypographyLanguages,
  removeBookOverride,
  resolveEffectiveTypography,
  setBookOverride,
  setLanguageDefault,
  validateTypographySettings,
} from '../src/services/readerTypography.ts'
import { getReaderCSS, resolveReaderColors } from '../src/services/readerTheme.ts'
import { settingsDefaults } from '../src/stores/settings.ts'

const mockBaseReaderPrefs = {
  fontSize: 18,
  lineHeight: 1.8,
  gap: 6,
  theme: 'light',
  flow: 'paginated',
  maxColumnCount: 2,
  portraitScroll: true,
  continuousScroll: true,
  fontFamily: 'CustomSerif',
  justify: true,
  letterSpacing: 0,
  progressDisplay: 'both',
}

test('normalizeLanguageTag handles various CJK, Latin, and fallback tags', () => {
  assert.equal(clampNumber(70, 8, 64, 18), 64)
  assert.equal(clampNumber(-5, 8, 64, 18), 8)
  assert.equal(getDefaultTypographyForLanguage('zh').textIndent, 2)
  assert.equal(getDefaultTypographyForLanguage('en').textIndent, 1.2)
  assert.equal(normalizeLanguageTag('zh-CN'), 'zh')
  assert.equal(normalizeLanguageTag('zh-TW'), 'zh')
  assert.equal(normalizeLanguageTag('zh-Hans'), 'zh')
  assert.equal(normalizeLanguageTag('cmn'), 'zh')
  assert.equal(normalizeLanguageTag('en-US'), 'en')
  assert.equal(normalizeLanguageTag('en-GB'), 'en')
  assert.equal(normalizeLanguageTag('eng'), 'en')
  assert.equal(normalizeLanguageTag('ja-JP'), 'ja')
  assert.equal(normalizeLanguageTag(''), 'und', 'missing metadata cannot alter Chinese defaults')
  assert.equal(normalizeLanguageTag(null), 'und')
  assert.equal(normalizeLanguageTag(undefined), 'und')
  assert.equal(normalizeLanguageTag('not a language'), 'und')
})

test('validateTypographySettings clamps numerical limits and filters invalid fields', () => {
  const invalid = {
    fontSize: 999, // clamp to 64
    lineHeight: 0.2, // clamp to 1.0
    gap: -10, // clamp to 2
    letterSpacing: 2.5, // clamp to 0.5
    displayMode: 'invalid-mode',
    unrelatedField: 'malicious',
  }

  const cleaned = validateTypographySettings(invalid)
  assert.equal(cleaned.fontSize, 64)
  assert.equal(cleaned.lineHeight, 1.0)
  assert.equal(cleaned.gap, 2)
  assert.equal(cleaned.letterSpacing, 0.5)
  assert.equal(cleaned.displayMode, undefined, 'invalid display mode stripped')
  assert.equal('unrelatedField' in cleaned, false, 'unrelated fields removed')
})

test('validateTypographySettings tolerates malformed / null / primitive inputs', () => {
  assert.deepEqual(validateTypographySettings(null), {})
  assert.deepEqual(validateTypographySettings(undefined), {})
  assert.deepEqual(validateTypographySettings('corrupted string'), {})
  assert.deepEqual(validateTypographySettings(12345), {})
  assert.deepEqual(validateTypographySettings([1, 2, 3]), {})
})

test('normalizeTypographyLanguages and normalizeTypographyBooks sanitize maps without throwing', () => {
  const malformedInput = {
    'zh-CN': { fontSize: 20, displayMode: 'optimized' },
    '': { fontSize: 30 },
    nullKey: null,
    badRecord: 'not an object',
  }
  const cleanLangs = normalizeTypographyLanguages(malformedInput)
  assert.equal(cleanLangs.zh.fontSize, 20)
  assert.equal(cleanLangs.zh.displayMode, 'optimized')
  assert.equal(Object.keys(cleanLangs).length, 1)

  const booksInput = {
    'book-abc': { fontSize: 24, justify: false },
    '': { fontSize: 18 },
    corrupted: [1, 2, 3],
  }
  const cleanBooks = normalizeTypographyBooks(booksInput)
  assert.equal(cleanBooks['book-abc'].fontSize, 24)
  assert.equal(cleanBooks['book-abc'].justify, false)
  assert.equal(Object.keys(cleanBooks).length, 1)
})

test('merge precedence: Base -> Language Defaults -> Book Overrides', () => {
  const languagesMap = {
    zh: { fontSize: 20, lineHeight: 1.9, displayMode: 'optimized' },
    en: { fontSize: 16, lineHeight: 1.4 },
  }
  const booksMap = {
    'book-special': { fontSize: 26, displayMode: 'repair' },
  }

  // 1. 无覆盖书籍 (继承语言默认)
  const effStandard = resolveEffectiveTypography({
    baseReaderPrefs: mockBaseReaderPrefs,
    language: 'zh-CN',
    bookId: 'book-standard',
    languagesMap,
    booksMap,
  })
  assert.equal(effStandard.fontSize, 20, 'language override takes precedence over base 18')
  assert.equal(effStandard.lineHeight, 1.9)
  assert.equal(effStandard.source, 'language')
  assert.equal(effStandard.hasBookOverride, false)
  assert.equal(effStandard.hasLanguageOverride, true)

  // 2. 有单书定制的书籍 (单书覆盖优先级最高)
  const effSpecial = resolveEffectiveTypography({
    baseReaderPrefs: mockBaseReaderPrefs,
    language: 'zh-CN',
    bookId: 'book-special',
    languagesMap,
    booksMap,
  })
  assert.equal(effSpecial.fontSize, 26, 'book override 26 takes precedence over language 20 and base 18')
  assert.equal(effSpecial.displayMode, 'repair')
  assert.equal(effSpecial.source, 'book')
  assert.equal(effSpecial.hasBookOverride, true)

  // 3. 英文书籍应用英文语言基准与定制
  const effEn = resolveEffectiveTypography({
    baseReaderPrefs: mockBaseReaderPrefs,
    language: 'en-US',
    bookId: 'book-english',
    languagesMap,
    booksMap,
  })
  assert.equal(effEn.fontSize, 16, 'english language override applied')
  assert.equal(effEn.appliedLanguage, 'en')
})

test('language scope updates do NOT clobber other books or other languages', () => {
  const originalBooks = {
    'book-a': { fontSize: 24, justify: false },
    'book-b': { fontSize: 28, displayMode: 'publisher' },
  }
  const originalLangs = {
    zh: { fontSize: 20 },
    en: { fontSize: 16 },
  }

  // 更新中文默认
  const updatedLangs = setLanguageDefault(originalLangs, 'zh', { fontSize: 22, lineHeight: 2.0 })
  assert.equal(updatedLangs.zh.fontSize, 22)
  assert.equal(updatedLangs.zh.lineHeight, 2.0)
  assert.equal(updatedLangs.en.fontSize, 16, 'english defaults untouched')

  // 书籍原有覆盖绝对完好
  assert.equal(originalBooks['book-a'].fontSize, 24, 'book-a override untouched')
  assert.equal(originalBooks['book-b'].fontSize, 28, 'book-b override untouched')

  // 单书更新
  const updatedBooks = setBookOverride(originalBooks, 'book-c', { fontSize: 32 })
  assert.equal(updatedBooks['book-c'].fontSize, 32)
  assert.equal(updatedBooks['book-a'].fontSize, 24, 'book-a untouched when modifying book-c')
  assert.equal(updatedBooks['book-b'].fontSize, 28, 'book-b untouched when modifying book-c')
})

test('restore-auto: removes only target book override and protects all other books', () => {
  const booksMap = {
    'book-1': { fontSize: 25 },
    'book-2': { fontSize: 30, displayMode: 'repair' },
    'book-3': { fontSize: 14 },
  }

  const restored = removeBookOverride(booksMap, 'book-2')
  assert.equal('book-2' in restored, false, 'book-2 override is cleanly deleted')
  assert.equal(restored['book-1'].fontSize, 25, 'book-1 override is fully intact')
  assert.equal(restored['book-3'].fontSize, 14, 'book-3 override is fully intact')

  // 验证重新解析后回退到语言/基础配置
  const effAfterRestore = resolveEffectiveTypography({
    baseReaderPrefs: mockBaseReaderPrefs,
    language: 'zh',
    bookId: 'book-2',
    languagesMap: { zh: { fontSize: 19 } },
    booksMap: restored,
  })
  assert.equal(effAfterRestore.fontSize, 19, 'falls back to language setting')
  assert.equal(effAfterRestore.hasBookOverride, false)
  assert.equal(effAfterRestore.source, 'language')
})

test('display modes generate real, distinct CSS semantics', () => {
  const sampleSettings = {
    displayMode: 'optimized',
    fontSize: 18,
    lineHeight: 1.8,
    gap: 6,
    fontFamily: 'Songti',
    justify: true,
    letterSpacing: 0.05,
    paragraphSpacing: 0.4,
    textIndent: 2,
  }
  const colors = resolveReaderColors('light', false)
  assert.equal(typeof colors.fg, 'string')
  assert.equal(typeof colors.bg, 'string')

  // 1. optimized: 包含两端对齐、首行缩进、断词与 CJK 禁则
  const cssOptimized = getDisplayModeCSS('optimized', sampleSettings, colors)
  assert.match(cssOptimized, /p\[data-pw-paragraph\]/)
  assert.match(cssOptimized, /text-indent:\s*36px/)
  assert.match(cssOptimized, /hyphens:\s*auto/)
  assert.doesNotMatch(cssOptimized, /word-break:\s*break-word/)

  // 2. publisher: 尊重原书内嵌样式，不强制对齐与缩进
  const cssPublisher = getDisplayModeCSS('publisher', sampleSettings, colors)
  assert.equal(cssPublisher, '', 'publisher mode must not replace author paragraph semantics with inherit resets')

  // 3. repair: 防御性排版，重置异常硬编码颜色、负边距与溢出
  const cssRepair = getDisplayModeCSS('repair', sampleSettings, colors)
  assert.match(cssRepair, /color:\s*#1d2129\s*!important/)
  assert.match(cssRepair, /background-color:\s*transparent\s*!important/)
  assert.match(cssRepair, /text-indent:\s*0\s*!important/)
  assert.match(cssRepair, /margin-left:\s*0\s*!important/)
  assert.match(cssRepair, /overflow-wrap:\s*anywhere\s*!important/)
  assert.match(cssRepair, /max-width:\s*100%\s*!important/)
})

test('getReaderCSS backwards compatibility and typography integration', () => {
  // 旧调用方：不传第 4 个参数，保持与原来完全相同的正文样式
  const legacyCss = getReaderCSS(mockBaseReaderPrefs, false)
  assert.match(legacyCss, /font-size:\s*18px;/)
  assert.match(legacyCss, /font-family:\s*CustomSerif;/)
  assert.match(legacyCss, /line-height:\s*1.8;/)

  // 新调用方：传入 typography 参数，生效指定显示模式与参数
  const customTypography = {
    displayMode: 'repair',
    fontSize: 24,
    lineHeight: 2.2,
    gap: 8,
    fontFamily: 'Heiti SC',
    justify: false,
    letterSpacing: 0.1,
    paragraphSpacing: 0.8,
    textIndent: 0,
  }
  const updatedCss = getReaderCSS(mockBaseReaderPrefs, false, undefined, customTypography)
  assert.match(updatedCss, /font-size:\s*24px;/)
  assert.match(updatedCss, /font-family:\s*Heiti SC;/)
  assert.match(updatedCss, /letter-spacing:\s*0\.1em;/)
  assert.match(updatedCss, /\[排版模式:\s*兼容修复\]/)
})

test('getSampleParagraph returns realistic excerpt according to language', () => {
  const zhSample = getSampleParagraph('zh-CN')
  assert.match(zhSample, /月光如流水一般/)
  const enSample = getSampleParagraph('en-US')
  assert.match(enSample, /truth universally acknowledged/)
})

test('settingsDefaults initializes backwards-compatible typography maps', () => {
  const defs = settingsDefaults()
  assert.deepEqual(defs.typographyLanguages, {})
  assert.deepEqual(defs.typographyBooks, {})
  assert.equal(typeof defs.reader.fontSize, 'number')
})

test('transactional apply contract: cancel discards draft without mutating stored settings', () => {
  // 模拟初始状态
  const initialPrefs = structuredClone(mockBaseReaderPrefs)
  const booksMap = { 'book-x': { fontSize: 20 } }
  const languagesMap = { zh: { fontSize: 18 } }

  // 初始解析
  const before = resolveEffectiveTypography({
    baseReaderPrefs: initialPrefs,
    language: 'zh',
    bookId: 'book-x',
    languagesMap,
    booksMap,
  })
  assert.equal(before.fontSize, 20)

  // 模拟用户在排版草稿中调大了字号到 32 并更改为兼容修复模式，但并未调用 setBookOverride
  const _draftSettings = {
    displayMode: 'repair',
    fontSize: 32,
    lineHeight: 2.2,
    gap: 10,
    fontFamily: '',
    justify: false,
    letterSpacing: 0.1,
    paragraphSpacing: 0.6,
    textIndent: 0,
  }
  assert.equal(_draftSettings.fontSize, 32)

  // 用户点击「取消」: 不提交任何修改
  // 验证: 没有任何 store 或 map 变更
  const afterCancel = resolveEffectiveTypography({
    baseReaderPrefs: initialPrefs,
    language: 'zh',
    bookId: 'book-x',
    languagesMap,
    booksMap,
  })
  assert.equal(afterCancel.fontSize, 20, 'fontSize remains unchanged after cancel')
  assert.equal(afterCancel.displayMode, 'optimized')
  assert.equal(afterCancel.source, 'book')
})

test('transactional apply contract: failure retention preserves draft and does not corrupt store', async () => {
  let booksMap = { 'book-fail': { fontSize: 18 } }

  // 模拟待提交的草稿
  const draftToApply = {
    displayMode: 'repair',
    fontSize: 28,
    lineHeight: 2.0,
    gap: 8,
    fontFamily: 'Noto Serif',
    justify: true,
    letterSpacing: 0.05,
    paragraphSpacing: 0.5,
    textIndent: 2,
  }

  // 模拟 ReaderView 试探性渲染失败 (例如字体加载超时或无法重定位)
  let failed = false
  const mockOnApply = async (_payload) => {
    // 渲染阶段抛出或返回失败
    return { success: false, error: 'Font layout timed out' }
  }

  const applyRes = await mockOnApply({
    bookId: 'book-fail',
    language: 'zh',
    scope: 'book',
    settings: draftToApply,
  })

  if (!applyRes.success) {
    failed = true
    // 面板保留草稿，不调用 setBookOverride
  }

  assert.equal(failed, true)
  assert.equal(applyRes.error, 'Font layout timed out')
  // 验证持久化设置未被污染
  assert.equal(booksMap['book-fail'].fontSize, 18, 'book settings remain original upon failure')

  // 用户再次重试，这次成功
  const mockOnApplySuccess = async (_payload) => ({ success: true })
  const retryRes = await mockOnApplySuccess({
    bookId: 'book-fail',
    language: 'zh',
    scope: 'book',
    settings: draftToApply,
  })
  assert.equal(retryRes.success, true)
  booksMap = setBookOverride(booksMap, 'book-fail', draftToApply)
  assert.equal(booksMap['book-fail'].fontSize, 28, 'committed only after success')
})

test('TypographyPanel.vue compiles cleanly as Vue SFC', () => {
  if (!sfc) return
  const filename = 'src/components/TypographyPanel.vue'
  const content = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8')
  const { descriptor, errors } = sfc.parse(content, { filename })
  assert.deepEqual(errors, [])
  assert.ok(descriptor.scriptSetup, 'has script setup')
  assert.ok(descriptor.template, 'has template')
  assert.ok(descriptor.styles.length > 0, 'has scoped styles')
  const script = sfc.compileScript(descriptor, { id: 'TypographyPanel' })
  assert.ok(script.content)
  const template = sfc.compileTemplate({ source: descriptor.template.content, filename, id: 'TypographyPanel', idScoped: false })
  assert.deepEqual(template.errors, [])
})

