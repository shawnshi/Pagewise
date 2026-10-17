/**
 * EPUB 3 打包的纯函数部分 (不依赖 DOM, node --test 可直接测):
 * OPF / nav / NCX / container 生成, XML 转义, 资源嗅探与相对路径, 文件名清洗, 压缩打包.
 * 由 bookToEpub.ts (浏览器端, 解析 MOBI/AZW3/FB2 等) 调用.
 */
import { deflateSync, strToU8 } from 'fflate'

export const XHTML_NS = 'http://www.w3.org/1999/xhtml'
export const EPUB_NS = 'http://www.idpf.org/2007/ops'

/** XML 文本与属性值转义 (& < > " ') */
export function escapeXml(s: string): string {
  return stripInvalidXmlChars(String(s ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 去掉 XML 1.0 不允许的字符 (控制字符 / 落单代理项 / U+FFFE U+FFFF), 否则阅读器解析整章失败 */
export function stripInvalidXmlChars(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  )
}

/** 合法的 XML 名 (不含冒号; 带前缀的另行处理) */
export function isXmlName(name: string): boolean {
  return /^[A-Za-z_][\w.-]*$/.test(name)
}

/** 下载 / 存储用文件名: 去掉路径分隔与保留字符, 限长, 保留扩展名 */
export function sanitizeFileName(name: string, ext = 'epub', maxLength = 120): string {
  let base = String(name ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`
  // 按码点截断, 避免切开代理对
  const chars = Array.from(base)
  if (chars.length > maxLength) base = chars.slice(0, maxLength).join('').trim()
  return `${base || 'book'}.${ext}`
}

/** 由文件名去掉扩展名 (含 .fb2.zip) */
export function baseNameOf(fileName: string): string {
  return fileName.replace(/\.fb2\.zip$/i, '').replace(/\.[^./\\]+$/, '')
}

/** 按文件头嗅探资源类型; 认不出时返回 fallback */
export function sniffMediaType(bytes: Uint8Array, fallback = ''): string {
  const b = bytes
  const at = (i: number, ...sig: number[]) => sig.every((v, k) => b[i + k] === v)
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, c => c.charCodeAt(0)))
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (ascii(0, 'GIF8')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(0, 'BM') && b.length > 14) return 'image/bmp'
  if (ascii(0, 'wOFF')) return 'font/woff'
  if (ascii(0, 'wOF2')) return 'font/woff2'
  if (ascii(0, 'OTTO')) return 'font/otf'
  if (at(0, 0x00, 0x01, 0x00, 0x00) || ascii(0, 'true')) return 'font/ttf'
  if (ascii(0, 'ID3') || at(0, 0xff, 0xfb)) return 'audio/mpeg'
  if (ascii(4, 'ftyp')) return 'video/mp4'
  // 文本类: 跳过 BOM 与空白看开头
  const head = new TextDecoder().decode(b.subarray(0, 256)).replace(/^﻿/, '').trimStart()
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return 'image/svg+xml'
  return fallback
}

/** 归一化常见的非标准 MIME (MOBI 字体等) */
export function normalizeMediaType(type: string): string {
  const t = (type || '').split(';')[0].trim().toLowerCase()
  const alias: Record<string, string> = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'application/x-font-ttf': 'font/ttf',
    'application/x-font-truetype': 'font/ttf',
    'application/font-sfnt': 'font/ttf',
    'application/x-font-otf': 'font/otf',
    'application/x-font-opentype': 'font/otf',
    'application/vnd.ms-opentype': 'font/otf',
    'application/font-woff': 'font/woff',
    'application/x-font-woff': 'font/woff',
  }
  return alias[t] ?? t
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'font/ttf': 'ttf', 'font/otf': 'otf', 'font/woff': 'woff', 'font/woff2': 'woff2',
  'text/css': 'css', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
  'application/xhtml+xml': 'xhtml',
}

export function extensionFor(mediaType: string): string {
  return EXT[mediaType] ?? 'bin'
}

/** 资源归档目录 (相对 OPF 所在目录) */
export function folderFor(mediaType: string): 'Images' | 'Fonts' | 'Styles' | 'Media' | 'Misc' {
  if (mediaType === 'text/css') return 'Styles'
  if (mediaType.startsWith('image/')) return 'Images'
  if (mediaType.startsWith('font/')) return 'Fonts'
  if (mediaType.startsWith('audio/') || mediaType.startsWith('video/')) return 'Media'
  return 'Misc'
}

/** 已压缩格式存储即可, 再 deflate 只会浪费时间 */
export function isCompressedMedia(mediaType: string): boolean {
  return /^(image\/(jpeg|png|gif|webp)|font\/woff2?|audio\/|video\/)/.test(mediaType)
}

/** from 文件 (OPF 目录下的相对路径) 引用 to 文件时的相对 URL; 各段做 URL 编码 */
export function relativeHref(from: string, to: string): string {
  const fromDir = from.split('/').slice(0, -1)
  const toParts = to.split('/')
  let i = 0
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++
  const up = fromDir.slice(i).map(() => '..')
  return [...up, ...toParts.slice(i)].map(seg => seg === '..' ? seg : encodeURIComponent(seg)).join('/')
}

/** CSS 里的 url(...) 与 @import "..." 逐个替换; replacer 返回 null 表示保持原样 */
export function rewriteCssUrls(css: string, replacer: (url: string) => string | null): string {
  return css
    .replace(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi, (whole, _q, url: string) => {
      const next = replacer(url.trim())
      return next == null ? whole : `url("${next}")`
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (whole, _q, url: string) => {
      const next = replacer(url.trim())
      return next == null ? whole : `@import "${next}"`
    })
}

/** 文本里出现的 blob: URL (CSS / SVG 资源内的二级引用) */
export const BLOB_URL_RE = /blob:[^\s"'()<>\\]+/g

/** dc:date 只接受 W3CDTF 形式, 取开头的 YYYY[-MM[-DD]] */
export function normalizeDate(value: string | undefined): string | undefined {
  const m = String(value ?? '').trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/)
  if (!m) return undefined
  return [m[1], m[2], m[3]].filter(Boolean).join('-')
}

/** ISBN-10/13 归一 (去掉横线空格), 不合法返回 undefined */
export function normalizeIsbn(value: string | undefined): string | undefined {
  const s = String(value ?? '').replace(/^(urn:)?isbn:?/i, '').replace(/[\s-]/g, '').toUpperCase()
  return /^(\d{9}[\dX]|\d{13})$/.test(s) ? s : undefined
}

/** BCP 47 语言标签的宽松检查; 不合法时回退 und */
export function normalizeLanguage(value: string | undefined): string {
  const s = String(value ?? '').trim().replace(/_/g, '-')
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(s) ? s : 'und'
}

export interface EpubMetadata {
  /** 唯一标识, 如 urn:uuid:... */
  identifier: string
  title: string
  authors: string[]
  language?: string
  publisher?: string
  description?: string
  isbn?: string
  date?: string
  subjects?: string[]
  rights?: string
  /** dcterms:modified, 形如 2026-10-05T00:00:00Z */
  modified: string
}

export interface ManifestItem {
  id: string
  /** 相对 OPF 的路径 */
  href: string
  mediaType: string
  properties?: string
}

export interface SpineItem {
  idref: string
  linear?: boolean
}

export interface TocNode {
  label: string
  /** 相对 OPF 的路径 + 片段 */
  href: string
  children?: TocNode[]
}

export interface OpfOptions {
  metadata: EpubMetadata
  manifest: ManifestItem[]
  spine: SpineItem[]
  /** NCX 的 manifest id (EPUB 2 阅读器兼容) */
  ncxId?: string
  /** 封面图片的 manifest id (同时写 EPUB 2 的 meta name="cover") */
  coverId?: string
  /** 'rtl' 时写 page-progression-direction */
  direction?: 'ltr' | 'rtl'
  /** 固定版式 (漫画式 KF8) */
  fixedLayout?: boolean
}

export function buildOpf(o: OpfOptions): string {
  const m = o.metadata
  const lang = normalizeLanguage(m.language)
  const lines: string[] = []
  lines.push(`<dc:identifier id="uid">${escapeXml(m.identifier)}</dc:identifier>`)
  if (m.isbn) lines.push(`<dc:identifier id="isbn">urn:isbn:${escapeXml(m.isbn)}</dc:identifier>`)
  lines.push(`<dc:title>${escapeXml(m.title || 'Untitled')}</dc:title>`)
  lines.push(`<dc:language>${escapeXml(lang)}</dc:language>`)
  m.authors.filter(Boolean).forEach((a, i) => {
    lines.push(`<dc:creator id="creator${i + 1}">${escapeXml(a)}</dc:creator>`)
    lines.push(`<meta refines="#creator${i + 1}" property="role" scheme="marc:relators">aut</meta>`)
  })
  if (m.publisher) lines.push(`<dc:publisher>${escapeXml(m.publisher)}</dc:publisher>`)
  const date = normalizeDate(m.date)
  if (date) lines.push(`<dc:date>${date}</dc:date>`)
  if (m.description) lines.push(`<dc:description>${escapeXml(m.description)}</dc:description>`)
  for (const s of m.subjects ?? []) if (s) lines.push(`<dc:subject>${escapeXml(s)}</dc:subject>`)
  if (m.rights) lines.push(`<dc:rights>${escapeXml(m.rights)}</dc:rights>`)
  lines.push(`<meta property="dcterms:modified">${escapeXml(m.modified)}</meta>`)
  if (o.fixedLayout) {
    lines.push('<meta property="rendition:layout">pre-paginated</meta>')
    lines.push('<meta property="rendition:spread">auto</meta>')
  }
  if (o.coverId) lines.push(`<meta name="cover" content="${escapeXml(o.coverId)}"/>`)
  lines.push('<meta name="generator" content="LightRead"/>')

  const manifest = o.manifest.map(item =>
    `<item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}"${
      item.properties ? ` properties="${escapeXml(item.properties)}"` : ''}/>`)
  const spineAttrs = [
    o.ncxId ? ` toc="${escapeXml(o.ncxId)}"` : '',
    o.direction === 'rtl' ? ' page-progression-direction="rtl"' : '',
  ].join('')
  const spine = o.spine.map(s =>
    `<itemref idref="${escapeXml(s.idref)}"${s.linear === false ? ' linear="no"' : ''}/>`)
  const prefix = o.fixedLayout ? ' prefix="rendition: http://www.idpf.org/vocab/rendition/#"' : ''

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${escapeXml(lang)}"${prefix}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${lines.join('\n    ')}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine${spineAttrs}>
    ${spine.join('\n    ')}
  </spine>
</package>
`
}

export function buildContainerXml(opfPath = 'OEBPS/content.opf'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${escapeXml(opfPath)}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
}

/** 目录项文字为空时阅读器会显示空行, nav 校验也不通过: 给个兜底 */
const tocLabel = (n: TocNode, fallback: string) => (n.label ?? '').replace(/\s+/g, ' ').trim() || fallback

/** EPUB 3 导航文档 (nav.xhtml 与 OPF 同目录, href 原样可用) */
export function buildNav(toc: TocNode[], o: { title: string; language?: string; tocTitle?: string; landmarks?: Array<{ type: string; href: string; label: string }> }): string {
  const lang = normalizeLanguage(o.language)
  const list = (nodes: TocNode[], depth: number): string => {
    const pad = '  '.repeat(depth + 2)
    return `${pad}<ol>\n${nodes.map((n, i) => {
      const children = n.children?.length ? `\n${list(n.children, depth + 2)}\n${pad}  ` : ''
      return `${pad}  <li><a href="${escapeXml(n.href)}">${escapeXml(tocLabel(n, `${i + 1}`))}</a>${children}</li>`
    }).join('\n')}\n${pad}</ol>`
  }
  const landmarks = o.landmarks?.length
    ? `\n  <nav epub:type="landmarks" id="landmarks" hidden="hidden">\n    <ol>\n${o.landmarks.map(l =>
      `      <li><a epub:type="${escapeXml(l.type)}" href="${escapeXml(l.href)}">${escapeXml(l.label)}</a></li>`).join('\n')}\n    </ol>\n  </nav>`
    : ''
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(o.title || o.tocTitle || 'Contents')}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(o.tocTitle || 'Contents')}</h1>
${list(toc.length ? toc : [{ label: o.title, href: '' }], 0)}
  </nav>${landmarks}
</body>
</html>
`
}

export function tocDepth(nodes: TocNode[]): number {
  return nodes.reduce((d, n) => Math.max(d, 1 + tocDepth(n.children ?? [])), 0)
}

/** EPUB 2 的 NCX 目录 (老阅读器 / Kindle 转换工具用); playOrder 按文档顺序递增 */
export function buildNcx(toc: TocNode[], o: { identifier: string; title: string }): string {
  let order = 0
  const point = (n: TocNode, i: number, depth: number): string => {
    const pad = '  '.repeat(depth + 2)
    const own = ++order
    const children = (n.children ?? []).map((c, k) => point(c, k, depth + 1)).join('\n')
    return `${pad}<navPoint id="np${own}" playOrder="${own}">
${pad}  <navLabel><text>${escapeXml(tocLabel(n, `${i + 1}`))}</text></navLabel>
${pad}  <content src="${escapeXml(n.href)}"/>${children ? `\n${children}` : ''}
${pad}</navPoint>`
  }
  const points = toc.map((n, i) => point(n, i, 0)).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(o.identifier)}"/>
    <meta name="dtb:depth" content="${Math.max(1, tocDepth(toc))}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(o.title || 'Untitled')}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`
}

/** 封面页 (原书正文里没有封面图时插在最前) */
export function buildCoverXhtml(imageHref: string, o: { title: string; language?: string }): string {
  const lang = normalizeLanguage(o.language)
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(o.title || 'Cover')}</title>
  <style>html, body { margin: 0; padding: 0; height: 100%; text-align: center; } img { max-width: 100%; max-height: 100%; object-fit: contain; }</style>
</head>
<body epub:type="cover">
  <img src="${escapeXml(imageHref)}" alt="${escapeXml(o.title || 'Cover')}"/>
</body>
</html>
`
}

export interface EpubEntry {
  /** zip 内完整路径 */
  path: string
  data: Uint8Array | string
  /** 已压缩的媒体: 直接存储 */
  store?: boolean
}

let crcTable: Uint32Array | undefined
/** CRC-32 (zip 用); 可分段累计: crc32(b, crc32(a)) === crc32(a+b) */
export function crc32(data: Uint8Array, previous = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = ~previous >>> 0
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}

/**
 * 打包为 EPUB (OCF): mimetype 必须是第一个条目、不压缩、无额外字段;
 * 其后依次是 container.xml 与其余文件. 逐个文件压缩, 每个文件之间调用 onYield
 * 让出主线程 (大书一次性 zipSync 会卡住界面几百毫秒).
 */
export async function zipEpub(entries: EpubEntry[], onYield?: () => Promise<void> | void): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const list: EpubEntry[] = [{ path: 'mimetype', data: 'application/epub+zip', store: true },
    ...entries.filter(e => e.path !== 'mimetype')]
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of list) {
    const name = enc.encode(e.path)
    const raw = typeof e.data === 'string' ? strToU8(e.data) : e.data
    let crc = 0
    for (let i = 0; i < raw.length; i += 1 << 20) {
      crc = crc32(raw.subarray(i, i + (1 << 20)), crc)
      if (raw.length > 1 << 20) await onYield?.()
    }
    let method = 0
    let body = raw
    if (!e.store && raw.length > 64) {
      const deflated = deflateSync(raw, { level: 6 })
      if (deflated.length < raw.length) { method = 8; body = deflated }
    }
    // UTF-8 文件名标记 (bit 11) 只在非 ASCII 时设置
    const flags = /[^\x20-\x7e]/.test(e.path) ? 0x0800 : 0
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    chunks.push(local, body)
    central.push(cd)
    offset += local.length + body.length
    await onYield?.()
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, list.length, true)
  ev.setUint16(10, list.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + end.length)
  let pos = 0
  for (const c of [...chunks, ...central, end]) { out.set(c, pos); pos += c.length }
  return out
}

/** EPUB 3 XHTML 里所有元素都可用的属性 (aria-* / data-* 另行放行) */
export const GLOBAL_ATTRS = new Set([
  'id', 'class', 'style', 'title', 'lang', 'dir', 'hidden', 'role', 'tabindex', 'translate', 'accesskey',
])

/** 各元素自己的合法属性 (只列电子书里常见的) */
export const ELEMENT_ATTRS: Record<string, string[]> = {
  a: ['href', 'hreflang', 'rel', 'target', 'type', 'download'],
  area: ['href', 'alt', 'coords', 'shape', 'rel', 'target'],
  img: ['src', 'alt', 'width', 'height', 'usemap', 'ismap'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  col: ['span'],
  colgroup: ['span'],
  table: ['border'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  blockquote: ['cite'],
  q: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  time: ['datetime'],
  data: ['value'],
  map: ['name'],
  audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload'],
  video: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload', 'poster', 'width', 'height'],
  source: ['src', 'type', 'media'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
}

/** HTML 长度属性 → CSS 长度; 不认识的返回 null */
export function cssLength(value: string): string | null {
  const v = value.trim().toLowerCase()
  const m = v.match(/^(-?\d*\.?\d+)(px|pt|em|ex|%|in|cm|mm|pc|rem)?$/)
  if (!m) return null
  return m[2] ? v : (Number(m[1]) === 0 ? '0' : `${m[1]}px`)
}

const TABLE_PARTS = new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'col', 'colgroup'])
const FONT_SIZE_NAMES = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large']

/**
 * 旧式外观属性 (EPUB 3 不允许) 换成等效 CSS 声明; 无对应时返回 '' (丢弃该属性).
 * 返回 'id' 表示 a[name] 应改作 id. srcTag 为原标签 (如 font), outTag 为输出标签 (如 span).
 * MOBI 6 里 <p width height> 表示首行缩进与段前距 (Calibre 也这样解释).
 */
export function legacyAttrStyle(srcTag: string, outTag: string, attr: string, value: string, hasId = false): string {
  const v = value.trim()
  if (!v && attr !== 'nowrap') return ''
  const lower = v.toLowerCase()
  switch (attr) {
    case 'color':
      return srcTag === 'font' ? `color: ${v}` : ''
    case 'face':
      return srcTag === 'font' ? `font-family: ${v}` : ''
    case 'size': {
      if (srcTag !== 'font') return ''
      const n = Number(v.replace(/^\+/, ''))
      if (!Number.isFinite(n)) return ''
      const level = /^[+-]/.test(v) ? 3 + n : n
      return `font-size: ${FONT_SIZE_NAMES[Math.max(1, Math.min(7, level)) - 1]}`
    }
    case 'bgcolor':
      return `background-color: ${v}`
    case 'name':
      return outTag === 'a' && !hasId ? 'id' : ''
    case 'valign':
      return /^(top|middle|bottom|baseline)$/.test(lower) ? `vertical-align: ${lower}` : ''
    case 'nowrap':
      return 'white-space: nowrap'
    case 'cellspacing': {
      const len = cssLength(v)
      return len ? `border-spacing: ${len}` : ''
    }
    case 'clear':
      return /^(left|right|all|both)$/.test(lower) ? `clear: ${lower === 'all' ? 'both' : lower}` : ''
    case 'type':
      return outTag === 'ul' && /^(disc|circle|square|none)$/.test(lower) ? `list-style-type: ${lower}` : ''
    case 'align':
      if (outTag === 'img') {
        if (lower === 'left' || lower === 'right') return `float: ${lower}`
        if (/^(top|middle|bottom)$/.test(lower)) return `vertical-align: ${lower}`
        return ''
      }
      if (outTag === 'table') {
        if (lower === 'center') return 'margin-left: auto; margin-right: auto'
        if (lower === 'left' || lower === 'right') return `float: ${lower}`
        return ''
      }
      if (outTag === 'caption') return ''
      return /^(left|right|center|justify)$/.test(lower) ? `text-align: ${lower}` : ''
    case 'width':
    case 'height': {
      const len = cssLength(v)
      if (!len) return ''
      if (outTag === 'table' || outTag === 'hr' || outTag === 'div' && srcTag !== 'div' || TABLE_PARTS.has(outTag)) {
        return `${attr}: ${len}`
      }
      // MOBI 6: width = 首行缩进, height = 段前距
      if (['p', 'div', 'blockquote', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(outTag)) {
        return attr === 'width' ? `text-indent: ${len}` : `margin-top: ${len}`
      }
      return ''
    }
    default:
      return ''
  }
}
