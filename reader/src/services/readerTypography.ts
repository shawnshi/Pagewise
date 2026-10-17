/**
 * readerTypography.ts: EPUB 排版事务管理、拟真预览与 REAL CSS 生成
 */

import type { ReaderThemeColors } from './readerTheme.ts'
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

  // 默认为 optimized
  return `
    /* [排版模式: 自动优化] 现代数字阅读规范: 规范化断词、缩进与段落流 */
    p:not(blockquote p, li p, td p, th p, dd p) {
      ${settings.justify ? 'text-align: justify;' : 'text-align: start;'}
      text-indent: ${settings.textIndent}em;
      margin-block-start: ${settings.paragraphSpacing}em;
      margin-block-end: 0;
      hyphens: auto;
      -webkit-hyphens: auto;
      overflow-wrap: break-word;
    }
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
