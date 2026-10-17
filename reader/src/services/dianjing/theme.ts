/**
 * 点睛阅读的正文主题取值与静态样式 (docs/dianjing-reading.md §3.3)。
 * 这些是正文主题的取值 (不是外壳令牌), 由 readerTheme.getReaderCSS() 按主题写入 iframe。
 * 纯函数、零依赖: readerTheme.ts 与回退绘制 (overlayer) 共用同一张表。
 */

export interface DjColors {
  /** 要句: 朱 */
  key: string
  /** 概念: 墨青 */
  term: string
  /** 注: 赭 */
  note: string
  /** 速读视图里要句的底色 */
  band: string
  /** 墨水屏: 线型代替颜色 */
  eink?: boolean
}

export const DJ_COLORS: Record<string, DjColors> = {
  light: { key: '#c2410c', term: '#0f6e6e', note: '#9a6700', band: 'rgba(194,65,12,.10)' },
  sepia: { key: '#b03a12', term: '#1d6560', note: '#8a5a00', band: 'rgba(176,58,18,.10)' },
  green: { key: '#9c2f0c', term: '#0b4f63', note: '#6e4700', band: 'rgba(156,47,12,.10)' },
  dark: { key: '#ff9466', term: '#6fd3c6', note: '#e3b65c', band: 'rgba(255,148,102,.14)' },
  eink: { key: '#000000', term: '#000000', note: '#000000', band: 'transparent', eink: true },
  'eink-dark': { key: '#ffffff', term: '#ffffff', note: '#ffffff', band: 'transparent', eink: true },
}

/** 正文主题名 + 墨水屏开关 → 取值表的键 */
export function djThemeName(theme: string, eink = false): string {
  return eink ? (theme === 'dark' ? 'eink-dark' : 'eink') : theme
}

export function djColors(theme: string): DjColors {
  return DJ_COLORS[theme] ?? DJ_COLORS.light
}

export const HL_KEY = 'lr-dj-key'
export const HL_TERM = 'lr-dj-term'
export const HL_BAND = 'lr-dj-band'
export const HL_FLASH = 'lr-dj-flash'

/**
 * 叠加优先级 (§5): 打字机隐藏层 100 > 墨迹 50 > 听书当前句 / 歌词聚焦 (≥20) > 点睛 (10–13) > 仿生阅读 (<10)。
 * 用户自己的划线画在 overlayer (SVG 色块) 上, 不参与 Highlight 优先级, 视觉上始终是色块 (R7)。
 */
export const DJ_PRIORITY = { band: 10, key: 11, term: 12, flash: 13 }

/** 注入到 iframe 的 ::highlight 规则 (只用颜色与 text-decoration, 不改字形, 不重排) */
export function dianjingCSS(theme: string): string {
  const c = djColors(theme)
  if (c.eink) {
    const ink = c.key
    return `
    ::highlight(${HL_KEY}) { text-decoration: underline solid ${ink} 0.12em; text-decoration-skip-ink: none; }
    ::highlight(${HL_TERM}) { text-decoration: underline dotted ${ink} 1px; -webkit-text-stroke-width: 0.02em; -webkit-text-stroke-color: ${ink}; }
    ::highlight(${HL_BAND}) { text-decoration: underline double ${ink} 0.08em; }
    ::highlight(${HL_FLASH}) { text-decoration: underline double ${ink} 0.14em; }
  `
  }
  return `
    ::highlight(${HL_KEY}) { text-decoration: underline solid ${c.key} 0.1em; text-decoration-skip-ink: none; }
    ::highlight(${HL_TERM}) { color: ${c.term}; -webkit-text-fill-color: ${c.term}; text-decoration: underline dotted ${c.term} 1px; }
    ::highlight(${HL_BAND}) { background-color: ${c.band}; }
    ::highlight(${HL_FLASH}) { background-color: ${c.band}; text-decoration: underline solid ${c.key} 0.14em; }
  `
}
