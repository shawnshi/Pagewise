/**
 * 叙事类 (小说等) 识别 (纯函数, docs/dianjing-reading.md §10 Q4 / reading-experience-plan Q9)。
 * 顺序: 用户手动设置 > 元数据 subject/标签 > 正文启发式 > 首块模型判断 (meta 行)。
 * 结果只决定防剧透规则 (R6): 释义、要义、脉络只用读者当前位置之前的内容。
 */

export type FictionVerdict = 'fiction' | 'nonfiction' | 'unknown'

const FICTION_SUBJECT = /(fiction|novel|novella|short stor|fantasy|science fiction|sci-fi|mystery|thriller|romance|horror|detective|fairy tal|fable|小说|长篇|中篇|短篇|武侠|言情|科幻|奇幻|玄幻|仙侠|推理|悬疑|侦探|童话|寓言|网文|戏剧|剧本)/i
const NONFICTION_SUBJECT = /(non-?fiction|biograph|memoir|history|histories|economics|philosophy|science|psychology|business|self-help|textbook|reference|politic|sociology|essay|传记|自传|回忆录|历史|经济|哲学|科学|心理|管理|商业|教材|教程|社科|社会|政治|法律|医学|散文|随笔|论文|手册|指南)/i
const NONFICTION_SUBJECT_BLOCK = /(fiction|novel|小说)/i

/** 依据元数据 (subject、标签、书名) 判断 */
export function fictionFromMeta(meta: { subjects?: string[]; tags?: string[]; title?: string }): FictionVerdict {
  const subjects = [...(meta.subjects ?? []), ...(meta.tags ?? [])].map(s => String(s ?? '')).filter(Boolean)
  let f = 0
  let n = 0
  for (const s of subjects) {
    if (/non-?fiction/i.test(s)) { n++; continue }
    if (FICTION_SUBJECT.test(s)) f++
    else if (NONFICTION_SUBJECT.test(s) && !NONFICTION_SUBJECT_BLOCK.test(s)) n++
  }
  if (f > n) return 'fiction'
  if (n > f) return 'nonfiction'
  if (meta.title && /(小说|演义|传奇|故事集|a novel)/i.test(meta.title)) return 'fiction'
  return 'unknown'
}

/**
 * 正文启发式: 对话引号密度 + 叙述动词 + 第一/三人称叙述。
 * 返回 0–1 的叙事分数; ≥0.6 视为叙事, ≤0.25 视为非叙事, 其间未知 (交给模型 meta)。
 */
export function narrativeScore(text: string): number {
  const s = String(text ?? '')
  if (s.length < 200) return 0.5
  const per1k = (n: number) => (n * 1000) / s.length
  const quotes = (s.match(/[“「『"]/g) ?? []).length
  const saidZh = (s.match(/(说道|问道|笑道|喊道|叹道|答道|心想|他说|她说|我说|只见|忽然|便|了一声)/g) ?? []).length
  const saidEn = (s.match(/\b(said|asked|replied|whispered|shouted|cried|muttered|looked at|smiled)\b/gi) ?? []).length
  const pronouns = (s.match(/(他|她)(们)?|\b(he|she|his|her)\b/gi) ?? []).length
  const expo = (s.match(/(因此|所以|研究|理论|定义|原理|概念|例如|首先|其次|总之|第[一二三四五六七八九十]+[，,、]|\btherefore\b|\bthus\b|\bresearch\b|\btheory\b|\bdefin\w*|\bfor example\b|\bin conclusion\b|\bdata\b)/gi) ?? []).length
  let score = 0.4
  score += Math.min(0.3, per1k(quotes) * 0.03)
  score += Math.min(0.25, per1k(saidZh + saidEn) * 0.05)
  score += Math.min(0.15, per1k(pronouns) * 0.006)
  score -= Math.min(0.5, per1k(expo) * 0.06)
  return Math.max(0, Math.min(1, score))
}

export function fictionFromText(text: string): FictionVerdict {
  const score = narrativeScore(text)
  if (score >= 0.6) return 'fiction'
  if (score <= 0.25) return 'nonfiction'
  return 'unknown'
}

/** 合并各来源: override > meta > text > model; 都未知时按非叙事处理 (不影响标记, 只放宽要义预读) */
export function decideFiction(sources: {
  override?: 'fiction' | 'nonfiction' | null
  meta?: FictionVerdict
  text?: FictionVerdict
  model?: boolean | null
}): { fiction: boolean; source: 'user' | 'meta' | 'text' | 'model' | 'default' } {
  if (sources.override) return { fiction: sources.override === 'fiction', source: 'user' }
  if (sources.meta && sources.meta !== 'unknown') return { fiction: sources.meta === 'fiction', source: 'meta' }
  if (sources.text && sources.text !== 'unknown') return { fiction: sources.text === 'fiction', source: 'text' }
  if (typeof sources.model === 'boolean') return { fiction: sources.model, source: 'model' }
  return { fiction: false, source: 'default' }
}
