import type { TypographyDisplayMode } from '../stores/settings'

export const PROTECTED_FONT_RUNS = ['code', 'pre', 'kbd', 'samp', 'sup', 'sub', 'ruby', 'math', 'svg', '[data-pw-preserve-font]', '.math', '.mathjax', '.katex', '.ipa', '.phonetic', '.gaiji', '.ancient']

const fontMetrics = ['font-size', 'font-family', 'line-height', 'letter-spacing', 'font-synthesis']
const paragraphMetrics = [...fontMetrics, 'text-indent', 'text-align', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'margin-block', 'margin-block-start', 'margin-block-end', 'margin-inline', 'margin-inline-start', 'margin-inline-end']
const fontRestore = ['font', 'font-style', 'font-weight', 'font-variant', 'font-stretch', ...fontMetrics]
type Declaration = { name: string; value: string; priority: string }
type Snapshot = { element: HTMLElement; remove: string[]; declarations: Declaration[] }
const snapshots = new WeakMap<Document, Map<HTMLElement, Snapshot>>()
const appliedModes = new WeakMap<Document, TypographyDisplayMode>()

/** Temporarily resolve inline !important conflicts in ordinary prose only.
 * No text nodes, source files, emphasis weights or italics are reconstructed.
 * Publisher/repair/rollback restore declarations in their original CSSOM order.
 */
export function applyTypographyDocumentMode(doc: Document, mode: TypographyDisplayMode) {
  if (appliedModes.get(doc) === mode) return
  const saved = snapshots.get(doc) ?? new Map<HTMLElement, Snapshot>()
  if (mode !== 'optimized') {
    for (const { element, remove, declarations } of saved.values()) {
      for (const name of remove) element.style.removeProperty(name)
      for (const { name, value, priority } of declarations) element.style.setProperty(name, value, priority)
    }
    appliedModes.set(doc, mode)
    return
  }
  const normalize = (element: HTMLElement | null, remove: string[], force = false) => {
    if (!element || element.closest(PROTECTED_FONT_RUNS.join(',')) || (!force && (!element.style?.length || !remove.some(name => element.style.getPropertyValue(name))))) return
    if (!saved.has(element)) {
      const declarations = Array.from(element.style).filter(name => remove.includes(name) || fontRestore.includes(name))
        .map(name => ({ name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }))
      saved.set(element, { element, remove, declarations })
    }
    // Remove longhands rather than the font shorthand: bold and italic remain intact.
    for (const name of remove) element.style.removeProperty(name)
  }
  normalize(doc.documentElement, fontMetrics)
  normalize(doc.body, fontMetrics)
  for (const p of doc.querySelectorAll<HTMLElement>('p[data-pw-paragraph]')) {
    normalize(p, paragraphMetrics)
    for (const span of p.querySelectorAll<HTMLElement>('span:not(code span, kbd span, samp span, sup span, sub span)')) normalize(span, fontMetrics)
  }
  for (const el of doc.querySelectorAll<HTMLElement>('[data-pw-semantic],[data-pw-semantic-text]')) {
    normalize(el, [...fontMetrics, '--pw-semantic-size'], true)
    const ratio = Number(el.getAttribute('data-pw-author-em'))
    if (Number.isFinite(ratio) && ratio > 0) el.style.setProperty('--pw-semantic-size', `${ratio}rem`)
  }
  snapshots.set(doc, saved)
  appliedModes.set(doc, mode)
}
