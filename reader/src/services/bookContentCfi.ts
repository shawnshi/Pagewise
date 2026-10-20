import * as CFI from 'foliate-js/epubcfi.js'

// Foliate's bundled declarations omit these exports. Verify the installed API at
// this boundary rather than widening the application's global module declarations.
if (!('fromRange' in CFI) || typeof CFI.fromRange !== 'function'
  || !('toRange' in CFI) || typeof CFI.toRange !== 'function'
  || !('joinIndir' in CFI) || typeof CFI.joinIndir !== 'function') {
  throw new Error('Unsupported Foliate CFI API')
}
const { fromRange, toRange, joinIndir } = CFI

interface SvgSection {
  url?: string
  roots: WeakMap<Document, Element>
}
interface Owner {
  active: boolean
  sections: Map<number, SvgSection>
}
interface CfiBook {
  sections: readonly { cfi?: string }[]
  resolveCFI?: (cfi: string) => { index: number; anchor: (doc: Document) => Range | number }
}
const owners = new WeakMap<CfiBook, Owner>()
const installed = new WeakSet<object>()
const svgNS = 'http://www.w3.org/2000/svg'

function textResult(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Foliate CFI result')
  return value
}
function rootFor(owner: Owner, section: SvgSection, doc: Document): Element {
  if (!owner.active) throw new Error('SVG CFI book already destroyed')
  let root = section.roots.get(doc)
  if (!root && section.url && doc.URL === section.url) {
    root = doc.body?.firstElementChild ?? undefined
    if (!root || root.namespaceURI !== svgNS || root.localName !== 'svg') throw new Error('Invalid secured SVG root')
    section.roots.set(doc, root)
  }
  if (!root || root.parentNode !== doc.body) throw new Error('SVG CFI document does not belong to this section')
  return root
}
function checkRange(root: Element, range: Range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)
    || range.startContainer === root || range.endContainer === root) {
    throw new Error('SVG CFI range is outside its registered root')
  }
}
function rootFilter(doc: Document, root: Element) {
  // Foliate's FILTER_SKIP flattens children and omits skipped ancestor steps in
  // fromRange. The same filter in toRange exposes exactly the original SVG root's
  // children, without string-prefix surgery or changing any text/ID assertions.
  return (node: Node) => node === doc.body || node === root ? NodeFilter.FILTER_SKIP
    : node.parentNode === doc.documentElement || node.parentNode === doc.body ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT
}
// P1b: Foliate's tokenizer silently overwrites repeated offsets and ignores
// unknown characters. Check raw structure before invoking that lossy parser.
function validRawCfi(cfi: string): boolean {
  if (!cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) return false
  const input = cfi.slice(8, -1)
  let pos = 0
  const number = (decimal = false) => {
    const match = (decimal ? /^\d+(?:\.\d+)?/ : /^\d+/).exec(input.slice(pos))
    if (!match) return false
    pos += match[0].length
    return true
  }
  let biased = false
  const assertion = () => {
    if (input[pos] !== '[') return true
    pos++
    while (pos < input.length) {
      const char = input[pos++]
      if (char === '^') { if (pos === input.length) return false; pos++ }
      else if (char === ']') return true
      else if (char === ';') {
        if (!/^s=[ab]\]/.test(input.slice(pos))) return false
        biased = true; pos += 4; return true
      }
      else if (char === '[' || char === '(' || char === ')') return false
    }
    return false
  }
  let lastCount = 0, lastQualified = false, lastOdd = false
  const path = (empty = false) => {
    let count = 0, qualified = false, odd = false
    while (input[pos] === '/') {
      pos++; count++
      const begin = pos
      if (!number()) return false
      odd = Number(input.slice(begin, pos)) % 2 === 1
      biased = false
      if (!assertion()) return false
      qualified = false
      // Character offsets apply only to character-data steps, never elements
      // (including :0). partToString otherwise silently erases them.
      if (input[pos] === ':') { if (!odd) return false; qualified = true; pos++; if (!number()) return false }
      if (input[pos] === '~') { qualified = true; pos++; if (!number(true)) return false }
      if (input[pos] === '@') {
        qualified = true; pos++
        if (!number(true) || input[pos++] !== ':' || !number(true)) return false
      }
      if (qualified && !assertion()) return false
      qualified ||= biased
      if ((qualified || odd) && (input[pos] === '/' || input[pos] === '!')) return false
    }
    lastCount = count; lastQualified = qualified; lastOdd = odd
    return count > 0 || (empty && (input[pos] === ',' || pos === input.length))
  }
  if (!path()) return false
  let local = false
  while (input[pos] === '!') { pos++; local = true; if (!path(true)) return false }
  if (input[pos] === ',') {
    const parentCount = lastCount, parentTerminal = lastQualified || lastOdd
    if (!local) return false
    pos++
    if (!path(true)) return false
    const startCount = lastCount
    if (input[pos++] !== ',' || !path(true)) return false
    const endCount = lastCount
    // buildRange may emit an empty relative endpoint, but it must inherit an
    // actual parent path; a terminal parent cannot then acquire child steps.
    if ((!parentCount && (!startCount || !endCount)) || (parentTerminal && (startCount || endCount))) return false
  } else if (!lastCount) return false
  return pos === input.length
}

interface Step { index: number; id?: string; offset?: number }
function steps(cfi: string, end: boolean, indirections: number, pathIndex = -1): Step[] {
  const parsed = CFI.parse(CFI.collapse(cfi, end))
  if (!Array.isArray(parsed) || parsed.length !== indirections || !Array.isArray(parsed.at(pathIndex))) {
    throw new Error('Unsupported SVG CFI indirection')
  }
  const result: Step[] = []
  for (const value of parsed.at(pathIndex)) {
    if (!value || typeof value !== 'object' || !Number.isInteger(value.index) || value.index < 0
      || (value.id !== undefined && typeof value.id !== 'string')
      || (value.offset !== undefined && (!Number.isInteger(value.offset) || value.offset < 0))) {
      throw new Error('Invalid SVG CFI step')
    }
    result.push(value)
  }
  if (!result.length) throw new Error('Empty SVG CFI path')
  return result
}
function sameTarget(expected: Step[], actual: Step[]) {
  if (expected.length !== actual.length || expected.some((step, i) => {
    const other = actual[i]!
    return step.index !== other.index || (step.offset ?? 0) !== (other.offset ?? 0)
      || (step.id !== undefined && step.id !== other.id)
  })) throw new Error('SVG CFI target does not match the original coordinates')
}

/** Called only by the trusted book URL boundary, never from book DOM attributes. */
export function registerBookContentCfi(book: CfiBook) {
  if (owners.has(book)) throw new Error('Book CFI boundary already registered')
  const owner: Owner = { active: true, sections: new Map() }
  owners.set(book, owner)
  const sectionFor = (index: number) => {
    let section = owner.sections.get(index)
    if (!section) { section = { roots: new WeakMap() }; owner.sections.set(index, section) }
    return section
  }
  const resolve = book.resolveCFI
  if (resolve) book.resolveCFI = (cfi: string) => {
    if (!validRawCfi(cfi)) throw new Error('Invalid raw CFI syntax')
    const resolved = resolve.call(book, cfi)
    if (!resolved || typeof resolved.index !== 'number' || typeof resolved.anchor !== 'function') {
      throw new Error('Invalid Foliate resolved CFI')
    }
    return { ...resolved, anchor: (doc: Document) => {
      const section = owner.sections.get(resolved.index)
      if (!section) return resolved.anchor(doc)
      const root = rootFor(owner, section, doc), filter = rootFilter(doc, root)
      const base = book.sections[resolved.index]?.cfi
      if (!base) throw new Error('Missing original SVG section CFI')
      const collapsed = CFI.parse(CFI.collapse(cfi))
      if (!Array.isArray(collapsed) || (collapsed.length !== 1 && collapsed.length !== 2)) throw new Error('Unsupported SVG CFI indirection')
      sameTarget(steps(cfi, false, collapsed.length, 0), steps(base, false, 1))
      sameTarget(steps(cfi, true, collapsed.length, 0), steps(base, false, 1))
      const parsed = CFI.parse(cfi)
      if (Array.isArray(parsed) && parsed.length === 1) {
        // Old FXL relocate stores only the spine CFI (range:null). Its exact
        // meaning is the section, not a missing local point to approximate.
        return 0
      }
      const start = steps(cfi, false, 2), end = steps(cfi, true, 2)
      // Validate each endpoint before DOM Range ordering can collapse/reorder
      // element/text boundaries. This preserves upstream buildRange targets,
      // while still rejecting its virtual-node and ID-shortcut retargeting.
      for (const endpoint of [start, end]) {
        const point: Range = toRange(doc, { parent: [[]], start: [endpoint], end: [endpoint] }, filter)
        checkRange(root, point)
        sameTarget(endpoint, steps(textResult(fromRange(point, filter)), false, 1))
      }
      const range: Range = toRange(doc, { parent: [[]], start: [start], end: [end] }, filter)
      checkRange(root, range)
      return range
    } }
  }
  return {
    document(index: number, doc: Document, root: Element) {
      if (!owner.active || root.ownerDocument !== doc || root.parentNode !== doc.body || root.namespaceURI !== svgNS) {
        throw new Error('Invalid SVG CFI document registration')
      }
      sectionFor(index).roots.set(doc, root)
    },
    url(index: number, url: string) { sectionFor(index).url = url },
    clear(index: number) {
      const section = owner.sections.get(index)
      if (section) { section.url = undefined; section.roots = new WeakMap() }
    },
    destroy() {
      owner.active = false
      for (const index of owner.sections.keys()) this.clear(index)
    },
  }
}

/** undefined preserves HTML behavior; null means no live trusted SVG document. */
export function bookContentRoot(book: CfiBook, index: number, doc: Document): Element | null | undefined {
  const owner = owners.get(book), section = owner?.sections.get(index)
  if (!owner || !section) return undefined
  if (!owner.active || (!section.roots.has(doc) && doc.URL !== section.url)) return null
  return rootFor(owner, section, doc)
}

/** The only missing upstream hook: View.getCFI calls fromRange without a filter. */
export function installBookContentCfi(View: unknown) {
  if (typeof View !== 'function') throw new Error('Unsupported Foliate View API')
  const prototype = View.prototype
  if (installed.has(prototype)) return
  const original = prototype.getCFI
  if (typeof original !== 'function') throw new Error('Unsupported Foliate View.getCFI API')
  prototype.getCFI = function (this: { book: CfiBook }, index: number, range?: Range) {
    const owner = owners.get(this.book), section = owner?.sections.get(index)
    if (!owner || !section || !range) return original.call(this, index, range)
    const doc = range.startContainer.ownerDocument
    if (!doc || range.endContainer.ownerDocument !== doc) throw new Error('SVG CFI range crosses documents')
    const root = rootFor(owner, section, doc)
    checkRange(root, range)
    const local = textResult(fromRange(range, rootFilter(doc, root)))
    return textResult(joinIndir(original.call(this, index), local))
  }
  installed.add(prototype)
}
