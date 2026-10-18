import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOOK_CATEGORIES, createClassification, parseClassification, normalizeTagName, classificationTags, classificationComplete, classificationFingerprint, getTaggingMetadata, mergeClassificationTag } from '../src/services/bookClassification.ts'
const tag = (value, locked = false, source = 'manual') => ({ value, locked, source })
const complete = () => ({ ...createClassification([' 原标签 ']), category: tag('science-mathematics'), topics: [tag('天文学'), tag('观测方法')] })

test('exact category vocabulary, stable order and immutable values', () => {
  assert.deepEqual(BOOK_CATEGORIES.map(v => v.id), ['literature-language', 'history-archaeology', 'biography-memoir', 'philosophy-religion', 'society-politics-law', 'economics-finance', 'business-management', 'psychology-cognition', 'education-learning', 'computing-ai', 'science-mathematics', 'engineering-industry', 'medicine-health', 'arts-design', 'life-leisure', 'general-reference'])
  assert.equal(BOOK_CATEGORIES.map(v => v.label).join('、'), '文学与语言、历史与考古、传记与回忆、哲学与宗教、社会政治与法律、经济与金融、商业与管理、心理与认知、教育与学习、计算机与AI、自然科学与数学、工程与产业技术、医学与健康、艺术与设计、生活与休闲、综合参考')
  assert.throws(() => { BOOK_CATEGORIES[0].id = 'bad' })
})
test('partial is legal; feature absent is complete; legacy/facets never canonical chips', () => {
  const c = complete()
  c.facets = { audience: '儿童', textbook: false, ancientText: false }
  assert.equal(classificationComplete(c), true)
  assert.equal(classificationComplete(undefined), false)
  assert.equal(classificationComplete(createClassification()), false)
  assert.deepEqual(classificationTags(c), ['自然科学与数学', '天文学', '观测方法'])
  const clone = parseClassification(c, true)
  clone.topics[0].locked = true
  assert.equal(c.topics[0].locked, false)
  assert.deepEqual(clone.legacyTags, [' 原标签 '])
  assert.throws(() => parseClassification(createClassification(), true), /Incomplete/)
})
test('strict schema rejects malformed fields, unknown category, counts, provenance and facets', () => {
  const c = complete()
  for (const patch of [{ version: 2 }, { revision: -1 }, { revision: 1.2 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { extra: 1 }, { category: tag('unknown') }, { category: undefined }, { topics: [tag('a'), tag('b'), tag('c'), tag('d')] }, { topics: [tag('a', 'yes')] }, { topics: [tag('a', false, 'unknown')] }, { facets: { textbook: 'false' } }, { facets: { audience: '' } }, { facets: { extra: true } }, { legacyTags: [2] }]) assert.throws(() => parseClassification({ ...c, ...patch }))
  assert.throws(() => classificationComplete({ ...c, topics: null }))
  assert.throws(() => parseClassification({ ...c, topics: [tag('a', false, { toString: () => 'manual' })] }))
})
test('normalization aliases, duplicates, topic hierarchy and invalid semantic roles', () => {
  assert.equal(normalizeTagName('  ＡＩ  '), '人工智能')
  assert.equal(normalizeTagName('Mixed  CASE'), 'Mixed CASE')
  for (const topics of [[tag('AI'), tag('人工智能')], [tag('人工智能'), tag('深度学习')], [tag('语言/汉语'), tag('语言')], [tag('PDF')], [tag('畅销书')], [tag('已读')]]) assert.throws(() => parseClassification({ ...complete(), topics }))
  assert.doesNotThrow(() => parseClassification({ ...complete(), category: tag('medicine-health'), topics: [tag('医学'), tag('公共卫生')] }))
})
test('canonical topics and feature cannot repeat the selected main category name or ID', () => {
  const c = { ...complete(), category: tag('computing-ai'), topics: [tag('编程语言'), tag('算法设计')] }
  for (const value of ['计算机与AI', 'computing-ai']) {
    assert.throws(() => parseClassification({ ...c, topics: [tag(value), tag('编程语言')] }), /Duplicate category/)
    assert.throws(() => parseClassification({ ...c, feature: tag(value) }), /Duplicate category/)
  }
  assert.doesNotThrow(() => parseClassification({ ...complete(), category: tag('science-mathematics') }, true))
})
test('role-scoped merges preserve source/locks with OR and never increment revisions', () => {
  const c = { ...complete(), revision: 7, topics: [tag('观星', true, 'ai'), tag('观测方法')], feature: tag('图解'), legacyTags: ['观星', 'old'] }
  const before = JSON.stringify(c)
  const merged = mergeClassificationTag(c, 'topic', '观星', '观测方法')
  assert.deepEqual(merged.topics, [tag('观测方法', true)])
  assert.equal(merged.revision, 7)
  assert.equal(classificationComplete(merged), false)
  assert.deepEqual(merged.legacyTags, c.legacyTags)
  assert.deepEqual(mergeClassificationTag(merged, 'topic', '观星', '观测方法'), merged)
  assert.deepEqual(mergeClassificationTag(c, 'legacy', '观星', 'old').legacyTags, ['old'])
  assert.equal(mergeClassificationTag(c, 'feature', '图解', '案例解析').feature.value, '案例解析')
  assert.equal(JSON.stringify(c), before)
  assert.throws(() => mergeClassificationTag(c, 'category', 'a', 'b'))
})
test('metadata allowlist and deterministic revision snapshots do not expose body/notes', () => {
  const book = { title: 'T', author: 'A', description: 'D', publisher: 'P', publicationDate: '2000', body: 'SECRET BODY', notes: ['SECRET NOTE'], classification: complete() }
  assert.deepEqual(Object.keys(getTaggingMetadata(book)), ['title', 'author', 'publisher', 'publicationDate', 'description'])
  const first = classificationFingerprint(book)
  assert.equal(first, classificationFingerprint({ ...book, body: 'CHANGED' }))
  assert.ok(!first.includes('SECRET'))
  assert.notEqual(first, classificationFingerprint({ ...book, title: 'different' }))
  assert.notEqual(first, classificationFingerprint({ ...book, classification: { ...book.classification, revision: 1 } }))
})
