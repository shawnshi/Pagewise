<script setup lang="ts">
/**
 * TypographyPanel.vue: 事务性 EPUB 排版面板
 *
 * 核心机制:
 *   1. 独立本地草稿 (draft): 调节字号、行距、边距、字体、显示模式不触碰真实 store 与正文。
 *   2. 拟真局部段落预览: 实时呈现字体、字号、行距、对齐、缩进与显示模式 real CSS。
 *   3. 作用域划分: 'book' (仅当前书) vs 'language' (语言默认 + 当前书)，保护其他已有单书覆盖。
 *   4. 显示模式 REAL CSS:
 *      - 自动优化 (optimized): 规范化行距、首行缩进(2em)、两端对齐与 CJK 断词。
 *      - 出版原貌 (publisher): 尽量保留原书样式，不强制对齐与缩进。
 *      - 兼容修复 (repair): 防御性重置异常颜色、微小字号、负边距与横向溢出。
 *   5. 事务性应用回调:
 *      通过 props.onApply 或 emit('apply') 暴露完整 payload，由 ReaderView 执行:
 *      记录锚点 -> 试探应用 -> 等待字体/分页 -> 重定位 -> 成功才提交; 失败保留草稿不关面板。
 *   6. 取消/返回: 无任何副作用，不改变 store/正文。
 *
 * e2e 依赖保持:
 *   - .theme-btn (5 个, 第 3 个护眼绿)
 *   - .seg 按钮文案「翻页」「滚动」
 */
import { computed, nextTick, onMounted, ref, type CSSProperties } from 'vue'
import { t } from '../i18n'
import { useSettings, type ReaderPrefs } from '../stores/settings'
import {
  READER_THEME_CHOICES,
  FONT_FAMILIES,
  resolveReaderColors,
  resolveReaderTheme,
} from '../services/readerTheme'
import {
  getDefaultTypographyForLanguage,
  getSampleParagraph,
  normalizeLanguageTag,
  type ResolvedTypography,
  type TypographyApplyPayload,
  type TypographyDisplayMode,
  type TypographyScope,
  type TypographySettings,
} from '../services/readerTypography'
import { listSystemFonts, importFontFile } from '../services/fonts'
import { isTauri } from '../storage/types'
import { toast } from '../services/toast'
import { DIM_MAX } from '../services/readingModes/eyeCare'
import type { ReadingModes } from '../composables/useReadingModes'

export type TypographySection = 'text' | 'color' | 'layout'

interface Props {
  modes: ReadingModes
  /** 生效的排版方式 (竖屏锁定时为滚动) */
  effectiveFlow: 'paginated' | 'scrolled'
  /** 固定版式 (漫画 / 版式 EPUB) */
  fixedLayout: boolean
  /** 竖屏单栏滚动锁定生效中 */
  portraitLocked: boolean
  /** 打开时滚到这个分区 (从「模式」的「在排版里微调」跳来) */
  focus?: TypographySection | null
  /** 当前书籍 ID (可选, 若缺失则降级为全局/语言设置) */
  bookId?: string
  /** 原书声明或已确认的语言；缺失时不能修改某种语言的默认值。 */
  bookLanguage?: string
  /** 当前书籍标题 (可选, 用于作用域提示) */
  bookTitle?: string
  /** 初始生效排版配置 (可选, 缺失时由 store 解析) */
  initialTypography?: TypographySettings
  /** 外部传入的应用回调 (Promise 成功返回 true 或 { success: true }) */
  applyTypography: (payload: TypographyApplyPayload) => Promise<{ success: boolean; error?: string }>
}

const props = withDefaults(defineProps<Props>(), {
  focus: null,
  bookId: '',
  bookLanguage: '',
  bookTitle: '',
  initialTypography: undefined,
})

const emit = defineEmits<{
  close: []
  /** 打开「模式」面板管理场景 */
  'open-modes': []
  /** 取消排版调整 (无副作用) */
  cancel: []
}>()

const settings = useSettings()
const desktop = isTauri()
const root = ref<HTMLElement>()

// ---- 本地草稿状态 ----
interface LocalDraft {
  displayMode: TypographyDisplayMode
  fontSize: number
  lineHeight: number
  gap: number
  fontFamily: string
  justify: boolean
  letterSpacing: number
  paragraphSpacing: number
  textIndent: number
  // 配色与版式 (保持全功能草稿)
  theme: ReaderPrefs['theme']
  dim: number
  flow: 'paginated' | 'scrolled'
  continuousScroll: boolean
  maxColumnCount: 1 | 2
  portraitScroll: boolean
  progressDisplay: 'both' | 'page' | 'percent'
  // 作用域
  scope: TypographyScope
}

const normLang = computed(() => normalizeLanguageTag(props.bookLanguage))
const initialResolved = ref<ResolvedTypography>(resolveCurrentEffective())

function resolveCurrentEffective(): ResolvedTypography {
  if (props.initialTypography) {
    return {
      displayMode: props.initialTypography.displayMode ?? 'optimized',
      fontSize: props.initialTypography.fontSize ?? settings.reader.fontSize,
      lineHeight: props.initialTypography.lineHeight ?? settings.reader.lineHeight,
      gap: props.initialTypography.gap ?? settings.reader.gap,
      fontFamily: props.initialTypography.fontFamily ?? settings.reader.fontFamily,
      justify: props.initialTypography.justify ?? settings.reader.justify,
      letterSpacing: props.initialTypography.letterSpacing ?? settings.reader.letterSpacing,
      paragraphSpacing: props.initialTypography.paragraphSpacing ?? 0.4,
      textIndent: props.initialTypography.textIndent ?? 2,
      source: props.bookId && settings.typographyBooks[props.bookId] ? 'book' : 'base',
      hasBookOverride: Boolean(props.bookId && settings.typographyBooks[props.bookId]),
      hasLanguageOverride: Boolean(settings.typographyLanguages[normLang.value]),
      appliedLanguage: normLang.value,
      bookId: props.bookId || undefined,
    }
  }
  return settings.getEffectiveTypography(props.bookId, props.bookLanguage)
}

function initDraft(): LocalDraft {
  const eff = resolveCurrentEffective()
  initialResolved.value = eff
  return {
    displayMode: eff.displayMode,
    fontSize: eff.fontSize,
    lineHeight: eff.lineHeight,
    gap: eff.gap,
    fontFamily: eff.fontFamily,
    justify: eff.justify,
    letterSpacing: eff.letterSpacing,
    paragraphSpacing: eff.paragraphSpacing,
    textIndent: eff.textIndent,
    theme: settings.reader.theme,
    dim: settings.readingMode.eyeCare.dim,
    flow: settings.reader.flow,
    continuousScroll: settings.reader.continuousScroll,
    maxColumnCount: settings.reader.maxColumnCount,
    portraitScroll: settings.reader.portraitScroll,
    progressDisplay: settings.reader.progressDisplay,
    scope: props.bookId ? 'book' : 'language',
  }
}

const draft = ref<LocalDraft>(initDraft())

// 记录是否有单书专属覆盖
const hasBookOverride = computed(() => Boolean(props.bookId && settings.typographyBooks[props.bookId]))

// 恢复自动优化预览状态 (非即时删除，先在预览中展示，点击应用才提交)
const isRestoreAutoPreview = ref(false)

// 拟真预览语言切换 (方便对比中英文实际排版效果)
const previewLang = ref<'zh' | 'en'>(normLang.value === 'en' ? 'en' : 'zh')

// 事务中状态
const applying = ref(false)
const applyError = ref('')

// 主题标签
const THEME_LABEL_KEYS: Record<string, string> = {
  light: 'reader.themeLight',
  sepia: 'reader.themeSepia',
  green: 'reader.themeGreen',
  dark: 'reader.themeDark',
  auto: 'reader.themeAuto',
}
const themeLabel = (name: string) => {
  if (settings.readingMode.eink.enabled && name === 'light') return t('reader.einkDay')
  if (settings.readingMode.eink.enabled && name === 'dark') return t('reader.einkNight')
  return THEME_LABEL_KEYS[name] ? t(THEME_LABEL_KEYS[name]) : name
}
const themeChoices = computed(() => READER_THEME_CHOICES.map(choice => {
  const colors = resolveReaderColors(choice.name, isDark.value, { eink: settings.readingMode.eink.enabled })
  return { ...choice, bg: colors.bg, fg: colors.fg }
}))

// 步进控制: 字号 (8..64)
function setFontSize(raw: string | number) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return
  draft.value.fontSize = Math.min(64, Math.max(8, n))
  isRestoreAutoPreview.value = false
}

// 步进控制: 行距 (1.0..3.0)
function setLineHeight(delta: number) {
  const next = Math.round((draft.value.lineHeight + delta) * 10) / 10
  draft.value.lineHeight = Math.min(3.0, Math.max(1.0, next))
  isRestoreAutoPreview.value = false
}

// 步进控制: 边距 (2..20)
function setGap(delta: number) {
  const next = draft.value.gap + delta
  draft.value.gap = Math.min(20, Math.max(2, next))
  isRestoreAutoPreview.value = false
}

// 切换显示模式 (自动优化 / 出版原貌 / 兼容修复)
function setDisplayMode(mode: TypographyDisplayMode) {
  draft.value.displayMode = mode
  isRestoreAutoPreview.value = false
}

// 恢复自动优化 (预览态)
function onPreviewRestoreAuto() {
  const langDef = getDefaultTypographyForLanguage(normLang.value)
  const langOv = settings.typographyLanguages[normLang.value] ?? {}
  const target = {
    ...langDef,
    fontSize: settings.reader.fontSize,
    lineHeight: settings.reader.lineHeight,
    gap: settings.reader.gap,
    fontFamily: settings.reader.fontFamily,
    justify: settings.reader.justify,
    letterSpacing: settings.reader.letterSpacing,
    ...langOv,
  }

  draft.value.displayMode = target.displayMode ?? 'optimized'
  draft.value.fontSize = target.fontSize
  draft.value.lineHeight = target.lineHeight
  draft.value.gap = target.gap
  draft.value.fontFamily = target.fontFamily
  draft.value.justify = target.justify
  draft.value.letterSpacing = target.letterSpacing
  draft.value.paragraphSpacing = target.paragraphSpacing ?? 0.4
  draft.value.textIndent = target.textIndent ?? 2

  isRestoreAutoPreview.value = true
}

// 系统字体
const systemFonts = sharedSystemFonts
async function loadSystemFonts() {
  if (!desktop || systemFonts.value.length || systemFontsLoading) return
  systemFontsLoading = true
  try {
    systemFonts.value = await listSystemFonts()
  } catch {
    /* 忽略枚举失败 */
  } finally {
    systemFontsLoading = false
  }
}

async function importFont() {
  try {
    const font = await importFontFile()
    if (!font) return
    if (!settings.customFonts.some(f => f.file === font.file)) settings.customFonts.push(font)
    draft.value.fontFamily = `custom:${font.name}`
    toast(t('reader.fontImported', { name: font.name }), 'success')
  } catch (e: any) {
    toast(t('reader.fontImportFailed', { msg: e?.message ?? e }), 'error', 5000)
  }
}

function onLetterSpacing(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n)) {
    draft.value.letterSpacing = Math.min(0.5, Math.max(0, Math.round(n * 100) / 100))
    isRestoreAutoPreview.value = false
  }
}

function onDim(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n)) {
    draft.value.dim = Math.min(DIM_MAX, Math.max(0, Math.round(n)))
  }
}

// 场景提示
const sceneNames = computed(() => {
  const names: string[] = []
  if (props.modes.largeTextOn.value) names.push(t('readingMode.modeLargeText'))
  if (props.modes.einkActive.value) names.push(t('readingMode.modeEink'))
  if (props.modes.immersive.value) names.push(t('readingMode.modeImmersive'))
  return names.join(t('reader.sceneSep'))
})

// 折叠记忆
const MORE_KEY = 'lightread-typography-more'
function loadMore(): { text: boolean; layout: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(MORE_KEY) || 'null')
    return { text: !!v?.text, layout: !!v?.layout }
  } catch {
    return { text: false, layout: false }
  }
}
const more = ref(loadMore())
function onMoreToggle(which: 'text' | 'layout', e: Event) {
  more.value = { ...more.value, [which]: (e.target as HTMLDetailsElement).open }
  try {
    localStorage.setItem(MORE_KEY, JSON.stringify(more.value))
  } catch {
    /* ignore */
  }
}

// 拟真预览计算样式
const isDark = computed(() => {
  if (settings.readingMode.eink.enabled) return false
  if (settings.appearance === 'dark') return true
  if (settings.appearance === 'light') return false
  return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches)
})

const previewColors = computed(() => {
  const resolvedTheme = resolveReaderTheme(draft.value.theme, isDark.value)
  return resolveReaderColors(resolvedTheme, isDark.value, props.modes.readerStyle.value)
})

const previewStyles = computed<CSSProperties>(() => {
  const isRepair = draft.value.displayMode === 'repair'
  const isPublisher = draft.value.displayMode === 'publisher'
  return {
    fontSize: `${draft.value.fontSize}px`,
    lineHeight: String(draft.value.lineHeight),
    letterSpacing: `${draft.value.letterSpacing}em`,
    fontFamily: draft.value.fontFamily || 'inherit',
    textAlign: isPublisher ? 'start' : draft.value.justify ? 'justify' : 'start',
    textIndent: isRepair ? '0' : `${draft.value.textIndent}em`,
    padding: `${Math.max(6, Math.round(draft.value.gap * 0.8))}px`,
    backgroundColor: previewColors.value.bg,
    color: previewColors.value.fg,
  }
})

// ---- 事务性保存与取消 ----
function onCancel() {
  if (applying.value) return
  emit('cancel')
  emit('close')
}

async function onApply() {
  if (applying.value) return
  applying.value = true
  applyError.value = ''

  const typographyPayload: TypographySettings = {
    displayMode: draft.value.displayMode,
    fontSize: draft.value.fontSize,
    lineHeight: draft.value.lineHeight,
    gap: draft.value.gap,
    fontFamily: draft.value.fontFamily,
    justify: draft.value.justify,
    letterSpacing: draft.value.letterSpacing,
    paragraphSpacing: draft.value.paragraphSpacing,
    textIndent: draft.value.textIndent,
  }

  const payload: TypographyApplyPayload = {
    bookId: props.bookId || undefined,
    language: normLang.value,
    scope: draft.value.scope,
    settings: typographyPayload,
    previousSettings: {
      displayMode: initialResolved.value.displayMode,
      fontSize: initialResolved.value.fontSize,
      lineHeight: initialResolved.value.lineHeight,
      gap: initialResolved.value.gap,
      fontFamily: initialResolved.value.fontFamily,
      justify: initialResolved.value.justify,
      letterSpacing: initialResolved.value.letterSpacing,
      paragraphSpacing: initialResolved.value.paragraphSpacing,
      textIndent: initialResolved.value.textIndent,
    },
    isRestoreAuto: isRestoreAutoPreview.value,
    readerPatch: {
      theme: draft.value.theme,
      flow: draft.value.flow,
      continuousScroll: draft.value.continuousScroll,
      maxColumnCount: draft.value.maxColumnCount,
      portraitScroll: draft.value.portraitScroll,
      progressDisplay: draft.value.progressDisplay,
    },
    dim: draft.value.dim,
  }

  try {
    const result = await props.applyTypography(payload)
    if (!result.success) throw new Error(result.error || t('reader.typographyFailed'))
    toast(t('reader.typographyApplied'), 'success')
    emit('close')
  } catch (error) {
    applyError.value = error instanceof Error ? error.message : t('reader.typographyFailed')
    toast(applyError.value, 'error')
  } finally {
    applying.value = false
  }
}

onMounted(async () => {
  void loadSystemFonts()
  if (!props.focus) return
  await nextTick()
  root.value?.querySelector<HTMLElement>(`[data-section="${props.focus}"]`)?.scrollIntoView({ block: 'start' })
})
</script>

<script lang="ts">
import { ref as sharedRef } from 'vue'
const sharedSystemFonts = sharedRef<string[]>([])
let systemFontsLoading = false
</script>

<template>
  <section ref="root" class="settings-pop card" role="dialog" :aria-label="t('reader.typography')">
    <header class="tp-head">
      <div class="tp-head-title">
        <strong>{{ t('reader.dockTypography') }}</strong>
        <span class="tp-badge" :title="t('uiV02.copy.\u8BED\u8A00: {v0}', { v0: normLang })">
          {{ normLang === 'zh' ? t("uiV02.copy.\u4E2D\u6587") : normLang.toUpperCase() }} ·
          {{ draft.displayMode === 'optimized' ? t("uiV02.copy.\u4F18\u5316") : draft.displayMode === 'publisher' ? t("uiV02.copy.\u539F\u8C8C") : t("uiV02.copy.\u4FEE\u590D") }}
        </span>
      </div>
      <button class="tp-close" type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="onCancel">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </header>

    <!-- 场景提示 -->
    <p v-if="sceneNames" class="tp-scenes" role="note">
      <span>{{ t('reader.scenesOn', { names: sceneNames }) }}</span>
      <button type="button" class="tp-link" @click="emit('open-modes')">{{ t('reader.manageScenes') }}</button>
    </p>

    <!-- 错误横幅 (应用失败保留草稿) -->
    <div v-if="applyError" class="tp-error-banner" role="alert">
      <span>{{ applyError }}</span>
      <button type="button" class="tp-link-danger" :disabled="applying" @click="onApply">{{ t('common.retry') }}</button>
    </div>

    <!-- 拟真局部段落预览 (草稿状态实时反映) -->
    <section class="tp-preview-section" :aria-label="t('uiV02.copy.排版效果预览')">
      <div class="tp-preview-bar">
        <span class="tp-preview-tag">
          {{ isRestoreAutoPreview ? t("uiV02.copy.\u9884\u89C8\uFF1A\u6062\u590D\u9ED8\u8BA4\uFF08\u672A\u5E94\u7528\uFF09") : hasBookOverride && draft.scope === 'book' ? t("uiV02.copy.\u9884\u89C8\uFF1A\u672C\u4E66\u5B9A\u5236") : t("uiV02.copy.\u9884\u89C8\uFF1A") + (normLang === 'zh' ? t("uiV02.copy.\u4E2D\u6587") : normLang) + t("uiV02.copy.\u6392\u7248") }}
        </span>
        <div class="tp-preview-toggles">
          <button
            type="button"
            class="tp-lang-toggle"
            :class="{ active: previewLang === 'zh' }"
            @click="previewLang = 'zh'"
          >{{ t("uiV02.copy.中") }}</button>
          <button
            type="button"
            class="tp-lang-toggle"
            :class="{ active: previewLang === 'en' }"
            @click="previewLang = 'en'"
          >EN</button>
        </div>
      </div>
      <div class="tp-preview-box" :style="previewStyles">
        <p class="tp-preview-text">{{ getSampleParagraph(previewLang) }}</p>
      </div>
    </section>

    <!-- 显示模式: 自动优化 / 出版原貌 / 兼容修复 (REAL CSS) -->
    <section class="tp-group" data-section="mode" :aria-label="t('uiV02.copy.显示模式')">
      <h3 class="tp-title">{{ t("uiV02.copy.显示模式") }}</h3>
      <div class="seg tp-mode-seg" role="group" :aria-label="t('uiV02.copy.显示模式')">
        <button
          type="button"
          :class="{ active: draft.displayMode === 'optimized' }"
          :aria-pressed="draft.displayMode === 'optimized'"
          @click="setDisplayMode('optimized')"
        >{{ t("uiV02.copy.自动优化") }}</button>
        <button
          type="button"
          :class="{ active: draft.displayMode === 'publisher' }"
          :aria-pressed="draft.displayMode === 'publisher'"
          @click="setDisplayMode('publisher')"
        >{{ t("uiV02.copy.出版原貌") }}</button>
        <button
          type="button"
          :class="{ active: draft.displayMode === 'repair' }"
          :aria-pressed="draft.displayMode === 'repair'"
          @click="setDisplayMode('repair')"
        >{{ t("uiV02.copy.兼容修复") }}</button>
      </div>
      <p class="set-note mode-desc">
        {{ draft.displayMode === 'optimized' ? t("uiV02.copy.\u8C03\u6574\u666E\u901A\u6BB5\u843D\u7684\u884C\u8DDD\u548C\u7F29\u8FDB\uFF0C\u4FDD\u7559\u5217\u8868\u3001\u5F15\u7528\u4E0E\u8868\u683C\u8BED\u4E49\u3002") : draft.displayMode === 'publisher' ? t("uiV02.copy.\u4FDD\u7559\u51FA\u7248\u6BB5\u843D\u4F53\u4F8B\uFF1B\u5B57\u53F7\u548C\u5B57\u4F53\u4ECD\u7531\u5F53\u524D\u9605\u8BFB\u8BBE\u7F6E\u63A7\u5236\u3002") : t("uiV02.copy.\u5C1D\u8BD5\u4FEE\u590D\u5E38\u89C1\u6587\u5B57\u989C\u8272\u3001\u5B57\u53F7\u4E0E\u6A2A\u5411\u6EA2\u51FA\uFF0C\u4E0D\u4FDD\u8BC1\u8986\u76D6\u6240\u6709\u590D\u6742\u51FA\u7248\u6837\u5F0F\u3002") }}
      </p>
    </section>

    <!-- 文字参数调节 (草稿) -->
    <section class="tp-group" data-section="text" :aria-label="t('reader.groupText')">
      <h3 class="tp-title">{{ t('reader.groupText') }}</h3>
      
      <!-- 字号 -->
      <div class="set-row">
        <span class="tp-label">{{ t('reader.fontSize') }}</span>
        <button type="button" class="step-btn" :title="t('reader.fontSmaller')" :aria-label="t('reader.fontSmaller')" @click="setFontSize(draft.fontSize - 1)">A−</button>
        <input v-model.number="draft.fontSize" type="range" min="8" max="64" step="1" :aria-label="t('reader.fontSize')" />
        <button type="button" class="step-btn big" :title="t('reader.fontLarger')" :aria-label="t('reader.fontLarger')" @click="setFontSize(draft.fontSize + 1)">A+</button>
        <span class="tp-unit-val">{{ draft.fontSize }}px</span>
      </div>

      <!-- 行距 -->
      <div class="set-row">
        <span class="tp-label">{{ t('reader.lineHeight') }}</span>
        <button type="button" class="step-btn" :title="t('uiV02.copy.减小行距')" :aria-label="t('uiV02.copy.减小行距')" @click="setLineHeight(-0.1)">−</button>
        <input v-model.number="draft.lineHeight" type="range" min="1.0" max="2.6" step="0.1" :aria-label="t('reader.lineHeight')" />
        <button type="button" class="step-btn" :title="t('uiV02.copy.增加行距')" :aria-label="t('uiV02.copy.增加行距')" @click="setLineHeight(0.1)">+</button>
        <span class="tp-unit-val">{{ draft.lineHeight.toFixed(1) }}</span>
      </div>

      <!-- 边距 -->
      <div class="set-row">
        <span class="tp-label">{{ t('reader.margin') }}</span>
        <button type="button" class="step-btn" :title="t('uiV02.copy.减小边距')" :aria-label="t('uiV02.copy.减小边距')" @click="setGap(-1)">−</button>
        <input v-model.number="draft.gap" type="range" min="2" max="16" step="1" :aria-label="t('reader.margin')" />
        <button type="button" class="step-btn" :title="t('uiV02.copy.增加边距')" :aria-label="t('uiV02.copy.增加边距')" @click="setGap(1)">+</button>
        <span class="tp-unit-val">{{ draft.gap }}%</span>
      </div>

      <!-- 字体 -->
      <div class="set-row">
        <span class="tp-label">{{ t('reader.font') }}</span>
        <select v-model="draft.fontFamily" class="input" :aria-label="t('reader.font')">
          <option v-for="f in FONT_FAMILIES" :key="f.labelKey" :value="f.value">{{ t(f.labelKey) }}</option>
          <optgroup v-if="settings.customFonts.length" :label="t('reader.customFonts')">
            <option v-for="f in settings.customFonts" :key="f.file" :value="`custom:${f.name}`">{{ f.name }}</option>
          </optgroup>
          <optgroup v-if="systemFonts.length" :label="t('reader.systemFonts')">
            <option v-for="name in systemFonts" :key="name" :value="`'${name}'`">{{ name }}</option>
          </optgroup>
        </select>
      </div>

      <details class="tp-more" :open="more.text" @toggle="onMoreToggle('text', $event)">
        <summary>
          <span>{{ t('reader.more') }}</span>
          <svg class="tp-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 9.3a1 1 0 0 1 1.4 0L12 13.58l4.3-4.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.4z"/></svg>
        </summary>
        <div class="tp-more-body">
          <div class="set-row">
            <span class="tp-label">{{ t('reader.letterSpacing') }}</span>
            <input
              type="range"
              min="0"
              max="0.2"
              step="0.01"
              :value="draft.letterSpacing"
              :aria-label="t('reader.letterSpacing')"
              :aria-valuetext="`${draft.letterSpacing.toFixed(2)}em`"
              @input="onLetterSpacing"
            />
            <span class="tp-unit-val">{{ draft.letterSpacing.toFixed(2) }}em</span>
          </div>
          <div class="set-row">
            <span class="tp-label">{{ t('reader.justify') }}</span>
            <div class="seg" role="group" :aria-label="t('reader.justify')">
              <button type="button" :class="{ active: draft.justify }" :aria-pressed="draft.justify" @click="draft.justify = true">{{ t('reader.justifyOn') }}</button>
              <button type="button" :class="{ active: !draft.justify }" :aria-pressed="!draft.justify" @click="draft.justify = false">{{ t('reader.justifyOff') }}</button>
            </div>
          </div>
          <div v-if="desktop" class="set-row">
            <span class="tp-label"></span>
            <button type="button" class="btn btn-sm" @click="importFont">{{ t('reader.importFont') }}</button>
            <span class="font-hint">ttf / otf / woff2</span>
          </div>
        </div>
      </details>
    </section>

    <!-- 配色 -->
    <section class="tp-group" data-section="color" :aria-label="t('reader.groupColor')">
      <h3 class="tp-title">{{ t('reader.groupColor') }}</h3>
      <div class="set-row">
        <span class="tp-label">{{ t('reader.theme') }}</span>
        <div class="theme-btns" role="group" :aria-label="t('reader.theme')">
          <button
            v-for="choice in themeChoices"
            :key="choice.name"
            type="button"
            class="theme-btn"
            :class="{ active: draft.theme === choice.name }"
            :style="{ background: choice.bg, color: choice.fg }"
            :title="themeLabel(choice.name)"
            :aria-label="themeLabel(choice.name)"
            :aria-pressed="draft.theme === choice.name"
            @click="draft.theme = choice.name"
          ><span><span v-if="draft.theme === choice.name" aria-hidden="true">✓ </span>{{ t('reader.themeSample') }}</span><span>{{ themeLabel(choice.name) }}</span></button>
        </div>
      </div>
      <div class="set-row">
        <span class="tp-label">{{ t('reader.dim') }}</span>
        <input
          type="range"
          min="0"
          :max="DIM_MAX"
          step="5"
          :value="draft.dim"
          :disabled="settings.readingMode.eink.enabled"
          :aria-label="t('reader.dim')"
          :aria-valuetext="`${draft.dim}%`"
          @input="onDim"
        />
        <span class="tp-unit-val">{{ draft.dim }}%</span>
      </div>
      <p v-if="modes.einkActive.value" class="set-note" role="note">{{ t('reader.einkColorNote') }}</p>
    </section>

    <!-- 版式 -->
    <section class="tp-group" data-section="layout" :aria-label="t('reader.groupLayout')">
      <h3 class="tp-title">{{ t('reader.groupLayout') }}</h3>
      <div class="set-row">
        <span class="tp-label">{{ t('reader.flow') }}</span>
        <div class="seg" role="group" :aria-label="t('reader.flow')">
          <button type="button" :class="{ active: draft.flow === 'paginated' }" :aria-pressed="draft.flow === 'paginated'" @click="draft.flow = 'paginated'">{{ t('reader.paginated') }}</button>
          <button type="button" :class="{ active: draft.flow === 'scrolled' }" :aria-pressed="draft.flow === 'scrolled'" @click="draft.flow = 'scrolled'">{{ t('reader.scrolled') }}</button>
        </div>
      </div>
      <p v-if="portraitLocked" class="set-note" role="note">{{ t('reader.portraitLockedNote') }}</p>
      <template v-if="effectiveFlow === 'scrolled' && !fixedLayout">
        <div class="set-row">
          <span class="tp-label" :title="t('reader.continuousScrollTitle')">{{ t('reader.continuousScroll') }}</span>
          <div class="seg" role="group" :aria-label="t('reader.continuousScroll')" :title="t('reader.continuousScrollTitle')">
            <button type="button" :class="{ active: draft.continuousScroll }" :aria-pressed="draft.continuousScroll" @click="draft.continuousScroll = true">{{ t('reader.continuousScrollOn') }}</button>
            <button type="button" :class="{ active: !draft.continuousScroll }" :aria-pressed="!draft.continuousScroll" @click="draft.continuousScroll = false">{{ t('reader.continuousScrollOff') }}</button>
          </div>
        </div>
        <p v-if="draft.continuousScroll" class="set-note" role="note">{{ t('reader.continuousScrollNote') }}</p>
      </template>
      <template v-if="draft.flow === 'paginated'">
        <div class="set-row">
          <span class="tp-label">{{ t('reader.columns') }}</span>
          <div class="seg" role="group" :aria-label="t('reader.columns')">
            <button type="button" :class="{ active: draft.maxColumnCount === 1 }" :aria-pressed="draft.maxColumnCount === 1" @click="draft.maxColumnCount = 1">{{ t('reader.singleColumn') }}</button>
            <button type="button" :class="{ active: draft.maxColumnCount === 2 }" :aria-pressed="draft.maxColumnCount === 2" @click="draft.maxColumnCount = 2">{{ t('reader.autoTwoColumns') }}</button>
          </div>
        </div>
        <p v-if="modes.forceSingleColumn.value && draft.maxColumnCount === 2" class="set-note" role="note">{{ t('reader.forcedSingleColumn') }}</p>
      </template>
      <details class="tp-more" :open="more.layout" @toggle="onMoreToggle('layout', $event)">
        <summary>
          <span>{{ t('reader.more') }}</span>
          <svg class="tp-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 9.3a1 1 0 0 1 1.4 0L12 13.58l4.3-4.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.4z"/></svg>
        </summary>
        <div class="tp-more-body">
          <div class="set-row">
            <span class="tp-label" :title="t('reader.portraitScrollTitle')">{{ t('reader.portrait') }}</span>
            <div class="seg" role="group" :aria-label="t('reader.portraitScrollMenu')" :title="t('reader.portraitScrollTitle')">
              <button type="button" :class="{ active: draft.portraitScroll }" :aria-pressed="draft.portraitScroll" @click="draft.portraitScroll = true">{{ t('reader.portraitScrollOn') }}</button>
              <button type="button" :class="{ active: !draft.portraitScroll }" :aria-pressed="!draft.portraitScroll" @click="draft.portraitScroll = false">{{ t('reader.portraitScrollOff') }}</button>
            </div>
          </div>
          <div class="set-row">
            <span class="tp-label">{{ t('reader.progressDisplay') }}</span>
            <div class="seg" role="group" :aria-label="t('reader.progressDisplay')">
              <button type="button" :class="{ active: draft.progressDisplay === 'both' }" :aria-pressed="draft.progressDisplay === 'both'" @click="draft.progressDisplay = 'both'">{{ t('reader.progressBoth') }}</button>
              <button type="button" :class="{ active: draft.progressDisplay === 'page' }" :aria-pressed="draft.progressDisplay === 'page'" @click="draft.progressDisplay = 'page'">{{ t('reader.progressPage') }}</button>
              <button type="button" :class="{ active: draft.progressDisplay === 'percent' }" :aria-pressed="draft.progressDisplay === 'percent'" @click="draft.progressDisplay = 'percent'">{{ t('reader.progressPercent') }}</button>
            </div>
          </div>
        </div>
      </details>
    </section>

    <!-- 作用域与底部事务性操作栏 -->
    <footer class="tp-footer">
      <div v-if="props.bookId" class="tp-scope-row">
        <span class="tp-scope-label">{{ t("uiV02.copy.生效范围:") }}</span>
        <div class="seg tp-scope-seg" role="group" :aria-label="t('uiV02.copy.排版生效范围')">
          <button
            type="button"
            :class="{ active: draft.scope === 'book' }"
            :aria-pressed="draft.scope === 'book'"
            @click="draft.scope = 'book'"
          >{{ t("uiV02.copy.仅本书") }}</button>
          <button
            type="button"
            :class="{ active: draft.scope === 'language' }"
            :aria-pressed="draft.scope === 'language'"
            :disabled="normLang === 'und' || applying"
            @click="draft.scope = 'language'"
          >{{ normLang === 'zh' ? t("uiV02.copy.\u4E2D\u6587\u9ED8\u8BA4") : normLang.toUpperCase() + t("uiV02.copy. \u9ED8\u8BA4") }}</button>
        </div>
      </div>
      <p v-if="props.bookId" class="tp-scope-hint">
        {{ draft.scope === 'book' ? t("uiV02.copy.\u4EC5\u6539\u53D8\u672C\u4E66\u6392\u7248\uFF0C\u5176\u4ED6\u4E66\u7C4D\u4FDD\u7559\u5404\u81EA\u4E13\u5C5E\u8BBE\u7F6E\u3002") : t("uiV02.copy.\u4F5C\u4E3A{v0}\u4E66\u7C4D\u7684\u9ED8\u8BA4\u6392\u7248\u5E76\u5E94\u7528\u5230\u672C\u4E66\uFF1B\u5176\u4ED6\u4E66\u5DF2\u6709\u4E13\u5C5E\u8BBE\u7F6E\u4E0D\u53D7\u5F71\u54CD\u3002", { v0: normLang === 'zh' ? t("uiV02.copy.\u4E2D\u6587") : normLang }) }}
      </p>

      <p class="tp-scope-hint">{{ t("uiV02.copy.主题、滚动与分栏属于通用阅读设置；正文排版按上方范围保存。未知语言不能设置语言默认。") }}</p>
      <div class="tp-actions">
        <button
          v-if="hasBookOverride"
          type="button"
          class="btn btn-sm tp-btn-restore"
          :disabled="applying"
          :title="t('uiV02.copy.预览恢复为语言默认')"
          @click="onPreviewRestoreAuto"
        >{{ t("uiV02.copy.恢复默认") }}</button>
        <button
          type="button"
          class="btn btn-sm tp-btn-cancel"
          :disabled="applying"
          @click="onCancel"
        >{{ t("uiV02.copy.取消") }}</button>
        <button
          type="button"
          class="btn btn-sm btn-primary tp-btn-apply"
          :disabled="applying"
          @click="onApply"
        >
          {{ applying ? t("uiV02.copy.\u6B63\u5728\u5E94\u7528\u2026") : draft.scope === 'book' ? t("uiV02.copy.\u5E94\u7528\u5230\u672C\u4E66") : t("uiV02.copy.\u5E94\u7528\u5230\u9ED8\u8BA4\u4E0E\u672C\u4E66") }}
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.settings-pop {
  position: absolute;
  top: calc(52px + var(--safe-top, 0px));
  right: 12px;
  z-index: 25;
  width: min(420px, calc(100% - 24px));
  max-height: calc(100% - 72px - var(--safe-top, 0px) - var(--safe-bottom, 0px));
  overflow-y: auto;
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
}
.tp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tp-head-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tp-head strong {
  font-size: 15px;
}
.tp-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
}
.tp-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.tp-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.tp-scenes {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--brand-light);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tp-scenes span {
  flex: 1;
  min-width: 0;
}
.tp-link {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 2px 4px;
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.tp-link:hover {
  text-decoration: underline;
}
.tp-error-banner {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--danger-light, #fee2e2);
  color: var(--danger, #b91c1c);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tp-link-danger {
  border: none;
  background: none;
  color: var(--danger, #b91c1c);
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

/* 拟真预览区域 */
.tp-preview-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.tp-preview-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}
.tp-preview-tag {
  color: var(--text-2);
  font-weight: 500;
}
.tp-preview-toggles {
  display: flex;
  gap: 4px;
}
.tp-lang-toggle {
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-3);
  font-size: 11px;
  border-radius: 3px;
  padding: 1px 6px;
  cursor: pointer;
}
.tp-lang-toggle.active {
  background: var(--brand-light);
  color: var(--brand);
  border-color: var(--brand);
  font-weight: 600;
}
.tp-preview-box {
  border-radius: 4px;
  border: 1px solid var(--border);
  min-height: 84px;
  max-height: 140px;
  overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
}
.tp-preview-text {
  margin: 0;
  hyphens: auto;
  -webkit-hyphens: auto;
  word-break: break-word;
}

.tp-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  scroll-margin-top: 8px;
}
.tp-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.set-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}
.tp-label {
  width: 44px;
  flex-shrink: 0;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.set-row input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.tp-unit-val {
  width: 52px;
  flex-shrink: 0;
  text-align: right;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.set-row select.input {
  flex: 1;
  min-width: 0;
  height: 32px;
}
.set-note {
  margin: -4px 0 0 52px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-3);
}
.mode-desc {
  margin: 0;
}
.font-hint {
  font-size: 12px;
  color: var(--text-3);
}
.theme-btns {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.theme-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 76px;
  min-height: 64px;
  padding: 6px;
  flex-shrink: 0;
  border-radius: 4px;
  border: 2px solid var(--border);
  font-size: 14px;
  cursor: pointer;
}
.theme-btn.active {
  border-color: currentColor;
  outline: 2px solid currentColor;
  outline-offset: -3px;
}
.seg {
  display: flex;
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.seg button {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 4px;
  border: none;
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.seg button + button {
  border-left: 1px solid var(--border);
}
.seg button.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.step-btn {
  flex-shrink: 0;
  width: 32px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.step-btn.big {
  font-size: 14px;
}
.step-btn:hover {
  color: var(--brand);
  border-color: var(--brand);
}
.step-btn:active {
  background: var(--brand-light);
  color: var(--brand);
}
.tp-more {
  margin-top: -4px;
}
.tp-more summary {
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  min-height: 28px;
  padding-left: 52px;
  list-style: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-3);
  user-select: none;
}
.tp-more summary::-webkit-details-marker {
  display: none;
}
.tp-more summary:hover {
  color: var(--brand);
}
.tp-chev {
  transition: transform var(--dur) var(--ease);
}
.tp-more[open] .tp-chev {
  transform: rotate(180deg);
}
.tp-more-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 8px;
}

/* 底部操作与范围 */
.tp-footer {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tp-scope-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.tp-scope-label {
  color: var(--text-2);
  font-weight: 500;
  width: 56px;
  flex-shrink: 0;
}
.tp-scope-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-3);
}
.tp-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.tp-btn-restore {
  margin-right: auto;
  color: var(--text-3);
}
.tp-btn-restore:hover {
  color: var(--brand);
}
.tp-btn-cancel {
  min-width: 60px;
}
.tp-btn-apply {
  min-width: 100px;
  font-weight: 600;
}

.tp-close:focus-visible,
.tp-link:focus-visible,
.tp-more summary:focus-visible,
.seg button:focus-visible,
.step-btn:focus-visible,
.theme-btn:focus-visible,
.tp-lang-toggle:focus-visible,
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.seg button:focus-visible {
  position: relative;
  z-index: 1;
}

/* 触屏交互 */
@media (pointer: coarse) {
  .tp-close {
    width: 44px;
    height: 44px;
    margin: -6px -8px -6px 0;
  }
  .seg button,
  .step-btn {
    height: 44px;
  }
  .step-btn {
    width: 44px;
  }
  .set-row select.input {
    height: 44px;
  }
  .theme-btn {
    width: 44px;
    height: 44px;
  }
  .tp-more summary {
    min-height: 40px;
  }
  .tp-actions .btn {
    min-height: 40px;
  }
}

/* 移动端抽屉 */
@media (max-width: 600px) {
  .settings-pop {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 85%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right, 0px)) calc(16px + var(--safe-bottom, 0px)) max(16px, var(--lr-safe-left, 0px));
    box-shadow: var(--shadow-lg);
    gap: 12px;
    animation: tp-sheet-up var(--dur-slow) var(--ease);
  }
  .settings-pop::before {
    content: '';
    position: absolute;
    top: 7px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .set-row {
    font-size: 14px;
  }
  .theme-btns {
    justify-content: space-between;
  }
}
@keyframes tp-sheet-up {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .settings-pop,
  .tp-chev {
    animation: none;
    transition: none;
  }
}
</style>
