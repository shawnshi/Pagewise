import { normalizeLanguageTag } from '../stores/settings.ts'
import { automaticFontFamily, defaultTypographyProfile, type TypographyProfile } from './readerTypographyProfiles.ts'

export interface BookTypographyContext {
  language: string
  profile: TypographyProfile
  source: 'metadata' | 'html' | 'text' | 'unknown'
  sampledSections: number
  protectedLayout: 'fixed' | 'vertical' | null
  warnings: string[]
}
export const UNKNOWN_TYPOGRAPHY_CONTEXT: BookTypographyContext = {
  language: 'und', profile: 'original', source: 'unknown', sampledSections: 0, protectedLayout: null, warnings: [],
}
const EN_WORDS = new Set('the and that this with from for was were are have has had not but you your his her their they them into which when what would could should about there been will can of to in on as is it be'.split(' '))

export function canonicalBookLanguage(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().replaceAll('_', '-')
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value) || value.toLowerCase() === 'und') return ''
  try { return Intl.getCanonicalLocales(value)[0] ?? '' } catch { return '' }
}

export function textLanguageEvidence(text: string): { language: 'zh' | 'en' | 'und'; han: number; latin: number; mixed: boolean } {
  const han = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (text.match(/[a-z]/gi) ?? []).length
  const words = text.toLowerCase().match(/[a-z]{2,}(?:['’-][a-z]+)*/g) ?? []
  const hits = words.filter(w => EN_WORDS.has(w)).length
  const otherCjk = (text.match(/[\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const english = words.length >= 8 && hits >= 3 && hits / words.length >= 0.12
  const language = otherCjk > 10 ? 'und' : han >= 20 && han / Math.max(1, han + latin) >= 0.6 ? 'zh'
    : english && latin / Math.max(1, han + latin) >= 0.85 ? 'en' : 'und'
  return { language, han, latin, mixed: han >= 30 && english && han / (han + latin) >= 0.15 && latin / (han + latin) >= 0.15 }
}

interface TypographyBook {
  metadata?: { language?: unknown }
  rendition?: { layout?: string }
  sections?: readonly { linear?: string | boolean; createDocument?: () => Document | Promise<Document> }[]
}

export async function resolveBookTypographyContext(book: TypographyBook, opts: {
  languageHint?: string
  generatedText?: boolean
  current?: () => boolean
} = {}): Promise<BookTypographyContext> {
  const raw = Array.isArray(book.metadata?.language) ? book.metadata.language : [book.metadata?.language]
  const declared = opts.generatedText ? [] : raw.map(canonicalBookLanguage).filter(Boolean)
  const hint = !opts.generatedText ? canonicalBookLanguage(opts.languageHint) : ''
  let language = declared[0] || hint || 'und'
  let source: BookTypographyContext['source'] = language === 'und' ? 'unknown' : 'metadata'
  if (book.rendition?.layout === 'pre-paginated') return { language, profile: 'original', source, sampledSections: 0, protectedLayout: 'fixed', warnings: [] }
  const sections = (book.sections ?? []).filter(s => s.linear !== 'no' && s.linear !== false && typeof s.createDocument === 'function')
  const indices = [...new Set([0, Math.floor(sections.length / 2), sections.length - 1])].filter(i => i >= 0 && i < sections.length)
  const samples: { lang: string; text: string; language: 'zh' | 'en' | 'und'; mixed: boolean; han: number; latin: number }[] = []
  const warnings: string[] = []
  let vertical = false
  for (const index of indices) {
    if (opts.current && !opts.current()) throw new Error('Typography context superseded')
    try {
      const doc = await sections[index]!.createDocument!()
      if (opts.current && !opts.current()) throw new Error('Typography context superseded')
      const text = (doc.body?.textContent ?? '').slice(0, 4000)
      const lang = opts.generatedText ? '' : canonicalBookLanguage(doc.documentElement.lang || doc.documentElement.getAttribute('xml:lang'))
      const paragraphs = [...doc.querySelectorAll('p')].slice(0, 80).map(p => textLanguageEvidence((p.textContent ?? '').slice(0, 600)))
      const evidence = textLanguageEvidence(text)
      const mixed = evidence.mixed && paragraphs.filter(p => p.language === 'zh').length >= 2 && paragraphs.filter(p => p.language === 'en').length >= 2
      vertical ||= /vertical/.test(doc.documentElement.style.writingMode || doc.body?.style.writingMode || '')
      samples.push({ lang, text, ...evidence, mixed })
    } catch (error) {
      if (opts.current && !opts.current()) throw error
      warnings.push(`sample-${index}-unavailable`)
    }
  }
  const useful = samples.filter(s => s.han + s.latin >= 100)
  const unanimous = useful.length && useful.every(s => s.language !== 'und' && s.language === useful[0]!.language) ? useful[0]!.language : 'und'
  const strongConflict = language !== 'und' && unanimous !== 'und' && normalizeLanguageTag(language) !== unanimous &&
    useful.reduce((n, s) => n + s.han + s.latin, 0) >= 1200 && (useful.length >= 2 || sections.length === 1)
  if (strongConflict) { language = unanimous; source = 'text'; warnings.push('declared-language-conflicts-with-text') }
  if (language === 'und') {
    const html = useful.map(s => s.lang).filter(Boolean)
    if (html.length && html.every(l => normalizeLanguageTag(l) === normalizeLanguageTag(html[0]!))) { language = html[0]!; source = 'html' }
    else if (unanimous !== 'und') { language = unanimous; source = 'text' }
  }
  // Refine an unspecified Chinese region only from explicit, compatible document metadata, never from Han characters alone.
  if (normalizeLanguageTag(language) === 'zh' && !language.includes('-')) {
    const regional = samples.map(s => s.lang).find(l => normalizeLanguageTag(l) === 'zh' && l.includes('-'))
    if (regional) language = regional
  }
  const group = normalizeLanguageTag(language)
  const bilingual = new Set(declared.map(normalizeLanguageTag)).has('zh') && new Set(declared.map(normalizeLanguageTag)).has('en')
  const mixed = (group === 'zh' || group === 'en' || group === 'und') && (bilingual || samples.filter(s => s.mixed).length >= Math.min(2, Math.max(1, samples.length)))
  if (mixed && language === 'und') source = 'text'
  return { language, profile: vertical ? 'original' : mixed ? 'mixed' : defaultTypographyProfile(group), source,
    sampledSections: samples.length, protectedLayout: vertical ? 'vertical' : null, warnings }
}

/** Explicit lifetime across delayed sampling, view handoff and component disposal. */
export function createTypographyBookOwner() {
  type Book = { destroy?: () => void }
  let current: Book | null = null
  let disposed = false
  const released = new WeakSet<Book>()
  const releaseOne = (book: Book) => { if (!released.has(book)) { released.add(book); book.destroy?.() } }
  const release = () => { const book = current; current = null; if (book) releaseOne(book) }
  return {
    adopt(book: Book) {
      if (current) throw new Error('A reader book is already owned')
      if (released.has(book)) throw new Error('A released book cannot be reused')
      if (disposed) { releaseOne(book); return false }
      current = book
      return true
    },
    release,
    dispose() { disposed = true; release() },
  }
}

const preparedDocuments = new WeakMap<Document, string>()

/** Only attributes and style variables are changed; no text or paragraph nodes are inserted. */
export function prepareTypographyDocument(doc: Document, context: BookTypographyContext, profile = context.profile): void {
  if (context.protectedLayout) return
  const root = doc.documentElement
  if ((!canonicalBookLanguage(root.lang) || context.source === 'text') && context.language !== 'und') {
    root.lang = context.language
    root.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', context.language)
  }
  root.style.setProperty('--pw-auto-font-family', automaticFontFamily(profile, root.lang || context.language))
  const signature = context.language + '|' + context.source
  if (preparedDocuments.get(doc) === signature) return
  preparedDocuments.set(doc, signature)
  // Styling the already-rendered chapter is separate from bounded book-language sampling.
  const rootSize = parseFloat(doc.defaultView?.getComputedStyle(root).fontSize ?? '')
  const semantic = new Map<HTMLElement, { role?: string; text?: boolean; size: number }>()
  const capture = (el: HTMLElement, flags: { role?: string; text?: boolean }) => {
    const size = parseFloat(doc.defaultView?.getComputedStyle(el).fontSize ?? '')
    semantic.set(el, { ...semantic.get(el), ...flags, size: rootSize > 0 && size > 0 ? Math.round(size / rootSize * 10000) / 10000 : 0 })
  }
  for (const el of doc.querySelectorAll<HTMLElement>('h1,h2,h3,figcaption,caption,td,th,[role="doc-footnote"],aside')) {
    if (el.closest('blockquote,li,dd,pre,code,.poem,.poetry,.verse,[role="doc-poem"],svg,math,ruby') || el.querySelector('ruby,math,img,svg,video,audio,table,pre,code')) continue
    const tag = el.localName
    const role = /^h[123]$/.test(tag) ? tag : tag === 'figcaption' || tag === 'caption' ? 'caption'
      : tag === 'td' || tag === 'th' ? 'cell' : el.getAttribute('role') === 'doc-footnote' || el.getAttribute('epub:type')?.split(/\s+/).includes('footnote') ? 'note' : null
    if (!role) continue
    capture(el, { role })
    for (const child of el.querySelectorAll<HTMLElement>('p,div,span')) {
      if (!child.closest('code,pre,kbd,samp,sup,sub,ruby,math,svg')) capture(child, { text: true })
    }
  }
  // Capture descendants before markers activate CSS; their larger authored text must not inherit a smaller container.
  for (const [el, value] of semantic) {
    if (value.size > 0) el.setAttribute('data-pw-author-em', String(value.size))
    else el.removeAttribute('data-pw-author-em')
    if (value.role) el.setAttribute('data-pw-semantic', value.role)
    if (value.text) el.setAttribute('data-pw-semantic-text', '')
  }
  const paragraphs = [...doc.querySelectorAll('p')]
  const preservedWhitespace = new Set(paragraphs.filter(p => /^pre/.test(p.style.whiteSpace || doc.defaultView?.getComputedStyle(p).whiteSpace || '')))
  for (const p of paragraphs) {
    p.removeAttribute('data-pw-paragraph'); p.removeAttribute('data-pw-after-heading')
    // A mixed semantic paragraph is protected as a whole, in either containment direction.
    if (semantic.has(p) || p.closest('blockquote,li,td,th,dd,pre,code,figure,aside,.poem,.poetry,.verse,[role="doc-poem"],[role="doc-footnote"]') || p.querySelector('ruby,math,img,svg,video,audio,table,pre,[data-pw-semantic],[data-pw-semantic-text]') || preservedWhitespace.has(p)) continue
    const evidence = textLanguageEvidence((p.textContent ?? '').slice(0, 1000))
    const explicit = canonicalBookLanguage(p.getAttribute('lang') || p.getAttribute('xml:lang'))
    if (explicit && !['zh', 'en'].includes(normalizeLanguageTag(explicit))) continue
    const kind = evidence.han >= 4 && evidence.han > evidence.latin ? 'zh' : evidence.language === 'und' ? normalizeLanguageTag(root.lang || context.language) === 'en' ? 'en' : 'zh' : evidence.language
    p.setAttribute('data-pw-paragraph', kind)
    if (kind === 'en' && (p.previousElementSibling?.matches('h1,h2,h3,h4,h5,h6,hr') || !p.previousElementSibling)) p.setAttribute('data-pw-after-heading', '')
    if (kind === 'en' && !explicit && ['zh', 'en', 'und'].includes(normalizeLanguageTag(root.lang || context.language))) { p.lang = 'en'; p.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'en') }
  }
}
