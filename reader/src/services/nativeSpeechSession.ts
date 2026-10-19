/** Complete foreground preparation; native owns all playback after commit. */
import { invoke } from '@tauri-apps/api/core'

export interface NativeSpeechIdentity { owner: string; sourceVersion: string }
export interface NativeSpeechRecord { key: string; text: string; sectionEnd?: boolean }
export interface NativeSpeechFeed {
  next(): Promise<NativeSpeechRecord | null>
  expectedUnits?: number
  resumeFromCheckpoint?: boolean
  drainCoverage?(): number[]
  startKey?(): string
}
export interface NativeSpeechSnapshot extends NativeSpeechIdentity {
  id: string
  instance: string
  generation: number
  sequence: number
  state: 'idle' | 'preparing' | 'playing' | 'paused' | 'finished' | 'stopped' | 'error'
  index: number
  count: number
  key: string
  text: string
  committed: boolean
  reason: string
  code: string
  rate: number
  voice: string
  deadline: number
  stopAtSection: boolean
}
export interface NativeSpeechSettings { rate: number; voice: string; deadline: number; stopAtSection: boolean }
export type NativeSpeechTransport = (action: string, payload: Record<string, unknown>) => Promise<NativeSpeechSnapshot>
const transport: NativeSpeechTransport = (action, payload) => invoke('system_tts_session', { action, payload })
const failure = (code: string) => Object.assign(new Error(code), { code })

export async function speechSourceVersion(blob: Blob, extractor: string): Promise<string> {
  // Source content, not mutable reading metadata or provider mtime hints.
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return `${extractor}:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`
}

export class NativeSpeechSession {
  snapshot: NativeSpeechSnapshot | null = null
  private epoch = 0
  private serial: Promise<unknown> = Promise.resolve()
  private poll: ReturnType<typeof setInterval> | undefined
  private polling = false
  private done: ((result: 'finished' | 'stopped') => void) | null = null
  private failed: ((error: unknown) => void) | null = null
  private desired: NativeSpeechSettings = { rate: 1, voice: '', deadline: 0, stopAtSection: false }
  private paused = false
  private preparing = false
  private visibility = () => { if (document.visibilityState !== 'hidden') void this.refresh() }

  private identity: () => Promise<NativeSpeechIdentity>
  private changed: (snapshot: NativeSpeechSnapshot) => void
  private call: NativeSpeechTransport
  constructor(
    identity: () => Promise<NativeSpeechIdentity>,
    changed: (snapshot: NativeSpeechSnapshot) => void,
    call: NativeSpeechTransport = transport,
  ) { this.identity = identity; this.changed = changed; this.call = call }

  get attached(): boolean { return !!this.snapshot?.id }
  get isPreparing(): boolean { return this.preparing }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.catch(() => {})
    return next
  }
  private accept(snapshot: NativeSpeechSnapshot, epoch: number): void {
    if (epoch !== this.epoch) return
    if (this.snapshot && (snapshot.instance !== this.snapshot.instance || snapshot.id !== this.snapshot.id || snapshot.sequence < this.snapshot.sequence)) return
    this.snapshot = snapshot
    this.changed(snapshot)
    if (snapshot.state === 'finished' || snapshot.state === 'stopped') this.settle(snapshot.state)
    else if (snapshot.state === 'error') this.settle('stopped', failure(snapshot.code || 'tts_error'))
  }
  private settle(result: 'finished' | 'stopped', error?: unknown): void {
    const done = this.done, failed = this.failed
    this.done = null; this.failed = null
    this.unwatch()
    if (error) failed?.(error)
    else done?.(result)
  }
  private watch(): void {
    this.unwatch()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility)
    this.poll = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void this.refresh() }, 750)
  }
  private unwatch(): void {
    clearInterval(this.poll); this.poll = undefined
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility)
  }
  async refresh(): Promise<void> {
    if (this.polling || !this.snapshot) return
    this.polling = true
    const epoch = this.epoch
    try {
      const next = await this.call('status', {})
      if (epoch !== this.epoch) return
      if (next.id !== this.snapshot?.id || next.instance !== this.snapshot.instance) {
        this.settle('stopped', failure('session_replaced')); this.detach(); return
      }
      this.accept(next, epoch)
    } catch (error) {
      // Transport failure is not EOF; keep the service untouched and surface it.
      if (epoch === this.epoch) this.settle('stopped', error)
    } finally { this.polling = false }
  }
  async attach(): Promise<NativeSpeechSnapshot | null> {
    const epoch = ++this.epoch
    let next = await this.call('status', {})
    if (epoch !== this.epoch || !next.committed || !['playing', 'paused', 'stopped', 'finished'].includes(next.state) || next.count === 0) return null
    const identity = await this.identity()
    if (epoch !== this.epoch || next.owner !== identity.owner) return null
    if (next.sourceVersion !== identity.sourceVersion) throw failure('source_changed')
    if (next.state === 'finished' || next.index >= next.count) {
      this.changed(next) // Reconcile the final listening locator without starting an active observer.
      return null
    }
    if (next.state === 'stopped') {
      next = await this.call('adopt', { id: next.id, instance: next.instance, generation: next.generation, sourceVersion: identity.sourceVersion, requestId: crypto.randomUUID() })
      if (epoch !== this.epoch) return null
    }
    this.snapshot = null
    this.desired = { rate: next.rate, voice: next.voice, deadline: next.deadline, stopAtSection: next.stopAtSection }
    this.accept(next, epoch); this.watch()
    return next
  }

  async play(feed: NativeSpeechFeed, settings: NativeSpeechSettings, startKey = '', startPaused = false): Promise<'finished' | 'stopped'> {
    this.detach()
    const epoch = this.epoch
    this.desired = { ...settings }; this.paused = startPaused; this.preparing = true
    const current = () => { if (epoch !== this.epoch) throw failure('cancelled') }
    let id = ''
    try {
      const identity = await this.identity(); current()
      const before = await this.call('status', {}); current()
      const begun = await this.enqueue(() => {
        current()
        return this.call('begin', { ...identity, instance: before.instance, generation: before.generation, expectedId: before.id, expectedUnits: feed.expectedUnits ?? 0, resumeFromCheckpoint: !!feed.resumeFromCheckpoint, requestId: crypto.randomUUID() })
      })
      id = begun.id
      if (epoch !== this.epoch) {
        await this.call('discard', { id, instance: begun.instance, generation: begun.generation, requestId: crypto.randomUUID() })
        return 'stopped'
      }
      this.snapshot = begun; this.accept(begun, epoch)
      if (begun.committed && begun.count > 0 && begun.index >= begun.count) { this.preparing = false; return 'finished' }
      let count = 0
      let items: NativeSpeechRecord[] = []
      const flush = async () => {
        const coverage = feed.drainCoverage?.() ?? []
        if (!items.length && !coverage.length) return
        const batch = items; items = []
        const next = await this.command('append', { offset: count, items: batch, coverage }, epoch)
        current(); count = next.count
      }
      for (;;) {
        current()
        // Yield between batches. Never keep the full book's text in JS memory.
        const item = await feed.next(); current()
        if (!item) break
        if (item.text.length > 4000) throw failure('invalid_sentence')
        items.push(item)
        if (items.length >= 100) { await flush(); await new Promise(resolve => setTimeout(resolve, 0)) }
      }
      await flush(); current()
      // Commit only publishes a paused queue. Pause/Resume/settings can change
      // while its ACK is in flight; never bake an old play intent into commit.
      await this.command('commit', { ...this.desired, startKey: feed.startKey?.() ?? startKey, count, autoplay: false }, epoch)
      current(); this.preparing = false
      await this.command('configure', { ...this.desired }, epoch)
      current()
      // A hidden/rebuilt page cannot turn its old start gesture into playback.
      if (!this.paused && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) await this.command('resume', {}, epoch)
      current()
      if (this.snapshot?.state === 'finished') return 'finished'
      const completed = new Promise<'finished' | 'stopped'>((resolve, reject) => { this.done = resolve; this.failed = reject })
      this.watch()
      return await completed
    } catch (error) {
      if (epoch !== this.epoch) return 'stopped'
      if (this.snapshot?.id === id && this.preparing) {
        try {
          const actual = await this.call('status', {})
          if (actual.id === id && actual.instance === this.snapshot.instance) {
            this.accept(actual, epoch)
            if (!actual.committed) await this.command('discard', {}, epoch)
          }
        } catch (discardError) { console.error('Native speech preparation cleanup failed', discardError) }
      }
      this.preparing = false
      throw error
    }
  }
  private command(action: string, payload: Record<string, unknown>, epoch = this.epoch): Promise<NativeSpeechSnapshot> {
    return this.enqueue(async () => {
      if (epoch !== this.epoch || !this.snapshot) throw failure('cancelled')
      const { id, instance, generation } = this.snapshot
      const next = await this.call(action, { ...payload, id, instance, generation, requestId: crypto.randomUUID() })
      this.accept(next, epoch)
      return next
    })
  }
  async pause(): Promise<void> {
    this.paused = true
    if (!this.preparing && this.attached) await this.command('pause', {})
  }
  async resume(): Promise<void> {
    const epoch = this.epoch
    this.paused = false
    if (!this.preparing && this.attached) {
      // The native owner clears fired one-shot sleep conditions.
      await this.command('resume', {}, epoch)
      if (epoch === this.epoch && this.attached) this.watch()
    }
  }
  async configure(settings: Partial<NativeSpeechSettings>): Promise<void> {
    this.desired = { ...this.desired, ...settings }
    if (!this.preparing && this.attached) await this.command('configure', settings)
  }
  async seek(delta: -1 | 1, key?: string, kind: 'sentence' | 'paragraph' = 'sentence'): Promise<void> { if (this.attached && !this.preparing) await this.command('seek', { delta, kind, ...(key ? { key } : {}) }) }
  async stop(): Promise<void> {
    const snapshot = this.snapshot
    const action = this.preparing ? 'discard' : 'stop'
    this.detach()
    // Capture identity before detach; a late stop can never stop a newer book.
    if (snapshot?.id) await this.enqueue(async () => {
      const actual = await this.call('status', {})
      if (actual.id !== snapshot.id || actual.instance !== snapshot.instance) return actual
      return this.call(actual.committed ? 'stop' : action, { id: actual.id, instance: actual.instance, generation: actual.generation, requestId: crypto.randomUUID() })
    })
  }
  detach(): void {
    this.epoch++; this.preparing = false; this.unwatch(); this.settle('stopped'); this.snapshot = null
  }
}
