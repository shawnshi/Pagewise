/**
 * 开放图书元数据检索服务
 * 第一级：并发查询 OpenLibrary Search API、Google Books API、豆瓣读书 API
 * 支持 AbortSignal 超时与取消控制，优雅降级
 */
import type { BookMetadataFields } from '../storage/types.ts'

async function callFetchRemote(url: string, auth: any, init: any): Promise<Response> {
  const mod = await import('./net')
  return mod.fetchRemote(url, auth, init)
}

export interface BookMetadataCandidate {
  source: 'openlibrary' | 'googlebooks' | 'douban'
  sourceLabel: string
  title?: string
  author?: string
  publisher?: string
  publicationDate?: string
  language?: string
  score?: number
}

export interface OpenBookSearchParams {
  title: string
  author?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface OpenBookSearchResult {
  candidates: BookMetadataCandidate[]
  bestMatch?: BookMetadataFields
  errors: Array<{ source: string; message: string }>
}

/** 规范化语种代号 */
export function normalizeLanguageCode(code?: string): string | undefined {
  if (!code || typeof code !== 'string') return undefined
  const cleaned = code.trim().toLowerCase()
  if (!cleaned) return undefined

  const mapping: Record<string, string> = {
    chi: 'zh',
    zho: 'zh',
    zh: 'zh',
    'zh-cn': 'zh',
    'zh-tw': 'zh',
    'zh-hk': 'zh',
    chinese: 'zh',
    eng: 'en',
    en: 'en',
    'en-us': 'en',
    'en-gb': 'en',
    english: 'en',
    jpn: 'ja',
    ja: 'ja',
    japanese: 'ja',
    fre: 'fr',
    fra: 'fr',
    fr: 'fr',
    french: 'fr',
    ger: 'de',
    deu: 'de',
    de: 'de',
    german: 'de',
    spa: 'es',
    es: 'es',
    spanish: 'es',
    rus: 'ru',
    ru: 'ru',
    russian: 'ru',
    ita: 'it',
    it: 'it',
    kor: 'ko',
    ko: 'ko',
  }

  return mapping[cleaned] || cleaned.slice(0, 10)
}

/** 规范化日期字符串为 YYYY 或 YYYY-MM 或 YYYY-MM-DD */
export function normalizePublicationDate(raw?: string | number): string | undefined {
  if (raw == null) return undefined
  const str = String(raw).trim()
  if (!str) return undefined

  // 纯 4 位年份，如 "2018"
  if (/^\d{4}$/.test(str)) return str

  // ISO 日期开头，如 "2018-05" 或 "2018-05-12"
  const isoMatch = str.match(/^(\d{4}(?:-\d{2}){1,2})/)
  if (isoMatch) return isoMatch[1]

  // 斜杠或点号分隔，如 "2018/5/1" 或 "2018.05"
  const altMatch = str.match(/^(\d{4})[./](\d{1,2})(?:[./](\d{1,2}))?/)
  if (altMatch) {
    const year = altMatch[1]
    const month = altMatch[2].padStart(2, '0')
    const day = altMatch[3] ? altMatch[3].padStart(2, '0') : undefined
    return day ? `${year}-${month}-${day}` : `${year}-${month}`
  }

  // 包含四位年份的散文/英文格式，例如 "May 12, 2018"
  const yearMatch = str.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/)
  if (yearMatch) return yearMatch[1]

  return str.slice(0, 64)
}

/** 清理书名，去除扩展名和括号副标题以提高检索命中率 */
export function sanitizeSearchTitle(title: string): string {
  return title
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '') // 去除扩展名 .epub, .pdf 等
    .replace(/[\[\(（【].*?[\]\)）】]/g, ' ') // 移除括号内容如 (精装) [译本]
    .replace(/[_\-+]+/g, ' ') // 转换分隔符为空格
    .trim()
}

/** OpenLibrary 检索 */
export async function searchOpenLibrary(
  title: string,
  author?: string,
  signal?: AbortSignal,
): Promise<BookMetadataCandidate[]> {
  const cleanTitle = sanitizeSearchTitle(title)
  if (!cleanTitle) return []

  const params = new URLSearchParams()
  params.set('title', cleanTitle)
  if (author?.trim()) {
    params.set('author', author.trim())
  }
  params.set('limit', '5')

  const url = `https://openlibrary.org/search.json?${params.toString()}`
  const res = await callFetchRemote(url, undefined, { signal, raw: true })
  if (!res.ok) {
    throw new Error(`OpenLibrary HTTP ${res.status}`)
  }

  const data = await res.json()
  const docs = Array.isArray(data?.docs) ? data.docs : []
  const candidates: BookMetadataCandidate[] = []

  for (const doc of docs) {
    const docAuthor = Array.isArray(doc.author_name) ? doc.author_name.slice(0, 3).join(', ') : undefined
    const docPublisher = Array.isArray(doc.publisher) ? doc.publisher[0] : undefined
    const docDate = doc.first_publish_year
      ? String(doc.first_publish_year)
      : (Array.isArray(doc.publish_date) ? doc.publish_date[0] : undefined)
    const docLang = Array.isArray(doc.language) ? doc.language[0] : undefined

    candidates.push({
      source: 'openlibrary',
      sourceLabel: 'OpenLibrary',
      title: doc.title,
      author: docAuthor,
      publisher: docPublisher,
      publicationDate: normalizePublicationDate(docDate),
      language: normalizeLanguageCode(docLang),
    })
  }

  return candidates
}

/** Google Books API 检索 */
export async function searchGoogleBooks(
  title: string,
  author?: string,
  signal?: AbortSignal,
): Promise<BookMetadataCandidate[]> {
  const cleanTitle = sanitizeSearchTitle(title)
  if (!cleanTitle) return []

  let q = `intitle:${cleanTitle}`
  if (author?.trim()) {
    q += `+inauthor:${author.trim()}`
  }

  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`
  const res = await callFetchRemote(url, undefined, { signal, raw: true })
  if (!res.ok) {
    throw new Error(`GoogleBooks HTTP ${res.status}`)
  }

  const data = await res.json()
  const items = Array.isArray(data?.items) ? data.items : []
  const candidates: BookMetadataCandidate[] = []

  for (const item of items) {
    const info = item.volumeInfo || {}
    const authors = Array.isArray(info.authors) ? info.authors.join(', ') : undefined
    const publisher = typeof info.publisher === 'string' ? info.publisher : undefined
    const pubDate = normalizePublicationDate(info.publishedDate)
    const lang = normalizeLanguageCode(info.language)

    candidates.push({
      source: 'googlebooks',
      sourceLabel: 'Google Books',
      title: info.title,
      author: authors,
      publisher,
      publicationDate: pubDate,
      language: lang,
    })
  }

  return candidates
}

/** 豆瓣读书 API 检索 (利用公共 subject_suggest 及开放元数据) */
export async function searchDoubanBooks(
  title: string,
  _author?: string,
  signal?: AbortSignal,
): Promise<BookMetadataCandidate[]> {
  const cleanTitle = sanitizeSearchTitle(title)
  if (!cleanTitle) return []

  const url = `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(cleanTitle)}`
  const res = await callFetchRemote(url, undefined, {
    signal,
    raw: true,
    headers: {
      accept: 'application/json',
      referer: 'https://book.douban.com/',
    },
  })
  if (!res.ok) {
    throw new Error(`Douban HTTP ${res.status}`)
  }

  const data = await res.json()
  if (!Array.isArray(data)) return []

  const candidates: BookMetadataCandidate[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const itemTitle = typeof item.title === 'string' ? item.title : undefined
    const itemAuthor = typeof item.author_name === 'string' ? item.author_name : undefined
    const itemYear = item.year != null ? normalizePublicationDate(item.year) : undefined

    candidates.push({
      source: 'douban',
      sourceLabel: '豆瓣读书',
      title: itemTitle,
      author: itemAuthor,
      publicationDate: itemYear,
      language: 'zh', // 豆瓣主要为中文著录
    })
  }

  return candidates
}

/** 评分函数：候选条目越完整、匹配越贴近，得分越高 */
function evaluateCandidateScore(candidate: BookMetadataCandidate, targetTitle: string): number {
  let score = 0
  if (candidate.author) score += 30
  if (candidate.publisher) score += 25
  if (candidate.publicationDate) score += 20
  if (candidate.language) score += 10

  const cTitle = (candidate.title || '').trim().toLowerCase()
  const tTitle = targetTitle.trim().toLowerCase()
  if (cTitle === tTitle) {
    score += 15
  } else if (cTitle.includes(tTitle) || tTitle.includes(cTitle)) {
    score += 8
  }

  return score
}

/**
 * 并发查询 OpenLibrary, Google Books, 豆瓣读书
 * 提供统一 AbortSignal 及可配置超时控制
 */
export async function searchOpenBookMetadata(
  params: OpenBookSearchParams,
): Promise<OpenBookSearchResult> {
  const { title, author, signal: externalSignal, timeoutMs = 9000 } = params

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(new Error('search_timeout')), timeoutMs)

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason)
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  const signal = controller.signal

  try {
    const tasks = [
      searchOpenLibrary(title, author, signal).catch(err => {
        return { error: 'openlibrary', message: err?.message || 'OpenLibrary search failed' }
      }),
      searchGoogleBooks(title, author, signal).catch(err => {
        return { error: 'googlebooks', message: err?.message || 'Google Books search failed' }
      }),
      searchDoubanBooks(title, author, signal).catch(err => {
        return { error: 'douban', message: err?.message || 'Douban search failed' }
      }),
    ]

    const results = await Promise.allSettled(tasks)
    const candidates: BookMetadataCandidate[] = []
    const errors: Array<{ source: string; message: string }> = []

    for (const res of results) {
      if (res.status === 'fulfilled') {
        const val = res.value
        if (Array.isArray(val)) {
          candidates.push(...val)
        } else if (val && typeof val === 'object' && 'error' in val) {
          errors.push({ source: String(val.error), message: String(val.message) })
        }
      } else {
        errors.push({ source: 'unknown', message: res.reason?.message || 'Request failed' })
      }
    }

    // 过滤完全为空的候选，并计算评分
    const scoredCandidates = candidates
      .filter(c => c.author || c.publisher || c.publicationDate || c.language)
      .map(c => ({
        ...c,
        score: evaluateCandidateScore(c, title),
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    let bestMatch: BookMetadataFields | undefined
    if (scoredCandidates.length > 0) {
      // 聚合最佳匹配：取第一候选，若第一候选缺字段，可从其他高分候选中补充空白
      const top = scoredCandidates[0]
      bestMatch = {
        author: top.author,
        publisher: top.publisher,
        publicationDate: top.publicationDate,
        language: top.language,
      }
      for (let i = 1; i < scoredCandidates.length; i++) {
        const c = scoredCandidates[i]
        if (!bestMatch.author && c.author) bestMatch.author = c.author
        if (!bestMatch.publisher && c.publisher) bestMatch.publisher = c.publisher
        if (!bestMatch.publicationDate && c.publicationDate) bestMatch.publicationDate = c.publicationDate
        if (!bestMatch.language && c.language) bestMatch.language = c.language
      }
    }

    return {
      candidates: scoredCandidates,
      bestMatch,
      errors,
    }
  } finally {
    clearTimeout(timeoutId)
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}
