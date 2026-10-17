/**
 * 「重点词」的主线程服务: 一本书一个实例。选词与全书统计交给 Worker (keyWords.worker.ts);
 * Worker 起不来时退回主线程直接算 (只统计已打开过的分节, 不做后台全书统计, 免得卡顿)。
 *
 * 后台全书统计: 第一次取词后稍等片刻, 在空闲时逐节读出段落 (section.createDocument, 不渲染) 发给 Worker,
 * 全部发完后做一次全书统计, 完成后通知各绘制层重新取词 (version 加一)。
 */
import lexiconUrl from '../../data/zh-lexicon.txt?url'
import { SectionText } from './blocks.ts'
import { KwBook, MAX_BOOK_CHARS, packPicks, type KwPickRequest } from './keyWordsBook.ts'
import { loadZhLexicon } from './zhLexicon.ts'

export interface KwBookHost {
  sectionCount(): number
  sectionLinear(i: number): boolean
  /** 未渲染的分节文档; 不可用返回 null */
  sectionDoc(i: number): Promise<Document | null>
}

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6'

/**
 * 一节的段落: 与绘制层同一套切分 (SectionText 的段落边界)。
 * 标题 (h1–h6) 记成空段: 不在章名里点亮词, 段序号不变。
 */
export function sectionParagraphs(text: SectionText): { cuts: number[]; paras: string[] } {
  const len = text.length
  const cuts = [0, ...text.breaks.filter(b => b > 0 && b < len), len]
  const paras: string[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const p = text.slice(cuts[i], cuts[i + 1])
    const lead = p.search(/\S/)
    let heading = false
    if (lead >= 0) {
      const pt = text.point(cuts[i] + lead)
      try { heading = !!pt?.node.parentElement?.closest?.(HEADING_SEL) } catch { heading = false }
    }
    paras.push(heading ? '' : p)
  }
  return { cuts, paras }
}

/** 第一次取词后多久开始后台统计 (让出首屏渲染) */
const BACKGROUND_DELAY_MS = 1500

type Pending = { resolve: (p: Int32Array) => void; reject: (e: unknown) => void; req: KwPickRequest }

const idle = (fn: () => void) => {
  const w = globalThis as any
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 500 })
  else setTimeout(fn, 30)
}

export class KeyWordService {
  readonly bookId: string
  /** 全书统计完成一次加一; 绘制层据此重新取词 */
  version = 0
  #mode: 'worker' | 'local' = 'worker'
  #worker: Worker | null = null
  #local: KwBook | null = null
  #seq = 0
  #pending = new Map<number, Pending>()
  #listeners = new Set<() => void>()
  #host: KwBookHost | null = null
  #background: 'idle' | 'scheduled' | 'running' | 'done' = 'idle'
  #fed = new Set<number>()
  #fedChars = 0
  #disposed = false

  constructor(bookId: string) {
    this.bookId = bookId
    this.#startWorker()
  }

  #startWorker() {
    try {
      if (typeof Worker === 'undefined') throw new Error('no Worker')
      const w = new Worker(new URL('./keyWords.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = e => this.#onMessage(e.data)
      w.onerror = e => { console.warn('key words worker failed, computing on the main thread', e?.message ?? e); this.#fallback() }
      w.postMessage({ type: 'init', lexiconUrl: new URL(lexiconUrl, location.href).href })
      this.#worker = w
    } catch {
      this.#fallback()
    }
  }

  /** 改为主线程计算; 已发出的取词请求重新算 */
  #fallback() {
    if (this.#mode === 'local') return
    this.#mode = 'local'
    try { this.#worker?.terminate() } catch { /* 已结束 */ }
    this.#worker = null
    const waiting = [...this.#pending.values()]
    this.#pending.clear()
    for (const p of waiting) this.#pickLocal(p.req).then(p.resolve, p.reject)
  }

  #onMessage(msg: any) {
    switch (msg?.type) {
      case 'failed': this.#fallback(); return
      case 'picked': {
        const p = this.#pending.get(msg.id)
        if (!p) return
        this.#pending.delete(msg.id)
        p.resolve(msg.picks as Int32Array)
        return
      }
      case 'pickFailed': {
        const p = this.#pending.get(msg.id)
        if (!p) return
        this.#pending.delete(msg.id)
        p.reject(new Error(msg.error))
        return
      }
      case 'analyzed':
        if (msg.bookId !== this.bookId) return
        this.#background = 'done'
        this.version++
        for (const cb of this.#listeners) { try { cb() } catch (e) { console.warn('key words listener', e) } }
    }
  }

  async #pickLocal(req: KwPickRequest): Promise<Int32Array> {
    if (!this.#local) {
      const lex = await loadZhLexicon()
      if (!lex) throw new Error('lexicon unavailable')
      this.#local ??= new KwBook(lex)
    }
    // 让出一帧再算 (一节约 10–50 ms)
    await new Promise(r => setTimeout(r, 0))
    return packPicks(this.#local.pick(req))
  }

  /** 给一节选词。结果: Int32Array, 每 4 个数一组 [段, 段内起点, 长度, 标志] (见 keyWordsBook.packPicks) */
  pick(req: KwPickRequest, host?: KwBookHost): Promise<Int32Array> {
    if (this.#disposed) return Promise.reject(new Error('disposed'))
    if (host) this.#host = host
    this.#fed.add(req.section)
    if (this.#mode === 'local' || !this.#worker) return this.#pickLocal(req)
    const id = ++this.#seq
    const promise = new Promise<Int32Array>((resolve, reject) => this.#pending.set(id, { resolve, reject, req }))
    this.#worker.postMessage({ type: 'pick', id, bookId: this.bookId, req })
    this.#scheduleBackground()
    return promise
  }

  /** 全书统计完成时回调 (返回取消函数) */
  onChange(cb: () => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  #scheduleBackground() {
    if (this.#background !== 'idle' || !this.#host || this.#mode !== 'worker') return
    this.#background = 'scheduled'
    setTimeout(() => { void this.#runBackground() }, BACKGROUND_DELAY_MS)
  }

  async #runBackground() {
    const host = this.#host
    if (!host || this.#disposed || this.#mode !== 'worker') { this.#background = 'idle'; return }
    this.#background = 'running'
    const total = host.sectionCount()
    for (let i = 0; i < total; i++) {
      if (this.#disposed || this.#mode !== 'worker') return
      if (this.#fed.has(i) || !host.sectionLinear(i)) continue
      if (this.#fedChars > MAX_BOOK_CHARS) break
      await new Promise<void>(r => idle(r))
      let doc: Document | null = null
      try { doc = await host.sectionDoc(i) } catch { doc = null }
      if (!doc || this.#disposed) continue
      const { paras } = sectionParagraphs(new SectionText(doc))
      const n = paras.reduce((a, p) => a + p.length, 0)
      if (!n) continue
      this.#fed.add(i)
      this.#fedChars += n
      this.#worker?.postMessage({ type: 'section', bookId: this.bookId, section: i, paras })
    }
    if (this.#disposed || !this.#worker) return
    this.#worker.postMessage({ type: 'analyze', bookId: this.bookId })
  }

  dispose() {
    this.#disposed = true
    this.#listeners.clear()
    for (const p of this.#pending.values()) p.reject(new Error('disposed'))
    this.#pending.clear()
    try { this.#worker?.terminate() } catch { /* 已结束 */ }
    this.#worker = null
    this.#local = null
  }
}

let current: KeyWordService | null = null

/** 当前书的服务 (换书时释放上一本的 Worker) */
export function keyWordService(bookId: string): KeyWordService {
  if (current && current.bookId === bookId) return current
  current?.dispose()
  current = new KeyWordService(bookId)
  return current
}

/** 关书时释放 */
export function disposeKeyWordService(bookId?: string) {
  if (!current || (bookId && current.bookId !== bookId)) return
  current.dispose()
  current = null
}
