/**
 * AI 著录信息推理补全服务
 * 第二级：复用 reader/src/services/ai.ts (aiConfigured 与 chatStream)
 * 结合书名、文件名及已知线索，推理输出标准化的 JSON 著录信息
 */
import type { AiMessage } from './ai.ts'
import type { BookMetadataFields } from '../storage/types.ts'
import { METADATA_LIMITS } from './bookMetadata.ts'
import { normalizeLanguageCode, normalizePublicationDate } from './openBookSearch.ts'

export interface InferBookMetadataParams {
  title: string
  fileName?: string
  current?: BookMetadataFields
  signal?: AbortSignal
}

export class AiMetadataError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AiMetadataError'
    this.code = code
  }
}

/** 提取文本中的有效 JSON 对象 */
export function extractJsonFromAiResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new AiMetadataError('empty_output', 'AI returned empty output')
  }

  // 去除 markdown 标记
  let sanitized = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const startIdx = sanitized.indexOf('{')
  const endIdx = sanitized.lastIndexOf('}')
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new AiMetadataError('invalid_json', 'No valid JSON found in AI response')
  }

  sanitized = sanitized.slice(startIdx, endIdx + 1)
  try {
    const parsed = JSON.parse(sanitized)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Not an object')
    }
    return parsed
  } catch (err: any) {
    throw new AiMetadataError('invalid_json', `Failed to parse AI JSON: ${err?.message || 'syntax error'}`)
  }
}

/** 规范化单项著录字符串 */
function cleanField(raw: unknown, limit: number): string | undefined {
  if (raw == null) return undefined
  let str = String(raw).trim()
  if (!str || str.toLowerCase() === 'unknown' || str === '未知') return undefined
  if (str.includes('\0')) {
    str = str.replace(/\0/g, '')
  }
  return str.slice(0, limit).trim() || undefined
}

export async function inferBookMetadataWithAi(
  params: InferBookMetadataParams,
): Promise<BookMetadataFields> {
  const { aiConfigured, chatStream } = await import('./ai')
  if (!aiConfigured()) {
    throw new AiMetadataError('unconfigured', 'AI service is not configured')
  }

  const { title, fileName, current, signal } = params
  if (!title?.trim()) {
    throw new AiMetadataError('invalid_input', 'Book title is required')
  }

  const knownHints: string[] = []
  if (fileName?.trim()) knownHints.push(`文件名: ${fileName.trim()}`)
  if (current?.author?.trim()) knownHints.push(`已知作者: ${current.author.trim()}`)
  if (current?.publisher?.trim()) knownHints.push(`已知出版社: ${current.publisher.trim()}`)
  if (current?.publicationDate?.trim()) knownHints.push(`已知出版时间: ${current.publicationDate.trim()}`)
  if (current?.language?.trim()) knownHints.push(`已知语种: ${current.language.trim()}`)

  const messages: AiMessage[] = [
    {
      role: 'system',
      content:
        '你是一名专业的图书情报编目专家。请根据提供的书名及线索，推理并补全该书籍的标准出版著录信息。' +
        '只输出符合以下格式的纯 JSON 对象，不要添加任何 markdown 解释或多余文本：\n' +
        '{\n' +
        '  "author": "作者姓名（多位作者用逗号分隔）",\n' +
        '  "publisher": "正规出版社名称",\n' +
        '  "publicationDate": "出版年份或年月，如 2018 或 2018-05",\n' +
        '  "language": "语种代码，如 zh 或 en"\n' +
        '}',
    },
    {
      role: 'user',
      content: `请为以下书籍推理著录元数据：\n书名: ${title.trim()}\n${knownHints.join('\n')}`,
    },
  ]

  let fullResponse = ''
  try {
    for await (const chunk of chatStream(messages, signal)) {
      fullResponse += chunk
    }
  } catch (err: any) {
    if (signal?.aborted) {
      throw new AiMetadataError('cancelled', 'AI metadata inference was cancelled')
    }
    throw new AiMetadataError('generation_failed', err?.message || 'AI request failed')
  }

  const json = extractJsonFromAiResponse(fullResponse)

  const rawAuthor = cleanField(json.author, METADATA_LIMITS.author)
  const rawPublisher = cleanField(json.publisher, METADATA_LIMITS.publisher)
  const rawDate = cleanField(json.publicationDate, METADATA_LIMITS.publicationDate)
  const rawLang = cleanField(json.language, METADATA_LIMITS.language)

  return {
    author: rawAuthor,
    publisher: rawPublisher,
    publicationDate: normalizePublicationDate(rawDate) || rawDate,
    language: normalizeLanguageCode(rawLang) || rawLang,
  }
}
