import type { BookMeta, BookDescriptionSnapshot, LibraryStorage } from '../storage/types.ts'
import { bookDescriptionSnapshot, BookDescriptionConflictError, BOOK_INTRODUCTION_MAX_LENGTH } from './bookDescription.ts'
import { generateBookIntroduction, BookIntroductionError, type BookIntroductionOptions } from './bookIntroduction.ts'

export interface IntroductionReply { ok: boolean; code?: string; [key: string]: unknown }
export interface IntroductionActionDependencies {
  storage(): Promise<LibraryStorage>
  generate(book: BookMeta, options: BookIntroductionOptions): Promise<string>
  ready(): Promise<IntroductionReply | undefined>
  now(): number
  token(): string
}
export type IntroductionHandler = (payload: Record<string, unknown>) => Promise<IntroductionReply>
interface Preview {
  bookId: string
  requestId: string
  expected: BookDescriptionSnapshot
  text: string
  createdAt: number
  state: 'preview' | 'saving' | 'unknown'
}
const TTL = 15 * 60_000
const CAP = 16
const defaults: IntroductionActionDependencies = {
  storage: async () => (await import('../storage/index.ts')).getStorage(),
  generate: generateBookIntroduction,
  ready: async () => {
    const { hasNativeState } = await import('./nativeState.ts')
    if (!hasNativeState()) return undefined
    const settings = (await import('../stores/settings.ts')).useSettings()
    const report = await settings.reloadNativeSettings()
    if (report.unsavedPaths.length || report.failedCommits.length) return { ok: false, code: 'settings_recovery_required' }
    await settings.flushNativeSettings()
    return undefined
  },
  now: Date.now,
  token: () => crypto.randomUUID(),
}
function string(value: unknown, max = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') }
const fail = (code: string): IntroductionReply => ({ ok: false, code })

/** Ephemeral proposals only: generating, cancelling or closing never writes book metadata. */
export function createBookIntroductionActions(overrides: Partial<IntroductionActionDependencies> = {}): Record<'bookIntroductionGenerate' | 'bookIntroductionSave' | 'bookIntroductionCancel', IntroductionHandler> {
  const deps = { ...defaults, ...overrides }
  const previews = new Map<string, Preview>()
  const running = new Map<string, { bookId: string; controller: AbortController }>()
  function prune() {
    const now = deps.now()
    for (const [token, preview] of previews) if (preview.state !== 'saving' && now - preview.createdAt >= TTL) previews.delete(token)
  }
  async function ready(): Promise<IntroductionReply | undefined> {
    try { return await deps.ready() } catch { return fail('settings_unavailable') }
  }
  return {
    bookIntroductionGenerate: async payload => {
      prune()
      const { bookId, requestId } = payload
      const series = payload.series ?? ''
      if (!string(bookId) || !string(requestId, 128) || typeof series !== 'string' || series.length > 1024 || series.includes('\0')) return fail('invalid_payload')
      if (running.size) return fail('busy')
      if (previews.size >= CAP) return fail('preview_limit')
      // Reserve before any await: cancellation during settings recovery must also stop this request.
      const controller = new AbortController()
      running.set(requestId, { bookId, controller })
      try {
        const blocked = await ready()
        if (blocked) return blocked
        controller.signal.throwIfAborted()
        const storage = await deps.storage()
        if (!storage.updateBookDescription) return fail('unsupported_storage')
        const book = await storage.getBook(bookId)
        if (!book || book.id !== bookId) return fail('not_found')
        const expected = bookDescriptionSnapshot(book)
        if (expected.description.length > 64_000) return fail('source_too_large')
        controller.signal.throwIfAborted()
        const generated = await deps.generate(book, { series, signal: controller.signal })
        controller.signal.throwIfAborted()
        if (running.get(requestId)?.controller !== controller) return fail('cancelled')
        const text = generated.trim()
        if (!text || text.length > BOOK_INTRODUCTION_MAX_LENGTH || text.includes('\0')) return fail('invalid_output')
        const token = deps.token()
        if (!string(token, 128) || previews.has(token)) return fail('token_conflict')
        previews.set(token, { bookId, requestId, expected, text, createdAt: deps.now(), state: 'preview' })
        return { ok: true, bookId, requestId, token, text, source: { title: expected.title, authors: expected.author, publisher: expected.publisher, pubdate: expected.publicationDate, series }, unverified: true }
      } catch (error) {
        if (controller.signal.aborted) return fail('cancelled')
        return fail(error instanceof BookIntroductionError ? error.code : 'generation_failed')
      } finally {
        if (running.get(requestId)?.controller === controller) running.delete(requestId)
      }
    },
    bookIntroductionSave: async payload => {
      prune()
      const { bookId, token, text } = payload
      if (!string(bookId) || !string(token, 128) || typeof text !== 'string' || !text.trim() || text.length > BOOK_INTRODUCTION_MAX_LENGTH || text.includes('\0') || payload.confirmReplace !== true) return fail('invalid_payload')
      const preview = previews.get(token)
      if (!preview || preview.bookId !== bookId) return fail('stale_preview')
      if (preview.state === 'saving') return fail('busy')
      if (preview.state === 'unknown') return fail('commit_outcome_unknown')
      const blocked = await ready()
      if (blocked) return blocked
      if (previews.get(token) !== preview || deps.now() - preview.createdAt >= TTL) return fail('stale_preview')
      if (preview.state !== 'preview') return fail(preview.state === 'unknown' ? 'commit_outcome_unknown' : 'busy')
      preview.state = 'saving'
      try {
        const storage = await deps.storage()
        if (!storage.updateBookDescription) { preview.state = 'preview'; return fail('unsupported_storage') }
        await storage.updateBookDescription(bookId, preview.expected, text.trim())
        previews.delete(token)
        return { ok: true, bookId, saved: true, description: text.trim() }
      } catch (error) {
        // A known CAS conflict is a zero-write failure. All other storage failures are conservatively unknown.
        preview.state = 'unknown'
        if (error instanceof BookDescriptionConflictError || (error as { code?: unknown })?.code === 'source_changed') {
          previews.delete(token)
          return fail('source_changed')
        }
        return fail('commit_outcome_unknown')
      }
    },
    bookIntroductionCancel: async payload => {
      const { bookId, requestId, token } = payload
      if (!string(bookId) || !string(requestId, 128)) return fail('invalid_payload')
      const active = running.get(requestId)
      if (active?.bookId === bookId) { active.controller.abort(); running.delete(requestId) }
      for (const [key, preview] of previews) {
        if (preview.bookId === bookId && (preview.requestId === requestId || key === token) && preview.state === 'preview') previews.delete(key)
      }
      return { ok: true, bookId, cancelled: true }
    },
  }
}
