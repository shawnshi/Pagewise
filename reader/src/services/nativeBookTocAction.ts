/** Read-only TOC snapshots from the SAME secured Foliate opener used by the existing reader/details page. */
import type { BookMeta } from '../storage/types.ts'
import { isFoliateNative } from './format.ts'
import { jsonObject, stateError } from './nativeState.ts'
import type { NativeManagementHandler } from './nativeManagementActions.ts'
interface OpenedBook { toc?: unknown; destroy?: () => void | Promise<void> }
interface Dependencies {
  metadata(id: string): Promise<BookMeta | undefined>
  file(id: string): Promise<Blob>
  open(book: BookMeta, blob: Blob): Promise<OpenedBook>
  now(): number
  token(): string
}
const defaults: Dependencies = {
  metadata: async id => (await (await import('../storage/index.ts')).getStorage()).getBook(id),
  file: async id => (await (await import('../storage/index.ts')).getStorage()).getBookFile(id),
  open: async (book, blob) => (await import('./foliateBook.ts')).makeFoliateBook(new File([blob], book.fileName || `${book.title}.${book.format}`, { type: blob.type })),
  now: Date.now, token: () => crypto.randomUUID(),
}
export function createNativeBookTocActions(injected: Partial<Dependencies> = {}): Record<string, NativeManagementHandler> {
  const deps = { ...defaults, ...injected }, snapshots = new Map<string, { bookId: string; expires: number; items: Array<{ title: string; depth: number }> }>()
  return { bookToc: async p => {
    if (Object.keys(p).some(k => !['bookId', 'token', 'offset', 'limit'].includes(k)) || typeof p.bookId !== 'string' || !p.bookId || p.bookId.length > 256) throw stateError('invalid_payload')
    const offset = p.offset ?? 0, limit = p.limit ?? 50
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw stateError('invalid_payload')
    let token: string, snapshot: { bookId: string; expires: number; items: Array<{ title: string; depth: number }> }
    if (p.token !== undefined) {
      if (typeof p.token !== 'string') throw stateError('invalid_payload')
      token = p.token
      const found = snapshots.get(token)
      if (!found || found.bookId !== p.bookId || found.expires < deps.now()) throw stateError('stale_toc_context')
      snapshot = found
    } else {
      if (offset !== 0) throw stateError('toc_context_required')
      const book = await deps.metadata(p.bookId)
      if (!book) throw stateError('book_not_found')
      if (!isFoliateNative(book.format)) return { ok: true, code: 'toc_format_unsupported', supported: false, total: 0, items: [] }
      const file = await deps.file(book.id)
      if (file.size <= 0 || file.size > 1024 * 1024 * 1024) throw stateError('resource_limit')
      const opened = await deps.open(book, file)
      const rows: Array<{ title: string; depth: number }> = []
      try {
        // Installed MOBI/EPUB openers legitimately leave toc null/undefined when no navigation exists.
        const toc = opened.toc ?? []
        if (!Array.isArray(toc)) throw stateError('invalid_toc_response')
        const stack = toc.slice().reverse().map(node => ({ node, depth: 0 })), visited = new WeakSet<object>()
        while (stack.length) {
          const { node: raw, depth } = stack.pop()!
          if (depth > 64 || rows.length >= 10000) throw stateError('resource_limit')
          const node = jsonObject(raw)
          if (visited.has(node)) throw stateError('invalid_toc_cycle')
          visited.add(node)
          const title = typeof node.label === 'string' ? node.label : typeof node.title === 'string' ? node.title : `Untitled ${rows.length + 1}`
          if (title.length > 4096) throw stateError('resource_limit')
          rows.push({ title, depth })
          if (node.subitems !== undefined && node.subitems !== null) {
            if (!Array.isArray(node.subitems)) throw stateError('invalid_toc_response')
            for (const child of node.subitems.slice().reverse()) stack.push({ node: child, depth: depth + 1 })
          }
        }
      } finally { await opened.destroy?.() }
      token = deps.token(); snapshot = { bookId: book.id, items: rows, expires: deps.now() + 5 * 60_000 }
      for (const [key, value] of snapshots) if (value.expires < deps.now() || snapshots.size >= 2) snapshots.delete(key)
      snapshots.set(token, snapshot)
    }
    const result = { ok: true, code: 'toc_snapshot', supported: true, token, snapshot: true, total: snapshot.items.length, offset, limit, items: snapshot.items.slice(offset, offset + limit) }
    if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw stateError('resource_limit')
    return result
  } }
}
