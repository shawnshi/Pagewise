/**
 * 「重点词」Worker: 全书统计 (新词发现、切分) 和按节选词都在这里做, 不占主线程。
 * 一次只服务一本书 (bookId 变了就换一本)。词表自己下载解析 (与主线程的按词着色互不依赖)。
 *
 * 消息 (main → worker):
 *   { type: 'init', lexiconUrl }
 *   { type: 'section', bookId, section, paras }
 *   { type: 'analyze', bookId }
 *   { type: 'pick', id, bookId, req: KwPickRequest }
 * 回复 (worker → main):
 *   { type: 'ready' } | { type: 'failed', error }
 *   { type: 'analyzed', bookId, sections, chars, newWords, ms }
 *   { type: 'picked', id, picks: Int32Array, ms } | { type: 'pickFailed', id, error }
 */
import { parseZhLexicon, type ZhLexicon } from './zhSegment.ts'
import { KwBook, packPicks, type KwPickRequest } from './keyWordsBook.ts'

let lexicon: Promise<ZhLexicon> | null = null
let book: KwBook | null = null
let bookId = ''
/** 消息按顺序处理 (词表下载完之前到的消息排队) */
let chain: Promise<unknown> = Promise.resolve()

const ctx = self as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }

async function bookFor(id: string): Promise<KwBook> {
  if (!lexicon) throw new Error('not initialised')
  const lex = await lexicon
  if (!book || bookId !== id) {
    book = new KwBook(lex)
    bookId = id
  }
  return book
}

async function handle(msg: any) {
  switch (msg?.type) {
    case 'init': {
      if (lexicon) return
      lexicon = fetch(msg.lexiconUrl)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text() })
        .then(text => {
          const lex = parseZhLexicon(text)
          if (lex.size < 1000) throw new Error('lexicon too small')
          return lex
        })
      try {
        await lexicon
        ctx.postMessage({ type: 'ready' })
      } catch (e) {
        lexicon = null
        ctx.postMessage({ type: 'failed', error: String(e) })
      }
      return
    }
    case 'section': {
      const b = await bookFor(msg.bookId)
      b.addSection(msg.section, msg.paras)
      return
    }
    case 'analyze': {
      const b = await bookFor(msg.bookId)
      const t0 = performance.now()
      b.analyze()
      ctx.postMessage({ type: 'analyzed', bookId: msg.bookId, sections: b.sectionCount, chars: b.chars, newWords: b.newWords, ms: Math.round(performance.now() - t0) })
      return
    }
    case 'pick': {
      try {
        const b = await bookFor(msg.bookId)
        const t0 = performance.now()
        const picks = packPicks(b.pick(msg.req as KwPickRequest))
        ctx.postMessage({ type: 'picked', id: msg.id, picks, ms: Math.round(performance.now() - t0) }, [picks.buffer])
      } catch (e) {
        ctx.postMessage({ type: 'pickFailed', id: msg.id, error: String(e) })
      }
      return
    }
  }
}

ctx.onmessage = (e: MessageEvent) => {
  chain = chain.then(() => handle(e.data)).catch(err => console.warn('key words worker', err))
}
