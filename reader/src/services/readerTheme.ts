import type { ReaderPrefs } from '../stores/settings'
import { WORD_GUIDE_DEFAULT, guideAccent, guideTailAlpha } from './readingModes/wordGuideIntensity.ts'
import { dianjingCSS, djThemeName } from './dianjing/theme.ts'
import { getDisplayModeCSS, type TypographySettings } from './readerTypography.ts'

export interface ReaderThemeColors {
  bg: string
  fg: string
  link: string
}

export type ReaderThemeName = Exclude<ReaderPrefs['theme'], 'auto'>

export const READER_THEMES: Record<ReaderThemeName, ReaderThemeColors> = {
  light: { bg: '#ffffff', fg: '#1d2129', link: '#1664ff' },
  sepia: { bg: '#faf3e7', fg: '#453c2c', link: '#8f6c2e' },
  green: { bg: '#c7edcc', fg: '#243528', link: '#1e6b4a' },
  dark: { bg: '#17181a', fg: '#c5c8ce', link: '#6a9bff' },
}

/** 墨水屏 (docs/research/reading-modes-landscape.md §6.3): 纯黑白 21:1, 链接为黑色加下划线; 夜间配合为反色 */
export const EINK_THEMES: { light: ReaderThemeColors; dark: ReaderThemeColors } = {
  light: { bg: '#ffffff', fg: '#000000', link: '#000000' },
  dark: { bg: '#000000', fg: '#ffffff', link: '#ffffff' },
}

/** 阅读模式对正文样式的附加影响 (useReadingModes().readerStyle), 由阅读器传给 getReaderCSS / resolveReaderColors */
export interface ReaderModeStyle {
  /** 墨水屏: 纯黑白配色、字重 +100、无动画 */
  eink?: boolean
  /** 大字: 段距 0.6em、正文字重 500 */
  largeText?: boolean
  /** 仿生阅读着色强度 (0.4–1) 与配色, 见 readingModes/wordGuideIntensity */
  wordGuideIntensity?: number
  wordGuideColor?: string
}

/** auto 跟随界面外观: 浅色外观读白底, 深色外观读夜间 */
export function resolveReaderTheme(theme: ReaderPrefs['theme'], appDark: boolean): ReaderThemeName {
  return theme === 'auto' ? (appDark ? 'dark' : 'light') : theme
}

export function resolveReaderColors(theme: ReaderPrefs['theme'], appDark: boolean, style?: ReaderModeStyle): ReaderThemeColors {
  const name = resolveReaderTheme(theme, appDark)
  if (style?.eink) return EINK_THEMES[name === 'dark' ? 'dark' : 'light']
  return READER_THEMES[name]
}

/** 主题选择按钮 (含 auto), 顺序固定; auto 的色板用斜切双色示意跟随外观 */
export const READER_THEME_CHOICES: Array<{ name: ReaderPrefs['theme']; bg: string; fg: string }> = [
  ...(Object.entries(READER_THEMES) as Array<[ReaderThemeName, ReaderThemeColors]>)
    .map(([name, c]) => ({ name: name as ReaderPrefs['theme'], bg: c.bg, fg: c.fg })),
  { name: 'auto', bg: 'linear-gradient(135deg, #ffffff 50%, #17181a 50%)', fg: '#8a919c' },
]

export const FONT_FAMILIES = [
  { labelKey: 'reader.fontDefault', value: '' },
  { labelKey: 'reader.fontSongti', value: '"Songti SC", "Noto Serif SC", SimSun, serif' },
  { labelKey: 'reader.fontHeiti', value: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' },
  { labelKey: 'reader.fontKaiti', value: '"Kaiti SC", KaiTi, "Noto Serif SC", serif' },
]

/** 注入到 foliate 渲染 iframe 的样式 */
export function getReaderCSS(
  prefs: ReaderPrefs,
  appDark: boolean,
  style?: ReaderModeStyle,
  typography?: TypographySettings,
): string {
  const theme = resolveReaderTheme(prefs.theme, appDark)
  const colors = resolveReaderColors(prefs.theme, appDark, style)
  const fontSize = typography?.fontSize ?? prefs.fontSize
  const fontFamily = typography?.fontFamily ?? prefs.fontFamily
  const letterSpacing = typography?.letterSpacing ?? prefs.letterSpacing
  const lineHeight = typography?.lineHeight ?? prefs.lineHeight
  const justify = typography?.justify ?? prefs.justify
  const displayMode = typography?.displayMode ?? 'optimized'

  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${theme === 'dark' ? 'dark' : 'light'};
      color: ${colors.fg};
      font-size: ${fontSize}px;
      ${fontFamily ? `font-family: ${fontFamily};` : ''}
      ${letterSpacing > 0 ? `letter-spacing: ${Math.min(0.5, letterSpacing)}em;` : ''}
    }
    body { background: none !important; }
    ${displayMode === 'publisher' ? '' : `p, li, blockquote, dd { line-height: ${lineHeight}; }`}
    a:any-link { color: ${colors.link}; }
    /* 脚注弹出场景保持可读 */
    aside[epub|type~="footnote"] { background: ${colors.bg}; }
    ${getDisplayModeCSS(displayMode, {
      displayMode,
      fontSize,
      lineHeight,
      gap: typography?.gap ?? prefs.gap,
      fontFamily,
      justify,
      letterSpacing,
      paragraphSpacing: typography?.paragraphSpacing ?? 0.4,
      textIndent: typography?.textIndent ?? 2,
    }, colors)}
    ${readingModeCSS(colors, theme, style)}
    ${modeStyleCSS(style)}
    ${style?.eink ? `
    ::highlight(lr-annotation) { background-color: ${theme === 'dark' ? '#333333' : '#e0e0e0'}; color: ${colors.fg}; }
    ::selection { background-color: ${theme === 'dark' ? '#333333' : '#e0e0e0'}; color: ${colors.fg}; }
    ` : ''}
    ${dianjingCSS(djThemeName(theme, !!style?.eink))}
  `
}

/** 墨水屏 / 大字附加的正文样式 (只在开关切换时随 setStyles 重排一次) */
function modeStyleCSS(style?: ReaderModeStyle): string {
  let css = ''
  if (style?.largeText) {
    css += `
    body { font-weight: 500; }
    p + p { margin-block-start: 0.6em; }
    `
  }
  if (style?.eink) {
    // 字重 +100 (约等于 Boox 的「加深」); 链接黑色加下划线; 图片灰度; 去掉一切过渡与动画
    css += `
    body { font-weight: ${style.largeText ? 600 : 500}; }
    b, strong, th, h1, h2, h3, h4, h5, h6 { font-weight: 800; }
    a:any-link { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 2px; }
    img, svg, video { filter: grayscale(1) contrast(1.1); }
    *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
    `
  }
  return css
}

/** 6 位 / 3 位十六进制色 → rgba, 用于淡显后文 (不依赖 color-mix, 兼容 Highlight API 最早的 Chrome 105) */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * 阅读模式 (打字机) 的静态样式: 开关模式只增删 Highlight 对象, 不调用 setStyles, 所以不会重排。
 * ::highlight 只允许改颜色类属性; 不支持它的旧 WebView 忽略这些规则, 改走 overlayer 遮罩。
 */
function readingModeCSS(colors: ReaderThemeColors, theme: string, style?: ReaderModeStyle): string {
  const ghost = withAlpha(colors.fg, 0.18)
  return `
    ::highlight(lr-tw-hidden) { color: transparent; -webkit-text-fill-color: transparent; text-shadow: none; text-decoration-color: transparent; }
    ::highlight(lr-tw-ghost) { color: ${ghost}; -webkit-text-fill-color: ${ghost}; text-shadow: none; text-decoration-color: ${ghost}; }
    ::highlight(lr-tw-fresh) { color: ${colors.link}; -webkit-text-fill-color: ${colors.link}; }
    ${wordGuideCSS(colors, theme, style?.wordGuideIntensity, style?.wordGuideColor)}
    [data-lr-pending] { visibility: hidden !important; }
  `
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffd54d',
  green: '#7ed99b',
  blue: '#7cb8ff',
  red: '#ff8f8f',
}

export function annotationLineStyle(color: string): 'solid' | 'double' | 'dashed' | 'dotted' {
  switch (color) {
    case 'green': return 'double'
    case 'blue': return 'dashed'
    case 'red': return 'dotted'
    default: return 'solid'
  }
}

export function annotationLabelKey(color: string, eink: boolean): string {
  const known = Object.hasOwn(HIGHLIGHT_COLORS, color)
  return eink ? `reader.highlightLine.${known ? color : 'yellow'}`
    : known ? `reader.highlightColor.${color}` : 'reader.highlight'
}

export function annotationSwatchStyle(color: string, eink: boolean) {
  return eink ? {
    background: 'var(--annotation-bg)',
    color: 'var(--text)',
    textDecorationLine: 'underline',
    textDecorationStyle: annotationLineStyle(color),
    textDecorationThickness: '2px',
    textUnderlineOffset: '3px',
  } : { background: HIGHLIGHT_COLORS[color] ?? color }
}

/**
 * 听书当前句的标记, 画在 foliate overlayer 上 (SVG 盖在文字上面, 正文和底色一起被染色)。
 * 每个正文主题一套: 色块按 opacity 叠上去后, 句内文字对色块的对比度 ≥ 4.5:1 (见 scripts/test-read-aloud.mjs);
 * 墨水屏不用色块 (灰阶屏上发灰、刷新残影), 改为同色粗下划线。
 */
export interface ListenMarkStyle {
  color: string
  opacity: number
  /** 下划线代替色块 */
  underline?: boolean
}

export const LISTEN_MARKS: Record<ReaderThemeName | 'eink' | 'eink-dark', ListenMarkStyle> = {
  light: { color: '#2f6bff', opacity: 0.24 },
  sepia: { color: '#b8741a', opacity: 0.26 },
  green: { color: '#1f7a5a', opacity: 0.24 },
  dark: { color: '#6a9bff', opacity: 0.26 },
  eink: { color: '#000000', opacity: 1, underline: true },
  'eink-dark': { color: '#ffffff', opacity: 1, underline: true },
}

export function listenMarkStyle(theme: ReaderPrefs['theme'], appDark: boolean, style?: ReaderModeStyle): ListenMarkStyle {
  const name = resolveReaderTheme(theme, appDark)
  if (style?.eink) return LISTEN_MARKS[name === 'dark' ? 'eink-dark' : 'eink']
  return LISTEN_MARKS[name]
}

/** 两个十六进制色按比例混合 (t 为 b 的占比), 不依赖 color-mix */
function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return null
    const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
    const n = parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return a
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/** 按词着色只修改 Highlight 颜色，避免调节强度时重排正文。 */
function wordGuideCSS(colors: ReaderThemeColors, theme: string, intensity = WORD_GUIDE_DEFAULT, color?: string): string {
  // 两个高亮名 (旧版轻 / 标准) 用同一颜色, 强度只由 intensity 决定
  const alt = mixHex(colors.fg, guideAccent(color, theme), Math.min(1, Math.max(0, intensity)))
  const altLight = alt
  const altNormal = alt
  const tail = withAlpha(colors.fg, guideTailAlpha(intensity))
  // 重点词 (点睛阅读): 全书第一次出现强 (着色更足 + 浅底), 之后弱 (只着色); 都随明显程度变化, 只改颜色不重排
  const t = Math.min(1, Math.max(0, intensity))
  const accent = guideAccent(color, theme)
  const kwStrong = mixHex(colors.fg, accent, Math.min(1, t + 0.2))
  const kwStrongBg = withAlpha(accent, Math.round((0.05 + 0.13 * t) * 1000) / 1000)
  const kwWeak = mixHex(colors.fg, accent, Math.round(t * 0.75 * 100) / 100)
  return `
    ::highlight(lr-wg-alt-l) { color: ${altLight}; -webkit-text-fill-color: ${altLight}; }
    ::highlight(lr-wg-alt-n) { color: ${altNormal}; -webkit-text-fill-color: ${altNormal}; }
    ::highlight(lr-wg-tail) { color: ${tail}; -webkit-text-fill-color: ${tail}; }
    ::highlight(lr-wg-kw-s) { color: ${kwStrong}; -webkit-text-fill-color: ${kwStrong}; background-color: ${kwStrongBg}; }
    ::highlight(lr-wg-kw-w) { color: ${kwWeak}; -webkit-text-fill-color: ${kwWeak}; }
  `
}
