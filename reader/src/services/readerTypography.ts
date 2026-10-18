/**
 * readerTypography.ts: EPUB 排版事务管理、拟真预览与 REAL CSS 生成
 */

import { isCFI, collapse as collapseCFI } from 'foliate-js/epubcfi.js'
import type { ReaderThemeColors } from './readerTheme.ts'
import type { BookTypographyContext } from './readerTypographyContext.ts'
import { PROTECTED_FONT_RUNS } from './readerTypographyDocument.ts'
import { automaticFontFamily, BUNDLED_READER_FAMILIES, bundledFontWeight, calibrationStatus, normalizeTypographyCalibration, type TypographyProfile } from './readerTypographyProfiles.ts'
import {
  getDefaultTypographyForLanguage,
  normalizeLanguageTag,
  normalizeTypographyBooks,
  normalizeTypographyLanguages,
  removeBookOverride,
  resolveEffectiveTypography,
  setBookOverride,
  setLanguageDefault,
  validateTypographySettings,
  type ReaderPrefs,
  type ResolvedTypography,
  type TypographyDisplayMode,
  type TypographyScope,
  type TypographySettings,
} from '../stores/settings.ts'

export type {
  TypographyDisplayMode,
  TypographyScope,
  TypographySettings,
  ResolvedTypography,
}

export {
  getDefaultTypographyForLanguage,
  normalizeLanguageTag,
  normalizeTypographyBooks,
  normalizeTypographyLanguages,
  removeBookOverride,
  resolveEffectiveTypography,
  setBookOverride,
  setLanguageDefault,
  validateTypographySettings,
}

/** A viewport range is not a stable reflow target: its union rect can include earlier columns. */
export function getTypographyAnchor(location: string): string {
  return isCFI.test(location) ? collapseCFI(location) : location
}

export function clampNumber(val: unknown, min: number, max: number, fallback: number, precision?: number): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(max, Math.max(min, n))
  if (precision != null) {
    const factor = Math.pow(10, precision)
    return Math.round(clamped * factor) / factor
  }
  return clamped
}

export const clamp = clampNumber

export function typographyPageMetrics(opts: { profile: TypographyProfile; width: number; height: number; calibration?: unknown; dpr: number; textScale: number }) {
  const calibration = normalizeTypographyCalibration(opts.calibration)
  const calibrated = calibrationStatus(calibration, opts.dpr, opts.textScale) === 'calibrated'
  const inline = calibrated && calibration ? (opts.profile === 'en' ? 14 : 12) * calibration.cssPxPerMm
    : opts.width * (opts.profile === 'en' ? 0.09 : 0.08)
  const top = calibrated && calibration ? 12 * calibration.cssPxPerMm : Math.max(24, Math.min(64, opts.height * 0.04))
  const bottom = calibrated && calibration ? 16 * calibration.cssPxPerMm : top + Math.min(24, opts.height * 0.01)
  return { inline: Math.min(inline, opts.width * 0.3), top, bottom, calibrated }
}

export interface TypographyApplyPayload {
  /** 当前书籍 ID */
  bookId?: string
  /** 目标语言 */
  language: string
  /** 应用作用域: 'book' | 'language' */
  scope: TypographyScope
  /** 新的排版设置 */
  settings: TypographySettings
  /** 应用前的排版快照 (用于失败回滚) */
  previousSettings?: TypographySettings
  /** 是否为恢复自动优化/默认操作 */
  isRestoreAuto?: boolean
  textLayoutProtected?: boolean
  readerPatch: Pick<ReaderPrefs, 'theme' | 'flow' | 'continuousScroll' | 'maxColumnCount' | 'portraitScroll' | 'progressDisplay'>
  dim: number
}

/**
 * REAL CSS: 根据显示模式生成具有实际视觉差异的正文规则
 * - publisher: 出版原貌，尊重原书样式
 * - optimized: 自动优化，规范化段落间距、首行缩进与断词
 * - repair: 兼容修复，防御性覆盖硬编码颜色、尺寸与负边距
 */
export function getDisplayModeCSS(
  mode: TypographyDisplayMode,
  settings: TypographySettings,
  colors?: ReaderThemeColors,
  context?: BookTypographyContext & { automaticFont?: boolean; fontKey?: string; userAlignment?: boolean; userLineHeight?: boolean; textScale?: number },
): string {
  if (mode === 'publisher') {
    return ''
  }

  if (mode === 'repair') {
    const fg = colors?.fg ?? '#1d2129'
    return `
    /* [排版模式: 兼容修复] 防御性排版: 消除内嵌异常颜色、负边距、微小字号与横向溢出 */
    body, p, div, span, table, td, th, blockquote, dd, dt, li {
      color: ${fg} !important;
      background-color: transparent !important;
      font-size: inherit !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
    }
    p, li, blockquote, dd {
      text-indent: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      word-break: break-word !important;
      overflow-wrap: anywhere !important;
      line-height: ${settings.lineHeight} !important;
      text-align: left !important;
    }
    img, svg, video {
      max-width: 100% !important;
      height: auto !important;
    }
    pre, code {
      white-space: pre-wrap !important;
      word-break: break-all !important;
    }
    `
  }

  // Ordinary paragraphs are marked without inserting nodes; semantic blocks retain publisher rules.
  const family = context?.automaticFont ? `var(--pw-auto-font-family, ${settings.fontFamily || 'serif'})` : settings.fontFamily || 'inherit'
  const englishFamily = context?.automaticFont ? automaticFontFamily('en', context.language) : 'inherit'
  const profile = context?.profile ?? (normalizeLanguageTag(context?.language) === 'en' ? 'en' : 'zh')
  const fontKey = context?.fontKey ?? (context?.automaticFont ? 'auto' : '')
  const bundled = fontKey === 'auto' || Object.hasOwn(BUNDLED_READER_FAMILIES, fontKey)
  const headingFamily = fontKey === 'songti-sans' ? '"PW Literata Latin", "PW Source Han Sans", sans-serif' : family
  const sansHeadings = fontKey === 'songti-sans' || fontKey === 'sans'
  const headingWeight = fontKey === 'wenkai' ? 400 : sansHeadings ? 500 : 600
  const renderedEm = settings.fontSize * (context?.textScale ?? 1)
  const px = (em: number, ratio = 1) => `${Math.round(renderedEm * ratio * em * 1000) / 1000}px`
  return `
    html, body {
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineHeight} !important;
      font-family: ${family} !important;
      font-synthesis: none;
      font-optical-sizing: ${fontKey === 'source-serif4' ? 'none' : 'auto'};
      ${bundled ? `font-weight: ${bundledFontWeight(fontKey)};` : ''}
    }
    ${bundled ? `[data-pw-semantic="h1"], [data-pw-semantic="h2"], [data-pw-semantic="h3"] {
      font-family: ${headingFamily} !important; font-weight: ${headingWeight} !important;
    }` : ''}
    ${sansHeadings ? '[data-pw-semantic="h1"] { font-weight: 700 !important; }' : ''}
    ${fontKey === 'wenkai' ? 'strong, b { font-family: "PW Literata Latin", "PW Source Han Serif", serif; font-weight: 700; }' : ''}
    p[data-pw-paragraph] {
      font-size: 1rem !important;
      font-family: inherit !important;
      line-height: ${settings.lineHeight} !important;
      text-align: ${settings.justify ? 'justify' : 'start'} !important;
      text-indent: ${px(settings.textIndent)} !important;
      margin-block-start: ${px(settings.paragraphSpacing)} !important;
      margin-block-end: 0 !important;
      letter-spacing: ${px(settings.letterSpacing)} !important;
      overflow-wrap: break-word;
      word-break: normal;
    }
    p[data-pw-paragraph] span:not(${PROTECTED_FONT_RUNS.map(selector => `${selector}, ${selector} *`).join(', ')}) {
      font-size: inherit !important;
      font-family: inherit !important;
    }
    p[data-pw-paragraph="zh"] { line-break: strict; hyphens: none; text-justify: inter-character; }
    p[data-pw-paragraph="en"] {
      font-family: ${englishFamily} !important;
      font-size: ${profile === 'mixed' ? '0.96rem' : '1rem'} !important;
      text-indent: ${px(settings.textIndent, profile === 'mixed' ? 0.96 : 1)} !important;
      margin-block-start: ${px(settings.paragraphSpacing, profile === 'mixed' ? 0.96 : 1)} !important;
      letter-spacing: ${px(settings.letterSpacing, profile === 'mixed' ? 0.96 : 1)} !important;
      line-height: ${profile !== 'en' && !context?.userLineHeight ? 1.55 : settings.lineHeight} !important;
      text-align: ${settings.justify && (profile === 'en' || context?.userAlignment) ? 'justify' : 'start'} !important;
      hyphens: auto;
      -webkit-hyphens: auto;
      line-break: auto;
      text-justify: auto;
      font-kerning: normal;
      font-variant-ligatures: common-ligatures;
    }
    p[data-pw-after-heading] { text-indent: 0 !important; }
    [data-pw-semantic="h1"] { --pw-semantic-floor: 1.6rem; font-size: max(1.6rem, var(--pw-semantic-size, 1.6rem)) !important; line-height: 1.3 !important; margin-block: ${px(1.2)} ${px(0.8)} !important; }
    [data-pw-semantic="h2"] { --pw-semantic-floor: 1.25rem; font-size: max(1.25rem, var(--pw-semantic-size, 1.25rem)) !important; line-height: 1.4 !important; margin-block: ${px(1.1)} ${px(0.65)} !important; }
    [data-pw-semantic="h3"] { --pw-semantic-floor: 1.1rem; font-size: max(1.1rem, var(--pw-semantic-size, 1.1rem)) !important; line-height: 1.4 !important; margin-block: ${px(0.9)} ${px(0.5)} !important; }
    [data-pw-semantic="caption"], [data-pw-semantic="cell"], [data-pw-semantic="note"] {
      --pw-semantic-floor: 0.9rem;
      font-size: max(0.9rem, var(--pw-semantic-size, 0.9rem)) !important;
      line-height: 1.45 !important;
      font-synthesis: none;
    }
    [data-pw-semantic="caption"] { margin-block: ${px(0.45)} ${px(0.8)} !important; }
    [data-pw-semantic-text] { font-size: max(var(--pw-semantic-floor, 0.9rem), var(--pw-semantic-size, 0.9rem)) !important; line-height: inherit !important; }
  `
}

/** 拟真预览段落文本 */
export const SAMPLE_TEXTS = {
  zh: '月光如流水一般，静静地泻在这一片叶子和花上。薄薄的青雾浮起在荷塘里。叶子和花仿佛在牛乳中洗过一样；又像笼着轻纱的梦。虽然是满月，天上却有一层淡淡的云，所以不能朗照；但我以为这恰是到了好处——酣眠固不可少，小睡也别有风味的。',
  en: 'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.',
}

export function getSampleParagraph(lang = 'zh'): string {
  const norm = normalizeLanguageTag(lang)
  return norm === 'en' ? SAMPLE_TEXTS.en : SAMPLE_TEXTS.zh
}
