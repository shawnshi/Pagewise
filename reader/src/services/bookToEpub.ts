/**
 * 格式转换: 把 foliate 能打开的流式电子书 (MOBI, 以及导入时按原文件保存的
 * TXT / Markdown) 重新打包成标准 EPUB 3 (附 EPUB 2 NCX 目录).
 *
 * 思路: 用 foliate 的解析器逐节取出已解码的 (X)HTML (资源已换成 blob:/data: URL),
 * 清洗成良构 XHTML, 把图片/样式/字体拷成包内文件并改写引用, 用 book.resolveHref
 * 把书内跳转 (filepos: / kindle:pos:) 改写成 EPUB 内的相对链接, 目录同理.
 * 大书分节处理并按时间片让出主线程, 通过 onProgress 报告进度.
 */
import { canConvertToEpub, detectFormat, isTextLike } from './format'
import type { BookFormat } from '../storage/types'
import {
  BLOB_URL_RE, ELEMENT_ATTRS, EPUB_NS, GLOBAL_ATTRS, XHTML_NS, legacyAttrStyle, baseNameOf, buildContainerXml, buildCoverXhtml, buildNav, buildNcx,
  buildOpf, extensionFor, folderFor, isCompressedMedia, isXmlName, normalizeIsbn, normalizeLanguage,
  normalizeMediaType, relativeHref, rewriteCssUrls, sanitizeFileName, sniffMediaType, stripInvalidXmlChars,
  zipEpub, type EpubEntry, type ManifestItem, type SpineItem, type TocNode,
} from './epubWriter'

export { canConvertToEpub, EPUB_CONVERTIBLE } from './format'

export type ConvertErrorCode = 'drm' | 'unsupported' | 'parse' | 'empty'

export class ConvertError extends Error {
  readonly code: ConvertErrorCode
  constructor(code: ConvertErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ConvertError'
    this.code = code
  }
}

export type ConvertStage = 'open' | 'read' | 'write' | 'package'

export interface ConvertProgress {
  /** 0-1 */
  fraction: number
  stage: ConvertStage
}

export interface ConvertOptions {
  /** 原文件名, 用来判断格式与生成输出文件名 */
  fileName: string
  onProgress?: (p: ConvertProgress) => void
  signal?: AbortSignal
  /** 藏书里的元数据 (用户可能改过), 优先于文件内嵌 */
  meta?: { title?: string; author?: string; description?: string; language?: string }
  /** 文件内没有封面时用的封面 (如藏书里存的封面) */
  cover?: Blob
}

export interface ConvertResult {
  epub: Blob
  fileName: string
  title: string
  author: string
  description?: string
  language?: string
  cover?: Blob
  /** 统计, 便于测试与日志 */
  stats: { sections: number; tocEntries: number; resources: number; links: number }
}

const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'

/** 整个元素连同内容丢弃 */
const DROP = new Set([
  'script', 'noscript', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'base',
  'meta', 'title', 'guide', 'template', 'form', 'input', 'button', 'select', 'textarea', 'head',
])
/** 旧式标签 → HTML5 */
const RENAME: Record<string, { tag: string; style?: string }> = {
  font: { tag: 'span' },
  center: { tag: 'div', style: 'text-align: center' },
  big: { tag: 'span', style: 'font-size: larger' },
  strike: { tag: 's' },
  tt: { tag: 'code' },
  acronym: { tag: 'abbr' },
  blink: { tag: 'span' },
  marquee: { tag: 'span' },
  nobr: { tag: 'span' },
  listing: { tag: 'pre' },
  xmp: { tag: 'pre' },
  plaintext: { tag: 'pre' },
}
/** MOBI / foliate 内部属性, 转换后无意义 */
const DROP_ATTRS = new Set(['filepos', 'recindex', 'mediarecindex', 'aid', 'data-foliate-id', 'srcset', 'contenteditable'])

const isExternalHref = (href: string) => /^(?!blob:|filepos:|kindle:)[a-z][a-z0-9+.-]*:/i.test(href)

/** 按时间片让出主线程: 每 ~24ms 让一次 (而不是每节都让, 避免 setTimeout 4ms 钳制拖慢大书) */
function makeYielder(signal?: AbortSignal) {
  let last = performance.now()
  return async () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (performance.now() - last < 24) return
    // 用普通宏任务让出 (scheduler.yield 的续体优先级高, 会把渲染压到 ~100ms 一帧)
    await new Promise(resolve => setTimeout(resolve, 0))
    last = performance.now()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }
}

/** foliate metadata 字段可能是字符串 / {name} / 语言映射 / 数组 */
function metaStrings(value: any): string[] {
  if (value == null || value === '') return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(metaStrings)
  if (typeof value === 'object') {
    if (typeof value.name === 'string') return [value.name]
    if (value.name && typeof value.name === 'object') return metaStrings(value.name)
    if (typeof value.value === 'string') return [value.value]
    const first = Object.values(value).find(v => typeof v === 'string')
    return typeof first === 'string' ? [first] : []
  }
  return []
}
const metaString = (value: any) => metaStrings(value)[0]?.trim() ?? ''

/** 简介可能是 HTML: 取纯文本 */
function htmlToText(html: string): string {
  if (!/[<&]/.test(html)) return html.trim()
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  doc.querySelectorAll('p, br, div, li').forEach(el => el.append('\n'))
  return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function parseDoc(text: string, type: string): Document {
  const parser = new DOMParser()
  if (/xhtml|xml|svg/i.test(type)) {
    const doc = parser.parseFromString(text, /svg/i.test(type) ? 'image/svg+xml' : 'application/xhtml+xml')
    if (!doc.querySelector('parsererror') && doc.documentElement?.namespaceURI) return doc
  }
  return parser.parseFromString(text, 'text/html')
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

interface Target {
  index: number
  anchor?: (doc: Document) => unknown
  /** 目标元素 id; '' 表示指向该节开头 */
  id?: string
}

interface Resource {
  id: string
  path: string
  mediaType: string
  data: Uint8Array | string
}

interface FoliateTocItem { label?: string; href?: string; subitems?: FoliateTocItem[] | null }

/** 打开文件: 文本类先套上内存 EPUB, 其余交给 foliate */
async function openBook(file: Blob, fileName: string, format: BookFormat) {
  const { makeFoliateBook } = await import('./foliateBook')
  if (isTextLike(format)) {
    const { convertToEpub } = await import('./textToEpub')
    const { epub, title } = await convertToEpub(file, fileName, format as 'txt' | 'md')
    return { book: await makeFoliateBook(new File([epub], `${baseNameOf(fileName)}.epub`)), textTitle: title }
  }
  const named = file instanceof File && file.name === fileName ? file : new File([file], fileName)
  return { book: await makeFoliateBook(named), textTitle: '' }
}

/** 打开前读 MOBI 第 0 条记录的加密标记: 受保护的书 foliate 也能打开, 但正文是乱码甚至解压出错 */
async function mobiHeaderDrm(file: Blob): Promise<boolean> {
  try {
    const head = new DataView(await file.slice(0, 86).arrayBuffer())
    if (head.byteLength < 86) return false
    const magic = String.fromCharCode(...new Uint8Array(head.buffer, 60, 8))
    if (magic !== 'BOOKMOBI' && magic !== 'TEXtREAd') return false
    const rec0 = head.getUint32(78)
    const rec = new DataView(await file.slice(rec0, rec0 + 16).arrayBuffer())
    return rec.byteLength >= 14 && rec.getUint16(12) !== 0
  } catch {
    return false
  }
}

/** MOBI 头里的加密标记 (PalmDOC encryption: 1 = 旧式, 2 = Mobipocket DRM) */
function isDrmProtected(book: any): boolean {
  const enc = book?.mobi?.headers?.palmdoc?.encryption
  return typeof enc === 'number' && enc !== 0
}

/**
 * 转换为 EPUB. 失败时抛出 ConvertError (drm / unsupported / parse / empty), 原文件不受影响.
 */
export async function convertBookToEpub(file: Blob, options: ConvertOptions): Promise<ConvertResult> {
  const { fileName, onProgress, signal } = options
  const format = detectFormat(fileName)
  if (!canConvertToEpub(format)) throw new ConvertError('unsupported')
  const report = (fraction: number, stage: ConvertStage) =>
    onProgress?.({ fraction: Math.max(0, Math.min(1, fraction)), stage })
  const yieldNow = makeYielder(signal)
  report(0, 'open')

  // MOBI DRM 也能被 foliate 打开 (正文是乱码), 先看头部标记
  if (format === 'mobi' && await mobiHeaderDrm(file)) throw new ConvertError('drm')
  let book: any
  let textTitle = ''
  try {
    const opened = await openBook(file, fileName, format!)
    book = opened.book
    textTitle = opened.textTitle
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e
    throw new ConvertError('parse', e?.message)
  }
  try {
    if (isDrmProtected(book)) throw new ConvertError('drm')
    const sections: any[] = (book.sections ?? []).filter((s: any) => typeof s?.load === 'function')
    if (!sections.length) throw new ConvertError('empty')
    const allSections: any[] = book.sections
    const outIndexOf = new Map<number, number>()
    allSections.forEach((s, i) => { if (typeof s?.load === 'function') outIndexOf.set(i, outIndexOf.size) })
    const sectionPath = (out: number) => `Text/s${String(out + 1).padStart(4, '0')}.xhtml`
    const fixedLayout = book.rendition?.layout === 'pre-paginated'
    const language = normalizeLanguage(options.meta?.language || metaString(book.metadata?.language))

    // ---- 第 1 遍: 取各节文本, 收集书内链接与目录项, 解析到 (节, 定位函数) ----
    const texts: Array<{ text: string; type: string }> = []
    const targets = new Map<string, Target>()
    const keyOf = (section: any, href: string) => {
      try { return section?.resolveHref ? section.resolveHref(href) : href } catch { return href }
    }
    const resolveTarget = async (key: string) => {
      if (targets.has(key)) return
      let resolved: any = null
      try { resolved = await book.resolveHref?.(key) } catch { resolved = null }
      const index = resolved?.index
      if (typeof index !== 'number' || !outIndexOf.has(index)) {
        targets.set(key, { index: -1 })
        return
      }
      targets.set(key, { index, anchor: typeof resolved.anchor === 'function' ? resolved.anchor : undefined })
    }
    const linkHref = (el: Element) => el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href')
    let linkCount = 0
    for (let i = 0; i < allSections.length; i++) {
      const section = allSections[i]
      if (!outIndexOf.has(i)) continue
      const url = await section.load()
      let text = ''
      let type = 'application/xhtml+xml'
      if (url) {
        const res = await fetch(url)
        type = res.headers.get('content-type') || type
        text = await res.text()
      }
      texts[i] = { text, type }
      const doc = parseDoc(text, type)
      for (const a of Array.from(doc.querySelectorAll('a, area'))) {
        const href = linkHref(a)
        if (!href || isExternalHref(href)) continue
        linkCount++
        await resolveTarget(keyOf(section, href))
      }
      report(0.05 + 0.25 * (outIndexOf.get(i)! + 1) / sections.length, 'read')
      await yieldNow()
    }
    const tocItems: FoliateTocItem[] = Array.isArray(book.toc) ? book.toc : []
    const walkToc = async (items: FoliateTocItem[]) => {
      for (const item of items) {
        if (item?.href) await resolveTarget(item.href)
        if (item?.subitems?.length) await walkToc(item.subitems)
      }
    }
    await walkToc(tocItems)

    // ---- 第 2 遍: 在目标节里找到定位元素, 确定锚点 id (没有 id 的补一个) ----
    const byIndex = new Map<number, Array<[string, Target]>>()
    for (const entry of targets) {
      const [, t] = entry
      if (t.index < 0) continue
      if (!byIndex.has(t.index)) byIndex.set(t.index, [])
      byIndex.get(t.index)!.push(entry)
    }
    let anchorSeq = 0
    /** 在 doc 上应用该节的锚点; 第 3 遍会对重新解析的文档再执行一次 (结果一致) */
    const applyAnchors = (index: number, doc: Document, assign: boolean) => {
      for (const [, t] of byIndex.get(index) ?? []) {
        let el: unknown = null
        try { el = t.anchor?.(doc) } catch { el = null }
        if (!(el instanceof Element) || el === doc.documentElement || el === doc.body) {
          if (assign) t.id = ''
          continue
        }
        if (assign) {
          if (!el.id) el.id = `lr-a${++anchorSeq}`
          t.id = el.id
        } else if (t.id && !el.id) {
          el.id = t.id
        }
      }
    }
    for (const index of byIndex.keys()) {
      const { text, type } = texts[index]
      applyAnchors(index, parseDoc(text, type), true)
      await yieldNow()
    }
    report(0.35, 'read')

    // ---- 资源: blob:/data: → 包内文件 ----
    const resources = new Map<string, Resource>()
    const resourceList: Resource[] = []
    let resourceSeq = 0
    const addResource = async (url: string, hint?: 'css'): Promise<Resource | null> => {
      const cached = resources.get(url)
      if (cached) return cached
      let blob: Blob
      try {
        const res = await fetch(url)
        if (!res.ok) return null
        blob = await res.blob()
      } catch { return null }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!bytes.byteLength) return null
      let mediaType = hint === 'css' ? 'text/css' : normalizeMediaType(blob.type)
      if (hint !== 'css') {
        const sniffed = sniffMediaType(bytes)
        if (sniffed && (!mediaType || mediaType.startsWith('image/') || mediaType.startsWith('font/') ||
          mediaType === 'application/octet-stream')) mediaType = sniffed
        if (!mediaType) mediaType = 'application/octet-stream'
        if (mediaType === 'text/css') hint = 'css'
      }
      const id = `r${++resourceSeq}`
      const path = `${folderFor(mediaType)}/${id}.${extensionFor(mediaType)}`
      const resource: Resource = { id, path, mediaType, data: bytes }
      resources.set(url, resource)
      resourceList.push(resource)
      // 样式表与 SVG 里还有二级引用 (字体 / 背景图)
      if (mediaType === 'text/css' || mediaType === 'image/svg+xml') {
        let text = new TextDecoder().decode(bytes)
        text = await rewriteBlobUrls(text, path, mediaType === 'text/css')
        resource.data = text
      }
      return resource
    }
    /** 文本内的 blob:/data: URL 改为相对 fromPath 的包内路径 */
    const rewriteBlobUrls = async (text: string, fromPath: string, css: boolean): Promise<string> => {
      const found = new Set<string>(text.match(BLOB_URL_RE) ?? [])
      if (css) rewriteCssUrls(text, u => { if (/^data:(?!,)/i.test(u) && u.length < 4_000_000) found.add(u); return null })
      const map = new Map<string, string>()
      for (const url of found) {
        const r = await addResource(url)
        if (r) map.set(url, relativeHref(fromPath, r.path))
      }
      if (!map.size) return text
      let out = text.replace(BLOB_URL_RE, u => map.get(u) ?? u)
      if (css) out = rewriteCssUrls(out, u => map.get(u) ?? null)
      return out
    }

    // ---- 第 3 遍: 清洗为 XHTML, 改写链接与资源 ----
    const serializer = new XMLSerializer()
    const entries: EpubEntry[] = []
    const manifest: ManifestItem[] = []
    const spine: SpineItem[] = []
    const sectionTitles: string[] = []
    let done = 0
    for (let i = 0; i < allSections.length; i++) {
      if (!outIndexOf.has(i)) continue
      const section = allSections[i]
      const out = outIndexOf.get(i)!
      const path = sectionPath(out)
      const src = parseDoc(texts[i].text, texts[i].type)
      applyAnchors(i, src, false)
      const { doc, pending, styleTexts, properties: props } = cleanDocument(src, {
        language,
        rewriteLink: (href: string) => {
          if (isExternalHref(href)) return href
          const t = targets.get(keyOf(section, href))
          if (!t || t.index < 0) return null
          const targetPath = sectionPath(outIndexOf.get(t.index)!)
          const hash = t.id ? `#${encodeURIComponent(t.id)}` : ''
          if (targetPath === path) return hash || relativeHref(path, targetPath)
          return relativeHref(path, targetPath) + hash
        },
        title: '',
        viewport: fixedLayout ? book.rendition?.viewport : undefined,
      })
      // 资源属性
      for (const p of pending) {
        const r = await addResource(p.url, p.css ? 'css' : undefined)
        if (r) {
          const href = relativeHref(path, r.path)
          if (p.ns) p.el.setAttributeNS(p.ns, p.name, href)
          else p.el.setAttribute(p.name, href)
        } else if (p.required) {
          p.el.remove()
        } else {
          if (p.ns) p.el.removeAttributeNS(p.ns, p.name.replace(/^.*:/, ''))
          else p.el.removeAttribute(p.name)
        }
      }
      for (const s of styleTexts) {
        const rewritten = await rewriteBlobUrls(s.get(), path, true)
        s.set(rewritten)
      }
      const label = (doc.querySelector('h1, h2, h3, h4')?.textContent ?? '').replace(/\s+/g, ' ').trim()
      sectionTitles[out] = label
      const titleEl = doc.querySelector('head > title')
      if (titleEl && !titleEl.textContent) titleEl.textContent = label || options.meta?.title || metaString(book.metadata?.title) || textTitle || baseNameOf(fileName)
      let xhtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n${serializer.serializeToString(doc.documentElement)}\n`
      xhtml = stripInvalidXmlChars(xhtml)
      // 理论上不会失败; 万一不良构, 退回纯文本段落, 保证整本可读
      const check = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml')
      if (check.querySelector('parsererror')) xhtml = plainTextXhtml(src, language, label)
      entries.push({ path: `OEBPS/${path}`, data: xhtml })
      manifest.push({ id: `s${out + 1}`, href: path, mediaType: 'application/xhtml+xml', properties: props || undefined })
      spine.push({ idref: `s${out + 1}`, linear: section.linear !== 'no' })
      texts[i] = { text: '', type: '' } // 释放内存
      done++
      report(0.35 + 0.5 * done / sections.length, 'write')
      await yieldNow()
    }

    // ---- 封面 ----
    let cover: Blob | undefined
    try { cover = (await book.getCover?.()) ?? undefined } catch { cover = undefined }
    if (!cover?.size) cover = options.cover
    let coverId: string | undefined
    let coverPage: string | undefined
    if (cover?.size) {
      const bytes = new Uint8Array(await cover.arrayBuffer())
      const existing = resourceList.find(r => r.data instanceof Uint8Array && r.mediaType.startsWith('image/') && bytesEqual(r.data, bytes))
      if (existing) {
        coverId = existing.id
      } else {
        const mediaType = sniffMediaType(bytes) || normalizeMediaType(cover.type)
        if (mediaType.startsWith('image/')) {
          const r: Resource = { id: 'cover-image', path: `Images/cover.${extensionFor(mediaType)}`, mediaType, data: bytes }
          resourceList.push(r)
          coverId = r.id
          coverPage = 'Text/cover.xhtml'
        }
      }
    }

    // ---- 元数据 ----
    const fileTitle = metaString(book.metadata?.title)
    const title = options.meta?.title?.trim() || fileTitle || textTitle || baseNameOf(fileName)
    const fileAuthors = metaStrings(book.metadata?.author).map(s => s.trim()).filter(Boolean)
    const libAuthor = options.meta?.author?.trim()
    const authors = libAuthor && libAuthor !== fileAuthors.join(', ') ? [libAuthor] : fileAuthors
    const rawDescription = options.meta?.description || metaString(book.metadata?.description)
    const description = rawDescription ? htmlToText(rawDescription) : ''
    const isbn = normalizeIsbn(book.mobi?.headers?.exth?.isbn) ?? normalizeIsbn(metaString(book.metadata?.identifier))

    // ---- 目录 ----
    const hrefFor = (key: string): string | null => {
      const t = targets.get(key)
      if (!t || t.index < 0) return null
      const p = sectionPath(outIndexOf.get(t.index)!)
      return t.id ? `${p}#${encodeURIComponent(t.id)}` : p
    }
    const mapToc = (items: FoliateTocItem[]): TocNode[] => items.flatMap(item => {
      const children = mapToc(item?.subitems ?? [])
      const href = item?.href ? hrefFor(item.href) : null
      if (!href) return children // 定位不到的条目: 保留其子项
      return [{ label: String(item.label ?? '').replace(/\s+/g, ' ').trim(), href, children: children.length ? children : undefined }]
    })
    let toc = mapToc(tocItems)
    if (!toc.length) {
      // 原书没有目录: 用各节标题兜底, 至少有一项
      toc = sectionTitles.flatMap((label, out) => label ? [{ label, href: sectionPath(out) }] : [])
      if (!toc.length) toc = [{ label: title, href: sectionPath(0) }]
    }
    // 没有标签的目录项: 取目标节的标题
    const fill = (nodes: TocNode[]) => nodes.forEach(n => {
      if (!n.label) {
        const m = n.href.match(/s(\d{4})\.xhtml/)
        n.label = (m && sectionTitles[Number(m[1]) - 1]) || title
      }
      if (n.children) fill(n.children)
    })
    fill(toc)
    const countToc = (nodes: TocNode[]): number => nodes.reduce((n, x) => n + 1 + countToc(x.children ?? []), 0)

    report(0.88, 'package')
    await yieldNow()

    // ---- 组装 ----
    const identifier = `urn:uuid:${crypto.randomUUID()}`
    if (coverPage) {
      const coverRes = resourceList.find(r => r.id === coverId)!
      entries.unshift({ path: `OEBPS/${coverPage}`, data: buildCoverXhtml(relativeHref(coverPage, coverRes.path), { title, language }) })
      manifest.unshift({ id: 'cover', href: coverPage, mediaType: 'application/xhtml+xml' })
      spine.unshift({ idref: 'cover' })
    }
    for (const r of resourceList) {
      manifest.push({ id: r.id, href: r.path, mediaType: r.mediaType, properties: r.id === coverId ? 'cover-image' : undefined })
      entries.push({ path: `OEBPS/${r.path}`, data: r.data, store: isCompressedMedia(r.mediaType) })
    }
    manifest.unshift(
      { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
      { id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' },
    )
    const opf = buildOpf({
      metadata: {
        identifier, title, authors, language,
        publisher: metaString(book.metadata?.publisher) || undefined,
        description: description || undefined,
        isbn,
        date: metaString(book.metadata?.published) || undefined,
        subjects: metaStrings(book.metadata?.subject),
        rights: metaString(book.metadata?.rights) || undefined,
        modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      },
      manifest, spine, ncxId: 'ncx', coverId,
      direction: book.dir === 'rtl' ? 'rtl' : undefined,
      fixedLayout,
    })
    const landmarks = [
      ...(coverPage ? [{ type: 'cover', href: coverPage, label: 'Cover' }] : []),
      { type: 'bodymatter', href: sectionPath(0), label: 'Start' },
    ]
    const tocTitle = /^zh/i.test(language) ? '目录' : 'Contents'
    entries.unshift(
      { path: 'META-INF/container.xml', data: buildContainerXml() },
      { path: 'OEBPS/content.opf', data: opf },
      { path: 'OEBPS/nav.xhtml', data: buildNav(toc, { title, language, tocTitle, landmarks }) },
      { path: 'OEBPS/toc.ncx', data: buildNcx(toc, { identifier, title }) },
    )
    const zipped = await zipEpub(entries, yieldNow)
    report(1, 'package')
    return {
      epub: new Blob([zipped.buffer as ArrayBuffer], { type: 'application/epub+zip' }),
      fileName: sanitizeFileName(baseNameOf(fileName) || title, 'epub'),
      title,
      author: authors.join(', '),
      description: description || undefined,
      language: language === 'und' ? undefined : language,
      cover: cover?.size ? cover : undefined,
      stats: { sections: spine.length, tocEntries: countToc(toc), resources: resourceList.length, links: linkCount },
    }
  } finally {
    // 资源 (样式表等) 挂在章节上, 全部写完才能卸载
    for (const section of book?.sections ?? []) {
      try { section?.unload?.() } catch { /* 忽略 */ }
    }
    try { book?.destroy?.() } catch { /* 忽略 */ }
  }
}

interface PendingResource {
  el: Element
  name: string
  ns?: string
  url: string
  css?: boolean
  /** 资源取不到时整个元素删掉 (如 img 必须有 src) */
  required?: boolean
}

interface CleanOptions {
  language: string
  title: string
  rewriteLink: (href: string) => string | null
  viewport?: { width?: string; height?: string }
}

/**
 * 把任意 (X)HTML 文档复制成干净的 XHTML 文档: 只保留合法的元素名/属性名, 去掉脚本与 MOBI 私有标记,
 * 旧式标签换成 HTML5 写法; 资源引用记入 pending, 由调用方异步拷贝后改写.
 */
function cleanDocument(src: Document, o: CleanOptions) {
  const doc = document.implementation.createDocument(XHTML_NS, 'html', null)
  const root = doc.documentElement
  root.setAttributeNS(XMLNS_NS, 'xmlns:epub', EPUB_NS)
  const srcRoot = src.documentElement
  const lang = srcRoot?.getAttribute('lang') || srcRoot?.getAttributeNS(XML_NS, 'lang') || o.language
  root.setAttribute('lang', lang)
  root.setAttributeNS(XML_NS, 'xml:lang', lang)
  const dir = srcRoot?.getAttribute('dir')
  if (dir === 'rtl' || dir === 'ltr') root.setAttribute('dir', dir)

  const head = doc.createElementNS(XHTML_NS, 'head')
  const body = doc.createElementNS(XHTML_NS, 'body')
  root.append(head, body)
  const meta = doc.createElementNS(XHTML_NS, 'meta')
  meta.setAttribute('charset', 'utf-8')
  head.append(meta)
  const title = doc.createElementNS(XHTML_NS, 'title')
  title.textContent = (src.querySelector('head > title')?.textContent ?? o.title).replace(/\s+/g, ' ').trim()
  head.append(title)

  const pending: PendingResource[] = []
  const styleTexts: Array<{ get(): string; set(v: string): void }> = []
  let hasSvg = false
  let hasMath = false
  let hasRemote = false
  let viewportSet = false

  // head: 样式表与内联样式, 固定版式的 viewport
  const srcHead = src.querySelector('head')
  if (srcHead) {
    for (const el of Array.from(srcHead.children)) {
      const name = el.localName.toLowerCase()
      if (name === 'link') {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase()
        const href = el.getAttribute('href') ?? ''
        if (!rel.includes('stylesheet') || !href) continue
        const link = doc.createElementNS(XHTML_NS, 'link')
        link.setAttribute('rel', 'stylesheet')
        link.setAttribute('type', 'text/css')
        head.append(link)
        if (/^(blob|data):/i.test(href)) pending.push({ el: link, name: 'href', url: href, css: true, required: true })
        else link.remove()
      } else if (name === 'style') {
        const style = doc.createElementNS(XHTML_NS, 'style')
        style.textContent = el.textContent ?? ''
        head.append(style)
        styleTexts.push({ get: () => style.textContent ?? '', set: v => { style.textContent = v } })
      } else if (name === 'meta' && el.getAttribute('name')?.toLowerCase() === 'viewport' && o.viewport) {
        const m = doc.createElementNS(XHTML_NS, 'meta')
        m.setAttribute('name', 'viewport')
        m.setAttribute('content', el.getAttribute('content') ?? '')
        head.append(m)
        viewportSet = true
      }
    }
  }
  if (o.viewport && !viewportSet && o.viewport.width && o.viewport.height) {
    const m = doc.createElementNS(XHTML_NS, 'meta')
    m.setAttribute('name', 'viewport')
    m.setAttribute('content', `width=${o.viewport.width}, height=${o.viewport.height}`)
    head.append(m)
  }

  const setAttr = (el: Element, ns: string | null, name: string, value: string) => {
    try {
      if (ns) el.setAttributeNS(ns, name, value)
      else el.setAttribute(name, value)
    } catch { /* 非法属性名: 丢弃 */ }
  }

  const copyAttributes = (from: Element, to: Element, tag: string, extraStyle?: string) => {
    const styles: string[] = []
    if (extraStyle) styles.push(extraStyle)
    const inSvg = to.namespaceURI === SVG_NS
    for (const attr of Array.from(from.attributes)) {
      const name = attr.name
      const lower = name.toLowerCase()
      const value = attr.value
      if (lower.startsWith('on') || lower === 'xmlns' || lower.startsWith('xmlns:') || DROP_ATTRS.has(lower)) continue
      // 资源与链接
      const isLinkAttr = (lower === 'href' || lower === 'xlink:href') && (tag === 'a' || tag === 'area')
      if (isLinkAttr) {
        const next = o.rewriteLink(value)
        if (next != null) setAttr(to, lower === 'xlink:href' ? XLINK_NS : null, name, next)
        continue
      }
      const isResourceAttr = lower === 'src' || lower === 'poster' ||
        ((lower === 'href' || lower === 'xlink:href') && (tag === 'image' || tag === 'use' || tag === 'feimage'))
      if (isResourceAttr) {
        if (/^(blob|data):/i.test(value) && value !== 'data:,') {
          const ns = lower === 'xlink:href' ? XLINK_NS : undefined
          setAttr(to, ns ?? null, name, '')
          pending.push({ el: to, name, ns, url: value, required: lower === 'src' && (tag === 'img' || tag === 'image') })
        } else if (/^https?:/i.test(value)) {
          setAttr(to, null, name, value)
          hasRemote = true
        } else if (lower === 'src' && tag === 'img') {
          to.setAttribute('data-lr-drop', '1')
        }
        continue
      }
      if (lower === 'style') { styles.push(value); continue }
      if (attr.namespaceURI) {
        setAttr(to, attr.namespaceURI, name, value)
        continue
      }
      if (name.includes(':')) {
        const [prefix] = name.split(':')
        const ns = prefix === 'epub' ? EPUB_NS : prefix === 'xml' ? XML_NS : prefix === 'xlink' ? XLINK_NS : null
        if (ns) setAttr(to, ns, name, value)
        continue
      }
      if (!isXmlName(name)) continue
      if (inSvg || to.namespaceURI === MATHML_NS) {
        setAttr(to, null, name, value)
        continue
      }
      const outTag = to.localName
      if (GLOBAL_ATTRS.has(lower) || lower.startsWith('aria-') || lower.startsWith('data-') || ELEMENT_ATTRS[outTag]?.includes(lower)) {
        // li[value] 只在 ol 里合法
        if (lower === 'value' && outTag === 'li' && from.parentElement?.localName.toLowerCase() !== 'ol') continue
        if (lower === 'border' && outTag === 'table') {
          if (value.trim() !== '' && Number(value) !== 0) setAttr(to, null, 'border', '1')
          continue
        }
        setAttr(to, null, lower, value)
        continue
      }
      // 旧式外观属性 → CSS (EPUB 3 的 XHTML 不允许这些属性)
      const css = legacyAttrStyle(tag, outTag, lower, value, !!from.getAttribute('id'))
      if (css === 'id') { if (isXmlName(value)) to.setAttribute('id', value); continue }
      if (css) styles.push(css)
    }
    const style = styles.map(s => s.trim().replace(/;+$/, '')).filter(Boolean).join('; ')
    if (style) {
      to.setAttribute('style', style)
      if (/blob:/i.test(style)) styleTexts.push({ get: () => to.getAttribute('style') ?? '', set: v => to.setAttribute('style', v) })
    }
  }

  const copyChildren = (from: Node, to: Node) => {
    for (let child = from.firstChild; child; child = child.nextSibling) {
      const node = copyNode(child)
      if (node) to.appendChild(node)
    }
  }

  const copyNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      return doc.createTextNode(stripInvalidXmlChars(node.nodeValue ?? ''))
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null
    const el = node as Element
    const ns = el.namespaceURI
    if (ns === SVG_NS || ns === MATHML_NS) {
      if (ns === SVG_NS) hasSvg = true
      else hasMath = true
      const local = el.localName
      if (local.toLowerCase() === 'script' || local.toLowerCase() === 'foreignobject' || !isXmlName(local)) return null
      const out = doc.createElementNS(ns, local)
      copyAttributes(el, out, local.toLowerCase())
      copyChildren(el, out)
      return out
    }
    const local = el.localName.toLowerCase()
    if (DROP.has(local)) return null
    if (local === 'style') {
      const style = doc.createElementNS(XHTML_NS, 'style')
      style.textContent = el.textContent ?? ''
      styleTexts.push({ get: () => style.textContent ?? '', set: v => { style.textContent = v } })
      return style
    }
    if (local === 'link') return null
    if (local === 'html') {
      const frag = doc.createDocumentFragment()
      copyChildren(el, frag)
      return frag
    }
    if (local.includes(':') || !isXmlName(local) || (ns && ns !== XHTML_NS)) {
      // 未知命名空间 / 非法标签 (如 mbp:nu): 只保留内容
      const frag = doc.createDocumentFragment()
      copyChildren(el, frag)
      return frag
    }
    // 嵌套的 body (如 FB2 注释) 换成 div
    const rename = local === 'body' ? { tag: 'div' } : RENAME[local]
    const out = doc.createElementNS(XHTML_NS, rename?.tag ?? local)
    copyAttributes(el, out, local, rename?.style)
    if (out.getAttribute('data-lr-drop')) return null
    copyChildren(el, out)
    return out
  }

  const srcBody = src.body ?? (src.documentElement?.namespaceURI === SVG_NS ? null : src.documentElement)
  if (srcBody) {
    copyAttributes(srcBody, body, 'body')
    copyChildren(srcBody, body)
  } else if (src.documentElement) {
    const node = copyNode(src.documentElement)
    if (node) body.append(node)
  }
  if (!body.firstChild) body.append(doc.createElementNS(XHTML_NS, 'div'))
  return { doc, pending, styleTexts, properties: [hasSvg && 'svg', hasMath && 'mathml', hasRemote && 'remote-resources'].filter(Boolean).join(' ') }
}

/** 兜底: 只保留文字段落 */
function plainTextXhtml(src: Document, language: string, title: string): string {
  const esc = (s: string) => stripInvalidXmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const blocks = Array.from((src.body ?? src.documentElement)?.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, div') ?? [])
    .filter(el => !el.querySelector('p, div, li'))
    .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const body = (blocks.length ? blocks : [(src.body?.textContent ?? '').trim()]).map(p => `<p>${esc(p)}</p>`).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${esc(language)}" xml:lang="${esc(language)}">
<head><meta charset="utf-8"/><title>${esc(title || 'Section')}</title></head>
<body>
${body}
</body>
</html>
`
}
