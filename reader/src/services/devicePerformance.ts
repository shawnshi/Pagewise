type Engine = 1 | 2
interface PerformanceBridge {
  recordPerformance(action: number, engine: number, elapsedMs: number, completed: boolean): boolean
}
interface ReflowView extends HTMLElement {
  lastLocation?: { cfi?: string; section?: { current?: number }; range?: Range }
  renderer?: { getContents?: () => { index: number; doc: Document }[] }
}
interface Snapshot {
  engine: Engine
  identity: string | number
  surface: object
  geometry: readonly number[]
}
interface Pending {
  action: 1 | 2
  engine: Engine | undefined
  start: number
  deadline: number
  before: Snapshot | null
  stable: Snapshot | null
  poisoned: boolean
}

/** Candidate-local software commit probe. No identities leave memory; this is not panel/touch latency. */
export function installDevicePerformance(bridge: PerformanceBridge, currentEngine: () => Engine | undefined): () => void {
  let stopped = false
  let count = 0
  let pending: Pending | null = null
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const contentListeners = new Map<Document, { view: ReflowView; key: (event: KeyboardEvent) => void }>()
  const contentObserver = new MutationObserver(pruneContentListeners)

  function pruneContentListeners() {
    for (const [doc, { view, key }] of contentListeners) {
      if (view.isConnected && doc.defaultView?.frameElement?.isConnected) continue
      doc.removeEventListener('keydown', key, true)
      contentListeners.delete(doc)
    }
  }
  function attachContent(view: ReflowView, doc: Document) {
    if (stopped || contentListeners.has(doc)) return
    const key = (event: KeyboardEvent) => {
      if (view.isConnected && currentEngine() === 1) keydown(event, doc.defaultView?.performance.timeOrigin)
    }
    doc.addEventListener('keydown', key, true)
    contentListeners.set(doc, { view, key })
  }
  function sectionLoaded(event: Event) {
    // Foliate emits load on its host; native iframe keys do not bubble to the outer window.
    if (!(event.target instanceof Element) || !event.target.matches('foliate-view')) return
    const doc = (event as CustomEvent<{ doc?: Document }>).detail?.doc
    if (!doc || stopped) return
    pruneContentListeners()
    attachContent(event.target as ReflowView, doc)
  }

  function cancel() {
    cancelAnimationFrame(frame)
    frame = 0
    clearTimeout(timer)
    timer = undefined
    pending = null
  }
  function stop() {
    if (stopped) return
    stopped = true
    window.removeEventListener('click', click, true)
    window.removeEventListener('keydown', keydown, true)
    document.removeEventListener('load', sectionLoaded, true)
    contentObserver.disconnect()
    for (const [doc, { key }] of contentListeners) doc.removeEventListener('keydown', key, true)
    contentListeners.clear()
    cancel()
  }
  function report(action: number, engine: number, start: number, completed: boolean) {
    if (stopped) return
    const elapsed = performance.now() - start
    const valid = Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 60000
    try {
      const accepted = bridge.recordPerformance(action, engine,
        valid ? elapsed : 60000, completed && valid)
      if (!accepted || ++count >= 512) stop()
    } catch {
      // No passing measurement exists if the native sink fails; never expose exception payloads.
      stop()
    }
  }
  function visibleArea(element: Element): number {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return 0
    return Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0))
      * Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0))
  }
  function snapshot(engine: Engine | undefined): Snapshot | null {
    if (engine === 1) {
      if (document.querySelector('.reader > .state')) return null
      const view = document.querySelector<ReflowView>('foliate-view')
      const loc = view?.lastLocation
      const range = loc?.range
      const doc = view?.renderer?.getContents?.().find(c => c.index === loc?.section?.current)?.doc
      const box = range?.getBoundingClientRect()
      if (!view || !loc?.cfi || !range || !doc?.body || doc.readyState !== 'complete'
        || range.startContainer.ownerDocument !== doc || range.endContainer.ownerDocument !== doc
        || doc.fonts?.status === 'loading' || !box || !(box.width > 0 || box.height > 0)
        || visibleArea(view) <= 0) return null
      return { engine, identity: loc.cfi, surface: doc, geometry: [box.x, box.y, box.width, box.height] }
    }
    if (engine === 2) {
      if (document.querySelector('.paper-state')) return null
      let best: Snapshot | null = null
      let area = 0
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>('.p-holder[data-page] .p-canvas canvas')) {
        const page = Number(canvas.closest<HTMLElement>('.p-holder')?.dataset.page)
        const visible = visibleArea(canvas)
        // PdfReaderView.renderPdmPage publishes the canvas only after drawImage completes.
        if (!canvas.isConnected || !canvas.width || !canvas.height || !Number.isInteger(page) || page < 1 || visible <= area) continue
        const box = canvas.getBoundingClientRect()
        area = visible
        best = { engine, identity: page, surface: canvas, geometry: [box.x, box.y, box.width, box.height, canvas.width, canvas.height] }
      }
      return best
    }
    return null
  }
  function same(a: Snapshot | null, b: Snapshot | null): boolean {
    return !!a && !!b && a.engine === b.engine && a.identity === b.identity && a.surface === b.surface
      && a.geometry.every((n, i) => Number.isFinite(n) && n === b.geometry[i])
  }
  function finish(completed: boolean) {
    const p = pending
    cancel()
    if (!p) return
    // An open that never reaches a known reader cannot be assigned a guessed engine.
    report(p.engine ? p.action : 0, p.engine ?? 0, p.start, completed)
  }
  function poll() {
    frame = 0
    const p = pending
    if (stopped || !p || p.poisoned) return
    if (performance.now() >= p.deadline) { finish(false); return }
    try {
      const engine = currentEngine()
      p.engine ??= engine
      const shown = engine === p.engine ? snapshot(engine) : null
      const changed = p.action === 1 || (!!p.before && !!shown &&
        // A replacement raster for the same PDF page is not a page turn.
        (p.before.engine !== shown.engine || p.before.identity !== shown.identity))
      if (changed && same(shown, p.stable)) { finish(true); return }
      p.stable = changed ? shown : null
      frame = requestAnimationFrame(poll)
    } catch {
      finish(false)
    }
  }
  function begin(action: 1 | 2, event: Event, timeOrigin = performance.timeOrigin) {
    if (stopped) return
    const now = performance.now()
    const stamp = event.timeStamp + (timeOrigin - performance.timeOrigin)
    const start = Number.isFinite(stamp) && stamp >= 0 && stamp <= now && now - stamp <= 60000 ? stamp : now
    if (pending) {
      // After overlapping inputs, no later commit can be attributed to one event. Quarantine to deadline.
      pending.poisoned = true
      cancelAnimationFrame(frame)
      frame = 0
      const engine = currentEngine() ?? pending.engine
      report(engine ? action : 0, engine ?? 0, start, false)
      return
    }
    const engine = currentEngine()
    const deadline = start + (action === 1 ? 15000 : 5000)
    try {
      pending = { action, engine, start, deadline, before: snapshot(engine), stable: null, poisoned: false }
      timer = setTimeout(() => finish(false), Math.max(0, deadline - now))
      frame = requestAnimationFrame(poll)
    } catch {
      cancel()
      report(engine ? action : 0, engine ?? 0, start, false)
    }
  }
  function click(event: MouseEvent) {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    if (event.target.closest('.btn-read:not(:disabled)')) begin(1, event)
  }
  function keydown(event: KeyboardEvent, timeOrigin = performance.timeOrigin) {
    if (!event.isTrusted || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')
      || !currentEngine() || !document.querySelector('.reader, .paper')) return
    begin(2, event, timeOrigin)
  }

  try {
    window.addEventListener('click', click, true)
    window.addEventListener('keydown', keydown, true)
    document.addEventListener('load', sectionLoaded, true)
    contentObserver.observe(document, { childList: true, subtree: true })
    const view = document.querySelector<ReflowView>('foliate-view')
    if (view) for (const { doc } of view.renderer?.getContents?.() ?? []) attachContent(view, doc)
    report(0, 0, performance.now(), true)
  } catch {
    stop()
  }
  return stop
}
