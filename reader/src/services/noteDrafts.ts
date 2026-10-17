/**
 * 笔记草稿服务 (Note Drafts)
 * 本地优先、防丢草稿辅助模块:
 * - 仅限本地存储, 带版本控制 (version: 1)
 * - 按书籍标识 (bookId) + 稳定编辑/选区上下文 (contextId) 双重键绑定
 * - 严禁将草稿标为已保存笔记 (草稿与已持久化标注严格分离)
 * - 独立保留选区原文引文 (quote) 与来源位置 (sourceLoc), 与可编辑笔记正文 (text) 严格分离
 * - 存储不可用/配额超出/损坏时返回结构化错误, 且调用方保留可恢复文本
 * - 仅同上下文可恢复; 笔记保存成功仅移除对应草稿; 支持显式放弃草稿
 * - 损坏的草稿载荷绝不连带清空其他不相关键
 * - 支持通过 DraftEnv 注入存储与时钟, 纯单元测试不读写全局 localStorage/DB
 */

import type { AnnotationRec } from '../storage/types.ts'

export const NOTE_DRAFT_VERSION = 1
export const DRAFT_KEY_PREFIX = 'pagewise:note-draft:v1:'
export const MAX_DRAFT_TEXT_LENGTH = 100_000 // 100KB 单条文本上限
export const MAX_STORED_DRAFTS = 100 // 本地最多保留 100 条草稿 (LRU 淘汰)

export interface NoteDraftContext {
  bookId: string
  /** 稳定上下文标识: 已有标注 id (如 `anno:${id}`) 或选区标识 (如 `sel:${cfi}`) */
  contextId: string
  /** 选区原文引文 (只读保留, 不混入用户正在编辑的正文) */
  quote?: string
  /** 来源位置 (CFI / 页码 / 章节) */
  sourceLoc?: string
}

export interface NoteDraft {
  readonly isDraft: true
  version: 1
  bookId: string
  contextId: string
  /** 用户编辑的笔记正文草稿 */
  text: string
  /** 关联的原选区引文 (独立保留) */
  quote?: string
  /** 来源位置 */
  sourceLoc?: string
  updatedAt: number
}

export type DraftSaveErrorCode =
  | 'storage_unavailable'
  | 'quota_exceeded'
  | 'capacity_reached'
  | 'payload_too_large'
  | 'invalid_context'
  | 'corrupt_storage'

export type DraftSaveResult =
  | { success: true; draft: NoteDraft }
  | {
      success: false
      error: DraftSaveErrorCode
      message: string
      textRecoverable: string
    }

export type DraftLoadErrorCode =
  | 'not_found'
  | 'context_mismatch'
  | 'corrupt_payload'
  | 'version_mismatch'
  | 'storage_unavailable'

export type DraftLoadResult =
  | { success: true; draft: NoteDraft }
  | {
      success: false
      error: DraftLoadErrorCode
      message: string
      rawPayload?: string
    }

export interface DraftStorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys?(): string[]
  length?: number
  key?(index: number): string | null
}

export interface DraftEnv {
  storage?: DraftStorageAdapter
  now?: () => number
}

function getDefaultStorage(): DraftStorageAdapter {
  // A volatile fallback must never acknowledge a reload-safe draft save.
  if (typeof window === 'undefined') throw new Error('本机草稿存储不可用')
  return window.localStorage
}

export function buildDraftKey(bookId: string, contextId: string): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(bookId)}::${encodeURIComponent(contextId)}`
}

export function parseDraftKey(key: string): { bookId: string; contextId: string } | null {
  if (!key.startsWith(DRAFT_KEY_PREFIX)) return null
  const sub = key.slice(DRAFT_KEY_PREFIX.length)
  const parts = sub.split('::')
  if (parts.length !== 2) return null
  try {
    return {
      bookId: decodeURIComponent(parts[0]),
      contextId: decodeURIComponent(parts[1]),
    }
  } catch {
    return null
  }
}

function getAllDraftKeys(storage: DraftStorageAdapter): string[] {
  if (typeof storage.keys === 'function') {
    return Array.from(storage.keys()).filter(k => k.startsWith(DRAFT_KEY_PREFIX))
  }
  const result: string[] = []
  const len = storage.length ?? 0
  if (typeof storage.key === 'function') {
    for (let i = 0; i < len; i++) {
      const k = storage.key(i)
      if (k && k.startsWith(DRAFT_KEY_PREFIX)) {
        result.push(k)
      }
    }
  }
  return result
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  const code = (err as { code?: number }).code
  const message = String((err as { message?: string }).message || '')
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014 ||
    /quota/i.test(message)
  )
}

/**
 * 保存笔记草稿 (显式调用或防抖触发)
 * 失败时保证 text 在返回结果中可恢复, 绝不丢失用户输入
 */
export function saveNoteDraft(
  ctx: NoteDraftContext,
  text: string,
  env?: DraftEnv,
): DraftSaveResult {
  const safeText = typeof text === 'string' ? text : String(text ?? '')

  if (!ctx || !ctx.bookId || !ctx.contextId) {
    return {
      success: false,
      error: 'invalid_context',
      message: '缺少有效的书籍标识或上下文标识',
      textRecoverable: safeText,
    }
  }

  if (safeText.length > MAX_DRAFT_TEXT_LENGTH) {
    return {
      success: false,
      error: 'payload_too_large',
      message: `草稿内容超过长度限制 (${MAX_DRAFT_TEXT_LENGTH} 字符)`,
      textRecoverable: safeText,
    }
  }

  const now = env?.now ? env.now() : Date.now()
  const key = buildDraftKey(ctx.bookId, ctx.contextId)

  const draft: NoteDraft = {
    isDraft: true,
    version: NOTE_DRAFT_VERSION,
    bookId: ctx.bookId,
    contextId: ctx.contextId,
    text: safeText,
    quote: ctx.quote,
    sourceLoc: ctx.sourceLoc,
    updatedAt: now,
  }

  try {
    const storage = env?.storage ?? getDefaultStorage()
    const keys = getAllDraftKeys(storage)
    if (!keys.includes(key) && keys.length >= MAX_STORED_DRAFTS) {
      return { success: false, error: 'capacity_reached', message: '草稿已达上限，请先保存或明确丢弃已有草稿；当前输入仍保留', textRecoverable: safeText }
    }
    storage.setItem(key, JSON.stringify(draft))
    return { success: true, draft }
  } catch (err) {
    if (isQuotaError(err)) {
      return {
        success: false,
        error: 'quota_exceeded',
        message: '本地存储配额不足, 草稿写入失败',
        textRecoverable: safeText,
      }
    }
    return {
      success: false,
      error: 'storage_unavailable',
      message: (err as Error)?.message || '存储不可用',
      textRecoverable: safeText,
    }
  }
}

/**
 * 读取同上下文草稿
 * 绝不允许跨上下文混淆或误认
 * 损坏的草稿载荷绝不连带清空其他不相关键
 */
export function loadNoteDraft(
  ctx: NoteDraftContext,
  env?: DraftEnv,
): DraftLoadResult {
  if (!ctx || !ctx.bookId || !ctx.contextId) {
    return {
      success: false,
      error: 'context_mismatch',
      message: '缺少有效的书籍标识或上下文标识',
    }
  }

  const key = buildDraftKey(ctx.bookId, ctx.contextId)

  let raw: string | null = null
  try {
    const storage = env?.storage ?? getDefaultStorage()
    raw = storage.getItem(key)
  } catch (err) {
    return {
      success: false,
      error: 'storage_unavailable',
      message: (err as Error)?.message || '存储不可用',
    }
  }

  if (raw === null || raw === undefined) {
    return {
      success: false,
      error: 'not_found',
      message: '未找到草稿',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      success: false,
      error: 'corrupt_payload',
      message: '草稿数据损坏 (JSON 解析失败)',
      rawPayload: raw,
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      success: false,
      error: 'corrupt_payload',
      message: '草稿格式非法',
      rawPayload: raw,
    }
  }

  const record = parsed as Record<string, unknown>

  if (record.version !== NOTE_DRAFT_VERSION) {
    return {
      success: false,
      error: 'version_mismatch',
      message: `草稿版本不匹配: ${record.version}`,
      rawPayload: raw,
    }
  }

  if (record.bookId !== ctx.bookId || record.contextId !== ctx.contextId) {
    return {
      success: false,
      error: 'context_mismatch',
      message: '草稿上下文不匹配',
      rawPayload: raw,
    }
  }

  if (typeof record.text !== 'string') {
    return {
      success: false,
      error: 'corrupt_payload',
      message: '草稿正文格式错误',
      rawPayload: raw,
    }
  }

  const draft: NoteDraft = {
    isDraft: true,
    version: NOTE_DRAFT_VERSION,
    bookId: String(record.bookId),
    contextId: String(record.contextId),
    text: record.text,
    quote: typeof record.quote === 'string' ? record.quote : ctx.quote,
    sourceLoc: typeof record.sourceLoc === 'string' ? record.sourceLoc : ctx.sourceLoc,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
  }

  return { success: true, draft }
}

/**
 * 成功保存正式笔记后移除草稿 (仅清除此上下文的草稿)
 */
export function removeNoteDraft(ctx: NoteDraftContext, env?: DraftEnv): { success: boolean; message?: string } {
  if (!ctx?.bookId || !ctx.contextId) return { success: false, message: '草稿上下文无效' }
  try {
    const storage = env?.storage ?? getDefaultStorage()
    storage.removeItem(buildDraftKey(ctx.bookId, ctx.contextId))
    return { success: true }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : '无法清理本机草稿' }
  }
}

/** 显式放弃草稿，不吞掉清理失败。 */
export function discardNoteDraft(ctx: NoteDraftContext, env?: DraftEnv) {
  return removeNoteDraft(ctx, env)
}

/**
 * 列出特定书籍或全局所有未保存草稿 (只读检索, 绝不标为正式标注)
 */
export function listDrafts(bookId?: string, env?: DraftEnv): NoteDraft[] {
  const storage = env?.storage ?? getDefaultStorage()
  const keys = getAllDraftKeys(storage)
  const results: NoteDraft[] = []

  for (const k of keys) {
    const raw = storage.getItem(k)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.version === NOTE_DRAFT_VERSION &&
        typeof parsed.bookId === 'string' &&
        typeof parsed.contextId === 'string' &&
        typeof parsed.text === 'string'
      ) {
        if (!bookId || parsed.bookId === bookId) {
          results.push({
            isDraft: true,
            version: NOTE_DRAFT_VERSION,
            bookId: parsed.bookId,
            contextId: parsed.contextId,
            text: parsed.text,
            quote: parsed.quote,
            sourceLoc: parsed.sourceLoc,
            updatedAt: parsed.updatedAt ?? 0,
          })
        }
      }
    } catch (error) {
      throw new Error('部分本机草稿无法解析，原始数据已保留', { cause: error })
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 契约守护: 严格校验是否为已持久化的正式标注, 严禁把 NoteDraft 混入为正式笔记
 */
export function isSavedAnnotation(rec: unknown): rec is AnnotationRec {
  if (!rec || typeof rec !== 'object') return false
  const r = rec as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.bookId === 'string' &&
    typeof r.cfi === 'string' &&
    typeof r.createdAt === 'number' &&
    r.isDraft !== true
  )
}

/**
 * 契约守护: 校验对象是否为草稿
 */
export function isNoteDraft(rec: unknown): rec is NoteDraft {
  if (!rec || typeof rec !== 'object') return false
  const r = rec as Record<string, unknown>
  return (
    r.isDraft === true &&
    r.version === NOTE_DRAFT_VERSION &&
    typeof r.bookId === 'string' &&
    typeof r.contextId === 'string' &&
    typeof r.text === 'string'
  )
}

/**
 * 防抖草稿保存器
 */
export interface DebouncedDraftSaver {
  save(text: string, quote?: string, sourceLoc?: string): void
  flush(): DraftSaveResult | null
  cancel(): void
  isPending(): boolean
  getRecoverableText(): string
}

export function createDebouncedDraftSaver(
  ctx: NoteDraftContext,
  options?: {
    delayMs?: number
    env?: DraftEnv
    onSaved?: (result: DraftSaveResult) => void
  },
): DebouncedDraftSaver {
  const delay = options?.delayMs ?? 400
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingText = ''
  let pendingQuote = ctx.quote
  let pendingLoc = ctx.sourceLoc
  let pending = false
  let lastResult: DraftSaveResult | null = null

  const doSave = (): DraftSaveResult => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const currentCtx: NoteDraftContext = {
      bookId: ctx.bookId,
      contextId: ctx.contextId,
      quote: pendingQuote,
      sourceLoc: pendingLoc,
    }
    const res = saveNoteDraft(currentCtx, pendingText, options?.env)
    pending = !res.success
    lastResult = res
    options?.onSaved?.(res)
    return res
  }

  return {
    save(text: string, quote?: string, sourceLoc?: string): void {
      pendingText = text
      if (quote !== undefined) pendingQuote = quote
      if (sourceLoc !== undefined) pendingLoc = sourceLoc
      pending = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        doSave()
      }, delay)
    },
    flush(): DraftSaveResult | null {
      if (pending) {
        return doSave()
      }
      return lastResult
    },
    cancel(): void {
      pending = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    isPending(): boolean {
      return pending
    },
    getRecoverableText(): string {
      return pendingText
    },
  }
}
