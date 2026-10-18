import type { BookMeta } from '../storage/types.ts'

export type BookTagRole = 'category' | 'topic' | 'feature' | 'legacy'
export type BookTagSource = 'manual' | 'ai'
export type BookClassTag = { value: string; locked: boolean; source: BookTagSource }
export type BookFacets = { audience?: string; textbook?: boolean; ancientText?: boolean; workCountry?: string; workPeriod?: string }
export type BookClassification = {
  version: 1; revision: number; category: BookClassTag | null; topics: BookClassTag[]
  feature: BookClassTag | null; facets: BookFacets; legacyTags: string[]
}
export type BookTaggingMetadata = Pick<BookMeta, 'title' | 'author' | 'publisher' | 'publicationDate' | 'description'>

export const BOOK_CATEGORIES: readonly Readonly<{ id: string; label: string }>[] = Object.freeze(([
  ['literature-language', '文学与语言'], ['history-archaeology', '历史与考古'],
  ['biography-memoir', '传记与回忆'], ['philosophy-religion', '哲学与宗教'],
  ['society-politics-law', '社会政治与法律'], ['economics-finance', '经济与金融'],
  ['business-management', '商业与管理'], ['psychology-cognition', '心理与认知'],
  ['education-learning', '教育与学习'], ['computing-ai', '计算机与AI'],
  ['science-mathematics', '自然科学与数学'], ['engineering-industry', '工程与产业技术'],
  ['medicine-health', '医学与健康'], ['arts-design', '艺术与设计'],
  ['life-leisure', '生活与休闲'], ['general-reference', '综合参考'],
] as const).map(([id, label]) => Object.freeze({ id, label })))

const aliases: Record<string, string> = {
  AI: '人工智能', ai: '人工智能', 'Artificial Intelligence': '人工智能',
  科幻小说: '科幻', 科学幻想: '科幻', 心理学: '心理', 天文: '天文学',
  数学教材: '数学', 中医学: '中医', 'Machine Learning': '机器学习',
}
export function normalizeTagName(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Tag must be text')
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return Object.hasOwn(aliases, normalized) ? aliases[normalized] ?? normalized : normalized
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Expected object')
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new TypeError('Unknown classification field')
  return raw as Record<string, unknown>
}
function text(raw: unknown, limit = 80): string {
  if (typeof raw !== 'string') throw new TypeError('Expected text')
  const value = normalizeTagName(raw)
  if (!value || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid text length or control character')
  return value
}
const excluded = /^(?:中文|英文|英语|汉语|简体|繁体|电子书|纸质书|EPUB|PDF|TXT|MOBI|精装|平装|未读|在读|已读|读完|暂停|畅销|畅销书|经典|必读|推荐|豆瓣高分|作者|教材|教科书|儿童|古籍)$/iu
const topicPaths: readonly (readonly string[])[] = [
  ['人工智能', '机器学习', '深度学习'], ['天文学', '宇宙学'], ['中医', '中医基础理论'],
]
function redundant(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || topicPaths.some(path => path.includes(a) && path.includes(b))
}
function tag(raw: unknown, category = false): BookClassTag {
  const obj = record(raw, ['value', 'locked', 'source'])
  const value = text(obj.value)
  if (typeof obj.locked !== 'boolean' || (obj.source !== 'manual' && obj.source !== 'ai')) throw new TypeError('Invalid tag provenance')
  if (category ? !BOOK_CATEGORIES.some(item => item.id === value) : excluded.test(value)) throw new TypeError('Invalid tag value')
  return { value, locked: obj.locked, source: obj.source }
}
export function createClassification(legacyTags: readonly string[] = []): BookClassification {
  return parseClassification({ version: 1, revision: 0, category: null, topics: [], feature: null, facets: {}, legacyTags: [...legacyTags] })
}
export function parseClassification(raw: unknown, requireComplete = false): BookClassification {
  const obj = record(raw, ['version', 'revision', 'category', 'topics', 'feature', 'facets', 'legacyTags'])
  if (obj.version !== 1 || !Number.isSafeInteger(obj.revision) || (obj.revision as number) < 0) throw new TypeError('Invalid classification version/revision')
  if (!Array.isArray(obj.topics) || obj.topics.length > 3 || !Array.isArray(obj.legacyTags)) throw new TypeError('Invalid tag arrays')
  const topics = obj.topics.map(value => tag(value))
  if (topics.some((item, i) => topics.slice(0, i).some(other => redundant(item.value, other.value)))) throw new TypeError('Duplicate or same-path topics')
  const facetsRaw = record(obj.facets, ['audience', 'textbook', 'ancientText', 'workCountry', 'workPeriod'])
  const facets: BookFacets = {}
  for (const key of ['audience', 'workCountry', 'workPeriod'] as const) {
    if (Object.hasOwn(facetsRaw, key)) {
      const value = text(facetsRaw[key], 80)
      if (/^(?:未知|不详|不明|unknown|n\/a)$/iu.test(value)) throw new TypeError('Unknown facets must be omitted')
      facets[key] = value
    }
  }
  for (const key of ['textbook', 'ancientText'] as const) {
    if (Object.hasOwn(facetsRaw, key)) {
      if (typeof facetsRaw[key] !== 'boolean') throw new TypeError('Invalid boolean facet')
      facets[key] = facetsRaw[key]
    }
  }
  const legacyTags = obj.legacyTags.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid legacy tag')
    return value
  })
  const result: BookClassification = {
    version: 1, revision: obj.revision as number, category: obj.category === null ? null : tag(obj.category, true),
    topics, feature: obj.feature === null ? null : tag(obj.feature), facets, legacyTags,
  }
  const featureValue = result.feature?.value
  if (featureValue && topics.some(item => item.value === featureValue)) throw new TypeError('Feature duplicates topic')
  if (result.category) {
    const category = BOOK_CATEGORIES.find(item => item.id === result.category!.value)!
    const categoryNames = [category.id, category.label].map(value => normalizeTagName(value).toLowerCase())
    if ([...topics, ...(result.feature ? [result.feature] : [])].some(item => categoryNames.includes(item.value.toLowerCase()))) throw new TypeError('Duplicate category')
  }
  if (requireComplete && (!result.category || topics.length < 2)) throw new TypeError('Incomplete classification')
  return result
}
export function classificationTags(c: BookClassification): string[] {
  const parsed = parseClassification(c)
  const categoryId = parsed.category?.value
  const category = BOOK_CATEGORIES.find(item => item.id === categoryId)
  return [
    ...(category ? [category.label] : []),
    ...parsed.topics.map(item => item.value), ...(parsed.feature ? [parsed.feature.value] : []),
  ]
}
export function classificationComplete(c: BookClassification | undefined): boolean {
  if (c === undefined) return false
  const parsed = parseClassification(c)
  return parsed.category !== null && parsed.topics.length >= 2
}
export function getTaggingMetadata(book: BookTaggingMetadata): BookTaggingMetadata {
  if (typeof book.title !== 'string' || typeof book.author !== 'string') throw new TypeError('Invalid metadata')
  const result: BookTaggingMetadata = { title: book.title, author: book.author }
  for (const key of ['publisher', 'publicationDate', 'description'] as const) {
    if (book[key] !== undefined) {
      if (typeof book[key] !== 'string') throw new TypeError('Invalid metadata')
      result[key] = book[key]
    }
  }
  return result
}
export function classificationFingerprint(book: BookTaggingMetadata & { classification?: BookClassification }): string {
  return JSON.stringify([getTaggingMetadata(book), book.classification ? parseClassification(book.classification).revision : 0])
}
export function mergeClassificationTag(c: BookClassification, role: 'topic' | 'feature' | 'legacy', from: string, to: string): BookClassification {
  const result = parseClassification(c)
  const source = normalizeTagName(from), target = text(to)
  if (role === 'legacy') {
    result.legacyTags = [...new Set(result.legacyTags.map(value => normalizeTagName(value) === source ? target : value))]
  } else if (role === 'feature') {
    if (result.feature?.value === source) result.feature.value = target
  } else if (role === 'topic') {
    const merged: BookClassTag[] = []
    for (const item of result.topics) {
      const next = { ...item, value: item.value === source ? target : item.value }
      const existing = merged.find(value => value.value === next.value)
      if (existing) {
        existing.locked ||= next.locked
        if (next.source === 'manual') existing.source = 'manual'
      } else merged.push(next)
    }
    result.topics = merged
  } else throw new TypeError('Invalid merge role')
  return parseClassification(result)
}
