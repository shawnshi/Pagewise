export interface ReadingLocation {
  cfi: string
  fraction: number
}

export interface InspectionLocation<Context> {
  origin: ReadingLocation
  context: Context
  available: boolean
}

export type ReaderBackTarget = 'editor' | 'selection' | 'inspection' | 'panel' | 'toolbar' | 'leave'

export function readerBackTarget(state: {
  editor: boolean; selection: boolean; inspection: boolean; panel: boolean; toolbar: boolean
}): ReaderBackTarget {
  if (state.editor) return 'editor'
  if (state.selection) return 'selection'
  if (state.inspection) return 'inspection'
  if (state.panel) return 'panel'
  if (state.toolbar) return 'toolbar'
  return 'leave'
}

/** Structural checks also work for elements from foliate's separate document realm. */
export function isReaderInteractive(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  return !!element?.closest?.('a[href],button,input,textarea,select,label,[contenteditable="true"],[role="button"],img,svg,video,audio')
}

export function blocksReaderTurn(state: {
  panel: boolean; selection: boolean; navigating?: boolean; interactive?: boolean; selectionGesture?: boolean
}): boolean {
  return state.panel || state.selection || !!state.navigating || !!state.interactive || !!state.selectionGesture
}

export function createReaderContext() {
  let revision = 0
  let disposed = false
  return {
    capture: () => revision,
    current: (token: number) => !disposed && token === revision,
    invalidate: () => { revision++ },
    dispose: () => { disposed = true; revision++ },
  }
}

/** Owns only primary progress. Inspection relocations never enter the pending-save slot. */
export function createReaderSession<Context>(options: {
  save: (location: ReadingLocation) => Promise<unknown>
  navigate: (target: string) => Promise<unknown>
  onChange?: () => void
  onSaveError?: (error: unknown) => void
  delay?: number
}) {
  let reading: ReadingLocation | null = null
  let visible: ReadingLocation | null = null
  let pending: ReadingLocation | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | null = null
  const inspections: InspectionLocation<Context>[] = []
  let navigating = false
  let disposed = false
  const context = createReaderContext()
  const changed = () => options.onChange?.()
  const cancelTimer = () => { clearTimeout(timer); timer = undefined }

  function flush(): Promise<void> {
    cancelTimer()
    if (flushing) return flushing
    flushing = (async () => {
      while (pending) {
        const location = pending
        pending = null
        try { await options.save(location) }
        catch (error) {
          // A newer primary position must not be replaced by the failed older write.
          pending ??= location
          throw error
        }
      }
    })().finally(() => { flushing = null })
    return flushing
  }

  function queue(location: ReadingLocation) {
    pending = { ...location }
    cancelTimer()
    timer = setTimeout(() => { void flush().catch(error => options.onSaveError?.(error)) }, options.delay ?? 600)
  }

  function relocate(location: ReadingLocation): boolean {
    if (disposed || !location.cfi || !Number.isFinite(location.fraction) || location.fraction < 0 || location.fraction > 1) return false
    visible = { ...location }
    if (inspections.length || navigating) return false
    reading = { ...location }
    queue(reading)
    return true
  }

  async function inspect(target: string, source: Context): Promise<void> {
    if (disposed || navigating) throw new Error('Reader navigation unavailable')
    if (!visible || !reading) throw new Error('Reading location unavailable')
    if (!target.trim()) throw new Error('Source unavailable')
    if (inspections.length >= 16) throw new Error('Inspection history limit reached')
    const entry = { origin: { ...visible }, context: source, available: false }
    inspections.push(entry)
    navigating = true
    changed()
    const token = context.capture()
    try {
      await options.navigate(target)
      if (context.current(token)) entry.available = true
    } catch (error) {
      // A renderer can relocate before it reports failure. Keep inspection protection
      // until the original position has actually been restored.
      if (context.current(token)) {
        try {
          await options.navigate(entry.origin.cfi)
          if (context.current(token)) { visible = { ...entry.origin }; inspections.pop() }
        } catch { /* Retain the entry so Return can retry; never promote a failed source. */ }
      }
      throw error
    } finally {
      navigating = false
      if (context.current(token)) changed()
    }
  }

  async function returnFromInspection(): Promise<Context | undefined> {
    const entry = inspections.at(-1)
    if (!entry || disposed || navigating) return undefined
    navigating = true
    changed()
    const token = context.capture()
    try {
      await options.navigate(entry.origin.cfi)
      if (!context.current(token)) return undefined
      visible = { ...entry.origin }
      inspections.pop()
      return entry.context
    } finally {
      navigating = false
      if (context.current(token)) changed()
    }
  }

  function promote(): boolean {
    if (disposed || navigating || !inspections.at(-1)?.available || !visible) return false
    inspections.length = 0
    reading = { ...visible }
    queue(reading)
    changed()
    return true
  }

  return {
    relocate, inspect, returnFromInspection, promote, flush,
    get reading() { return reading },
    get inspecting() { return inspections.length > 0 },
    get navigating() { return navigating },
    cancelPending() { cancelTimer(); pending = null },
    dispose() { disposed = true; cancelTimer(); context.dispose() },
  }
}
