interface LayoutView {
  lastLocation?: { cfi?: string }
  renderer?: { getContents?: () => { doc: Document }[] }
}

/** An ephemeral equality witness, never a cross-document readiness cache. */
export function layoutWitness(view: LayoutView, revision: string): readonly unknown[] | null {
  const contents = view.renderer?.getContents?.() ?? []
  if (!contents.length || !view.lastLocation?.cfi) return null
  const values: unknown[] = [view, view.lastLocation.cfi, revision]
  for (const { doc } of contents) {
    if (doc.readyState !== 'complete' || !doc.body || doc.fonts?.status !== 'loaded'
      || [...doc.images].some(image => !image.complete)) return null
    const style = doc.defaultView?.getComputedStyle(doc.body)
    if (!style) return null
    const rect = doc.body.getBoundingClientRect()
    values.push(doc, doc.fonts, doc.documentElement.scrollWidth, doc.documentElement.scrollHeight,
      rect.width, rect.height, style.cssText, style.font, style.lineHeight, style.writingMode,
      ...Array.from(doc.fonts).flatMap(font => [font, font.status]))
  }
  return values
}

export function sameLayoutWitness(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
  return !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}
