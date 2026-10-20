import { onyxNativeAccelerator, type OnyxNativePdfInfo } from './onyxNativeAccelerator.ts'

export interface PdfRasterResult { bitmap: ImageBitmap; renderer: string }
export interface PdfRasterRequest { page: number; width: number; height: number; renderer: string }
type Job = { id: number; revision: number; request: PdfRasterRequest; priority: number; resolve: (result: PdfRasterResult) => void; reject: (error: Error) => void }
let nextSession = 0
const cancelled = () => new DOMException('Obsolete PDF raster', 'AbortError')

/** One non-preemptible WASM call at a time; at most eight waiting requests. */
export class PdfRasterClient {
  readonly session = ++nextSession
  private worker: Worker | null = null
  private queue: Job[] = []
  private active: Job | null = null
  private delivering = false
  private revision = 0
  private id = 0
  private ready = false
  private closed = false
  private failure: Error | null = null
  private restarts = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private blob: Blob
  private factory: () => Worker
  private deadline: number
  private nativeBookRelPath = ''
  constructor(blob: Blob, factory = () => new Worker(new URL('./pdfRaster.worker.ts', import.meta.url), { type: 'module' }), deadline = 20_000) {
    this.blob = blob
    this.factory = factory
    this.deadline = deadline
  }
  setNativeBookPath(bookRelPath: string): OnyxNativePdfInfo | null {
    this.nativeBookRelPath = bookRelPath.trim()
    if (!this.nativeBookRelPath) return null
    return onyxNativeAccelerator.openNativePdfInfo(this.nativeBookRelPath)
  }
  renderNativeDataUrl(page: number, width: number, height: number): string {
    if (!this.nativeBookRelPath) return ''
    return onyxNativeAccelerator.renderNativePdfPage(this.nativeBookRelPath, page, width, height)
  }
  setRevision(revision: number) {
    if (this.revision === revision) return
    this.revision = revision
    for (const job of this.queue.splice(0)) job.reject(cancelled())
    // An active synchronous WASM call cannot be interrupted except by termination.
    // Its reply is consumed and closed without committing to the new view.
  }
  render(request: PdfRasterRequest, revision: number, priority = 0): Promise<PdfRasterResult> {
    if (this.closed) return Promise.reject(new Error('PDF raster client closed'))
    if (this.failure) return Promise.reject(this.failure)
    if (revision !== this.revision) return Promise.reject(cancelled())
    return new Promise((resolve, reject) => {
      if (this.queue.length >= 8) {
        if (priority > 0) { reject(cancelled()); return }
        this.queue.pop()!.reject(cancelled())
      }
      this.queue.push({ id: ++this.id, revision, request, priority, resolve, reject })
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id)
      this.pump()
    })
  }
  private arm() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const error = new Error('PDF worker deadline exceeded')
      // A stuck WASM call owns its heap until termination. Permit one lazy reopen,
      // not a replay loop; the failed request is always reported to its caller.
      this.fail(error, this.restarts++ < 1)
    }, this.deadline)
  }
  private pump() {
    if (this.closed || this.failure || this.active || this.delivering) return
    if (!this.worker) {
      try {
        const worker = this.factory()
        this.worker = worker
        worker.onerror = event => { event.preventDefault(); if (this.worker === worker) this.fail(new Error(`PDF worker error: ${event.message}`)) }
        worker.onmessageerror = () => { if (this.worker === worker) this.fail(new Error('PDF worker message decoding failed')) }
        worker.onmessage = ({ data }) => {
          if (this.worker !== worker || data.session !== this.session || this.closed) { data.bitmap?.close(); return }
          if (data.id === 0 && !this.ready) {
            clearTimeout(this.timer)
            if (data.error) { this.fail(new Error(data.error)); return }
            this.ready = true
            this.pump()
            return
          }
          const job = this.active
          if (!job || job.id !== data.id || job.revision !== data.revision) { data.bitmap?.close(); return }
          clearTimeout(this.timer)
          this.active = null
          this.delivering = true
          if (data.error) job.reject(new Error(data.error))
          else if (job.revision !== this.revision) { data.bitmap?.close(); job.reject(cancelled()) }
          else if (!data.bitmap) job.reject(new Error('PDF worker returned no bitmap'))
          else job.resolve({ bitmap: data.bitmap, renderer: data.renderer })
          // The view consumes/closes the transferred bitmap in its await continuation
          // before the next raster can allocate surfaces against the same reservation.
          queueMicrotask(() => { this.delivering = false; this.pump() })
        }
        this.arm()
        worker.postMessage({ kind: 'open', session: this.session, revision: this.revision, id: 0, blob: this.blob })
      } catch (error) { this.fail(new Error(`PDF Worker unavailable: ${error instanceof Error ? error.message : error}`)) }
      return
    }
    if (!this.ready) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    this.arm()
    try { this.worker.postMessage({ kind: 'render', session: this.session, revision: job.revision, id: job.id, ...job.request }) }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }
  private fail(error: Error, reopen = false) {
    clearTimeout(this.timer)
    this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.active?.reject(error)
    this.active = null
    for (const job of this.queue.splice(0)) job.reject(error)
    if (!reopen) this.failure = error
  }
  close() {
    this.closed = true
    this.fail(new Error('PDF raster client closed'))
    this.blob = new Blob()
  }
}
