import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { resolveEffectiveTypography, settingsDefaults, useSettings } from '../src/stores/settings.ts'
import { getDisplayModeCSS, typographyPageMetrics } from '../src/services/readerTypography.ts'
import { measureTypographyCalibration, normalizeTypographyCalibration, calibrationStatus } from '../src/services/readerTypographyProfiles.ts'

const resolve = (extra = {}) => resolveEffectiveTypography({ baseReaderPrefs: settingsDefaults().reader, language: 'zh', viewportWidth: 992, textScale: 0.85, ...extra })
const context = { profile: 'zh', language: 'zh-CN', protectedLayout: false, automaticFont: true, textScale: 0.85 }

test('PW-VIS-01: a tablet gets a readable uncalibrated starting size and no factory hard line cap', () => {
  assert.equal(resolve().fontSize, 30)
  assert.equal(resolve().maxLineLength, 0)
  assert.equal(resolve({ language: 'en' }).fontSize, 29)
  assert.equal(resolve({ profile: 'mixed' }).fontSize, 30)
  assert.equal(resolve({ viewportWidth: 390 }).fontSize, 18)
  assert.equal(resolve({ language: 'und' }).fontSize, 18)
})

test('PW-VIS-01/02: explicit book/language/global sizing and hard line caps are not replaced', () => {
  assert.equal(resolve({ bookId: 'A', booksMap: { A: { fontSize: 21, maxLineLength: 38 } } }).fontSize, 21)
  assert.equal(resolve({ bookId: 'A', booksMap: { A: { fontSize: 21, maxLineLength: 38 } } }).maxLineLength, 38)
  assert.equal(resolve({ languagesMap: { zh: { fontSize: 23 } } }).fontSize, 23)
  assert.equal(resolve({ baseReaderPrefs: { ...settingsDefaults().reader, fontSize: 24 } }).fontSize, 24)
  assert.equal(resolve({ protectedLayout: true }).displayMode, 'publisher')
})

test('PW-VIS-02: physical-size calibration records text scaling and compensates rather than changing the OS', () => {
  const calibration = measureTypographyCalibration(160, 20, 1.875, 0.85)
  assert.equal(calibration.textScale, 0.85)
  assert.equal(resolve({ calibration, dpr: 1.875 }).fontSize, Math.round(12.5 * 25.4 / 72 * 8 / 0.85))
  assert.equal(calibrationStatus(calibration, 1.875, 1), 'changed-text-scale')
  assert.equal(calibrationStatus(calibration, 2, 0.85), 'changed-dpr')
  assert.equal(normalizeTypographyCalibration({ ...calibration, textScale: 0 }), null)
  assert.throws(() => measureTypographyCalibration(160, 0, 1.875, 0.85))
  assert.equal(resolve({ calibration, dpr: 1.875, textScale: 1 }).calibration, 'changed-text-scale')
})

test('PW-VIS-02: indents, tracking and paragraph spacing use the rendered em under 85% text scale', () => {
  const css = getDisplayModeCSS('optimized', { ...resolve(), fontSize: 18, textIndent: 2, paragraphSpacing: 0.15, letterSpacing: 0.1 }, undefined, context)
  assert.match(css, /text-indent:\s*30\.6px/)
  assert.match(css, /margin-block-start:\s*2\.295px/)
  assert.match(css, /letter-spacing:\s*1\.53px/)
  assert.equal(getDisplayModeCSS('publisher', resolve(), undefined, context), '')
})

test('PW-VIS-02: ruler edges include the footer band once and uncalibrated edges remain explicitly proportional', () => {
  const calibration = measureTypographyCalibration(160, 20, 1.875, 0.85)
  const page = typographyPageMetrics({ profile: 'zh', width: 992, height: 1322, calibration, dpr: 1.875, textScale: 0.85 })
  assert.equal(page.inline, 96); assert.equal(page.top, 96); assert.equal(page.bottom, 128)
  assert.equal(page.bottom - page.top, 32); assert.equal(page.calibrated, true)
  const fallback = typographyPageMetrics({ profile: 'zh', width: 992, height: 1322, calibration, dpr: 1.875, textScale: 1 })
  assert.equal(fallback.calibrated, false); assert.equal(fallback.inline, 992 * 0.08)
  assert.equal(typographyPageMetrics({ profile: 'en', width: 992, height: 1322, dpr: 1.875, textScale: 0.85 }).inline, 992 * 0.09)
})

test('PW-VIS-REVIEW-02: non-default globals survive calibration and lose only to explicit language/book fields', () => {
  const base = { ...settingsDefaults().reader, fontSize: 24, fontFamily: 'Georgia, serif', lineHeight: 2.2, justify: false, letterSpacing: 0.08 }
  const calibration = measureTypographyCalibration(160, 20, 1.875, 0.85)
  for (const state of [{}, { calibration, dpr: 1.875 }, { calibration, dpr: 2 }]) {
    const global = resolve({ ...state, baseReaderPrefs: base })
    for (const field of ['fontSize','fontFamily','lineHeight','justify','letterSpacing']) assert.equal(global[field], base[field], field)
    assert.ok(global.overriddenFields.includes('lineHeight'))
    const language = resolve({ ...state, baseReaderPrefs: base, languagesMap: { zh: { fontSize: 25, lineHeight: 2.3 } } })
    assert.equal(language.fontSize, 25); assert.equal(language.lineHeight, 2.3); assert.equal(language.fontFamily, base.fontFamily)
    const book = resolve({ ...state, baseReaderPrefs: base, languagesMap: { zh: { fontSize: 25 } }, bookId: 'A', booksMap: { A: { fontSize: 26 } } })
    assert.equal(book.fontSize, 26)
  }
})

test('PW-VIS-03: role-based hierarchy is generated separately from ordinary paragraph markers', () => {
  const css = getDisplayModeCSS('optimized', resolve(), undefined, context)
  assert.match(css, /data-pw-semantic/)
  assert.match(css, /0\.9rem/)
  assert.match(css, /1\.6rem/)
})

test('PW-VIS-04: the book-only baseline is sparse and never mutates global or language preferences', () => {
  const data = new Map()
  globalThis.localStorage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }
  setActivePinia(createPinia())
  const store = useSettings()
  const globalBefore = JSON.stringify({ reader: store.reader, modes: store.readingMode, dianjing: store.dianjing })
  store.setBookTypography('A', { publicationBaseline: true, fontSize: 21, theme: 'green' })
  assert.equal(store.getEffectiveTypography('A', 'zh').publicationBaseline, true)
  assert.equal(store.getEffectiveTypography('A', 'zh').theme, 'green')
  assert.equal(store.getEffectiveTypography('B', 'zh').publicationBaseline, false)
  store.setLanguageTypography('zh', { publicationBaseline: true, lineHeight: 1.8 })
  assert.notEqual(store.typographyLanguages.zh.publicationBaseline, true)
  assert.equal(store.getEffectiveTypography('B', 'zh').publicationBaseline, false)
  assert.equal(store.getEffectiveTypography('A', 'zh').publicationBaseline, true)
  const previous = store.getEffectiveTypography('A', 'zh')
  store.commitTypography({ bookId: 'A', language: 'zh', scope: 'language', previousSettings: previous,
    settings: { ...previous, profile: previous.profilePreference }, readerPatch: {}, dim: 0 })
  assert.equal(store.typographyLanguages.zh.publicationBaseline, undefined)
  assert.equal(store.typographyBooks.A.publicationBaseline, true)
  assert.equal(store.getEffectiveTypography('B', 'zh').publicationBaseline, false)
  assert.equal(JSON.stringify({ reader: store.reader, modes: store.readingMode, dianjing: store.dianjing }), globalBefore)
})
