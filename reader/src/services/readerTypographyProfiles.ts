import type { ReaderPrefs, TypographySettings } from '../stores/settings.ts'

export type TypographyProfile = 'zh' | 'en' | 'mixed' | 'original'
export interface TypographyCalibration {
  cssPxPerMm: number
  dpr: number
  textScale: number
  source: 'manual-ruler'
}
export const TYPOGRAPHY_POLICY_VERSION = 4

export function normalizeTypographyCalibration(raw: unknown): TypographyCalibration | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<TypographyCalibration>
  if (r.source !== 'manual-ruler' || typeof r.cssPxPerMm !== 'number' || !Number.isFinite(r.cssPxPerMm) || r.cssPxPerMm < 0.5 || r.cssPxPerMm > 30 || typeof r.dpr !== 'number' || !Number.isFinite(r.dpr) || r.dpr < 0.5 || r.dpr > 8) return null
  const textScale = r.textScale ?? 1
  if (typeof textScale !== 'number' || !Number.isFinite(textScale) || textScale < 0.5 || textScale > 3) return null
  const target = 12.5 * 25.4 / 72 * r.cssPxPerMm / textScale
  if (target < 8 || target > 64) return null
  return { cssPxPerMm: r.cssPxPerMm, dpr: r.dpr, textScale, source: 'manual-ruler' }
}

export function measureTypographyCalibration(cssWidth: number, measuredMm: number, dpr: number, textScale = 1): TypographyCalibration {
  if (!Number.isFinite(cssWidth) || cssWidth < 40 || cssWidth > 1000 || !Number.isFinite(measuredMm) || measuredMm < 5 || measuredMm > 300) throw new Error('Invalid ruler measurement')
  const value = normalizeTypographyCalibration({ cssPxPerMm: cssWidth / measuredMm, dpr, textScale, source: 'manual-ruler' })
  if (!value) throw new Error('Invalid display calibration')
  return value
}

export function calibrationStatus(raw: unknown, dpr: number, textScale = 1): 'uncalibrated' | 'calibrated' | 'changed-dpr' | 'changed-text-scale' {
  const value = normalizeTypographyCalibration(raw)
  return !value ? 'uncalibrated' : (!Number.isFinite(dpr) || Math.abs(value.dpr - dpr) > 0.02) ? 'changed-dpr'
    : !Number.isFinite(textScale) || Math.abs(value.textScale - textScale) > 0.01 ? 'changed-text-scale' : 'calibrated'
}

export function defaultTypographyProfile(language: string): TypographyProfile {
  return language === 'zh' ? 'zh' : language === 'en' ? 'en' : 'original'
}

export function profileDefaults(profile: TypographyProfile, opts: {
  base?: Partial<ReaderPrefs>
  calibration?: unknown
  dpr?: number
  textScale?: number
  viewportWidth?: number
} = {}): TypographySettings {
  const base = opts.base ?? {}
  const original = profile === 'original'
  const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  let size = finite(base.fontSize, 18)
  // A tablet visual starting point is not a physical-size claim; non-factory choices remain authoritative.
  if (!original && size === 18 && (opts.viewportWidth ?? 0) >= 768) size = profile === 'en' ? 29 : 30
  const calibration = normalizeTypographyCalibration(opts.calibration)
  if (!original && calibration && calibrationStatus(calibration, opts.dpr ?? 1, opts.textScale ?? 1) === 'calibrated') size = (profile === 'en' ? 12 : 12.5) * 25.4 / 72 * calibration.cssPxPerMm / calibration.textScale
  return {
    profile,
    displayMode: original ? 'publisher' : 'optimized',
    fontSize: Math.min(64, Math.max(8, Math.round(size))),
    lineHeight: original ? finite(base.lineHeight, 1.8) : profile === 'zh' ? 1.7 : profile === 'en' ? 1.55 : 1.75,
    gap: Math.min(20, Math.max(2, finite(base.gap, 6) === 6 && !original ? profile === 'en' ? 9 : 8 : finite(base.gap, 6))),
    fontFamily: original ? typeof base.fontFamily === 'string' ? base.fontFamily : '' : 'auto',
    justify: original ? base.justify ?? true : profile === 'zh',
    letterSpacing: original ? finite(base.letterSpacing, 0) : 0,
    paragraphSpacing: profile === 'mixed' ? 0.45 : profile === 'zh' ? 0.15 : 0,
    textIndent: original ? 0 : profile === 'en' ? 1.2 : profile === 'mixed' ? 0 : 2,
    maxLineLength: 0,
    publicationBaseline: false,
  }
}

const MIXED_LATIN = '"PW Literata Latin"'
export const BUNDLED_READER_FAMILIES: Record<string, string> = {
  songti: `${MIXED_LATIN}, "PW Source Han Serif", "PW WenKai Screen", "Noto Serif CJK SC", "SimSun-ExtB", serif`,
  'songti-medium': `${MIXED_LATIN}, "PW Source Han Serif", "PW WenKai Screen", "Noto Serif CJK SC", "SimSun-ExtB", serif`,
  'songti-sans': `${MIXED_LATIN}, "PW Source Han Serif", "PW WenKai Screen", "Noto Serif CJK SC", "SimSun-ExtB", serif`,
  sans: `${MIXED_LATIN}, "PW Source Han Sans", "PW WenKai Screen", "Noto Sans CJK SC", "SimSun-ExtB", sans-serif`,
  wenkai: `${MIXED_LATIN}, "PW WenKai Screen", "PW Source Han Serif", serif`,
  literata: '"PW Literata", "PW Source Han Serif", "PW WenKai Screen", "SimSun-ExtB", Georgia, serif',
  'source-serif4': '"PW Source Serif 4", "PW Source Han Serif", "PW WenKai Screen", "SimSun-ExtB", Georgia, serif',
}

export function bundledFontWeight(key: string): number {
  return key === 'songti-medium' ? 500 : 400
}

export function automaticFontFamily(profile: TypographyProfile, language = ''): string {
  const tag = language.toLowerCase().replaceAll('_', '-')
  const latin = '"PW Literata", "Literata", "Source Serif 4", "Noto Serif", Georgia, "Times New Roman"'
  const cjk = /^zh-(?:hk|mo)(?:-|$)/.test(tag) ? '"Source Han Serif HK", "Noto Serif CJK HK"'
    : /^(?:zh-(?:hant|tw)|cmn-hant)/.test(tag) ? '"Source Han Serif TC", "Noto Serif CJK TC"'
    : /^(?:zh-(?:hans|cn|sg)|cmn-hans)/.test(tag) ? '"Source Han Serif SC", "Noto Serif CJK SC"'
    : /^ja(?:-|$)/.test(tag) ? '"Source Han Serif", "Noto Serif CJK JP"'
    : /^ko(?:-|$)/.test(tag) ? '"Source Han Serif K", "Noto Serif CJK KR"' : ''
  // The full SC-default face contains ZHS/ZHT/ZHH locl substitutions; lang, not
  // a second font download, selects regional forms. An unspecified region keeps
  // the documented SC product default without inventing a book language tag.
  return (profile === 'en' ? [latin, '"PW Source Han Serif"', cjk]
    : [MIXED_LATIN, '"PW Source Han Serif"', cjk, latin]).filter(Boolean).join(', ') + ', "PW WenKai Screen", "SimSun-ExtB", serif'
}
