import { defineStore } from 'pinia'
import { watch } from 'vue'
import { normalizeAiProfiles, providerById, type AiProviderProfile } from '../services/aiProviders.ts'
import type { TypographyApplyPayload } from '../services/readerTypography.ts'
import { DIM_MAX } from '../services/readingModes/eyeCare.ts'
import { isTauri } from '../storage/types.ts'
import { normalizeRetiredLyricSettings } from '../services/readingModes/retiredSettings.ts'
import { BASIC_MARK_DEFAULT, migrateLevel, normalizeLevel, savedBasicMark, type BasicMark, type DjLevel } from '../services/dianjing/level.ts'

export type TypographyDisplayMode = 'optimized' | 'publisher' | 'repair'
export type TypographyScope = 'book' | 'language'

export interface TypographySettings {
  /** 显示模式 */
  displayMode: TypographyDisplayMode
  /** 字号 (px, 8..64) */
  fontSize: number
  /** 行距 (1.0..3.0) */
  lineHeight: number
  /** 页边距百分比 (2..20) */
  gap: number
  /** 字体族 (空为默认) */
  fontFamily: string
  /** 两端对齐 */
  justify: boolean
  /** 字距 (em, 0..0.5) */
  letterSpacing: number
  /** 段距 (em, 0..2.0) */
  paragraphSpacing: number
  /** 首行缩进 (em, 0..4.0, 中文默认 2em) */
  textIndent: number
}

export interface ResolvedTypography extends TypographySettings {
  source: 'base' | 'language' | 'book'
  hasBookOverride: boolean
  hasLanguageOverride: boolean
  appliedLanguage: string
  bookId?: string
}

function clampNum(val: unknown, min: number, max: number, fallback: number, precision?: number): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(max, Math.max(min, n))
  if (precision != null) {
    const factor = Math.pow(10, precision)
    return Math.round(clamped * factor) / factor
  }
  return clamped
}

export function normalizeLanguageTag(lang?: string): string {
  if (!lang || typeof lang !== 'string') return 'und'
  const clean = lang.trim().toLowerCase()
  if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/.test(clean)) return 'und'
  if (/^zh\b|^cmn\b/i.test(clean)) return 'zh'
  if (/^en\b|^eng\b/i.test(clean)) return 'en'
  if (/^ja\b/i.test(clean)) return 'ja'
  if (/^ko\b/i.test(clean)) return 'ko'
  if (/^fr\b/i.test(clean)) return 'fr'
  if (/^de\b/i.test(clean)) return 'de'
  if (/^es\b/i.test(clean)) return 'es'
  if (/^ru\b/i.test(clean)) return 'ru'
  const first = clean.split(/[-_]/)[0]
  return first || 'und'
}

export function validateTypographySettings(raw: unknown): Partial<TypographySettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const res: Partial<TypographySettings> = {}

  if (typeof r.displayMode === 'string' && ['optimized', 'publisher', 'repair'].includes(r.displayMode)) {
    res.displayMode = r.displayMode as TypographyDisplayMode
  }
  if (r.fontSize !== undefined) {
    res.fontSize = Math.round(clampNum(r.fontSize, 8, 64, 18))
  }
  if (r.lineHeight !== undefined) {
    res.lineHeight = clampNum(r.lineHeight, 1.0, 3.0, 1.8, 1)
  }
  if (r.gap !== undefined) {
    res.gap = Math.round(clampNum(r.gap, 2, 20, 6))
  }
  if (typeof r.fontFamily === 'string') {
    res.fontFamily = r.fontFamily.trim()
  }
  if (typeof r.justify === 'boolean') {
    res.justify = r.justify
  }
  if (r.letterSpacing !== undefined) {
    res.letterSpacing = clampNum(r.letterSpacing, 0, 0.5, 0, 2)
  }
  if (r.paragraphSpacing !== undefined) {
    res.paragraphSpacing = clampNum(r.paragraphSpacing, 0, 2.0, 0.4, 2)
  }
  if (r.textIndent !== undefined) {
    res.textIndent = clampNum(r.textIndent, 0, 4.0, 2, 1)
  }

  return res
}

export function normalizeTypographyLanguages(raw: unknown): Record<string, Partial<TypographySettings>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const res: Record<string, Partial<TypographySettings>> = {}
  for (const [lang, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof lang === 'string' && lang.trim()) {
      const validated = validateTypographySettings(val)
      if (Object.keys(validated).length > 0) {
        res[normalizeLanguageTag(lang)] = validated
      }
    }
  }
  return res
}

export function normalizeTypographyBooks(raw: unknown): Record<string, Partial<TypographySettings>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const res: Record<string, Partial<TypographySettings>> = {}
  for (const [bookId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof bookId === 'string' && bookId.trim()) {
      const validated = validateTypographySettings(val)
      if (Object.keys(validated).length > 0) {
        res[bookId.trim()] = validated
      }
    }
  }
  return res
}

export function getDefaultTypographyForLanguage(language = 'zh'): TypographySettings {
  const norm = normalizeLanguageTag(language)
  if (!['zh', 'ja', 'ko'].includes(norm)) {
    return {
      displayMode: 'optimized',
      fontSize: 17,
      lineHeight: 1.5,
      gap: 7,
      fontFamily: '',
      justify: true,
      letterSpacing: 0,
      paragraphSpacing: 0.6,
      textIndent: 0,
    }
  }
  return {
    displayMode: 'optimized',
    fontSize: 18,
    lineHeight: 1.8,
    gap: 6,
    fontFamily: '',
    justify: true,
    letterSpacing: 0,
    paragraphSpacing: 0.4,
    textIndent: 2,
  }
}

export function resolveEffectiveTypography(opts: {
  baseReaderPrefs: ReaderPrefs
  language?: string
  bookId?: string
  languagesMap?: Record<string, Partial<TypographySettings>>
  booksMap?: Record<string, Partial<TypographySettings>>
}): ResolvedTypography {
  const normLang = normalizeLanguageTag(opts.language)
  const langDefault = getDefaultTypographyForLanguage(normLang)

  const baseSettings: TypographySettings = {
    displayMode: 'optimized',
    fontSize: clampNum(opts.baseReaderPrefs.fontSize, 8, 64, langDefault.fontSize),
    lineHeight: clampNum(opts.baseReaderPrefs.lineHeight, 1.0, 3.0, langDefault.lineHeight, 1),
    gap: clampNum(opts.baseReaderPrefs.gap, 2, 20, langDefault.gap),
    fontFamily: opts.baseReaderPrefs.fontFamily ?? '',
    justify: opts.baseReaderPrefs.justify ?? true,
    letterSpacing: clampNum(opts.baseReaderPrefs.letterSpacing, 0, 0.5, 0, 2),
    paragraphSpacing: langDefault.paragraphSpacing,
    textIndent: langDefault.textIndent,
  }

  let source: 'base' | 'language' | 'book' = 'base'
  let hasLanguageOverride = false
  let hasBookOverride = false

  let merged: TypographySettings = { ...baseSettings }
  if (opts.languagesMap && opts.languagesMap[normLang]) {
    const langOv = validateTypographySettings(opts.languagesMap[normLang])
    if (Object.keys(langOv).length > 0) {
      merged = { ...merged, ...langOv }
      hasLanguageOverride = true
      source = 'language'
    }
  }

  if (opts.bookId && opts.booksMap && opts.booksMap[opts.bookId]) {
    const bookOv = validateTypographySettings(opts.booksMap[opts.bookId])
    if (Object.keys(bookOv).length > 0) {
      merged = { ...merged, ...bookOv }
      hasBookOverride = true
      source = 'book'
    }
  }

  return {
    ...merged,
    source,
    hasBookOverride,
    hasLanguageOverride,
    appliedLanguage: normLang,
    bookId: opts.bookId,
  }
}

export function setBookOverride(
  booksMap: Record<string, Partial<TypographySettings>> = {},
  bookId: string,
  settings: Partial<TypographySettings>,
): Record<string, Partial<TypographySettings>> {
  if (!bookId) return { ...booksMap }
  const clean = validateTypographySettings(settings)
  return {
    ...booksMap,
    [bookId]: {
      ...(booksMap[bookId] ? validateTypographySettings(booksMap[bookId]) : {}),
      ...clean,
    },
  }
}

export function removeBookOverride(
  booksMap: Record<string, Partial<TypographySettings>> = {},
  bookId: string,
): Record<string, Partial<TypographySettings>> {
  if (!bookId || !booksMap[bookId]) return { ...booksMap }
  const copy = { ...booksMap }
  delete copy[bookId]
  return copy
}

export function setLanguageDefault(
  languagesMap: Record<string, Partial<TypographySettings>> = {},
  language: string,
  settings: Partial<TypographySettings>,
): Record<string, Partial<TypographySettings>> {
  const norm = normalizeLanguageTag(language)
  const clean = validateTypographySettings(settings)
  return {
    ...languagesMap,
    [norm]: {
      ...(languagesMap[norm] ? validateTypographySettings(languagesMap[norm]) : {}),
      ...clean,
    },
  }
}

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  /** 页边距百分比 */
  gap: number
  /** 阅读主题; auto 跟随界面外观在浅色/夜间间切换 */
  theme: 'auto' | 'light' | 'sepia' | 'green' | 'dark'
  flow: 'paginated' | 'scrolled'
  maxColumnCount: 1 | 2
  /** 平板竖屏 (高于宽) 时改为单栏连续滚动, 横屏恢复上面的 flow / 分栏; PDF 同样适用 */
  portraitScroll: boolean
  /** 滚动模式下跨章连续滚动: 章与章首尾相接 (docs/continuous-scroll.md); 关掉回到单章滚动 */
  continuousScroll: boolean
  fontFamily: string
  justify: boolean
  /** 字距 (em), 0 为书籍原样; 大字预设为 0.05 */
  letterSpacing: number
  /** 页脚 / 底栏的阅读进度显示: 页码 + 百分比 / 只看页码 / 只看百分比 */
  progressDisplay: 'both' | 'page' | 'percent'
}

export interface PdfPrefs {
  /** 可见页面位图渲染引擎；文字几何与交互仍由 PDFium 提供 */
  renderer: 'mupdf' | 'pdfium'
  /** original: 保留版式；reflow 仅用于兼容旧设置，产品入口已移除 */
  layout: 'original' | 'reflow'
  /** paged: 整页翻页；scroll: 连续滚动（默认） */
  mode: 'paged' | 'scroll'
  /** 快捷适配: fitH 适高整页 / fitW 适宽（默认） */
  fit: 'fitH' | 'fitW'
  /** Sumatra 风格页布局：单页 / 对页 / 书籍封面错位双页 */
  spreadMode: 'single' | 'facing' | 'book'
}

/** 打字机模式 (docs/reading-modes.md §3.1) */
export interface TypewriterPrefs {
  /** 粒度: 逐字 / 逐句 / 逐行 */
  unit: 'char' | 'sentence' | 'line'
  /** 中文书速度, 字/分 (60–1200) */
  cpm: number
  /** 西文书速度, 词/分 (40–800) */
  wpm: number
  /** 后文: 隐藏 / 淡显 */
  upcoming: 'hidden' | 'ghost'
  punctuationPause: boolean
  /** 墨迹未干: 最新出现的字用强调色 */
  freshInk: boolean
  /** 打字声 (CC0 录音单发样本, 见 services/readingModes/soundPresets.ts) */
  sound: boolean
  /** 打字声音色 (同 soundPresets.TypingSoundPresetId) */
  soundPreset: 'typewriter' | 'mechanical' | 'soft' | 'pen'
  /** 打字声音量 0–1 */
  soundVolume: number
  /** 打完一页后停留多久再自动翻页, 毫秒 */
  pageDwellMs: number
}

/** 预设开关的快照 (大字 / 墨水屏 / 夜间 / 护眼): 开启时记下原值, 关闭时恢复; 见 services/readingModes/presets.ts */
export interface PresetRecordPrefs {
  before: Record<string, unknown>
  applied: Record<string, unknown>
  order: number
}

/** 阅读模式 (docs/research/reading-modes-landscape.md §5) */
export interface ReadingModePrefs {
  typewriter: TypewriterPrefs
  /** 点睛阅读基础版 (按词分色; 默认关): 西文词首强调 / 中文分词交替着色。enabled 只在 dianjing.level 为 basic 时生效 */
  wordGuide: {
    enabled: boolean
    style: 'auto' | 'alternate' | 'fixation'
    strength: 'light' | 'normal'
    /** 着色强度 0.4–1 (默认五档 柔和 … 最强, 可拖动微调); 取代 strength */
    intensity: number
    /** 着色颜色 (精选配色之一) */
    color: 'teal' | 'indigo' | 'amber' | 'rose' | 'forest'
    /**
     * 基础版标什么: boundary = 词与词 (相邻的词交替着色); keywords = 重点词 (离线挑出每段最要紧的词, 密度随 dianjing.density)。
     * 新安装默认重点词; 已有存档没有这个字段时保持词与词 (load 里补, 不升版本)。
     */
    mark: BasicMark
  }
  /** 大字: 预设开关; custom 为在大字模式里手动调过的值 (下次开启沿用) */
  largeText: { enabled: boolean; size: 'large' | 'xlarge'; custom: Record<string, unknown> }
  /** 墨水屏: 纯黑白高对比、字重 +100、无动画; suggestDismissed 为「识别到墨水屏设备」提示已处理 */
  eink: { enabled: boolean; suggestDismissed: boolean }
  /** 沉浸: 隐藏页眉页脚文字 / 工具栏只在轻点时出现; hideFooter 连页码也隐藏 */
  immersive: { enabled: boolean; hideFooter: boolean }
  /** 护眼: 暖色主题 + 应用内调暗 (0–60%) + 休息提醒 (分钟) */
  eyeCare: { theme: 'sepia' | 'green'; dim: number; reminder: boolean; intervalMin: 20 | 30 | 45 }
  /** 夜间定时: from–to 之间自动切到夜间 (HH:MM, 可跨午夜) */
  night: { schedule: boolean; from: string; to: string }
  /** 预设快照 (按预设 id), 持久化以便崩溃后恢复 */
  presets: Record<string, PresetRecordPrefs>
}

/** 结构版本: 修正历史默认值时递增 */
const SETTINGS_VERSION = 14

export interface CustomFontRec {
  name: string
  file: string
}

/** 背景音 (services/ambient, docs/research/reading-ambient-audio.md §5.5); 只记住选择, 从不自动播放 */
export interface AmbientPrefs {
  /** 最近一次使用的场景 id */
  scene: string
  /** 主音量 0..1 (滑块值, 按感知曲线映射到增益), 默认 0.3 */
  master: number
  /** 每层音量 0..1, 键为「场景/层」; 缺省用场景默认值 */
  layers: Record<string, number>
  /** 专注噪音的颜色 */
  noiseColor: 'pink' | 'white' | 'brown'
  /** 听书时自动降低 */
  duckWithVoice: boolean
  /** 降低到的倍数 (0.25 = -12 dB) */
  duckLevel: number
  /** 手机切到后台时暂停 (只有背景音在播时) */
  pauseWhenHidden: boolean
}

/**
 * 点睛阅读 (docs/dianjing-reading.md §4.1, services/dianjing/level.ts): 两个版本——
 * 基础版 (按词分色, 不联网; 开关即 readingMode.wordGuide.enabled) 与智能版 (AI, 下面这些字段; 首次开启需同意)。
 */
export interface DianjingPrefs {
  /** 选的版本 (默认基础版); 「点睛阅读开着」= 这个版本开着 */
  level: DjLevel
  /** 智能版: 「所有书开启」后的全局开关 (perBook 未设置的书跟随它) */
  enabled: boolean
  /** 已同意「所有书开启」 */
  consentAll: boolean
  /** 按书开关 (bookId → 开/关); 选「仅本书」即写这里 */
  perBook: Record<string, boolean>
  /**
   * 标记多少 (少 / 适中 / 多), 基础版重点词与智能版共用: 智能版要句 5% / 8% / 15% (按字数);
   * 重点词 基础版 2% / 4% / 8% (占词数), 智能版 只亮重要度≥2 的 AI 词 / 全部 AI 词 / AI 词 + 离线补到 8%
   */
  density: 'low' | 'normal' | 'high'
  /** 标记类型 (kw: 智能版的重点词) */
  kinds: { key: boolean; term: boolean; note: boolean; kw: boolean }
  /** 通道: auto (已配置自己的密钥则用自己的, 否则内置) / builtin / own */
  channel: 'auto' | 'builtin' | 'own'
  /** 体裁手动设置 (bookId → 叙事 / 非叙事), 未设置时自动识别 */
  fiction: Record<string, 'fiction' | 'nonfiction'>
  /** 章首要义卡 */
  chapterCard: boolean
}

interface SettingsState {
  version?: number
  /** 界面语言 */
  language: 'zh' | 'en'
  /** 界面外观: 跟随系统 / 浅色 / 深色 (阅读正文主题另由 reader.theme 控制) */
  appearance: 'system' | 'light' | 'dark'
  reader: ReaderPrefs
  pdf: PdfPrefs
  /** 导入的自定义字体 (桌面端) */
  customFonts: CustomFontRec[]
  /** 用户自行添加的 GitHub 书库仓库 (owner/repo); 社区清单另行远程拉取 */
  /** 自动阅读速度: 秒/页 (EPUB 与 PDF 共用) */
  autoReadSeconds: number
  /** 听书引擎: edge 在线神经音色 / local 本地离线神经音色 / system 系统语音 */
  ttsEngine: 'edge' | 'local' | 'system'
  /** 听书语速 (0.5 - 2) */
  ttsRate: number
  /** 系统语音音色名称, 空为自动匹配 (中文优先) */
  ttsVoice: string
  /** Edge 在线音色 id */
  edgeVoice: string
  /** 本地音色编号 (Kokoro 0-102) */
  localVoiceId: number
  /** Web 端跨域代理模板, {url} 为占位符; 桌面端走原生请求无需代理 */
  corsProxy: string
  /** 桌面端网络代理 (http:// 或 socks5://), 书源请求经此代理 */
  httpProxy: string
  /** 书库存储根目录 (桌面端), 空为默认应用数据目录 */
  libraryRoot: string
  /** AI 助手: 预设 id / 接口地址 / 密钥 / 模型 */
  /** 匿名使用统计 (设置 → 隐私); 默认开启, 可关闭, 见 services/usageStats.ts */
  usageStats: boolean
  aiProvider: string
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  /** 每个服务商独立保存; 当前表单字段仍是活动配置的唯一来源。 */
  aiProfiles: Record<string, AiProviderProfile>
  /** 阅读记录: 每日阅读目标 (分钟), 0 表示不设目标 */
  dailyGoalMinutes: number
  /** 点睛阅读 */
  dianjing: DianjingPrefs
  /** 阅读模式 (打字机等) */
  readingMode: ReadingModePrefs
  /** 背景音 */
  ambient: AmbientPrefs
  /** 语言默认排版配置 (例如 'zh', 'en') */
  typographyLanguages: Record<string, Partial<TypographySettings>>
  /** 单书排版覆盖配置 (bookId -> 局部覆盖) */
  typographyBooks: Record<string, Partial<TypographySettings>>
}

const STORAGE_KEY = 'lightread-settings'

const defaults: SettingsState = {
  version: SETTINGS_VERSION,
  language: 'zh',
  appearance: 'system',
  customFonts: [],
  reader: {
    fontSize: 18,
    lineHeight: 1.8,
    gap: 6,
    theme: 'auto',
    flow: 'paginated',
    maxColumnCount: 2,
    portraitScroll: true,
    continuousScroll: true,
    fontFamily: '',
    justify: true,
    letterSpacing: 0,
    progressDisplay: 'both',
  },
  pdf: {
    renderer: 'mupdf',
    layout: 'original',
    mode: 'scroll',
    fit: 'fitW',
    spreadMode: 'single',
  },
  autoReadSeconds: 15,
  ttsEngine: 'edge',
  ttsRate: 1,
  ttsVoice: '',
  edgeVoice: 'zh-TW-HsiaoChenNeural',
  localVoiceId: 50,
  corsProxy: '',
  httpProxy: '',
  libraryRoot: '',
  usageStats: true,
  aiProvider: 'trial',
  aiBaseUrl: 'https://lightread-ai.jiangshu.ai/v1',
  aiApiKey: '',
  aiModel: 'deepseek-ai/DeepSeek-V4-Flash',
  aiProfiles: {},
  dailyGoalMinutes: 30,
  dianjing: {
    level: 'basic',
    enabled: false,
    consentAll: false,
    perBook: {},
    density: 'normal',
    kinds: { key: true, term: true, note: true, kw: true },
    channel: 'auto',
    fiction: {},
    chapterCard: true,
  },
  readingMode: {
    typewriter: {
      unit: 'char',
      cpm: 300,
      wpm: 200,
      upcoming: 'hidden',
      punctuationPause: true,
      freshInk: true,
      sound: false,
      soundPreset: 'mechanical',
      soundVolume: 0.4,
      pageDwellMs: 800,
    },
    wordGuide: { enabled: false, style: 'auto', strength: 'normal', intensity: 0.7, color: 'rose', mark: BASIC_MARK_DEFAULT },
    largeText: { enabled: false, size: 'large', custom: {} },
    eink: { enabled: false, suggestDismissed: false },
    immersive: { enabled: false, hideFooter: false },
    eyeCare: { theme: 'sepia', dim: 0, reminder: true, intervalMin: 20 },
    night: { schedule: false, from: '22:00', to: '07:00' },
    presets: {},
  },
  ambient: {
    scene: 'rain-study',
    master: 0.3,
    layers: {},
    noiseColor: 'pink',
    duckWithVoice: true,
    duckLevel: 0.25,
    pauseWhenHidden: true,
  },
  typographyLanguages: {},
  typographyBooks: {},
}

/** 默认设置副本，用于恢复与回归测试。 */
export function settingsDefaults(): SettingsState {
  return structuredClone(defaults)
}

/** 阅读模式是嵌套对象: 逐层合并, 以后新增字段时旧存档自动补默认值 */
function mergeReadingMode(saved: unknown): ReadingModePrefs {
  const d = structuredClone(defaults.readingMode)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return d
  const s = saved as Partial<Record<keyof ReadingModePrefs, unknown>>
  const part = <T extends object>(base: T, v: unknown): T =>
    v && typeof v === 'object' && !Array.isArray(v) ? { ...base, ...(v as Partial<T>) } : base
  return {
    typewriter: part(d.typewriter, s.typewriter),
    wordGuide: part(d.wordGuide, s.wordGuide),
    largeText: part(d.largeText, s.largeText),
    eink: part(d.eink, s.eink),
    immersive: part(d.immersive, s.immersive),
    eyeCare: part(d.eyeCare, s.eyeCare),
    night: part(d.night, s.night),
    presets: part(d.presets, s.presets),
  }
}

/**
 * 安装版首次启动按系统语言选界面语言 (中文系统中文, 其余英文); 已有设置的用户不变。
 * macOS/iOS 的 WKWebView 在应用未声明本地化时 navigator.language 常报英文, 不可靠, 仍默认中文;
 * 网页版保持中文默认。
 */
export function systemLanguage(language = globalThis.navigator?.language ?? '', userAgent = globalThis.navigator?.userAgent ?? ''): 'zh' | 'en' | undefined {
  if (!language || /Mac OS X|Macintosh|iPhone|iPad/.test(userAgent)) return undefined
  return /^zh\b/i.test(language) ? 'zh' : 'en'
}

function firstRunDefaults(): SettingsState {
  const fresh = structuredClone(defaults)
  if (isTauri()) fresh.language = systemLanguage() ?? fresh.language
  return fresh
}

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return firstRunDefaults()
    const saved = JSON.parse(raw)
    normalizeRetiredLyricSettings(saved)
    const merged = {
      ...structuredClone(defaults),
      ...saved,
      aiProfiles: normalizeAiProfiles(saved.aiProfiles),
      reader: { ...defaults.reader, ...saved.reader },
      pdf: { ...defaults.pdf, ...saved.pdf },
      typographyLanguages: normalizeTypographyLanguages(saved.typographyLanguages),
      typographyBooks: normalizeTypographyBooks(saved.typographyBooks),
      readingMode: mergeReadingMode(saved.readingMode),
      dianjing: {
        ...structuredClone(defaults.dianjing),
        ...(saved.dianjing && typeof saved.dianjing === 'object' ? saved.dianjing : {}),
        kinds: { ...defaults.dianjing.kinds, ...(saved.dianjing?.kinds ?? {}) },
      },
    }
    if (!['system', 'light', 'dark'].includes(merged.appearance)) merged.appearance = 'system'
    // v2: PDF 阅读默认翻页+适高 (纠正早期版本持久化下来的滚动模式)
    if ((saved.version ?? 1) < 2) {
      merged.pdf.mode = 'paged'
      merged.pdf.fit = 'fitH'
    }
    // v6: 双页布尔值扩展为 Sumatra 风格的单页 / 对页 / 书籍视图。
    if ((saved.version ?? 1) < 6) {
      merged.pdf.spreadMode = saved.pdf?.spread ? 'facing' : 'single'
    }
    // v7: PDF 产品模型回归原版阅读，连续滚动成为默认主模式。
    // 早期版本曾通过迁移强制所有用户使用翻页，因此在此统一纠正一次。
    if ((saved.version ?? 1) < 7) {
      merged.pdf.layout = 'original'
      merged.pdf.mode = 'scroll'
      merged.pdf.fit = 'fitW'
    }
    // v9: 阅读主题默认改为跟随界面外观; 旧默认 light 视为未显式选择, 一并迁入 auto。
    if ((saved.version ?? 1) < 9 && (saved.reader?.theme ?? 'light') === 'light') {
      merged.reader.theme = 'auto'
    }
    // v10: 界面外观默认改为跟随系统; 旧默认 light 视为未显式选择, 一并迁入 system。
    if ((saved.version ?? 1) < 10 && (saved.appearance ?? 'light') === 'light') {
      merged.appearance = 'system'
    }
    // v11: 在线听书默认音色改为台湾腔女声 (曉臻); 仍是旧默认 (晓晓) 的视为未显式选择, 一并迁入。
    if ((saved.version ?? 1) < 11 && (saved.edgeVoice ?? 'zh-CN-XiaoxiaoNeural') === 'zh-CN-XiaoxiaoNeural') {
      merged.edgeVoice = 'zh-TW-HsiaoChenNeural'
    }
    // Preserve saved AI endpoints/models even for pre-v12 settings; switching is explicit.
    // v13: 分明阅读 (原仿生阅读) 默认色改为玫瑰; v1.13.1 写入的旧默认 teal 视为未显式选择, 一并迁入。
    if ((saved.version ?? 1) < 13 && (saved.readingMode?.wordGuide?.color ?? 'teal') === 'teal') {
      merged.readingMode.wordGuide.color = 'rose'
    }
    // v14: 按词着色并入点睛阅读成为基础版, 原点睛阅读为智能版; 按旧存档里在用的功能选版本 (services/dianjing/level.ts)
    if ((saved.version ?? 1) < 14 && saved.dianjing?.level == null) {
      const m = migrateLevel(saved)
      merged.dianjing.level = m.level
      merged.readingMode.wordGuide.enabled = m.wordGuideEnabled
    }
    merged.dianjing.level = normalizeLevel(merged.dianjing.level)
    // 基础版「标什么」: 新增字段, 已有存档保持原来的词与词 (新安装默认重点词); 不需要升版本
    merged.readingMode.wordGuide.mark = savedBasicMark(saved.readingMode?.wordGuide?.mark)
    merged.version = SETTINGS_VERSION
    return merged
  } catch {
    return structuredClone(defaults)
  }
}

export const useSettings = defineStore('settings', {
  state: (): SettingsState => load(),
  actions: {
    selectAiProvider(id: string) {
      const preset = providerById(id)
      if (id === this.aiProvider) return
      const current: AiProviderProfile = {
        baseUrl: this.aiBaseUrl, apiKey: this.aiApiKey, model: this.aiModel,
      }
      const next = this.aiProfiles[id] ?? {
        baseUrl: preset.baseUrl, apiKey: '', model: preset.defaultModel,
      }
      this.$patch({
        aiProfiles: { ...this.aiProfiles, [this.aiProvider]: current },
        aiProvider: id,
        aiBaseUrl: next.baseUrl,
        aiApiKey: next.apiKey,
        aiModel: next.model,
      })
    },
    persistOnChange() {
      let timer: ReturnType<typeof setTimeout> | undefined
      watch(
        () => this.$state,
        state => {
          clearTimeout(timer)
          timer = setTimeout(
            () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)),
            300,
          )
        },
        { deep: true },
      )
    },
    resetReader() {
      this.reader = structuredClone(defaults.reader)
    },
    commitTypography(payload: TypographyApplyPayload) {
      if (!payload.bookId) throw new Error('没有可应用排版的书籍')
      const language = normalizeLanguageTag(payload.language)
      if (payload.scope === 'language' && language === 'und') throw new Error('书籍语言未识别，不能设置语言默认')
      const typographyLanguages = payload.scope === 'language'
        ? setLanguageDefault(this.typographyLanguages, language, payload.settings)
        : this.typographyLanguages
      const typographyBooks = payload.isRestoreAuto || payload.scope === 'language'
        ? removeBookOverride(this.typographyBooks, payload.bookId)
        : setBookOverride(this.typographyBooks, payload.bookId, payload.settings)
      const patch = {
        typographyLanguages,
        typographyBooks,
        reader: { ...this.reader, ...payload.readerPatch },
        readingMode: { ...this.readingMode, eyeCare: { ...this.readingMode.eyeCare, dim: clampNum(payload.dim, 0, DIM_MAX, this.readingMode.eyeCare.dim) } },
      }
      // Persist before acknowledgement: quota denial must leave both maps and the old body usable.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.$state, ...patch }))
      this.$patch(state => { Object.assign(state, patch) })
    },
    setBookTypography(bookId: string, settings: Partial<TypographySettings>) {
      this.typographyBooks = setBookOverride(this.typographyBooks, bookId, settings)
    },
    restoreBookTypography(bookId: string) {
      this.typographyBooks = removeBookOverride(this.typographyBooks, bookId)
    },
    setLanguageTypography(language: string, settings: Partial<TypographySettings>) {
      this.typographyLanguages = setLanguageDefault(this.typographyLanguages, language, settings)
    },
    getEffectiveTypography(bookId?: string, language?: string): ResolvedTypography {
      return resolveEffectiveTypography({
        baseReaderPrefs: this.reader,
        language,
        bookId,
        languagesMap: this.typographyLanguages,
        booksMap: this.typographyBooks,
      })
    },
  },
})
