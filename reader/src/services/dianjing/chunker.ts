/**
 * 点睛阅读的分块与编号 (纯函数, docs/dianjing-reading.md §6.1 §6.2)。
 *
 * 输入: 一节里各段 (block) 的句子文本 —— 段的切分与听书的 SentenceCursor 相同, 句子由 splitSentences 切出,
 * 所以 (block, sentence) 与听书的游标位置一一对应。
 * 输出: 按段聚合的块 (不跨节、段落完整), 每块带编号后的文本和内容 hash。
 * 块边界只取决于各段长度, 与从哪里打开无关 —— 同一节每次切出相同的块, 缓存才能命中。
 */

export interface SectionBlock {
  /** 本节内的段序号 (与 SentenceCursor 的 block 相同) */
  block: number
  /** 句子文本, 与 SentenceCursor.sentencesOf(block) 一一对应 */
  sentences: string[]
}

export interface Chunk {
  /** 本节内第几块 */
  index: number
  /** 包含的段 (按顺序) */
  blocks: SectionBlock[]
  /** 正文字数 (不含编号与空白) */
  chars: number
  /** 发给模型的编号文本: 每段一行, 「[段.句] 句子」, 段号从 1 起 (块内相对编号) */
  text: string
  /** 内容 hash (编号文本的 hash, 64 位十六进制) */
  hash: string
}

export interface ChunkOptions {
  /** 目标字数 */
  target?: number
  /** 上限 (超过就截断成新块; 单段超长时整段一块, 再按句切) */
  max?: number
  /** 本节第一块的目标字数 (更快出现首批标记) */
  first?: number
}

export const CHUNK_TARGET = 1000
export const CHUNK_MAX = 1500
export const CHUNK_FIRST = 600
/** 太短的块并入前一块 */
const CHUNK_MIN_TAIL = 200

const visibleLen = (s: string) => s.replace(/\s+/g, '').length

/**
 * 64 位内容 hash (两路 32 位 FNV-1a 变体拼接)。同步、跨环境一致, 只用于缓存键, 不用于安全。
 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
    h2 ^= h2 >>> 15
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(h1) + hex(h2)
}

/** 把一组段编号成模型输入 (块内段号从 1 起) */
export function numberBlocks(blocks: SectionBlock[]): string {
  return blocks
    .map((b, i) => b.sentences.map((s, j) => `[${i + 1}.${j + 1}] ${s.replace(/\s+/g, ' ').trim()}`).join(' '))
    .join('\n')
}

function makeChunk(index: number, blocks: SectionBlock[]): Chunk {
  const text = numberBlocks(blocks)
  return {
    index,
    blocks,
    chars: blocks.reduce((n, b) => n + b.sentences.reduce((m, s) => m + visibleLen(s), 0), 0),
    text,
    hash: hashText(text),
  }
}

/** 单段超过上限时按句切成几段 (段号不变, 句号用 offset 保持与原段一致) */
function splitLongBlock(b: SectionBlock, max: number): Array<SectionBlock & { offset: number }> {
  const out: Array<SectionBlock & { offset: number }> = []
  let cur: string[] = []
  let len = 0
  let offset = 0
  b.sentences.forEach((s, i) => {
    const l = visibleLen(s)
    if (cur.length && len + l > max) {
      out.push({ block: b.block, sentences: cur, offset })
      offset = i
      cur = []
      len = 0
    }
    cur.push(s)
    len += l
  })
  if (cur.length) out.push({ block: b.block, sentences: cur, offset })
  return out
}

/** 块内的段: 超长段被切开时记下句子偏移 */
export interface ChunkBlock extends SectionBlock {
  /** 本片段第一句在原段里的序号 (未切开为 0) */
  offset?: number
}

/**
 * 分块: 段落完整、不跨节; 第一块目标 first 字, 之后 target 字, 不超过 max 字。
 * 末尾太短的块并入前一块 (仍不超过 max)。
 */
export function chunkSection(blocks: SectionBlock[], opts: ChunkOptions = {}): Chunk[] {
  const target = opts.target ?? CHUNK_TARGET
  const max = opts.max ?? CHUNK_MAX
  const first = opts.first ?? CHUNK_FIRST
  const pieces: ChunkBlock[] = []
  for (const b of blocks) {
    if (!b.sentences.length) continue
    const len = b.sentences.reduce((n, s) => n + visibleLen(s), 0)
    if (len > max) pieces.push(...splitLongBlock(b, target))
    else pieces.push(b)
  }
  const groups: ChunkBlock[][] = []
  let cur: ChunkBlock[] = []
  let len = 0
  for (const p of pieces) {
    const l = p.sentences.reduce((n, s) => n + visibleLen(s), 0)
    const goal = groups.length === 0 ? first : target
    if (cur.length && (len + l > max || len >= goal)) {
      groups.push(cur)
      cur = []
      len = 0
    }
    cur.push(p)
    len += l
  }
  if (cur.length) {
    const prev = groups[groups.length - 1]
    const prevLen = prev ? prev.reduce((n, p) => n + p.sentences.reduce((m, s) => m + visibleLen(s), 0), 0) : 0
    if (prev && len < CHUNK_MIN_TAIL && prevLen + len <= max) prev.push(...cur)
    else groups.push(cur)
  }
  return groups.map((g, i) => makeChunk(i, g))
}

/** 块内相对编号 "p.s" → 本节绝对位置 { block, sentence }; 不存在返回 null */
export function resolveSentence(chunk: Chunk, ref: string): { block: number; sentence: number } | null {
  const m = /^\s*(\d+)\.(\d+)\s*$/.exec(String(ref ?? ''))
  if (!m) return null
  const p = Number(m[1]) - 1
  const s = Number(m[2]) - 1
  const b = chunk.blocks[p] as ChunkBlock | undefined
  if (!b || s < 0 || s >= b.sentences.length) return null
  return { block: b.block, sentence: (b.offset ?? 0) + s }
}

/** 块内段号 (1 起) → 本节段序号 */
export function resolveParagraph(chunk: Chunk, p: number): number | null {
  const b = chunk.blocks[Number(p) - 1]
  return b ? b.block : null
}

/** 块内某句的文本 */
export function sentenceText(chunk: Chunk, ref: string): string | null {
  const m = /^\s*(\d+)\.(\d+)\s*$/.exec(String(ref ?? ''))
  if (!m) return null
  return chunk.blocks[Number(m[1]) - 1]?.sentences[Number(m[2]) - 1] ?? null
}

/** 包含某段的块序号 (找不到时取其后最近的块) */
export function chunkIndexForBlock(chunks: Chunk[], block: number): number {
  for (const c of chunks) {
    const last = c.blocks[c.blocks.length - 1]
    if (last && last.block >= block) return c.index
  }
  return Math.max(0, chunks.length - 1)
}

/**
 * 请求顺序: 当前块优先, 然后按阅读方向往后 ahead 块, 最后 (可选) 往前 1 块。
 */
export function requestOrder(total: number, current: number, ahead = 2, behind = 0): number[] {
  const out: number[] = []
  const cur = Math.min(Math.max(0, current), Math.max(0, total - 1))
  for (let i = cur; i < total && i <= cur + ahead; i++) out.push(i)
  for (let i = cur - 1; i >= 0 && i >= cur - behind; i--) out.push(i)
  return out
}
