/**
 * 可重排书 (EPUB / TXT / MOBI …) 的页码。
 *
 * 重排书没有固定页: 页数随字号、行距、边距、分栏、窗口尺寸变化。foliate 只知道
 * 「当前章第几屏」, 所以这里把全书页码拼出来:
 * - 读过的章记下真实排版页数 (精确);
 * - 没读过的章按已测章节的「字节 / 页」密度、用章节字节数推算;
 * - 同一排版 (layoutKey) 的测量按书持久化, 再次打开总页数立刻稳定, 不会边读边跳。
 * 双栏时每栏算一页, 和翻开的纸书一样左右各一个页码。
 */

/** 某本书在某种排版下的测量结果 */
export interface PageMeasure {
  /** 排版指纹; 变化后旧测量全部作废 */
  key: string
  /** 章节序号 → 实际页数 */
  pages: Record<number, number>
}

export interface PagePosition {
  /** 当前页 (1 起); 双栏时为左栏页码 */
  current: number
  /** 当前屏最后一页; 单栏时等于 current */
  last: number
  total: number
  /** 本章在当前屏之后还剩几页 */
  sectionLeft: number
}

/** foliate 章节字节数; 非线性 (linear="no") 与空章不计入进度, 和 foliate 的 SectionProgress 一致 */
export function sectionSizes(sections: ReadonlyArray<{ size?: number; linear?: string }>): number[] {
  return sections.map(s => (s.linear !== 'no' && (s.size ?? 0) > 0 ? s.size! : 0))
}

/**
 * 已测章节的平均「字节 / 页」。只用 ≥2 页的章: 1 页的章 (封面、扉页) 没排满, 会把密度拉低;
 * 每章最后一页通常不满, 按半页计。
 */
export function bytesPerPage(sizes: readonly number[], pages: Readonly<Record<number, number>>): number | null {
  let bytes = 0
  let count = 0
  for (const [k, n] of Object.entries(pages)) {
    const size = sizes[Number(k)] ?? 0
    if (size > 0 && n >= 2) {
      bytes += size
      count += n - 0.5
    }
  }
  return count > 0 ? bytes / count : null
}

/**
 * 还没有可用测量时的兜底密度: 按版面能放下的字数估算。
 * 中日韩一个字 3 字节 (UTF-8) 占一个字宽; 西文一个字节约半个字宽; 另算 15% 标记开销。
 */
export function fallbackBytesPerPage(opts: {
  width: number
  height: number
  fontSize: number
  lineHeight: number
  cjk: boolean
}): number {
  const fontSize = Math.max(8, opts.fontSize)
  const lines = Math.max(1, Math.floor(opts.height / (fontSize * Math.max(1, opts.lineHeight))))
  const perLine = Math.max(1, opts.width / fontSize)
  const bytes = opts.cjk ? perLine * lines * 3 : perLine * 2 * lines
  return bytes * 1.15
}

/** 每章页数: 测过的用实测, 没测过的按密度推算 (至少 1 页); 不计入进度的章为 0 */
export function sectionPageCounts(
  sizes: readonly number[],
  pages: Readonly<Record<number, number>>,
  fallbackBpp: number,
): number[] {
  const bpp = bytesPerPage(sizes, pages) ?? fallbackBpp
  return sizes.map((size, i) => {
    if (!size) return 0
    const measured = pages[i]
    if (measured && measured > 0) return measured
    return Math.max(1, Math.round(size / Math.max(1, bpp)))
  })
}

const sum = (xs: readonly number[], end = xs.length) => {
  let s = 0
  for (let i = 0; i < end; i++) s += xs[i]
  return s
}

/**
 * 当前位置: index 章的第 pageInSection 页 (1 起), 当前屏显示 perScreen 页 (双栏为 2)。
 * 不计入进度的章 (如书末脚注) 停在前一章末页上。
 */
export function pagePosition(
  counts: readonly number[],
  index: number,
  pageInSection: number,
  perScreen = 1,
): PagePosition {
  const total = Math.max(1, sum(counts))
  const before = sum(counts, Math.max(0, Math.min(index, counts.length)))
  const count = counts[index] ?? 0
  if (!count) {
    const at = Math.min(total, Math.max(1, before))
    return { current: at, last: at, total, sectionLeft: 0 }
  }
  const local = Math.min(count, Math.max(1, Math.round(pageInSection)))
  const localLast = Math.min(count, local + Math.max(1, perScreen) - 1)
  return {
    current: before + local,
    last: before + localLast,
    total,
    sectionLeft: count - localLast,
  }
}

/** 全书第 page 页落在哪一章的第几页 */
export function locatePage(counts: readonly number[], page: number): { index: number; local: number } | null {
  const total = sum(counts)
  if (!total) return null
  let rest = Math.min(total, Math.max(1, Math.round(page)))
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue
    if (rest <= counts[i]) return { index: i, local: rest }
    rest -= counts[i]
  }
  return null
}

/**
 * 页码 → foliate goToFraction 用的全书进度。
 * 翻页模式下 foliate 按 round(章内进度 × (屏数 - 1)) 选屏, 这里按屏反推使其正好落在目标屏;
 * 滚动模式按章内比例滚动。
 */
export function pageToFraction(
  sizes: readonly number[],
  counts: readonly number[],
  page: number,
  opts: { perScreen?: number; scrolled?: boolean } = {},
): number | null {
  const hit = locatePage(counts, page)
  const sizeTotal = sum(sizes)
  if (!hit || !sizeTotal) return null
  const count = counts[hit.index]
  let inSection: number
  if (opts.scrolled) {
    inSection = (hit.local - 1) / count
  } else {
    const per = Math.max(1, opts.perScreen ?? 1)
    const screens = Math.ceil(count / per)
    const screen = Math.floor((hit.local - 1) / per)
    // 往回让 1/4 屏: 末屏的 1.0 会正好落在下一章开头
    inSection = screens > 1 ? Math.max(0, screen - 0.25) / (screens - 1) : 0
  }
  return (sum(sizes, hit.index) + inSection * sizes[hit.index]) / sizeTotal
}

/** 全书进度 → 页码与所在章 (拖动进度条时预览) */
export function fractionToPage(
  sizes: readonly number[],
  counts: readonly number[],
  fraction: number,
): { page: number; index: number } | null {
  const sizeTotal = sum(sizes)
  if (!sizeTotal || !sum(counts)) return null
  const target = Math.min(1, Math.max(0, fraction)) * sizeTotal
  let acc = 0
  let before = 0
  let lastIndex = 0
  for (let i = 0; i < sizes.length; i++) {
    if (!sizes[i]) continue
    lastIndex = i
    if (target < acc + sizes[i] || i === sizes.length - 1) {
      const inSection = Math.min(1, Math.max(0, (target - acc) / sizes[i]))
      const local = Math.min(counts[i], Math.floor(inSection * counts[i]) + 1)
      return { page: before + Math.max(1, local), index: i }
    }
    acc += sizes[i]
    before += counts[i]
  }
  return { page: Math.max(1, before), index: lastIndex }
}

/** 跳页输入: 「128」按页码, 「25%」按百分比; 越界或无法识别返回 null */
export function parseJumpInput(raw: string, total: number): { page: number } | { fraction: number } | null {
  const s = raw.trim().replace(/[％]/g, '%').replace(/\s+/g, '')
  if (!s) return null
  const pct = s.match(/^(\d+(?:\.\d+)?)%$/)
  if (pct) {
    const v = Number(pct[1])
    return v >= 0 && v <= 100 ? { fraction: v / 100 } : null
  }
  if (!/^\d+$/.test(s)) return null
  const page = Number(s)
  return page >= 1 && page <= total ? { page } : null
}
