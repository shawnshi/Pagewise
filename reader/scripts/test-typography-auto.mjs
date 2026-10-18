import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { useSettings, settingsDefaults, resolveEffectiveTypography, normalizeLanguageTag, prepareTypographyCommit } from '../src/stores/settings.ts'
import { measureTypographyCalibration, normalizeTypographyCalibration, automaticFontFamily } from '../src/services/readerTypographyProfiles.ts'
import { resolveBookTypographyContext, textLanguageEvidence, createTypographyBookOwner } from '../src/services/readerTypographyContext.ts'

import { getTypographyAnchor } from '../src/services/readerTypography.ts'

const zh = '这是用于测试阅读排版的合成正文，讨论清楚的段落、阅读位置与文字布局，不包含任何私人资料。'.repeat(35)
const en = 'The reader opens the book and the words stay in their original order. This is a synthetic paragraph for the typography test, with no private content. '.repeat(35)
function doc(text, language = '', paragraphs = [text]) {
  return { body: { textContent: text, style: { writingMode: '' } }, documentElement: { lang: language, style: { writingMode: '' }, getAttribute: () => '' }, querySelectorAll: () => paragraphs.map(textContent => ({ textContent })) }
}
function book(language, texts, htmlLanguage = '') {
  return { metadata: { language }, sections: texts.map(text => ({ createDocument: async () => doc(text, htmlLanguage) })) }
}
function fixture() {
  const data = new Map(); let fail = false, writes = 0
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (fail) throw new Error('fixture quota denied'); writes++; data.set(key, value) }, removeItem: key => data.delete(key) }
  setActivePinia(createPinia())
  return { store: useSettings(), data, deny: () => { fail = true }, writes: () => writes }
}
function payload(store, id, language, change = {}, reader = {}) {
  const previous = store.getEffectiveTypography(id, language)
  return { bookId: id, language, scope: 'book', previousSettings: previous,
    settings: { ...previous, profile: previous.profilePreference, ...change },
    readerPatch: { theme: previous.theme, flow: previous.flow, continuousScroll: previous.continuousScroll, maxColumnCount: previous.maxColumnCount, portraitScroll: previous.portraitScroll, progressDisplay: previous.progressDisplay, ...reader }, dim: 0 }
}

test('viewport CFIs collapse to their logical start, not a union rectangle across columns', () => {
  const range = 'epubcfi(/6/2!/4,/62[p29]/1:344,/74[p35]/1:344)'
  const point = 'epubcfi(/6/2!/4/62[p29]/1:344)'
  assert.equal(getTypographyAnchor(range), point)
  assert.equal(getTypographyAnchor(point), point)
  assert.equal(getTypographyAnchor('chapter.xhtml#p29'), 'chapter.xhtml#p29')
})

test('automatic profiles expose distinct, measured-safe defaults rather than global line-height shadowing', () => {
  const base = settingsDefaults().reader
  const a = resolveEffectiveTypography({ baseReaderPrefs: base, language: 'zh' })
  const b = resolveEffectiveTypography({ baseReaderPrefs: base, language: 'en' })
  const c = resolveEffectiveTypography({ baseReaderPrefs: base, language: 'zh', profile: 'mixed' })
  assert.equal(a.lineHeight, 1.7); assert.equal(a.textIndent, 2); assert.equal(a.paragraphSpacing, 0.15); assert.equal(a.maxLineLength, 0)
  assert.equal(b.lineHeight, 1.55); assert.equal(b.textIndent, 1.2); assert.equal(b.justify, false); assert.equal(b.maxLineLength, 0)
  assert.equal(c.lineHeight, 1.75); assert.equal(c.paragraphSpacing, 0.45); assert.equal(c.textIndent, 0)
  assert.equal(a.fontSize, base.fontSize); assert.equal(b.fontSize, base.fontSize)
  assert.equal(a.fontFamily, 'auto')
  assert.equal(normalizeLanguageTag('cmn_Hans_CN'), 'zh')
  const unknown = resolveEffectiveTypography({ baseReaderPrefs: base })
  assert.equal(unknown.profile, 'original'); assert.equal(unknown.displayMode, 'publisher')
})

test('open/resolve never creates book preferences or writes storage', () => {
  const f = fixture()
  for (let i = 0; i < 5; i++) { f.store.getEffectiveTypography('A', 'zh'); f.store.getEffectiveTypography('B', 'en') }
  assert.deepEqual(f.store.typographyBooks, {}); assert.equal(f.writes(), 0)
})

test('one-book edits are sparse, persisted, reloadable and do not leak theme/layout into another book', () => {
  const { store, data } = fixture()
  const before = JSON.stringify(store.reader)
  store.commitTypography(payload(store, 'A', 'zh', { fontSize: 29, textIndent: 3, paragraphSpacing: 0.25, maxLineLength: 38 }, { theme: 'green', flow: 'scrolled', maxColumnCount: 1, portraitScroll: false, progressDisplay: 'percent' }))
  assert.equal(JSON.stringify(store.reader), before)
  assert.equal(store.typographyBooks.A.fontSize, 29)
  assert.equal(Object.hasOwn(store.typographyBooks.A, 'justify'), false, 'untouched defaults are not frozen as user overrides')
  assert.equal(store.getEffectiveTypography('B', 'en').theme, store.reader.theme)
  assert.equal(store.getEffectiveTypography('B', 'en').lineHeight, 1.55)
  setActivePinia(createPinia()); const reopened = useSettings().getEffectiveTypography('A', 'zh')
  assert.equal(reopened.fontSize, 29); assert.equal(reopened.textIndent, 3); assert.equal(reopened.paragraphSpacing, 0.25)
  assert.equal(reopened.theme, 'green'); assert.equal(reopened.flow, 'scrolled'); assert.equal(reopened.portraitScroll, false)
  assert.equal(reopened.maxColumnCount, 1); assert.equal(reopened.progressDisplay, 'percent')
  assert.ok(data.has('lightread-settings'))
})

test('language defaults preserve other languages and existing book overrides; restore removes only this book', () => {
  const { store } = fixture()
  store.commitTypography(payload(store, 'B', 'en', { fontSize: 31 }))
  const set = payload(store, 'A', 'zh', { lineHeight: 1.8 }, { theme: 'sepia' }); set.scope = 'language'
  store.commitTypography(set)
  assert.equal(store.getEffectiveTypography('C', 'zh').lineHeight, 1.8)
  assert.equal(store.getEffectiveTypography('C', 'zh').theme, 'sepia')
  assert.equal(store.getEffectiveTypography('D', 'en').lineHeight, 1.55)
  assert.equal(store.getEffectiveTypography('B', 'en').fontSize, 31)
  store.commitTypography(payload(store, 'A', 'zh', { fontSize: 26 }))
  const restore = payload(store, 'A', 'zh'); restore.isRestoreAuto = true
  store.commitTypography(restore)
  assert.equal(Object.hasOwn(store.typographyBooks, 'A'), false)
  assert.equal(store.getEffectiveTypography('A', 'zh').lineHeight, 1.8)
  assert.equal(store.getEffectiveTypography('B', 'en').fontSize, 31)
})

test('quota failure is not acknowledged and changes neither maps nor global viewing preferences', () => {
  const f = fixture(), before = JSON.stringify(f.store.$state)
  f.deny()
  assert.throws(() => f.store.commitTypography(payload(f.store, 'A', 'zh', { fontSize: 30 }, { theme: 'dark' })), /quota denied/)
  assert.equal(JSON.stringify(f.store.$state), before)
})

test('ruler math, limits, per-device scale invalidation and book-size precedence are explicit', () => {
  const f = fixture()
  const calibration = measureTypographyCalibration(160, 32, 1.875)
  f.store.setTypographyCalibration(calibration)
  assert.equal(f.store.getEffectiveTypography('A', 'zh', { dpr: 1.875 }).fontSize, 22)
  assert.equal(f.store.getEffectiveTypography('B', 'en', { dpr: 1.875 }).fontSize, 21)
  f.store.commitTypography(payload(f.store, 'A', 'zh', { fontSize: 30 }))
  assert.equal(f.store.getEffectiveTypography('A', 'zh', { dpr: 1.875 }).fontSize, 30)
  assert.equal(f.store.getEffectiveTypography('B', 'en', { dpr: 2 }).fontSize, f.store.reader.fontSize)
  assert.equal(f.store.getEffectiveTypography('B', 'en', { dpr: 2 }).calibration, 'changed-dpr')
  for (const mm of [0, -5, NaN, Infinity, 1000, 5]) assert.throws(() => measureTypographyCalibration(160, mm, 1.875))
  assert.equal(normalizeTypographyCalibration({ cssPxPerMm: 4, dpr: 1, source: 'automatic-guess' }), null)
  f.store.setTypographyCalibration(null)
  assert.equal(f.store.getEffectiveTypography('B', 'en').fontSize, f.store.reader.fontSize)
})

test('metadata, distributed chapter evidence, conflicting declarations, and converted text do not use UI language', async () => {
  assert.equal((await resolveBookTypographyContext(book('zh-CN', [zh, zh, zh]))).profile, 'zh')
  const english = await resolveBookTypographyContext(book('en-US', [zh, en, en]))
  assert.equal(english.profile, 'en', 'a Chinese foreword is not an entire-book language switch')
  const wrong = await resolveBookTypographyContext(book('en-US', [zh, zh, zh]))
  assert.equal(wrong.profile, 'zh'); assert.equal(wrong.source, 'text'); assert.ok(wrong.warnings.length)
  const converted = await resolveBookTypographyContext(book('zh', [en], 'zh'), { generatedText: true })
  assert.equal(converted.language, 'en'); assert.equal(converted.profile, 'en')
  assert.equal((await resolveBookTypographyContext(book(undefined, ['1234 --- x']))) .profile, 'original')
  assert.equal(textLanguageEvidence('Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(30)).language, 'und')
})

test('PW-TYPO-01: balanced undeclared mixed content remains mixed without inventing a primary language', async () => {
  const make = () => ({ metadata: {}, sections: [0, 1, 2].map(() => ({ createDocument: () => doc(zh + en, '', [zh, en, zh, en]) })) })
  for (const generatedText of [false, true]) {
    const context = await resolveBookTypographyContext(make(), { generatedText })
    assert.equal(context.language, 'und'); assert.equal(context.profile, 'mixed'); assert.equal(context.source, 'text')
    const result = resolveEffectiveTypography({ baseReaderPrefs: settingsDefaults().reader, language: context.language, profile: context.profile, languagesMap: { zh: { fontSize: 50 } } })
    assert.equal(result.fontSize, 18); assert.equal(result.lineHeight, 1.75)
  }
})

test('PW-TYPO-02: trial and commit share sparse field provenance, including language scope', () => {
  const { store } = fixture()
  const previous = store.getEffectiveTypography('A', 'zh', { profile: 'mixed' })
  const change = payload(store, 'A', 'zh', { fontSize: 28 })
  change.previousSettings = previous; change.settings = { ...previous, profile: 'auto', fontSize: 28 }
  const candidate = prepareTypographyCommit(store, change)
  assert.deepEqual(Object.keys(candidate.typographyBooks.A), ['fontSize'])
  store.commitTypography(change); assert.deepEqual(store.typographyBooks, candidate.typographyBooks)
  const language = payload(store, 'A', 'zh'); language.scope = 'language'
  store.commitTypography(language)
  assert.equal(store.typographyLanguages.zh.fontSize, 28)
  assert.equal(Object.hasOwn(store.typographyLanguages.zh, 'lineHeight'), false)
  assert.equal(Object.hasOwn(store.typographyLanguages.zh, 'justify'), false)
  assert.equal(Object.hasOwn(store.typographyBooks, 'A'), false)
})

test('PW-TYPO-03: delayed sampling and late opening release their owned book exactly once', async () => {
  const owner = createTypographyBookOwner(); let alive = true, destroyed = 0, finish
  const delayed = new Promise(resolve => { finish = resolve })
  const pendingBook = { metadata: { language: 'zh' }, sections: [{ createDocument: async () => { await delayed; return doc(zh) } }], destroy() { destroyed++ } }
  assert.equal(owner.adopt(pendingBook), true)
  const preparation = resolveBookTypographyContext(pendingBook, { current: () => alive })
  alive = false; owner.dispose(); finish()
  await assert.rejects(preparation, /superseded/)
  owner.release(); owner.dispose(); assert.equal(destroyed, 1)
  let lateDestroyed = 0
  assert.equal(owner.adopt({ destroy() { lateDestroyed++ } }), false); assert.equal(lateDestroyed, 1)
})

test('mixed prose is distinguished from incidental acronyms and unsupported publication layouts are untouched', async () => {
  const mixedDoc = () => doc(zh + en, 'zh', [zh, en, zh, en])
  const mixed = await resolveBookTypographyContext({ metadata: { language: 'zh' }, sections: [0, 1, 2].map(() => ({ createDocument: mixedDoc })) })
  assert.equal(mixed.profile, 'mixed')
  assert.equal((await resolveBookTypographyContext(book('zh', [zh + ' AI API GPU CPU ', zh, zh]))).profile, 'zh')
  let sampled = false
  const fixed = await resolveBookTypographyContext({ rendition: { layout: 'pre-paginated' }, sections: [{ createDocument() { sampled = true; throw new Error('must not sample fixed layout') } }] })
  assert.equal(fixed.protectedLayout, 'fixed'); assert.equal(sampled, false)
  assert.ok(!automaticFontFamily('zh', 'zh').includes('SC'), 'Han text alone cannot force a mainland font variant')
  assert.ok(automaticFontFamily('zh', 'zh-Hant-TW').includes('TC'))
  const inherited = resolveEffectiveTypography({ baseReaderPrefs: settingsDefaults().reader, language: 'zh', protectedLayout: true, booksMap: { A: { fontSize: 40, displayMode: 'repair' } }, bookId: 'A' })
  assert.equal(inherited.displayMode, 'publisher')
})
