import { onyxEpd } from './onyxEpd.ts'

export interface EinkStreamAggregatorOptions {
  /** Aggregate at most N characters/tokens before flushing to UI + A2 fast mode. Default: 18. */
  maxBatchChars?: number
  /** Aggregate at most N milliseconds before flushing to UI + A2 fast mode. Default: 650. */
  maxWaitMs?: number
  /** Whether E-Ink waveform & batching orchestration is active. Default: true. */
  einkEnabled?: boolean
  /** Callback invoked with each batched text delta. */
  onFlush: (chunk: string) => void
  /** Optional completion hook invoked after final flush & trailing Regal repaint. */
  onComplete?: () => void
  /** Optional abort signal to cancel pending timers and exit A2 fast mode cleanly. */
  signal?: AbortSignal
}

/**
 * Buffers streaming LLM token deltas into coarser E-Ink friendly batches (18 chars or 650ms)
 * so EPD controllers stay in low-flicker A2 mode during bursts and settle cleanly with Regal.
 */
export class EinkStreamAggregator {
  private readonly maxBatchChars: number
  private readonly maxWaitMs: number
  private readonly einkEnabled: boolean
  private readonly onFlush: (chunk: string) => void
  private readonly onComplete?: () => void
  private readonly signal?: AbortSignal
  private readonly abortListener?: () => void

  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private enteredFastMode = false
  private finished = false

  constructor(options: EinkStreamAggregatorOptions) {
    this.maxBatchChars = Math.max(1, Math.round(options.maxBatchChars ?? 18))
    this.maxWaitMs = Math.max(16, Math.round(options.maxWaitMs ?? 650))
    this.einkEnabled = options.einkEnabled ?? true
    this.onFlush = options.onFlush
    this.onComplete = options.onComplete
    this.signal = options.signal

    if (this.signal) {
      if (this.signal.aborted) {
        this.abort()
      } else {
        this.abortListener = () => this.abort()
        this.signal.addEventListener('abort', this.abortListener, { once: true })
      }
    }
  }

  push(token: string): void {
    if (this.finished || !token) return
    if (!this.einkEnabled) {
      this.onFlush(token)
      return
    }
    this.buffer += token
    if (this.buffer.length >= this.maxBatchChars) {
      this.flush()
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.maxWaitMs)
    }
  }

  flush(): void {
    this.clearTimer()
    if (this.finished || !this.buffer) return
    const chunk = this.buffer
    this.buffer = ''
    if (this.einkEnabled && !this.enteredFastMode) {
      this.enteredFastMode = true
      onyxEpd.enterFastMode('stream', 'a2')
    }
    this.onFlush(chunk)
  }

  complete(): void {
    if (this.finished) return
    this.flush()
    this.finished = true
    this.detachAbort()
    if (this.einkEnabled && this.enteredFastMode) {
      onyxEpd.exitFastModeNow()
      onyxEpd.repaint('regal')
      this.enteredFastMode = false
    }
    this.onComplete?.()
  }

  abort(): void {
    if (this.finished) return
    this.clearTimer()
    this.buffer = ''
    this.finished = true
    this.detachAbort()
    if (this.einkEnabled && this.enteredFastMode) {
      onyxEpd.exitFastModeNow()
      onyxEpd.repaint('regal')
      this.enteredFastMode = false
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private detachAbort(): void {
    if (this.signal && this.abortListener) {
      this.signal.removeEventListener('abort', this.abortListener)
    }
  }
}
