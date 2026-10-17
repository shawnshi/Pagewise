/**
 * 点睛阅读基础版的着色强度 (0.25–1): 中文交替着色的那一半混入多少青色, 西文词尾降多少。
 * 默认五档有名字, 也可以拖到两档之间; 「标准」比旧版的「标准」明显 (旧版太淡)。
 */
export const WORD_GUIDE_STOPS: ReadonlyArray<{ value: number; key: string }> = [
  { value: 0.5, key: 'readingMode.intensitySoft' },
  { value: 0.6, key: 'readingMode.intensityGentle' },
  { value: 0.7, key: 'readingMode.intensityNormal' },
  { value: 0.82, key: 'readingMode.intensityClear' },
  { value: 0.95, key: 'readingMode.intensityVivid' },
]
/** 默认居中「标准」 */
export const WORD_GUIDE_DEFAULT = 0.7
/** 可调范围两端都超出刻度, 留足余地 */
export const WORD_GUIDE_MIN = 0.25

/**
 * 精选配色 (默认玫瑰): 每种颜色按四种正文底色分别调过, 与底色的对比度都 ≥ 4.5:1 (夜间 8–10:1),
 * 清楚但不刺眼。颜色名用读者的说法。
 */
export type GuideColor = 'teal' | 'indigo' | 'amber' | 'rose' | 'forest'
type ThemeKey = 'light' | 'sepia' | 'green' | 'dark'
export const GUIDE_COLORS: ReadonlyArray<{ id: GuideColor; key: string; shades: Record<ThemeKey, string> }> = [
  { id: 'rose', key: 'readingMode.colorRose', shades: { light: '#c2185b', sepia: '#ad1652', green: '#951247', dark: '#ff92b6' } },
  { id: 'teal', key: 'readingMode.colorTeal', shades: { light: '#0b7f8a', sepia: '#0a7480', green: '#075f69', dark: '#4fd0d8' } },
  { id: 'indigo', key: 'readingMode.colorIndigo', shades: { light: '#3d4fd1', sepia: '#3846bf', green: '#2f3ca6', dark: '#9aa9ff' } },
  { id: 'amber', key: 'readingMode.colorAmber', shades: { light: '#a35800', sepia: '#934f00', green: '#7d4300', dark: '#f2b650' } },
  { id: 'forest', key: 'readingMode.colorForest', shades: { light: '#2a7d3a', sepia: '#287034', green: '#1b5527', dark: '#74d98a' } },
]
export const GUIDE_COLOR_DEFAULT: GuideColor = 'rose'

/** 当前正文主题下的强调色 */
export function guideAccent(color: string | undefined, theme: string): string {
  const c = GUIDE_COLORS.find(x => x.id === (color ?? GUIDE_COLOR_DEFAULT)) ?? GUIDE_COLORS.find(x => x.id === GUIDE_COLOR_DEFAULT)!
  const t: ThemeKey = theme === 'sepia' || theme === 'green' || theme === 'dark' ? theme : 'light'
  return c.shades[t]
}

/** 西文「词尾」的不透明度: 强度越高越淡 (0.5 → 0.75, 1 → 0.45) */
export function guideTailAlpha(intensity: number): number {
  const t = Math.min(1, Math.max(WORD_GUIDE_MIN, intensity))
  return Math.round((1.05 - 0.6 * t) * 100) / 100
}

/** 旧设置 (strength: light / normal) 没有 intensity 时的取值 */
export function guideIntensity(prefs: { intensity?: number; strength?: string } | undefined): number {
  const v = prefs?.intensity
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(1, Math.max(WORD_GUIDE_MIN, v))
  return WORD_GUIDE_DEFAULT
}
