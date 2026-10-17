/**
 * TXT 断行还原: 古登堡等来源的 TXT 按固定列宽硬换行, 段落之间用空行分隔。
 * 若逐行当段落, 手机上每一行都会带首行缩进, 句子被切得七零八落。
 *
 * 判定为「硬换行」才合并: 按空行 / 缩进行首分块后多数行落在多行块中, 块不长,
 * 且块内非末行的长度接近一致 (固定列宽的特征)。网络小说式 TXT
 * (一行一段, 长短不一) 不满足, 原样按行分段。
 */

/** 以全角空格或两个以上空白开头的行视为新段 (诗词、引文的缩进行) */
const INDENTED_RE = /^(?:　|\s{2,})/

/** 行宽统计只看非末行; 太短的文本不做判断 */
const MIN_LINES = 20

const isCjk = (ch: string) => /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch)

/** 视觉宽度: 汉字等全角字符算 2, 使中英文列宽可比 */
function visualWidth(line: string): number {
  let w = 0
  for (const ch of line) w += isCjk(ch) ? 2 : 1
  return w
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

/** 块内各行是否像被固定列宽截断: 非末行长度的四分位距窄, 且宽度在常见列宽范围 */
export function looksHardWrapped(lines: string[]): boolean {
  const blocks = splitBlocks(lines)
  const nonEmpty = blocks.reduce((n, b) => n + b.length, 0)
  if (nonEmpty < MIN_LINES) return false
  const multi = blocks.filter(b => b.length > 1)
  const inMulti = multi.reduce((n, b) => n + b.length, 0)
  if (inMulti / nonEmpty < 0.5) return false
  const sizes = multi.map(b => b.length).sort((a, b) => a - b)
  if (quantile(sizes, 0.5) > 20) return false
  const widths = multi
    .flatMap(b => b.slice(0, -1))
    .map(l => visualWidth(l.trim()))
    .sort((a, b) => a - b)
  if (widths.length < MIN_LINES / 2) return false
  const p25 = quantile(widths, 0.25)
  const p50 = quantile(widths, 0.5)
  const p75 = quantile(widths, 0.75)
  return p50 >= 40 && p50 <= 160 && (p75 - p25) / p50 <= 0.25
}

/** 按空行或缩进行首切块: 每块是一个候选段落 */
function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = []
  let cur: string[] = []
  for (const line of lines) {
    if (!line.trim() || INDENTED_RE.test(line)) {
      if (cur.length) blocks.push(cur)
      cur = []
    }
    if (line.trim()) cur.push(line)
  }
  if (cur.length) blocks.push(cur)
  return blocks
}

/** 两行拼接: 中文直接相连, 行尾连字符原样接上 (多为复合词), 其余西文补一个空格 */
function joinLines(a: string, b: string): string {
  const last = a[a.length - 1] ?? ''
  const first = b[0] ?? ''
  if (last === '-' || isCjk(last) || isCjk(first)) return a + b
  return `${a} ${b}`
}

/**
 * 一段文本行 → 段落数组 (已 trim, 不含空段)。
 * hardWrapped 为 true 时按空行 / 缩进分段并合并段内断行, 否则一行一段。
 */
export function toParagraphs(lines: string[], hardWrapped: boolean): string[] {
  if (!hardWrapped) return lines.map(l => l.trim()).filter(Boolean)
  return splitBlocks(lines).map(block => block.map(l => l.trim()).reduce(joinLines))
}

/**
 * 多章合成一个分节的字符上限。foliate 一个分节一个 iframe, 分节边界处滚动模式会整页切换;
 * 合并后边界少一个数量级, 章与章之间是连续滚动。上限兼顾翻页模式分栏排版的开销。
 */
export const SECTION_CHARS = 40_000

/** 按顺序把章节装进分节, 单章超过上限时独占一节 */
export function packSections<T extends { html: string }>(chapters: T[], limit = SECTION_CHARS): T[][] {
  const sections: T[][] = []
  let cur: T[] = []
  let size = 0
  for (const c of chapters) {
    if (cur.length && size + c.html.length > limit) {
      sections.push(cur)
      cur = []
      size = 0
    }
    cur.push(c)
    size += c.html.length
  }
  if (cur.length) sections.push(cur)
  return sections
}
