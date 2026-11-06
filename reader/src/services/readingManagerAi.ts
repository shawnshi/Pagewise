/**
 * AI 原生个人阅读管理器核心服务 (P0 - P2)
 *
 * 涵盖三大核心演进能力:
 * - P0: 单书批注聚类综述与带 CFI 锚点的结构化 Markdown 导出 (Annotation Synthesis)
 * - P1: 跨周期断点前情提要 (Contextual Catch-up)
 * - P2: 跨书观点对比矩阵 (Dialectical Matrix) 与 主题阅读路径规划 (Reading Path Builder)
 *
 * 架构护栏:
 * 1. 隐私与预算边界: 仅发送书目元数据、TOC 标题与用户主动标注的 AnnotationRec，绝不读取或上传原书正文 Blob。
 * 2. 防幻觉白名单校验: AI 返回的 annotationIds 与 bookId 严格对照输入白名单过滤，杜绝悬空引用。
 * 3. 确定性降级: 即使未配置 AI，本地断点快照与带 CFI 跳转链接的 Markdown 笔记导出依然 100% 可用。
 */

import type { AnnotationRec, BookMeta } from '../storage/types.ts'
import type { AiMessage } from './ai.ts'

export type ReadingManagerAiErrorCode =
  | 'unconfigured'
  | 'invalid_input'
  | 'empty_annotations'
  | 'no_progress_or_records'
  | 'insufficient_books'
  | 'empty_output'
  | 'invalid_json'
  | 'invalid_schema'
  | 'cancelled'
  | 'generation_failed'

export class ReadingManagerAiError extends Error {
  readonly code: ReadingManagerAiErrorCode
  constructor(code: ReadingManagerAiErrorCode, message: string) {
    super(message)
    this.name = 'ReadingManagerAiError'
    this.code = code
  }
}

export interface AiRuntimeDeps {
  isConfigured?: () => boolean
  streamChat?: (messages: AiMessage[], signal?: AbortSignal) => AsyncIterable<string>
}

/** 安全清理并截断提示词文本，剔除 \0 空字符 */
export function sanitizePromptText(text: string | undefined | null, maxLen = 400): string {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/\0/g, '').trim().slice(0, maxLen)
}

/** 从大模型响应中提取有效 JSON 对象 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = (raw || '').trim()
  if (!trimmed) {
    throw new ReadingManagerAiError('empty_output', 'AI 未返回有效内容')
  }

  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new ReadingManagerAiError('invalid_json', 'AI 响应中未找到有效 JSON 结构')
  }

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Root is not an object')
    }
    return parsed as Record<string, unknown>
  } catch (err: any) {
    throw new ReadingManagerAiError('invalid_json', `解析 AI JSON 失败: ${err?.message || '语法错误'}`)
  }
}

async function runAiJsonPrompt(
  messages: AiMessage[],
  signal?: AbortSignal,
  deps?: AiRuntimeDeps,
): Promise<Record<string, unknown>> {
  let isConfigured = deps?.isConfigured
  let streamChat = deps?.streamChat
  if (!isConfigured || !streamChat) {
    const aiMod = await import('./ai.ts')
    isConfigured = isConfigured ?? aiMod.aiConfigured
    streamChat = streamChat ?? aiMod.chatStream
  }

  if (!isConfigured()) {
    throw new ReadingManagerAiError('unconfigured', '请先在设置中配置 AI 服务')
  }

  signal?.throwIfAborted()

  let output = ''
  try {
    for await (const chunk of streamChat(messages, signal)) {
      signal?.throwIfAborted()
      output += chunk
    }
  } catch (err: any) {
    if (signal?.aborted) {
      throw new ReadingManagerAiError('cancelled', '请求已取消')
    }
    if (err instanceof ReadingManagerAiError) throw err
    throw new ReadingManagerAiError('generation_failed', err?.message || 'AI 生成请求失败')
  }

  return extractJsonObject(output)
}

/** 生成阅读器内原书定位跳转链接 */
export function formatAnnotationJumpPath(
  book: Pick<BookMeta, 'id' | 'kind' | 'format'>,
  cfi: string,
): string {
  if (!book?.id) return ''
  const isPaper = book.kind === 'paper' || book.format === 'pdf'
  const base = isPaper ? `/read-paper/${encodeURIComponent(book.id)}` : `/read/${encodeURIComponent(book.id)}`
  return cfi ? `${base}?loc=${encodeURIComponent(cfi)}` : base
}

// ============================================================================
// P0: 单书批注聚类综述与结构化 Markdown 导出
// ============================================================================

export interface AnnotationThemeCluster {
  title: string
  insight: string
  annotationIds: string[]
}

export interface AnnotationSynthesisResult {
  summary: string
  themes: AnnotationThemeCluster[]
  keyTakeaways: string[]
}

export interface SynthesizeAnnotationsParams {
  book: Pick<BookMeta, 'id' | 'title' | 'author' | 'publisher' | 'description'>
  annotations: readonly AnnotationRec[]
  signal?: AbortSignal
  deps?: AiRuntimeDeps
}

/**
 * P0: AI 批注聚类综述
 * 仅发送书籍基础元数据与用户主动标注的划线/想法，对返回的 annotationIds 执行白名单过滤
 */
export async function synthesizeBookAnnotationsWithAi(
  params: SynthesizeAnnotationsParams,
): Promise<AnnotationSynthesisResult> {
  const { book, annotations, signal, deps } = params
  if (!book?.title?.trim()) {
    throw new ReadingManagerAiError('invalid_input', '缺少书籍标题')
  }

  const validAnnotations = annotations.filter(a => (a.text && a.text.trim()) || (a.note && a.note.trim()))
  if (validAnnotations.length === 0) {
    throw new ReadingManagerAiError('empty_annotations', '当前书籍暂无可用于综述的划线或想法记录')
  }

  const subset = validAnnotations.slice(0, 60)
  const allowedIds = new Set(subset.map(a => a.id))

  const serializedNotes = subset.map((a, idx) => ({
    id: a.id,
    index: idx + 1,
    kind: a.kind || 'highlight',
    quote: sanitizePromptText(a.text, 320),
    thought: sanitizePromptText(a.note, 240) || undefined,
  }))

  const messages: AiMessage[] = [
    {
      role: 'system',
      content:
        '你是一位严谨的学术与深度阅读研究顾问。请基于用户在该书中留下的划线原文(quote)与个人想法(thought)，' +
        '将零散批注按核心论点聚类整理为结构化读书综述。\n' +
        '严格要求：\n' +
        '1. 忠实于用户的批注与想法，不捏造未出现的原文事实；\n' +
        '2. annotationIds 必须且只能引用输入批注列表中真实存在的 id；\n' +
        '3. 仅输出如下格式的纯 JSON 对象，不含任何额外说明文字：\n' +
        '{\n' +
        '  "summary": "全书阅读收获与核心脉络综述（120-260字）",\n' +
        '  "themes": [\n' +
        '    {\n' +
        '      "title": "主题维度标题",\n' +
        '      "insight": "该维度下的核心论点与用户思考合成",\n' +
        '      "annotationIds": ["批注id1", "批注id2"]\n' +
        '    }\n' +
        '  ],\n' +
        '  "keyTakeaways": ["可迁移的核心认知或行动启发1", "启发2"]\n' +
        '}',
    },
    {
      role: 'user',
      content: JSON.stringify({
        book: {
          title: sanitizePromptText(book.title, 160),
          author: sanitizePromptText(book.author, 120),
          publisher: sanitizePromptText(book.publisher, 120),
          description: sanitizePromptText(book.description, 400),
        },
        annotations: serializedNotes,
      }),
    },
  ]

  const json = await runAiJsonPrompt(messages, signal, deps)

  const summary = sanitizePromptText(String(json.summary ?? ''), 1200)
  if (!summary) {
    throw new ReadingManagerAiError('invalid_schema', 'AI 未生成有效的综述摘要')
  }

  const rawThemes = Array.isArray(json.themes) ? json.themes : []
  const themes: AnnotationThemeCluster[] = []
  for (const item of rawThemes.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const title = sanitizePromptText(String(rec.title ?? ''), 120)
    const insight = sanitizePromptText(String(rec.insight ?? ''), 600)
    if (!title || !insight) continue
    const rawIds = Array.isArray(rec.annotationIds) ? rec.annotationIds : []
    const filteredIds = rawIds
      .map(id => String(id).trim())
      .filter(id => allowedIds.has(id))
    themes.push({
      title,
      insight,
      annotationIds: [...new Set(filteredIds)],
    })
  }

  const rawTakeaways = Array.isArray(json.keyTakeaways) ? json.keyTakeaways : []
  const keyTakeaways = rawTakeaways
    .map(v => sanitizePromptText(String(v ?? ''), 240))
    .filter(Boolean)
    .slice(0, 8)

  return {
    summary,
    themes,
    keyTakeaways,
  }
}

/**
 * P0: 生成结构化读书笔记 Markdown（支持纯本地确定性导出 + 融合 AI 聚类综述导出）
 * 保留每条记录的 CFI 锚点与原书定位跳转链接
 */
export function buildLocalAnnotationMarkdown(
  book: Pick<BookMeta, 'id' | 'title' | 'author' | 'publisher' | 'publicationDate' | 'kind' | 'format'>,
  annotations: readonly AnnotationRec[],
  synthesis?: AnnotationSynthesisResult | null,
): string {
  const lines: string[] = []
  const title = book.title?.trim() || '未命名书籍'
  const author = book.author?.trim() || '未知作者'

  lines.push(`# 《${title}》读书笔记与批注综述`)
  lines.push('')
  lines.push(`- **作者**：${author}`)
  if (book.publisher?.trim()) lines.push(`- **出版社**：${book.publisher.trim()}`)
  if (book.publicationDate?.trim()) lines.push(`- **出版时间**：${book.publicationDate.trim()}`)
  lines.push(`- **标注总数**：${annotations.length} 条`)
  lines.push('')

  const annById = new Map<string, AnnotationRec>()
  for (const a of annotations) {
    if (a?.id) annById.set(a.id, a)
  }

  if (synthesis) {
    lines.push('## 一、 核心脉络综述 (AI 蒸馏)')
    lines.push('')
    lines.push(synthesis.summary)
    lines.push('')

    if (synthesis.themes.length > 0) {
      lines.push('## 二、 主题论点聚类')
      lines.push('')
      synthesis.themes.forEach((theme, idx) => {
        lines.push(`### ${idx + 1}. ${theme.title}`)
        lines.push('')
        lines.push(theme.insight)
        if (theme.annotationIds.length > 0) {
          lines.push('')
          lines.push('**关联原文锚点：**')
          for (const aid of theme.annotationIds) {
            const ann = annById.get(aid)
            if (!ann) continue
            const snippet = (ann.text || ann.note || '').replace(/\s+/g, ' ').slice(0, 80)
            const jumpUrl = formatAnnotationJumpPath(book, ann.cfi)
            lines.push(`- “${snippet}” ([定位原文](${jumpUrl}) \`${ann.cfi || 'N/A'}\`)`)
          }
        }
        lines.push('')
      })
    }

    if (synthesis.keyTakeaways.length > 0) {
      lines.push('## 三、 核心认知启发')
      lines.push('')
      for (const item of synthesis.keyTakeaways) {
        lines.push(`- ${item}`)
      }
      lines.push('')
    }
  }

  lines.push(synthesis ? '## 四、 原始批注与想法明细' : '## 原始批注与想法明细')
  lines.push('')

  if (annotations.length === 0) {
    lines.push('_暂无标注记录_')
    return lines.join('\n')
  }

  const sorted = [...annotations].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  sorted.forEach((ann, idx) => {
    const dateStr = ann.createdAt ? new Date(ann.createdAt).toISOString().slice(0, 10) : ''
    const kindLabel = ann.kind === 'bookmark' ? '书签' : '划线'
    const jumpUrl = formatAnnotationJumpPath(book, ann.cfi)
    lines.push(`### ${idx + 1}. [${kindLabel}] ${dateStr}`)
    if (ann.text?.trim()) {
      lines.push(`> ${ann.text.trim().replace(/\n/g, '\n> ')}`)
    }
    if (ann.note?.trim()) {
      lines.push('')
      lines.push(`**想法**：${ann.note.trim()}`)
    }
    if (ann.cfi) {
      lines.push('')
      lines.push(`- 锚点：\`${ann.cfi}\` · [回跳原文](${jumpUrl})`)
    }
    lines.push('')
  })

  return lines.join('\n')
}

// ============================================================================
// P1: 断点前情提要 (Contextual Catch-up)
// ============================================================================

export interface LocalCatchupSnapshot {
  progressPercent: number
  daysSinceLastRead: number | null
  needsCatchup: boolean
  recentAnnotations: AnnotationRec[]
}

export interface ReadingCatchupResult {
  whereYouLeftOff: string
  keyThreads: string[]
  nextStepSuggestion: string
}

export interface GenerateCatchupParams {
  book: Pick<
    BookMeta,
    'id' | 'title' | 'author' | 'description' | 'progress' | 'location' | 'lastReadAt' | 'readingStatus'
  >
  annotations: readonly AnnotationRec[]
  tocTitles?: readonly string[]
  signal?: AbortSignal
  deps?: AiRuntimeDeps
}

/**
 * P1: 构建确定性本地断点快照（零网络开销）
 */
export function buildLocalCatchupSnapshot(
  book: Pick<BookMeta, 'id' | 'title' | 'author' | 'progress' | 'location' | 'lastReadAt' | 'readingSeconds' | 'readingStatus'>,
  annotations: readonly AnnotationRec[],
  now = Date.now(),
): LocalCatchupSnapshot {
  const progressPercent = book.progress != null
    ? Math.min(100, Math.max(0, Math.round(book.progress * 100)))
    : 0

  let daysSinceLastRead: number | null = null
  if (typeof book.lastReadAt === 'number' && book.lastReadAt > 0 && now >= book.lastReadAt) {
    daysSinceLastRead = Math.floor((now - book.lastReadAt) / (1000 * 60 * 60 * 24))
  }

  const recentAnnotations = [...annotations]
    .filter(a => (a.text && a.text.trim()) || (a.note && a.note.trim()))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 5)

  const needsCatchup =
    progressPercent > 0 ||
    recentAnnotations.length > 0 ||
    book.readingStatus === 'paused' ||
    book.readingStatus === 'reading'

  return {
    progressPercent,
    daysSinceLastRead,
    needsCatchup,
    recentAnnotations,
  }
}

/**
 * P1: AI 生成断点前情提要
 */
export async function generateReadingCatchupWithAi(
  params: GenerateCatchupParams,
): Promise<ReadingCatchupResult> {
  const { book, annotations, tocTitles = [], signal, deps } = params
  if (!book?.title?.trim()) {
    throw new ReadingManagerAiError('invalid_input', '缺少书籍标题')
  }

  const snapshot = buildLocalCatchupSnapshot(book, annotations)
  const hasContext =
    snapshot.progressPercent > 0 ||
    snapshot.recentAnnotations.length > 0 ||
    tocTitles.length > 0 ||
    Boolean(book.description?.trim())

  if (!hasContext) {
    throw new ReadingManagerAiError(
      'no_progress_or_records',
      '本书尚无阅读进度、批注或简介线索，无需生成前情提要',
    )
  }

  const messages: AiMessage[] = [
    {
      role: 'system',
      content:
        '你是深度阅读伴读顾问。用户准备续读一本此前阅读过或搁置的书籍，请根据当前阅读进度、目录章节及用户最近留下的划线/想法，' +
        '生成一份简明精炼的“断点前情提要”，帮助用户快速找回阅读状态。\n' +
        '仅输出如下格式的纯 JSON 对象：\n' +
        '{\n' +
        '  "whereYouLeftOff": "上次阅读所处的脉络位置与核心议题回顾（80-180字）",\n' +
        '  "keyThreads": ["基于已有批注或章节提炼的认知锚点/待解问题1", "锚点2"],\n' +
        '  "nextStepSuggestion": "接下来续读时的衔接建议与关注点（40-100字）"\n' +
        '}',
    },
    {
      role: 'user',
      content: JSON.stringify({
        book: {
          title: sanitizePromptText(book.title, 160),
          author: sanitizePromptText(book.author, 120),
          description: sanitizePromptText(book.description, 400),
          progressPercent: snapshot.progressPercent,
          daysSinceLastRead: snapshot.daysSinceLastRead,
          readingStatus: book.readingStatus,
        },
        tocPreview: tocTitles.slice(0, 25).map(t => sanitizePromptText(t, 80)),
        recentAnnotations: snapshot.recentAnnotations.map(a => ({
          quote: sanitizePromptText(a.text, 260),
          thought: sanitizePromptText(a.note, 200) || undefined,
        })),
      }),
    },
  ]

  const json = await runAiJsonPrompt(messages, signal, deps)

  const whereYouLeftOff = sanitizePromptText(String(json.whereYouLeftOff ?? ''), 800)
  const nextStepSuggestion = sanitizePromptText(String(json.nextStepSuggestion ?? ''), 400)
  if (!whereYouLeftOff) {
    throw new ReadingManagerAiError('invalid_schema', 'AI 未返回有效的前情提要内容')
  }

  const rawThreads = Array.isArray(json.keyThreads) ? json.keyThreads : []
  const keyThreads = rawThreads
    .map(v => sanitizePromptText(String(v ?? ''), 240))
    .filter(Boolean)
    .slice(0, 5)

  return {
    whereYouLeftOff,
    keyThreads,
    nextStepSuggestion: nextStepSuggestion || '建议从上次停留章节或最近一条高亮处继续阅读。',
  }
}

// ============================================================================
// P2-A: 跨书观点对比矩阵 (Dialectical Matrix)
// ============================================================================

export interface CrossBookEntry {
  book: Pick<BookMeta, 'id' | 'title' | 'author' | 'description' | 'publisher' | 'publicationDate'>
  annotations: readonly AnnotationRec[]
}

export interface BookPerspectiveItem {
  bookId: string
  bookTitle: string
  coreStance: string
  keyEvidence: string
  boundary: string
}

export interface CrossBookMatrixResult {
  topic: string
  consensus: string[]
  divergences: string[]
  perspectives: BookPerspectiveItem[]
}

export interface GenerateCrossBookMatrixParams {
  topic?: string
  entries: readonly CrossBookEntry[]
  signal?: AbortSignal
  deps?: AiRuntimeDeps
}

/**
 * P2-A: 生成跨书观点对比矩阵（2-4 本书）
 */
export async function generateCrossBookMatrixWithAi(
  params: GenerateCrossBookMatrixParams,
): Promise<CrossBookMatrixResult> {
  const { topic = '', entries, signal, deps } = params
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 4) {
    throw new ReadingManagerAiError('insufficient_books', '请选择 2 至 4 本书籍进行跨书观点对比')
  }

  const bookMap = new Map<string, CrossBookEntry['book']>()
  for (const e of entries) {
    if (!e?.book?.id || !e.book.title?.trim()) {
      throw new ReadingManagerAiError('invalid_input', '所选书籍包含无效的书目记录')
    }
    bookMap.set(e.book.id, e.book)
  }

  const payloadBooks = entries.map((e: CrossBookEntry) => ({
    bookId: e.book.id,
    title: sanitizePromptText(e.book.title, 140),
    author: sanitizePromptText(e.book.author, 100),
    description: sanitizePromptText(e.book.description, 320),
    annotations: e.annotations
      .filter((a: AnnotationRec) => (a.text && a.text.trim()) || (a.note && a.note.trim()))
      .slice(0, 15)
      .map((a: AnnotationRec) => ({
        quote: sanitizePromptText(a.text, 220),
        thought: sanitizePromptText(a.note, 180) || undefined,
      })),
  }))

  const cleanTopic = sanitizePromptText(topic, 160) || '核心论点与方法论比较'

  const messages: AiMessage[] = [
    {
      role: 'system',
      content:
        '你是一位跨学科文献对比研究顾问。请基于用户勾选的多本书籍元数据及用户在各书中留下的批注，' +
        '构建结构化的“跨书观点对比矩阵”，识别多书之间的核心共识、张力分歧以及每本书的独立立场与适用边界。\n' +
        '严格要求：\n' +
        '1. perspectives 中的 bookId 必须严格使用输入中的真实 bookId；\n' +
        '2. 仅输出如下格式的纯 JSON 对象：\n' +
        '{\n' +
        '  "topic": "对比核心议题",\n' +
        '  "consensus": ["多书共同认可的底层规律或共识1", "共识2"],\n' +
        '  "divergences": ["各书在机制、路径或价值取向上的核心分歧1", "分歧2"],\n' +
        '  "perspectives": [\n' +
        '    {\n' +
        '      "bookId": "输入中的真实bookId",\n' +
        '      "coreStance": "该书的核心命题与切入视角",\n' +
        '      "keyEvidence": "承重论据及用户批注印证",\n' +
        '      "boundary": "适用前提或局限边界"\n' +
        '    }\n' +
        '  ]\n' +
        '}',
    },
    {
      role: 'user',
      content: JSON.stringify({
        topic: cleanTopic,
        books: payloadBooks,
      }),
    },
  ]

  const json = await runAiJsonPrompt(messages, signal, deps)

  const consensus = (Array.isArray(json.consensus) ? json.consensus : [])
    .map(v => sanitizePromptText(String(v ?? ''), 300))
    .filter(Boolean)
    .slice(0, 6)

  const divergences = (Array.isArray(json.divergences) ? json.divergences : [])
    .map(v => sanitizePromptText(String(v ?? ''), 300))
    .filter(Boolean)
    .slice(0, 6)

  const rawPerspectives = Array.isArray(json.perspectives) ? json.perspectives : []
  const perspectives: BookPerspectiveItem[] = []
  const seenIds = new Set<string>()

  for (const item of rawPerspectives) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const bid = String(rec.bookId ?? '').trim()
    const matchedBook = bookMap.get(bid)
    if (!matchedBook || seenIds.has(bid)) continue

    const coreStance = sanitizePromptText(String(rec.coreStance ?? ''), 400)
    const keyEvidence = sanitizePromptText(String(rec.keyEvidence ?? ''), 400)
    const boundary = sanitizePromptText(String(rec.boundary ?? ''), 300)
    if (!coreStance) continue

    seenIds.add(bid)
    perspectives.push({
      bookId: bid,
      bookTitle: matchedBook.title,
      coreStance,
      keyEvidence: keyEvidence || '基于书目简介与现有批注归纳',
      boundary: boundary || '需结合具体业务或历史语境审视',
    })
  }

  if (perspectives.length === 0) {
    throw new ReadingManagerAiError('invalid_schema', 'AI 未能生成有效的多书立场对比矩阵')
  }

  return {
    topic: sanitizePromptText(String(json.topic ?? ''), 160) || cleanTopic,
    consensus,
    divergences,
    perspectives,
  }
}

/**
 * 将跨书观点对比矩阵导出为 Markdown
 */
export function buildCrossBookMatrixMarkdown(matrix: CrossBookMatrixResult): string {
  const lines: string[] = []
  lines.push(`# 跨书观点对比矩阵：${matrix.topic}`)
  lines.push('')

  if (matrix.consensus.length > 0) {
    lines.push('## 一、 核心共识')
    lines.push('')
    for (const c of matrix.consensus) {
      lines.push(`- ${c}`)
    }
    lines.push('')
  }

  if (matrix.divergences.length > 0) {
    lines.push('## 二、 关键分歧与张力')
    lines.push('')
    for (const d of matrix.divergences) {
      lines.push(`- ${d}`)
    }
    lines.push('')
  }

  lines.push('## 三、 各书立场与边界对照')
  lines.push('')
  lines.push('| 书目 | 核心立场 | 承重论据与批注印证 | 适用边界与局限 |')
  lines.push('| :--- | :--- | :--- | :--- |')
  for (const p of matrix.perspectives) {
    const clean = (s: string) => s.replaceAll('|', '\\|').replace(/\n+/g, ' ')
    lines.push(
      `| 《${clean(p.bookTitle)}》 | ${clean(p.coreStance)} | ${clean(p.keyEvidence)} | ${clean(p.boundary)} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ============================================================================
// P2-B: 主题阅读路径规划 (Reading Path / Syllabus Builder)
// ============================================================================

export interface ReadingPathStage {
  order: number
  stageName: string
  bookId: string
  bookTitle: string
  bookAuthor: string
  rationale: string
  focusArea: string
}

export interface ReadingPathResult {
  goal: string
  overview: string
  stages: ReadingPathStage[]
}

export interface GenerateReadingPathParams {
  goal: string
  books: readonly BookMeta[]
  signal?: AbortSignal
  deps?: AiRuntimeDeps
}

/**
 * 本地确定性相关性初筛：从全量藏书中选出与目标主题最相关的候选子集（控制 Token 预算）
 */
export function rankBooksForReadingPath(
  goal: string,
  books: readonly BookMeta[],
  limit = 12,
): BookMeta[] {
  const rawSegments = goal
    .toLowerCase()
    .split(/[\s,，。；;、/|+_\-与和及的之或]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2)

  const tokenSet = new Set<string>(rawSegments)
  for (const seg of rawSegments) {
    // 提取中文双字词片段以提升无空格短语的召回率
    if (/[\u4e00-\u9fff]/.test(seg) && seg.length > 2) {
      for (let i = 0; i <= seg.length - 2; i++) {
        tokenSet.add(seg.slice(i, i + 2))
      }
    }
  }
  const tokens = [...tokenSet]

  const scored = books.map(book => {
    let score = 0
    const haystack = [
      book.title || '',
      book.author || '',
      book.description || '',
      ...(book.tags || []),
      book.classification?.category?.value || '',
      ...(book.classification?.topics?.map(t => t.value) || []),
    ]
      .join(' ')
      .toLowerCase()

    for (const token of tokens) {
      if (book.title?.toLowerCase().includes(token)) score += 15
      else if (haystack.includes(token)) score += 6
    }

    if (book.description?.trim()) score += 3
    if (book.readingStatus === 'wanted' || book.readingStatus === 'reading') score += 2
    return { book, score }
  })

  return scored
    .sort((a, b) => b.score - a.score || (b.book.addedAt || 0) - (a.book.addedAt || 0))
    .slice(0, Math.max(1, limit))
    .map(item => item.book)
}

/**
 * P2-B: AI 生成阶梯式主题阅读路径，并严格按本地真实藏书 ID 白名单校验
 */
export async function generateReadingPathWithAi(
  params: GenerateReadingPathParams,
): Promise<ReadingPathResult> {
  const { goal, books, signal, deps } = params
  const cleanGoal = sanitizePromptText(goal, 200)
  if (!cleanGoal) {
    throw new ReadingManagerAiError('invalid_input', '请输入明确的阅读主题或待研究问题')
  }
  if (!Array.isArray(books) || books.length === 0) {
    throw new ReadingManagerAiError('insufficient_books', '当前书架暂无可用藏书')
  }

  const candidates = rankBooksForReadingPath(cleanGoal, books, 12)
  const allowedBooks = new Map<string, BookMeta>()
  for (const b of candidates) {
    allowedBooks.set(b.id, b)
  }

  const serializedCandidates = candidates.map(b => ({
    bookId: b.id,
    title: sanitizePromptText(b.title, 140),
    author: sanitizePromptText(b.author, 100),
    description: sanitizePromptText(b.description, 260),
    tags: (b.tags || []).slice(0, 6),
    readingStatus: b.readingStatus || 'unmarked',
  }))

  const messages: AiMessage[] = [
    {
      role: 'system',
      content:
        '你是一位资深学术导师与个人藏书规划师。请根据用户提出的“研究课题/阅读目标”，从提供的本地候选藏书中挑选最匹配的 1 至 5 本书，' +
        '按“基础通识 -> 核心机制 -> 进阶深化/反方检验”设计阶梯式阅读路径（Syllabus）。\n' +
        '严格要求：\n' +
        '1. stages 中的 bookId 必须严格来自输入候选列表中的真实 bookId，严禁编造列表之外的书籍；\n' +
        '2. 仅输出如下格式的纯 JSON 对象：\n' +
        '{\n' +
        '  "goal": "规范化后的主题名称",\n' +
        '  "overview": "整体阅读路径设计逻辑（60-160字）",\n' +
        '  "stages": [\n' +
        '    {\n' +
        '      "stageName": "阶段一：通识与框架建立",\n' +
        '      "bookId": "候选中的真实bookId",\n' +
        '      "rationale": "为何在此顺位阅读本书",\n' +
        '      "focusArea": "建议重点关注的章节脉络或核心问题"\n' +
        '    }\n' +
        '  ]\n' +
        '}',
    },
    {
      role: 'user',
      content: JSON.stringify({
        goal: cleanGoal,
        candidates: serializedCandidates,
      }),
    },
  ]

  const json = await runAiJsonPrompt(messages, signal, deps)

  const overview = sanitizePromptText(String(json.overview ?? ''), 600)
  const rawStages = Array.isArray(json.stages) ? json.stages : []
  const stages: ReadingPathStage[] = []
  const usedIds = new Set<string>()

  for (const item of rawStages) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const bid = String(rec.bookId ?? '').trim()
    const matched = allowedBooks.get(bid)
    if (!matched || usedIds.has(bid)) continue

    const stageName = sanitizePromptText(String(rec.stageName ?? ''), 100) || `第 ${stages.length + 1} 阶段`
    const rationale = sanitizePromptText(String(rec.rationale ?? ''), 360)
    const focusArea = sanitizePromptText(String(rec.focusArea ?? ''), 360)
    if (!rationale) continue

    usedIds.add(bid)
    stages.push({
      order: stages.length + 1,
      stageName,
      bookId: bid,
      bookTitle: matched.title,
      bookAuthor: matched.author || '未知作者',
      rationale,
      focusArea: focusArea || '重点通读核心论点章节并做结构化笔记',
    })
  }

  if (stages.length === 0) {
    throw new ReadingManagerAiError('invalid_schema', '未能从当前藏书中匹配出有效的主题阅读路径')
  }

  return {
    goal: sanitizePromptText(String(json.goal ?? ''), 160) || cleanGoal,
    overview: overview || `围绕“${cleanGoal}”从本地藏书中筛选出的 ${stages.length} 步阶梯阅读计划。`,
    stages,
  }
}
