/**
 * 点睛阅读的提示词、调用参数与额度换算 (docs/dianjing-reading.md §6.3 §6.6 §6.9)。
 *
 * **单一来源**: relay (relay/src/index.js) 直接 import 本文件 (wrangler/esbuild 打包 .ts),
 * 内置通道在服务端拼装提示词; 用户自带密钥时客户端用同一个函数拼装后直连。
 * 所以本文件必须是纯函数、零依赖 (不 import 任何 Vue / 浏览器模块)。
 *
 * 改提示词或输出协议时递增 PROMPT_VERSION: 它进入缓存键, 旧缓存不会与新协议混用。
 */

export const PROMPT_VERSION = 'dj2'
/** 上一版 (没有重点词): 已读部分的旧缓存仍可用于要句 / 概念 / 注, 重点词改用离线结果 */
export const LEGACY_PROMPT_VERSIONS: readonly string[] = ['dj1']

/** 内置通道默认模型 (SiliconFlow) 与备用模型 */
export const DJ_MODEL = 'deepseek-ai/DeepSeek-V4-Flash'
export const DJ_FALLBACK_MODEL = 'Qwen/Qwen3.5-35B-A3B'

/** 单块正文上限 (字符); relay 超出直接 400 */
export const MAX_CHUNK_CHARS = 3000
export const MAX_TOKENS = 1500
export const MAX_KNOWN_TERMS = 30

export type DjMode = 'mark' | 'summary' | 'translate'

export interface DjBookMeta {
  title?: string
  author?: string
}

/** 发给 relay 的请求体 (内置通道) */
export interface DjRequest {
  promptVersion: string
  mode: DjMode
  /** 界面语言: 释义 / 理由 / 注释用它写 */
  lang: 'zh' | 'en'
  /** 书的语言 (BCP47, 可空) */
  bookLang?: string
  book: DjBookMeta
  chapter?: string
  /** 叙事类 (小说等): 防剧透规则 */
  fiction?: boolean
  /** 需要模型判断体裁时为 true (首块), 模型先输出一行 {"t":"meta","fiction":bool} */
  askGenre?: boolean
  /** mark / translate: 已编号的正文 ("[1.1] 句子……" 每段一行); summary: 段意与要句列表 */
  text: string
  /** 同书已释义的概念 (避免重复), 最多 30 个 */
  knownTerms?: string[]
  /** mark: 另外挑出本块的重点词 ({"t":"kw"} 行, 用来在正文里点亮); 只对中文正文 (dj2 起) */
  keywords?: boolean
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

const clip = (s: string | undefined, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** 书的语言与界面语言是否不同 (决定是否输出译文 tr) */
export function needsTranslation(bookLang: string | undefined, lang: 'zh' | 'en'): boolean {
  const b = String(bookLang ?? '').toLowerCase()
  if (!b) return false
  return lang === 'zh' ? !b.startsWith('zh') : !b.startsWith('en')
}

const SYSTEM_MARK_ZH = `你是严谨的阅读导读者，为读者在原文上「点睛」：只标出真正关键的少数内容。正文每句前有编号 [段.句]。
只输出 NDJSON：每行一个 JSON 对象，不要代码块、不要其他文字。按句号从前到后输出。类型：
{"t":"key","s":"2.1","r":3,"why":"≤20字，为什么是要句"}  要句：论点、结论、定义、转折、关键情节。r 为重要度 1-3（3 最重要）
{"t":"term","s":"2.3","q":"术语原文","def":"≤40字，依据本书上下文的释义","r":2}  概念：本书的专门术语、人名地名中读者需要知道的，只标首次出现或下定义处
{"t":"note","s":"4.2","q":"原文片段","text":"≤80字注释","k":"culture|allusion|history"}  注：典故、历史背景、文化差异，仅当不解释会影响理解时；每千字最多 1 条
{"t":"gist","p":2,"text":"≤30字段意"}  每个意义段一条（相邻短段可合并，用首段编号）
规则：
- q 必须是 s 那句中一字不差的子串，≤12字；没把握就不输出。
- 要句约占正文的 8%，每段最多 2 条 key；宁缺毋滥，琐碎、举例、过渡句不标。
- why/def/text 用{LANG}写，简洁、不复述原句、不说空话。
- 只依据给出的正文和常识，不编造。`

const SYSTEM_MARK_EN = `You are a careful reading guide who "spotlights" only the few truly essential things in a text. Each sentence is prefixed with a number [para.sentence].
Output NDJSON only: one JSON object per line, no code fences, no other text, in sentence order. Types:
{"t":"key","s":"2.1","r":3,"why":"<=12 words: why it matters"}  key sentence: thesis, conclusion, definition, turn, pivotal event. r = importance 1-3 (3 highest)
{"t":"term","s":"2.3","q":"exact term","def":"<=25 words, meaning in this book's context","r":2}  concept: a term/name the reader needs; only at first use or definition
{"t":"note","s":"4.2","q":"exact phrase","text":"<=50 words","k":"culture|allusion|history"}  note: allusion, historical or cultural background, only when needed to understand; at most 1 per 1000 words
{"t":"gist","p":2,"text":"<=15 words: what this paragraph says"}  one per meaningful paragraph (merge short neighbours, use the first number)
Rules:
- q must be an exact substring of sentence s, at most 6 words; skip when unsure.
- Key sentences cover about 8% of the text, at most 2 per paragraph; fewer is better; never mark trivial, example or transition sentences.
- Write why/def/text in {LANG}. Be concise, don't restate the sentence.
- Use only the given text and common knowledge; never invent facts.`

const FICTION_ZH = '\n- 这是叙事作品：不得提及、暗示或推测本段之后的情节、人物命运和结局；释义只用本段及之前已出现的信息。'
const FICTION_EN = '\n- This is narrative fiction: never mention, hint at or guess anything that happens after this passage; explain only with what has appeared so far.'
const GENRE_ZH = '\n- 第一行先输出 {"t":"meta","fiction":true 或 false}，判断这段是否出自小说等叙事作品。'
const GENRE_EN = '\n- First output one line {"t":"meta","fiction":true|false}: is this passage from narrative fiction?'
const TR_ZH = '\n- 另为每条 key 输出一行译文 {"t":"tr","s":"同一编号","text":"{LANG}译文"}（紧跟在该 key 之后）。'
const TR_EN = '\n- For every key also output {"t":"tr","s":"same number","text":"translation into {LANG}"} right after it.'

// 重点词 (llm-keyword-selection.md §6.1): 只用来点亮, 不带释义; 放在最后输出, 不打乱按句号的顺序
const KW_ZH = '\n- 全部行输出完后，再输出本块的重点词，每词一行 {"t":"kw","q":"词","r":2}：只挑人物（含「赵太爷」这类称谓式人名）、地名、机构、专有名词、术语、反复出现的核心概念或关键物件；q 是正文里一字不差的 2–8 字词，同一个词只输出一次；r 为重要度 1-3（3=全书或本段核心）；约每 100 字 1 个，宁缺毋滥，不要普通常用词、一般动词形容词、短语和句子。'
const KW_EN = '\n- After all other lines, output this passage\'s key words, one per line {"t":"kw","q":"word","r":2}: only people (including titled names), places, organisations, proper nouns, terms, recurring core concepts or key objects; q must be an exact 2-8 character substring of the text (in its original language), each word once; r = importance 1-3; about one per 100 characters, fewer is better; no common words, ordinary verbs or adjectives, phrases or sentences.'

const SYSTEM_SUMMARY_ZH = `你为读者写章首「要义」。输入是本章（或已读部分）的段意与要句，句前有编号。
只输出 NDJSON：
{"t":"sum","text":"≤120字，一段话说明本章讲什么"}
然后 3 行要点 {"t":"pt","s":"编号","text":"≤30字"}，s 取最能代表该要点的要句编号。
用{LANG}写，不编造，不复述原句。`
const SYSTEM_SUMMARY_EN = `Write the chapter "gist" for a reader. Input: paragraph gists and key sentences of the chapter (or the part already read), each with a number.
Output NDJSON only:
{"t":"sum","text":"<=70 words: what this chapter is about"}
then 3 lines {"t":"pt","s":"number","text":"<=15 words"}, s = the key sentence that best represents the point.
Write in {LANG}. Don't invent, don't restate sentences.`
const SUMMARY_FICTION_ZH = '\n这是叙事作品：只总结给出的内容，不预测后文。'
const SUMMARY_FICTION_EN = '\nThis is fiction: summarise only what is given, never predict what comes next.'

const SYSTEM_TR_ZH = '把编号句子译成{LANG}，忠实、通顺。只输出 NDJSON，每句一行 {"t":"tr","s":"编号","text":"译文"}。'
const SYSTEM_TR_EN = 'Translate each numbered sentence into {LANG}, faithfully and fluently. Output NDJSON only, one line per sentence: {"t":"tr","s":"number","text":"translation"}.'

/** 拼装提示词。relay 与客户端自带密钥直连共用。 */
export function buildMessages(req: DjRequest): ChatMessage[] {
  const en = req.lang === 'en'
  const langName = en ? 'English' : '简体中文'
  const tr = needsTranslation(req.bookLang, req.lang)
  let system: string
  if (req.mode === 'summary') {
    system = (en ? SYSTEM_SUMMARY_EN : SYSTEM_SUMMARY_ZH) + (req.fiction ? (en ? SUMMARY_FICTION_EN : SUMMARY_FICTION_ZH) : '')
  } else if (req.mode === 'translate') {
    system = en ? SYSTEM_TR_EN : SYSTEM_TR_ZH
  } else {
    system = (en ? SYSTEM_MARK_EN : SYSTEM_MARK_ZH)
      + (req.fiction ? (en ? FICTION_EN : FICTION_ZH) : '')
      + (req.askGenre ? (en ? GENRE_EN : GENRE_ZH) : '')
      + (tr ? (en ? TR_EN : TR_ZH) : '')
      + (req.keywords ? (en ? KW_EN : KW_ZH) : '')
  }
  system = system.split('{LANG}').join(langName)

  const head: string[] = []
  const title = clip(req.book?.title, 80)
  const author = clip(req.book?.author, 40)
  if (title) head.push(en ? `Book: ${title}${author ? ` by ${author}` : ''}` : `书：《${title}》${author ? ` ${author}` : ''}`)
  const chapter = clip(req.chapter, 80)
  if (chapter) head.push(en ? `Chapter: ${chapter}` : `章：${chapter}`)
  const known = (req.knownTerms ?? []).map(s => clip(s, 16)).filter(Boolean).slice(0, MAX_KNOWN_TERMS)
  if (req.mode === 'mark' && known.length) {
    head.push(en ? `Already explained (don't mark again): ${known.join(', ')}` : `已解释过的概念（不要重复标）：${known.join('、')}`)
  }
  const label = req.mode === 'summary' ? (en ? 'Gists and key sentences:' : '段意与要句：') : (en ? 'Text:' : '正文：')
  const user = `${head.join('\n')}${head.length ? '\n\n' : ''}${label}\n${String(req.text ?? '').slice(0, MAX_CHUNK_CHARS + 600)}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** OpenAI 兼容的请求体 (SiliconFlow 额外接受 enable_thinking) */
export function buildChatBody(req: DjRequest, model = DJ_MODEL, opts: { thinkingFlag?: boolean } = {}) {
  return {
    model,
    messages: buildMessages(req),
    stream: true,
    temperature: 0.2,
    max_tokens: req.mode === 'translate' ? 800 : MAX_TOKENS,
    ...(opts.thinkingFlag === false ? {} : { enable_thinking: false }),
  }
}

/** 校验客户端传来的请求体 (relay 用); 返回错误信息或 null */
export function validateRequest(body: any): string | null {
  if (!body || typeof body !== 'object') return 'invalid body'
  if (!['mark', 'summary', 'translate'].includes(body.mode)) return 'invalid mode'
  if (body.lang !== 'zh' && body.lang !== 'en') return 'invalid lang'
  if (typeof body.text !== 'string' || !body.text.trim()) return 'empty text'
  if (body.text.length > MAX_CHUNK_CHARS + 600) return 'text too long'
  if (body.knownTerms != null && !Array.isArray(body.knownTerms)) return 'invalid knownTerms'
  return null
}

/** 规范化请求体: 只保留白名单字段 (relay 用, 防止夹带任意提示词) */
export function sanitizeRequest(body: any): DjRequest {
  return {
    promptVersion: String(body.promptVersion ?? PROMPT_VERSION).slice(0, 16),
    mode: body.mode,
    lang: body.lang,
    bookLang: body.bookLang ? String(body.bookLang).slice(0, 16) : undefined,
    book: { title: clip(body.book?.title, 80), author: clip(body.book?.author, 40) },
    chapter: clip(body.chapter, 80),
    fiction: !!body.fiction,
    askGenre: !!body.askGenre,
    text: String(body.text),
    knownTerms: Array.isArray(body.knownTerms) ? body.knownTerms.map((s: unknown) => clip(String(s), 16)).slice(0, MAX_KNOWN_TERMS) : [],
    keywords: body.mode === 'mark' && body.keywords === true,
  }
}

// ---- 额度与成本 (§6.6 §6.9) ----

/** 每台设备每日内置额度 (字) */
export const DEVICE_DAILY_CHARS = 100_000
/** 每个 IP 每日内置额度 (字) */
export const IP_DAILY_CHARS = 300_000
/** 全站每日预算 (元) */
export const DAILY_BUDGET_CNY = 50

/** SiliconFlow V4-Flash 日间价 (元 / 百万 token), 不计缓存命中折扣 (保守) */
export const PRICE_IN_PER_M = 3
export const PRICE_OUT_PER_M = 9

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/g

/** 字符 → token 估算: 中文约 0.6 token/字, 其他约 0.3 token/字符 (DeepSeek 文档经验值) */
export function estimateTokens(text: string): number {
  const s = String(text ?? '')
  const cjk = (s.match(CJK) ?? []).length
  return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.3)
}

/** 成本以「万分之一元」整数计 (D1 计数是整数) */
export function costUnits(inTokens: number, outTokens: number): number {
  return Math.ceil((inTokens * PRICE_IN_PER_M + outTokens * PRICE_OUT_PER_M) / 100)
}

export const CNY_TO_UNITS = 10_000

/** 一块计入设备额度的字数: 只算正文字符 (不算编号与提示词), 至少 1 */
export function chargeChars(text: string): number {
  return Math.max(1, String(text ?? '').replace(/\[\d+\.\d+\]\s?/g, '').replace(/\s+/g, '').length)
}
