import { registerBookContentCfi } from './bookContentCfi.ts'

// PW-A01: same-origin book DOM is required by Foliate CFI/selection. Enforce the
// trust boundary before iframe navigation, not in a post-load event handler.
const BOOK_CSP = [
  "default-src 'none'", "script-src 'none'", "connect-src 'none'",
  "style-src 'unsafe-inline' blob: data:", 'img-src blob: data:',
  'media-src blob: data:', "frame-src 'none'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "worker-src 'none'", "manifest-src 'none'",
].join('; ')

const blockedElements = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base',
  'template', 'noscript', 'foreignobject', 'animate', 'animatemotion',
  'animatetransform', 'set', 'discard',
])
const resourceAttributes = new Set([
  'src', 'href', 'poster', 'background', 'data', 'lowsrc', 'dynsrc',
  'codebase', 'archive', 'classid', 'profile', 'longdesc', 'usemap',
])
const droppedAttributes = new Set([
  'srcdoc', 'srcset', 'imagesrcset', 'ping', 'target', 'download', 'nonce',
  'action', 'formaction', 'manifest', 'is',
])
const htmlNS = 'http://www.w3.org/1999/xhtml'
const svgNS = 'http://www.w3.org/2000/svg'
const mathNS = 'http://www.w3.org/1998/Math/MathML'

function localResource(value: string) {
  return /^(?:blob:|data:|#)/i.test(value.trim())
}
function safeLink(value: string) {
  const normalized = value.replace(/[\u0000-\u0020\u007f]/g, '')
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase()
  return !scheme || ['http', 'https', 'mailto', 'tel', 'filepos', 'kindle', 'epubcfi'].includes(scheme)
}

/** Sanitizes an inert document without changing ordinary body element indices. */
function sanitizeDocument(doc: Document, onSvg?: (doc: Document, root: Element) => void): Document {
  if (doc.querySelector('parsererror')) throw new Error('Book content XML parsing error')
  for (const element of doc.querySelectorAll('*')) {
    const tag = element.localName.toLowerCase()
    const ns = element.namespaceURI
    const blocked = blockedElements.has(tag)
      || (ns !== htmlNS && ns !== svgNS && ns !== mathNS)
      || (tag === 'meta' && !element.hasAttribute('charset') && element.getAttribute('name')?.toLowerCase() !== 'viewport')
      || (tag === 'link' && element.getAttribute('rel')?.toLowerCase() !== 'stylesheet')
    if (blocked) {
      // P1a: a span in head is moved into body by the HTML parser and shifts
      // ID-less body CFIs. Meta is inert and head-valid after real navigation.
      const placeholderTag = doc.head?.contains(element) ? 'meta' : ns === svgNS ? 'g' : 'span'
      const placeholder = doc.createElementNS(ns === svgNS ? svgNS : htmlNS, placeholderTag)
      placeholder.setAttribute('hidden', '')
      element.replaceWith(placeholder)
      continue
    }
    // NamedNodeMap is live; snapshot it so removals cannot skip the next attribute.
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase()
      if (name.startsWith('on') || droppedAttributes.has(name)
        || (resourceAttributes.has(name) && !(tag === 'a' && name === 'href'
          ? safeLink(attribute.value) : localResource(attribute.value)))) {
        element.removeAttributeNode(attribute)
      }
    }
  }
  // XML stylesheet PIs can initiate loads outside the element/attribute model.
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_PROCESSING_INSTRUCTION)
  const instructions: Node[] = []
  while (walker.nextNode()) instructions.push(walker.currentNode)
  for (const instruction of instructions) instruction.parentNode?.removeChild(instruction)

  if (doc.documentElement.namespaceURI === svgNS) {
    // CSP meta is not enforced in standalone SVG. Keep its graphics in an HTML
    // document instead. The trusted CFI registry hides these wrapper coordinates.
    const wrapper = document.implementation.createHTMLDocument('')
    const charset = wrapper.createElement('meta')
    charset.setAttribute('charset', 'utf-8')
    wrapper.head.append(charset)
    const root = doc.documentElement
    const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
    const width = viewBox?.[2] ?? Number(root.getAttribute('width'))
    const height = viewBox?.[3] ?? Number(root.getAttribute('height'))
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const viewport = wrapper.createElement('meta')
      viewport.name = 'viewport'
      viewport.content = `width=${width},height=${height}`
      wrapper.head.append(viewport)
    }
    wrapper.body.style.margin = '0'
    const securedRoot = wrapper.importNode(root, true)
    wrapper.body.append(securedRoot)
    doc = wrapper
    onSvg?.(doc, securedRoot)
  }
  if (!doc.head || !doc.body) throw new Error('Unsupported book document root')
  const csp = doc.createElementNS(htmlNS, 'meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  // Reader-owned bundled faces are app assets, not archive URLs. Do not allow
  // all of 'self': book CSS must not probe arbitrary app endpoints or the network.
  const bundledFonts = new URL('/fonts/', location.href)
  const fontSource = /^https?:$/.test(bundledFonts.protocol) ? ` ${bundledFonts.href}` : ''
  csp.setAttribute('content', `${BOOK_CSP}; font-src blob: data:${fontSource}`)
  doc.head.prepend(csp)
  return doc
}

interface BookSection {
  cfi?: string
  load?: () => string | null | Promise<string | null>
  unload?: () => void
  createDocument?: () => Document | Promise<Document>
}
interface ContentBook {
  sections: BookSection[]
  destroy?: () => void
}

/** Owns only the sanitized URLs; Foliate retains ownership of archive resources. */
export function secureBookContent<T extends ContentBook>(book: T): T {
  let destroyed = false
  const cleanups: (() => void)[] = []
  const cfi = registerBookContentCfi(book)
  for (const [index, section] of book.sections.entries()) {
    // KF8 can expose non-renderable linear:no entries with no loader.
    if (!section.load) continue
    const load = section.load.bind(section)
    const unload = section.unload?.bind(section)
    const createDocument = section.createDocument?.bind(section)
    let generation = 0
    let pending: Promise<string | null> | undefined
    let safeURL: string | undefined
    const clear = () => {
      generation++
      if (safeURL) URL.revokeObjectURL(safeURL)
      safeURL = undefined
      pending = undefined
      cfi.clear(index)
    }
    cleanups.push(clear)
    section.load = () => {
      if (destroyed) return Promise.reject(new Error('Book content already destroyed'))
      if (pending) return pending
      const owner = generation
      pending = (async () => {
        const source = await load()
        if (destroyed || owner !== generation) throw new Error('Book content load cancelled')
        if (source === null) return null
        // Installed EPUB, MOBI6 and KF8 all return generated blob URLs. Never
        // fetch an untrusted section URL or silently treat a failed read as empty.
        if (!source.startsWith('blob:')) throw new Error('Non-local book document URL')
        const response = await fetch(source)
        if (!response.ok) throw new Error(`Book content read failed: ${response.status}`)
        const blob = await response.blob()
        const type = blob.type.split(';')[0]
        if (type !== 'text/html' && type !== 'application/xhtml+xml' && type !== 'image/svg+xml') {
          throw new Error(`Unsupported book content type: ${type}`)
        }
        const sourceText = await blob.text()
        if (destroyed || owner !== generation) throw new Error('Book content load cancelled')
        let svg = false
        const doc = sanitizeDocument(new DOMParser().parseFromString(sourceText, type), (doc, root) => {
          svg = true
          cfi.document(index, doc, root)
        })
        const outputType = type === 'image/svg+xml' ? 'text/html;charset=utf-8' : type
        safeURL = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: outputType }))
        if (svg) cfi.url(index, safeURL)
        return safeURL
      })()
      return pending
    }
    section.unload = () => { clear(); unload?.() }
    if (createDocument) section.createDocument = async () => {
      if (destroyed) throw new Error('Book content already destroyed')
      const doc = await createDocument()
      if (destroyed) throw new Error('Book content load cancelled')
      return sanitizeDocument(doc, (secured, root) => cfi.document(index, secured, root))
    }
  }
  const destroy = book.destroy?.bind(book)
  book.destroy = () => {
    if (destroyed) return
    destroyed = true
    for (const clear of cleanups) clear()
    cfi.destroy()
    destroy?.()
  }
  return book
}
