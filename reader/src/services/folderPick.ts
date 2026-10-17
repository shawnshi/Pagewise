/**
 * 本地文件夹导入：同一本书有多种受支持格式时，只选择推荐格式。
 * 纯函数 (不碰 DOM / Tauri), 测试见 scripts/test-folder-pick.mjs。
 *
 * 规则:
 *  - 忽略: 隐藏文件/目录 (以 . 开头)、__MACOSX、$RECYCLE.BIN、@eaDir、Thumbs.db、desktop.ini、
 *    Office 临时文件 (~$)、未下完的文件 (.part / .crdownload / .tmp / .download)、0 字节文件。
 *  - 不支持：扩展名不在活动导入格式中。
 *  - 同一本书: 文件名 (去扩展名) NFKC + 小写, 去掉「(z-lib.org)」「[www.xxx.com]」「 - 副本」等噪声,
 *    再忽略空格与标点; 数字和「上/下/卷/册」保留, 所以分卷不会被合并。浏览器重复下载的「 (1)」
 *    只有在同一文件夹里确实有不带编号的同名书时才算重复 (「三体 (1)」「三体 (2)」单独出现时视为分卷)。
 *  - 每组优先 EPUB > MOBI > PDF > TXT > Markdown；
 *    同格式留更大的文件, 一样大时原件优先于「副本 / (1)」, 再按路径排第一的。
 */
import type { BookFormat } from '../storage/types'
import { detectFormat, SUPPORTED_FORMATS } from './format.ts'

export interface FolderEntry {
  /** 在所选文件夹内的相对路径 (含文件名), 分隔符 / 或 \ */
  path: string
  name: string
  size: number
}
export interface DuplicateGroup<T> { kept: T; dropped: T[] }
export interface FolderPlan<T> {
  /** 要导入的书，按路径自然排序。 */
  selected: T[]
  /** 同一本书的其他格式 / 副本: kept 为保留的那本 (可能已在藏书里或超出大小) */
  skippedDuplicates: DuplicateGroup<T>[]
  /** 格式不支持的文件数 */
  unsupported: number
  /** 被静默忽略的文件数 (隐藏、临时、空文件等) */
  ignored: number
  /** 藏书里已有同名文件, 不再导入 */
  alreadyInLibrary: T[]
  /** 超过大小上限 (同一本书没有更小的可选格式时) */
  oversize: T[]
}
export interface FolderPlanOptions {
  /** 目标接受的格式 */
  formats: Iterable<BookFormat>
  /** 单本大小上限 (字节), 超出的不选 */
  maxBytes?: number
  /** 藏书里已有的文件名 (BookMeta.fileName), 同名 (不分大小写) 视为已导入 */
  existingFileNames?: Iterable<string>
}

/** 格式推荐顺序, 越靠前越好 */
export const FORMAT_PREFERENCE: readonly BookFormat[] = SUPPORTED_FORMATS
/** 「添加书籍」支持的全部格式 */
export const IMPORT_FORMATS: readonly BookFormat[] = FORMAT_PREFERENCE

const RANK: Partial<Record<BookFormat, number>> = {}
FORMAT_PREFERENCE.forEach((f, i) => { RANK[f] = i })
export function formatRank(format: BookFormat | null | undefined): number {
  return format ? RANK[format] ?? FORMAT_PREFERENCE.length : FORMAT_PREFERENCE.length
}

const IGNORED_DIRS = new Set(['__macosx', '$recycle.bin', 'system volume information', '@eadir'])
const IGNORED_NAMES = new Set(['thumbs.db', 'desktop.ini', 'ehthumbs.db'])
const TEMP_EXTS = new Set(['part', 'crdownload', 'tmp', 'download', 'partial', 'opdownload'])

/** 是否静默忽略 (不计入「不支持」) */
export function isIgnoredEntry(entry: FolderEntry): boolean {
  const segments = entry.path.split(/[\\/]/).filter(Boolean)
  const dirs = segments.slice(0, -1)
  if (dirs.some(d => d.startsWith('.') || IGNORED_DIRS.has(d.toLowerCase()))) return true
  const name = entry.name.toLowerCase()
  if (name.startsWith('.') || name.startsWith('~$') || IGNORED_NAMES.has(name)) return true
  if (TEMP_EXTS.has(name.split('.').pop() ?? '')) return true
  return !(entry.size > 0)
}

/** 去扩展名 (含 .fb2.zip) */
export function fileStem(name: string): string {
  if (/\.fb2\.zip$/i.test(name)) return name.slice(0, -8)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

// 括号里出现这些即视为来源水印, 整段去掉
const NOISE = /z-?lib(rary)?|1lib|libgen|anna.?s.?archive|epubee|sobooks|www\.|\.(com|org|net|cn|io|me|cc|top|info|xyz)\b|电子书下载|免费下载/
const BRACKETS = /[[(【〔{「『]([^\])】〕}」』]*)[\])】〕}」』]/g
const COPY_MARKERS = [
  /\s*[-–—]\s*(副本|copy|kopie|copie|copia)(\s*\(\d+\))?$/, // Windows: 「 - 副本」「 - Copy (2)」
  /\s+(副本|copy)(\s+\d+)?$/, // macOS: 「 副本」「 copy 2」
  /^(副本|copy of)\s+/,
]
const SITE_SUFFIXES = [
  /\s*[-–—]+\s*anna.?s.?archive$/, // Anna's Archive 长文件名尾巴
  /[\s_-]*z-?lib(rary)?(\.org)?$/,
]
const DOWNLOAD_COPY = /\s*\((\d{1,2})\)$/

function stripNoise(stem: string): { text: string; copy: boolean } {
  let s = stem.normalize('NFKC').toLowerCase().trim()
  s = s.replace(BRACKETS, (whole, inner: string) => (NOISE.test(inner) ? ' ' : whole)).trim()
  let copy = false
  for (let changed = true; changed;) {
    changed = false
    for (const re of [...COPY_MARKERS, ...SITE_SUFFIXES]) {
      const next = s.replace(re, '').trim()
      if (next !== s && next) { s = next; changed = true; copy ||= COPY_MARKERS.includes(re) }
    }
  }
  return { text: s, copy }
}

function compact(s: string, fallback: string): string {
  // 只留文字、数字与 + # (C++ / C#); 空格、标点、下划线、连字符一律忽略
  return s.replace(/[^\p{L}\p{M}\p{N}+#]+/gu, '') || fallback
}

export interface BookIdentity {
  key: string
  /** 去掉「 (1)」后的键 (仅当文件名带这种编号时) */
  withoutCopyNumber?: string
  /** 文件名带「副本 / copy / (1)」之类的标记: 同格式同大小时排在原件后面 */
  copy: boolean
}
export function bookIdentity(name: string): BookIdentity {
  const stem = fileStem(name)
  const { text: clean, copy } = stripNoise(stem)
  const fallback = stem.normalize('NFKC').toLowerCase()
  const key = compact(clean, fallback)
  const m = DOWNLOAD_COPY.exec(clean)
  const base = m ? clean.slice(0, m.index).trim() : ''
  return base ? { key, withoutCopyNumber: compact(base, fallback), copy: true } : { key, copy }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byPath = <T extends FolderEntry>(a: T, b: T) => collator.compare(a.path, b.path)
const normName = (name: string) => name.normalize('NFKC').toLowerCase()

export function planFolderPick<T extends FolderEntry>(entries: readonly T[], options: FolderPlanOptions): FolderPlan<T> {
  const formats = new Set(options.formats)
  const existing = new Set(Array.from(options.existingFileNames ?? [], normName))
  const max = options.maxBytes ?? Infinity
  let unsupported = 0, ignored = 0
  const candidates: Array<{ entry: T; format: BookFormat; id: BookIdentity }> = []
  for (const entry of entries) {
    if (isIgnoredEntry(entry)) { ignored++; continue }
    const format = detectFormat(entry.name)
    if (!format || !formats.has(format)) { unsupported++; continue }
    candidates.push({ entry, format, id: bookIdentity(entry.name) })
  }
  const plainKeys = new Set(candidates.map(c => c.id.key))
  const groups = new Map<string, typeof candidates>()
  for (const c of candidates) {
    const key = c.id.withoutCopyNumber && plainKeys.has(c.id.withoutCopyNumber) ? c.id.withoutCopyNumber : c.id.key
    const list = groups.get(key)
    if (list) list.push(c); else groups.set(key, [c])
  }
  const plan: FolderPlan<T> = { selected: [], skippedDuplicates: [], unsupported, ignored, alreadyInLibrary: [], oversize: [] }
  for (const list of groups.values()) {
    list.sort((a, b) => formatRank(a.format) - formatRank(b.format) || b.entry.size - a.entry.size ||
      Number(a.id.copy) - Number(b.id.copy) || byPath(a.entry, b.entry))
    const fitting = list.filter(c => c.entry.size <= max)
    if (!fitting.length) { plan.oversize.push(...list.map(c => c.entry)); continue }
    const kept = fitting[0].entry
    const dropped = list.filter(c => c.entry !== kept).map(c => c.entry)
    if (dropped.length) plan.skippedDuplicates.push({ kept, dropped })
    if (existing.has(normName(kept.name))) plan.alreadyInLibrary.push(kept)
    else plan.selected.push(kept)
  }
  plan.selected.sort(byPath)
  plan.alreadyInLibrary.sort(byPath)
  plan.oversize.sort(byPath)
  plan.skippedDuplicates.sort((a, b) => byPath(a.kept, b.kept))
  return plan
}
