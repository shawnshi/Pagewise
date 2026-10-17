/**
 * 书单: 待找条目与藏书的匹配 / 自动关联、分享格式 (JSON 与纯文本)、推荐书单的校验.
 * 纯函数, 只允许 `import type`, 以便在 node --experimental-strip-types 下直接测试. 设计见 docs/booklists.md.
 */
import type { BooklistWantedRec } from '../storage/types'

/** 书单里的一本书的书目信息 (待找条目、分享、推荐书单共用) */
export interface BooklistEntry {
  title: string
  author: string
  isbn?: string
  /** 首次出版年, 负数为公元前 */
  year?: number
  note?: string
  /** 外文原名 / 原作者, 参与匹配与「搜原名」 */
  originalTitle?: string
  originalAuthor?: string
}

/** 参与匹配的藏书 (BookMeta 的子集) */
export interface MatchableBook {
  id: string
  title: string
  author: string
  kind?: 'book' | 'paper'
}

// ---- 规范化 ----

const EXT_RE = /\.(epub|pdf|mobi|azw3?|txt|fb2|fbz|djvu|cbz|cbr|md|html?)$/i
/** 末尾括注: 「红楼梦（程乙本）」「Walden (Illustrated)」 */
const TRAILING_BRACKET = /\s*[(\[（【〔［][^()\[\]（）【】〔〕［］]*[)\]）】〕］]\s*$/
/** 副标题分隔: 冒号、分号、破折号、斜杠、左括号; 英文的 ", or" */
const SUBTITLE_SEP = /\s*(?:[:;：；/／(（]|——|—|–|\s-\s|,\s*or\b)/i
const LEADING_ARTICLE = /^(?:the|a|an)\s+/i

/** 去变音符的小写形式 (Brontë = Bronte), 只保留字母与数字 */
function compact(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function cleanTitle(raw: string, dropArticle = true): string {
  let s = String(raw ?? '').normalize('NFKC').trim().replace(EXT_RE, '')
  s = s.replace(/^[《「『〈"“'‘]+/, '').replace(/[》」』〉"”'’]+$/, '')
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TRAILING_BRACKET, '').trim()
    if (next === s || !next) break
    s = next
  }
  return dropArticle ? s.replace(LEADING_ARTICLE, '') : s
}

/** 书名的比较键: 去书名号、末尾括注、扩展名、英文冠词与所有标点空白 */
export function titleKey(title: string): string {
  return compact(cleanTitle(title))
}

/** 主书名的比较键 (去副标题): 「Walden; or, Life in the Woods」→ walden */
export function mainTitleKey(title: string): string {
  const cleaned = cleanTitle(title)
  const cut = cleaned.split(SUBTITLE_SEP)[0] ?? cleaned
  return compact(cut.replace(LEADING_ARTICLE, '')) || compact(cleaned)
}

const AUTHOR_STOP = new Set(['von', 'van', 'der', 'den', 'de', 'la', 'le', 'du', 'des', 'the', 'and', 'jr', 'sr', 'sir', 'graf', 'count'])
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 作者的词元: 去掉朝代/国别括注 ([清] 曹雪芹)、著/编/译等后缀与生卒年; 「Austen, Jane」与「Jane Austen」得到同一组词元 */
export function authorTokens(author: string): string[] {
  let s = String(author ?? '').normalize('NFKC').toLowerCase()
  s = s.replace(/[\[［【(（〔][^\]］】)）〕]*[\]］】)）〕]/g, ' ')
  s = s.replace(/(?:编著|主编|校注|编译|译注|著|编|译|撰|辑|注|等)(?=$|[\s,，、;；/])/g, ' ')
  s = s.replace(/\b\d{1,4}\s*\??\s*[-–]\s*\d{0,4}\??/g, ' ').replace(/\b\d{3,4}\b/g, ' ')
  const tokens = s.split(/[\s,，、;；&·•・.\-/]+|\band\b|和|与/u)
    .map(token => compact(token))
    .filter(token => token && !AUTHOR_STOP.has(token))
  return [...new Set(tokens)]
}

/** 作者相容: 中文名互相包含 (卡尔·马克思 ⊇ 马克思); 拉丁字母名有一个长度 ≥ 3 的词元相同 */
export function authorsCompatible(a: string, b: string): boolean {
  const ta = authorTokens(a)
  const tb = authorTokens(b)
  if (!ta.length || !tb.length) return false
  const ca = ta.join('')
  const cb = tb.join('')
  if (ca === cb) return true
  for (const token of ta) {
    if (CJK.test(token) ? token.length >= 2 && cb.includes(token) : token.length >= 3 && tb.includes(token)) return true
  }
  for (const token of tb) {
    if (CJK.test(token) && token.length >= 2 && ca.includes(token)) return true
  }
  return false
}

/** 书名相同: 完整键相同、主书名相同, 或较长的以较短的开头且较短的足够长 (避免「诗」匹配「诗经」) */
export function titlesMatch(a: string, b: string): boolean {
  const ka = titleKey(a)
  const kb = titleKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  if (mainTitleKey(a) === mainTitleKey(b)) return true
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
  return short.length >= 8 && long.startsWith(short)
}

/** 缺作者时只接受完全相同且足够长的书名 */
function longEnoughAlone(title: string): boolean {
  const key = titleKey(title)
  return CJK.test(key) ? key.length >= 2 : key.length >= 4
}

function pairMatches(title: string, author: string, book: MatchableBook): boolean {
  if (!title.trim()) return false
  const hasA = authorTokens(author).length > 0
  const hasB = authorTokens(book.author).length > 0
  if (hasA && hasB) return titlesMatch(title, book.title) && authorsCompatible(author, book.author)
  return titleKey(title) === titleKey(book.title) && longEnoughAlone(title)
}

/** 条目与藏书里的一本书是否是同一本 (中文书名/作者或外文原名任一组对上即可) */
export function entryMatchesBook(entry: BooklistEntry, book: MatchableBook): boolean {
  if (pairMatches(entry.title, entry.author, book)) return true
  if (entry.originalTitle) {
    return pairMatches(entry.originalTitle, entry.originalAuthor ?? entry.author, book)
  }
  return false
}

/** 藏书里第一本匹配的书 (只看「藏书」类, 不含论文); 多本时取加入最早的 (调用方按需排序) */
export function findMatchingBook<T extends MatchableBook>(entry: BooklistEntry, books: readonly T[]): T | undefined {
  return books.find(book => (book.kind ?? 'book') === 'book' && entryMatchesBook(entry, book))
}

// ---- ISBN 与去重 ----

/** 规范化 ISBN: 去掉连字符空格, 校验位不对或长度不对返回 undefined; ISBN-10 转成 ISBN-13 */
export function normalizeIsbn(raw: unknown): string | undefined {
  if (raw == null) return undefined
  const s = String(raw).toUpperCase().replace(/[^0-9X]/g, '')
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    let sum = 0
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i)
    if (sum % 11 !== 0) return undefined
    const body = '978' + s.slice(0, 9)
    return body + isbn13Check(body)
  }
  if (s.length === 13 && /^\d{13}$/.test(s)) {
    return isbn13Check(s.slice(0, 12)) === s[12] ? s : undefined
  }
  return undefined
}

function isbn13Check(body12: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 ? 3 : 1)
  return String((10 - (sum % 10)) % 10)
}

/** 条目去重键: 有 ISBN 用 ISBN, 否则书名 + 作者 */
export function entryKey(entry: BooklistEntry): string {
  const isbn = normalizeIsbn(entry.isbn)
  if (isbn) return `isbn:${isbn}`
  return `t:${titleKey(entry.title)}|${authorTokens(entry.author).sort().join(' ')}`
}

/** 两个条目是否重复: ISBN 相同, 或书名相同且作者相容 (任一方缺作者时书名完全相同) */
export function sameEntry(a: BooklistEntry, b: BooklistEntry): boolean {
  const ia = normalizeIsbn(a.isbn)
  const ib = normalizeIsbn(b.isbn)
  if (ia && ib) return ia === ib
  return pairMatches(a.title, a.author, { id: '', title: b.title, author: b.author })
}

// ---- 自动关联 ----

export interface AutoLink {
  wantedId: string
  booklistId: string
  bookId: string
}

/**
 * 待找条目匹配到藏书时, 把书加入该书单并删除待找条目. books 按加入时间排序后取最早的一本 (稳定).
 * 书已在书单里时也删除待找条目 (重复).
 */
export function planAutoLink(wanted: readonly BooklistWantedRec[], books: readonly (MatchableBook & { addedAt?: number })[]): AutoLink[] {
  if (!wanted.length || !books.length) return []
  const sorted = [...books]
    .filter(book => (book.kind ?? 'book') === 'book')
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id))
  const links: AutoLink[] = []
  for (const entry of wanted) {
    const book = findMatchingBook(entry, sorted)
    if (book) links.push({ wantedId: entry.id, booklistId: entry.booklistId, bookId: book.id })
  }
  return links
}

/**
 * 把一组条目并进某个书单: 能在藏书里找到的返回书 id (去重), 其余作为新的待找条目
 * (与该书单已有的待找条目、已在书单里的书以及本组内重复的跳过).
 */
export function planListImport(
  entries: readonly BooklistEntry[],
  books: readonly (MatchableBook & { addedAt?: number })[],
  existing: { bookIds?: readonly string[]; wanted?: readonly BooklistEntry[] } = {},
): { bookIds: string[]; wanted: BooklistEntry[] } {
  const sorted = [...books]
    .filter(book => (book.kind ?? 'book') === 'book')
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id))
  const inList = new Set(existing.bookIds ?? [])
  const bookIds: string[] = []
  const wanted: BooklistEntry[] = []
  const known: BooklistEntry[] = [...(existing.wanted ?? [])]
  for (const raw of entries) {
    const entry = cleanEntry(raw)
    if (!entry) continue
    const book = findMatchingBook(entry, sorted)
    if (book) {
      if (!inList.has(book.id)) {
        inList.add(book.id)
        bookIds.push(book.id)
      }
      continue
    }
    if (known.some(other => sameEntry(entry, other))) continue
    known.push(entry)
    wanted.push(entry)
  }
  return { bookIds, wanted }
}

const str = (v: unknown, max = 500): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

const intYear = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= -3000 && v <= 2100 ? v : undefined

/** 规范化一个条目 (去掉空白、非法字段); 缺书名返回 undefined */
export function cleanEntry(raw: unknown): BooklistEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const title = str(r.title, 300)
  if (!title) return undefined
  const entry: BooklistEntry = { title, author: str(r.author, 200) ?? '' }
  const isbn = normalizeIsbn(r.isbn)
  if (isbn) entry.isbn = isbn
  const year = intYear(r.year)
  if (year !== undefined) entry.year = year
  const note = str(r.note, 500)
  if (note) entry.note = note
  const original = r.original && typeof r.original === 'object' ? r.original as Record<string, unknown> : undefined
  const originalTitle = str(r.originalTitle, 300) ?? str(original?.title, 300)
  const originalAuthor = str(r.originalAuthor, 200) ?? str(original?.author, 200)
  if (originalTitle) {
    entry.originalTitle = originalTitle
    if (originalAuthor) entry.originalAuthor = originalAuthor
  }
  return entry
}

// ---- 分享 ----

export const SHARE_FORMAT = 'org.lightread.booklist'
export const SHARE_FILE_SUFFIX = '.lightread-booklist.json'

export interface BooklistShare {
  format: typeof SHARE_FORMAT
  version: 1
  name: string
  description?: string
  exportedAt?: string
  books: Array<Omit<BooklistEntry, 'originalTitle' | 'originalAuthor'> & { original?: { title: string; author?: string } }>
}

export function buildShare(name: string, entries: readonly BooklistEntry[], opts: { description?: string; now?: Date } = {}): BooklistShare {
  const share: BooklistShare = {
    format: SHARE_FORMAT,
    version: 1,
    name: name.trim(),
    exportedAt: (opts.now ?? new Date()).toISOString(),
    books: [],
  }
  if (opts.description?.trim()) share.description = opts.description.trim()
  for (const raw of entries) {
    const e = cleanEntry(raw)
    if (!e) continue
    const book: BooklistShare['books'][number] = { title: e.title, author: e.author }
    if (e.isbn) book.isbn = e.isbn
    if (e.year !== undefined) book.year = e.year
    if (e.note) book.note = e.note
    if (e.originalTitle) {
      book.original = { title: e.originalTitle }
      if (e.originalAuthor) book.original.author = e.originalAuthor
    }
    share.books.push(book)
  }
  return share
}

export function shareToJson(share: BooklistShare): string {
  return JSON.stringify(share, null, 2)
}

/** 年份的显示: 公元前写成「前 375」/「375 BC」 */
export function yearLabel(year: number | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (year === undefined) return ''
  if (year < 0) return lang === 'en' ? `${-year} BC` : `前${-year}`
  return String(year)
}

/** 适合发到聊天里的纯文本清单 (Markdown 编号列表) */
export function shareToMarkdown(share: BooklistShare, lang: 'zh' | 'en' = 'zh'): string {
  const lines = [`# ${share.name}`]
  if (share.description) lines.push('', share.description)
  lines.push('')
  share.books.forEach((book, index) => {
    const title = lang === 'en' && /^[\x20-\x7e]+$/.test(book.title) ? `*${book.title}*` : `《${book.title}》`
    let line = `${index + 1}. ${title}`
    if (book.author) line += ` — ${book.author}`
    const year = yearLabel(book.year, lang)
    if (year) line += lang === 'en' ? ` (${year})` : `（${year}）`
    lines.push(line)
    if (book.note) lines.push(`   ${book.note}`)
  })
  lines.push('', lang === 'en'
    ? `— ${share.books.length} books · shared from LightRead`
    : `—— 共 ${share.books.length} 本 · 来自轻阅 LightRead`)
  return lines.join('\n')
}

/** 解析分享 JSON 对象; 格式不对返回 null */
export function parseShareObject(data: unknown): BooklistShare | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  // 也接受推荐书单文件 (title 代替 name)
  const name = str(d.name, 100) ?? str(d.title, 100)
  if (!name || !Array.isArray(d.books)) return null
  if (d.format !== undefined && d.format !== SHARE_FORMAT) return null
  const entries = d.books.map(cleanEntry).filter((e): e is BooklistEntry => !!e)
  if (!entries.length) return null
  const share = buildShare(name, entries, { description: str(d.description, 1000) })
  share.exportedAt = str(d.exportedAt, 40)
  if (!share.exportedAt) delete share.exportedAt
  return share
}

const LIST_LINE = /^\s*(?:\d{1,4}\s*[.、)）]|[-*•·])\s*(.+)$/
const YEAR_TAIL = /\s*[(（]\s*(前\s*)?(\d{1,4})\s*(BC|BCE)?\s*[)）]\s*$/i

/** 解析一行「《书名》— 作者（年份）」/「Title — Author (1859)」/「书名 / 作者」 */
function parseListLine(text: string): BooklistEntry | undefined {
  let s = text.trim()
  let year: number | undefined
  const ym = s.match(YEAR_TAIL)
  if (ym) {
    const n = Number(ym[2])
    year = ym[1] || ym[3] ? -n : n
    s = s.slice(0, ym.index).trim()
  }
  let title = ''
  let author = ''
  const quoted = s.match(/^《([^》]+)》\s*(.*)$/) ?? s.match(/^\*([^*]+)\*\s*(.*)$/)
  if (quoted) {
    title = quoted[1]
    author = quoted[2].replace(/^(?:[—–\-·:：/|]+|by\s+)/i, '').trim()
  } else {
    const parts = s.split(/\s+(?:—+|–|-|·|\/|\|)\s+|——|\s+by\s+/i)
    title = parts[0] ?? ''
    author = parts.slice(1).join(' ').trim()
  }
  return cleanEntry({ title, author, year })
}

/** 解析纯文本清单: 标题取第一行「# 」, 每个编号/项目符号行一本书, 缩进行为上一本的备注 */
export function parseShareMarkdown(text: string): BooklistShare | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let name = ''
  const entries: BooklistEntry[] = []
  const desc: string[] = []
  for (const line of lines) {
    const heading = line.match(/^\s*#{1,3}\s+(.+)$/)
    if (heading && !name) {
      name = heading[1].trim()
      continue
    }
    const item = line.match(LIST_LINE)
    if (item) {
      const entry = parseListLine(item[1])
      if (entry) entries.push(entry)
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || /^[—–-]{2,}|^— \d+ books/.test(trimmed)) continue
    if (/^\s{2,}\S/.test(line) && entries.length) {
      const last = entries[entries.length - 1]
      last.note = last.note ? `${last.note} ${trimmed}` : trimmed
    } else if (!entries.length && name) {
      desc.push(trimmed)
    }
  }
  if (!entries.length) return null
  return buildShare(name || entries[0].title, entries, { description: desc.join(' ') || undefined })
}

/** 「导入书单」: 先按 JSON 解析, 不是 JSON 再按纯文本清单解析 */
export function parseShareText(text: string): BooklistShare | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return parseShareObject(JSON.parse(trimmed))
    } catch {
      return null
    }
  }
  return parseShareMarkdown(trimmed)
}

/** 分享文件名: 去掉文件名里不允许的字符 */
export function shareFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'booklist'
  return base + SHARE_FILE_SUFFIX
}

// ---- 推荐书单 ----

export interface CuratedBook extends BooklistEntry {
  wikidata?: string
}

export interface CuratedList {
  id: string
  title: string
  description: string
  en?: { title?: string; description?: string }
  curator: string
  tags: string[]
  updated: string
  source: { name: string; url: string; license: string }
  books: CuratedBook[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const CURATED_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

const httpUrl = (v: unknown): string | undefined => {
  const s = str(v, 500)
  if (!s) return undefined
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : undefined
  } catch {
    return undefined
  }
}

/** 校验一个推荐书单 (远程与自带共用); 不合格的条目丢弃, 整体不合格返回 null */
export function validateCuratedList(raw: unknown): CuratedList | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && CURATED_ID_RE.test(r.id) ? r.id : undefined
  const title = str(r.title, 100)
  const curator = str(r.curator, 100)
  const updated = typeof r.updated === 'string' && DATE_RE.test(r.updated) && Number.isFinite(Date.parse(r.updated)) ? r.updated : undefined
  const src = r.source && typeof r.source === 'object' ? r.source as Record<string, unknown> : undefined
  const source = src && str(src.name, 200) && httpUrl(src.url) && str(src.license, 100)
    ? { name: str(src.name, 200)!, url: httpUrl(src.url)!, license: str(src.license, 100)! }
    : undefined
  if (!id || !title || !curator || !updated || !source || !Array.isArray(r.books)) return null
  const books: CuratedBook[] = []
  for (const item of r.books) {
    const entry = cleanEntry(item)
    if (!entry || !entry.author) continue
    if (books.some(other => titleKey(other.title) === titleKey(entry.title) && authorsCompatible(other.author, entry.author))) continue
    const book: CuratedBook = entry
    const wd = (item as Record<string, unknown>).wikidata
    if (typeof wd === 'string' && /^Q\d+$/.test(wd)) book.wikidata = wd
    books.push(book)
  }
  if (!books.length) return null
  const list: CuratedList = {
    id,
    title,
    description: str(r.description, 1000) ?? '',
    curator,
    tags: Array.isArray(r.tags) ? r.tags.map(tag => str(tag, 30)).filter((tag): tag is string => !!tag).slice(0, 8) : [],
    updated,
    source,
    books,
  }
  const en = r.en && typeof r.en === 'object' ? r.en as Record<string, unknown> : undefined
  if (en && (str(en.title) || str(en.description))) {
    list.en = {}
    if (str(en.title, 100)) list.en.title = str(en.title, 100)
    if (str(en.description, 1000)) list.en.description = str(en.description, 1000)
  }
  return list
}

export interface CuratedIndex {
  updated: string
  lists: string[]
}

export function parseCuratedIndex(raw: unknown): CuratedIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const updated = typeof r.updated === 'string' && DATE_RE.test(r.updated) ? r.updated : ''
  const lists = Array.isArray(r.lists)
    ? [...new Set(r.lists.filter((id): id is string => typeof id === 'string' && CURATED_ID_RE.test(id)))]
    : []
  return updated && lists.length ? { updated, lists } : null
}

/** 豆瓣读书搜索 (只链出, 不抓取) */
export function doubanSearchUrl(title: string, author = ''): string {
  const q = `${title} ${author}`.replace(/\s+/g, ' ').trim()
  return `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(q)}`
}

/** 「找书」的搜索词: 书名 + 作者 */
export function findQuery(title: string, author = ''): string {
  const cleanAuthor = authorTokens(author).length ? author.replace(/[\[［【(（〔][^\]］】)）〕]*[\]］】)）〕]/g, ' ').trim() : ''
  return `${cleanTitle(title, false)} ${cleanAuthor}`.replace(/\s+/g, ' ').trim()
}
