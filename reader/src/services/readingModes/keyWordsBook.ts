/**
 * 「重点词」的一本书 (纯逻辑, 无 DOM): 收集各节段落 → 全书统计 → 按节选词。
 * 在 Worker 里跑 (keyWords.worker.ts); 没有 Worker 时由 keyWordsClient.ts 在主线程直接用。
 *
 * 全书统计还没做完时 (刚打开书), 先用已收到的分节当作「本书」来算; 做完后调用方重新取词并重画。
 */
import {
  KW_AI_DENSITY, KW_DEFAULTS, KW_DENSITY, buildStats, pickSection, scoreTypes,
  type AiWord, type KwLevel, type KwPick, type KwStats, type KwType,
} from './keyWords.ts'
import type { ZhLexicon } from './zhSegment.ts'

export interface KwPickRequest {
  section: number
  paras: string[]
  level: KwLevel
  /** 小说: K、B 只用读到本节为止的文本 */
  spoilerSafe: boolean
  /** 智能版: AI 词 [词, 重要度, 块数] 与各段是否已有 AI 结果 (没有的段用离线结果) */
  smart?: { words: Array<[string, number, number]>; aiParas: ArrayLike<number> } | null
}

/** 选词结果打包成 Int32Array: 每个词 4 个数 [段, 段内起点, 长度, 标志 (1 = 强样式, 2 = AI 词)] */
export function packPicks(picks: KwPick[]): Int32Array {
  const out = new Int32Array(picks.length * 4)
  picks.forEach((p, i) => {
    out[i * 4] = p.para
    out[i * 4 + 1] = p.index
    out[i * 4 + 2] = p.len
    out[i * 4 + 3] = (p.strong ? 1 : 0) | (p.ai ? 2 : 0)
  })
  return out
}

/** 一本书最多统计这么多字 (超长的书只取前面的部分, 控制 Worker 内存) */
export const MAX_BOOK_CHARS = 1_500_000

export class KwBook {
  readonly lex: ZhLexicon
  #sections = new Map<number, string[]>()
  #chars = 0
  #stats: KwStats | null = null
  /** 统计覆盖了哪些节 */
  #covered = new Set<number>()
  #types = new Map<number, Map<string, KwType>>()
  /** 全书统计已完成 (之后新加的节会让它变回 false) */
  complete = false

  constructor(lex: ZhLexicon) {
    this.lex = lex
  }

  get sectionCount(): number { return this.#sections.size }
  get chars(): number { return this.#chars }
  hasSection(i: number): boolean { return this.#sections.has(i) }
  get newWords(): number { return this.#stats?.newWords.size ?? 0 }

  /** 加一节 (已有则替换); 超过字数上限时不再收 */
  addSection(section: number, paras: string[]): boolean {
    const n = paras.reduce((a, p) => a + p.length, 0)
    const old = this.#sections.get(section)
    if (!old && this.#chars + n > MAX_BOOK_CHARS && this.#sections.size > 0) return false
    if (old) this.#chars -= old.reduce((a, p) => a + p.length, 0)
    this.#sections.set(section, paras)
    this.#chars += n
    if (!this.#covered.has(section)) this.complete = false
    return true
  }

  /** 用已收到的全部分节重建统计 (新词发现 + 切分 + 记位置) */
  analyze(): KwStats {
    const sections = [...this.#sections].map(([section, paras]) => ({ section, paras }))
    this.#stats = buildStats(sections, this.lex)
    this.#covered = new Set(this.#sections.keys())
    this.#types.clear()
    this.complete = true
    return this.#stats
  }

  #typesFor(limit: number): Map<string, KwType> {
    let t = this.#types.get(limit)
    if (!t) {
      t = scoreTypes(this.#stats!, KW_DEFAULTS, limit)
      if (this.#types.size > 8) this.#types.delete(this.#types.keys().next().value!)
      this.#types.set(limit, t)
    }
    return t
  }

  pick(req: KwPickRequest): KwPick[] {
    this.addSection(req.section, req.paras)
    // 还没有统计, 或统计不含这一节且还没做过全书统计: 先用已有分节算一份
    if (!this.#stats || (!this.#covered.has(req.section) && !this.complete)) this.analyze()
    const stats = this.#stats!
    const end = stats.ordEnd.get(req.section)
    const limit = req.spoilerSafe && end !== undefined ? end : stats.N
    const types = this.#typesFor(limit)
    const offline = { ...KW_DEFAULTS, density: KW_DENSITY[req.level] ?? KW_DENSITY.normal }
    const smart = req.smart
    if (!smart || !smart.words.length) return pickSection(req.paras, req.section, stats, types, offline, { spoilerSafe: req.spoilerSafe })
    const ai = new Map<string, AiWord>(smart.words.map(([w, r, n]) => [w, { r, n }]))
    const mask = smart.aiParas
    let anyAi = false
    let anyOffline = false
    for (let i = 0; i < req.paras.length; i++) { if (mask[i]) anyAi = true; else anyOffline = true }
    const aiPrm = { ...KW_DEFAULTS, density: KW_AI_DENSITY }
    const aiPicks = anyAi
      ? pickSection(req.paras, req.section, stats, types, aiPrm, {
        ai, mode: req.level === 'high' ? 'aiFill' : 'ai', minR: req.level === 'low' ? 2 : 1, spoilerSafe: req.spoilerSafe,
      })
      : []
    const offPicks = anyOffline ? pickSection(req.paras, req.section, stats, types, offline, { spoilerSafe: req.spoilerSafe }) : []
    return [...aiPicks.filter(p => mask[p.para]), ...offPicks.filter(p => !mask[p.para])]
      .sort((a, b) => a.para - b.para || a.index - b.index)
  }
}
