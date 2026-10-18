/**
 * 阅读模式与 ReaderView 的对接层 (docs/reading-modes.md, docs/research/reading-modes-landscape.md §4–§6)。
 * 逻辑全部在这里和 services/readingModes/*, ReaderView 只做接线。
 *
 * 模式 (一个名字一个模式): 场景 = 夜读 / 护眼 / 墨水屏 / 大字 / 沉浸 (一键套用一组排版值, 关闭恢复;
 * 值本身只在「排版」面板里调, 见 docs/reader-panels.md);
 * 带读 = 自动翻页 / 打字机 / 听书 (同一时刻只运行一个);
 * 按词着色 = 点睛阅读基础版 (开关在点睛阅读里, 绘制在这里)。
 *
 * ## 接线清单 (ReaderView.vue)
 *
 * ```ts
 * const modes = useReadingModes({
 *   getView: () => view,
 *   getColors: () => themeColors.value,
 *   pingReadingAuto,
 *   appDark: () => appDark.value,
 *   onExclusiveStart: () => { stopAutoRead(); if (ttsState.value === 'playing') pauseTTS() },
 *   isAutoReading: () => autoReading.value,
 *   isTTSActive: () => ttsState.value === 'playing',
 *   pauseWhen: () => panel.value !== 'none' || settingsOpen.value || ttsPanel.value || jumpOpen.value || !!activeAnnotation.value,
 *   beforePanelOpen: closeOverlays,
 *   onImmersiveChange: on => { setSystemBarsHidden(on); setKeepScreenOn(on); if (on) hideBars() },  // 原生部分由主会话实现
 *   refreshMarginals: updateMarginals,
 *   onReminder: () => { stopAutoRead() },           // 休息提醒出现时打字机已自动暂停
 * })
 * (按词着色是点睛阅读的基础版: 开关由 useDianjing 统一管理 (传入 basic: { isOn, set, supported }),
 *  这里只在 settings.dianjing.level 为 basic 时绘制, 与智能版天然互斥。)
 * ```
 *
 * 1. applyPrefs():
 *    - `view.renderer.setAttribute('max-column-count', String(modes.forceSingleColumn.value ? 1 : prefs.maxColumnCount))`
 *      (大字运行时强制单栏, 不改用户的双栏设置);
 *    - 墨水屏去掉翻页动画: `modes.einkActive.value ? r.removeAttribute('animated') : r.setAttribute('animated', '')`;
 *    - `getReaderCSS(prefsWithFont, appDark.value, modes.readerStyle.value)`;
 *    - themeColors 改为 `resolveReaderColors(settings.reader.theme, appDark.value, modes.readerStyle.value)` (墨水屏纯黑白);
 *    - 重排 watch 加上 `() => modes.renderKey.value`: `watch([() => settings.reader, appDark, () => modes.renderKey.value], …)`。
 * 2. onRelocate(e): 开头 `modes.onRelocate(e.detail)`; 计时
 *    `if (ttsState.value === 'playing' || modes.progressActive.value) pingReadingAuto() else pingReading()`;
 *    沉浸时不要因 relocate 呼出工具栏。
 * 3. onSectionLoad(e): 开头 `modes.onSectionLoad(e.detail)`。
 * 4. onContentClick(clientX, doc, target, clientY): 选区 / 链接判断之后
 *    `const tap = modes.onContentTap(); if (tap) { tap === 'paused' ? showBars() : hideBars(); return }`
 * 5. handleKeydown: 输入框判断之后第一行 `if (modes.handleKey(e)) return`
 *    (M 面板; Shift+T 打字机; 运行中 空格 / 方向键 / Shift+↑↓ / Esc)。
 * 6. startAutoRead() 开头 `modes.stopForExternal('auto')`; startTTS() 开头 `modes.stopForExternal('tts')`
 *    (旧名 stopTypewriterFor 仍可用)。
 * 8. 入口 / 面板 / 迷你条 / 外层 (模板):
 *    <div class="reader" :class="[{ 'bars-on': barsVisible }, modes.shellClass.value]">
 *    <ReadingModePanel v-if="modes.panelOpen.value" :modes="modes" :progress="readingModeProgress"
 *      :auto-reading="autoReading" :tts-active="ttsState === 'playing'" v-model:auto-read-seconds="settings.autoReadSeconds"
 *      @start-auto="startAutoRead" @stop-auto="stopAutoRead" @open-tts="openTTSPanel" @close="modes.closePanel()">
 *      <template #top><DianjingToggle … /></template>
 *    </ReadingModePanel>
 *    <ReadingModeMini :modes="modes" :bars-visible="barsVisible" :progress="readingModeProgress" />
 *    <ReadingModeLayer :modes="modes" />   (调暗遮罩、休息提醒、全局模式样式)
 *    readingModeProgress = 原 typewriterProgress, 条件改为 `modes.progressActive.value`;
 *    按钮 active = `modes.panelOpen.value || autoReading.value || modes.progressActive.value`。
 * 9. updateMarginals(): 按 `modes.marginalsPolicy.value` 取舍 —— head=false 时页眉不写章名, footLeft=false 时不写本章剩余,
 *    footRight=false 时页脚整条留空 (沉浸 + 隐藏页码)。
 * 10. 大字: `modes.largeUi.value` 时 (shellClass 已带 lr-large-ui, 工具栏按钮放大到 60px) 可把左 1/3 设为上一页、
 *    右 2/3 为下一页 (§6.4, 可选)。
 * 11. 墨水屏提示 (可选): `modes.einkSuggested.value` 时提示一次「要开启墨水屏吗？」, 同意调 `modes.toggleEink()`,
 *    不论选什么都调 `modes.dismissEinkSuggestion()`。
 * 12. onBeforeUnmount: `modes.dispose()` (清除所有阅读模式高亮、沉浸回调 false)。
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { toast } from '../services/toast'
import type { ReaderModeStyle, ReaderThemeColors } from '../services/readerTheme'
import {
  adjustSpeed as stepSpeed,
  clampSpeed,
  soundEvery,
  speedPresets,
  speedRange,
  type Script,
} from '../services/readingModes/pacing'
import { TypewriterController, type TypewriterConfig, type TypewriterHost, type TypewriterState } from '../services/readingModes/typewriter'
import { HL_GHOST, HL_HIDDEN, READING_MODE_PREFIXES, clearReadingModeMarks, supportsHighlights } from '../services/readingModes/revealLayer'
import { createTypingSound, type TypingSound } from '../services/readingModes/sound'
import {
  einkValues,
  engagePreset,
  holderOf,
  isEyeCareTheme,
  isNightTheme,
  largeTextValues,
  looksLikeEinkDevice,
  releasePreset,
  sameValue,
  themeAfterRelease,
  type PresetValues,
  type ThemeName,
} from '../services/readingModes/presets'
import {
  afterReminder,
  clampDim,
  dimBackground,
  inNightWindow,
  minutesOfDay,
  newBreakTimer,
  nightScheduleAction,
  noteActivity as noteBreakActivity,
  reminderDue as isReminderDue,
} from '../services/readingModes/eyeCare'
import { WordGuideLayer } from '../services/readingModes/wordGuideLayer'
import { guideIntensity } from '../services/readingModes/wordGuideIntensity'
import { normalizeLevel, smartOnFor } from '../services/dianjing/level'
import { KeyWordLayer, looksChinese, type KwSmartInput } from '../services/readingModes/keyWordsLayer'
import { disposeKeyWordService, keyWordService, type KwBookHost } from '../services/readingModes/keyWordsClient'
import type { KwLevel } from '../services/readingModes/keyWords'

/**
 * 「重点词」的数据来源 (由阅读器在点睛阅读接好后设置, 见 setKeyWordSource):
 * 书 id 与分节 (后台全书统计)、体裁 (小说不剧透)、智能版的 AI 词与分块。
 */
export interface KeyWordSource extends KwBookHost {
  bookId: string
  /** 小说等叙事作品: 关键度只用读到当前章为止的文本 */
  fiction(): boolean
  /** 智能版: 本节的 AI 词与分块; 还没有时返回 null (先全用离线结果) */
  smart(doc: Document, section: number): KwSmartInput | null
  /** 选词结果到了 (使用统计) */
  onPicked?(info: { section: number; aiChunks: number; chunks: number; ms: number }): void
}

/** 「带读」分段: 自动翻页 / 打字机 / 听书 */
export type ReadingModeTab = 'auto' | 'typewriter' | 'tts'
export type GuideKind = 'typewriter'
export type { TypewriterState }

export interface UseReadingModesOptions {
  /** foliate-view 元素 */
  getView: () => any
  /** 当前正文主题颜色 (回退遮罩用) */
  getColors: () => ReaderThemeColors
  /** 自动推进的阅读计时 (与听书同口径) */
  pingReadingAuto: () => void
  /** 界面是否为深色外观 (正文主题 auto 时夜间开关的判定) */
  appDark?: () => boolean
  presentationSuppressed?: () => boolean
  /** 打字机开始前调用: 停止自动翻页、暂停听书 */
  onExclusiveStart?: () => void
  isAutoReading?: () => boolean
  isTTSActive?: () => boolean
  /** 返回 true 时 (面板、浮层、脚注弹层打开) 自动暂停 */
  pauseWhen?: () => boolean
  /** 自动翻页的动作, 默认 view.next() (方向随书, RTL 书也正确) */
  nextPage?: () => unknown
  /** 面板打开前调用 (收起其他浮层, 保持同一时间只开一个) */
  beforePanelOpen?: () => void
  /** 沉浸开关变化 (含 setup 时已开启 → true、dispose → false): 阅读器隐藏系统栏、屏幕常亮 */
  onImmersiveChange?: (on: boolean) => void
  /** 页眉页脚要按 marginalsPolicy 重画 */
  refreshMarginals?: () => void
  /** 20-20-20 休息提醒出现 (打字机已自动暂停; 阅读器可暂停自动翻页) */
  onReminder?: () => void
}

const REDUCED_DEFAULT_KEY = 'lightread-reading-mode-reduced-default'
/** 调暗改为对所有主题生效 (docs/reader-panels.md §4): 一次性清掉此前在非暖色主题下看不到的调暗值 */
const DIM_GENERAL_KEY = 'lightread-dim-general'
const ACTIVITY_THROTTLE_MS = 10000
const REMINDER_CHECK_MS = 30000

export function useReadingModes(opts: UseReadingModesOptions) {
  const settings = useSettings()
  const tw = computed(() => settings.readingMode.typewriter)
  const appDark = () => !!opts.appDark?.()

  const panelOpen = ref(false)
  const panelTab = ref<ReadingModeTab>('typewriter')
  const typewriterState = ref<TypewriterState>('idle')
  const typewriterActive = computed(() => typewriterState.value !== 'idle')
  /** 书的主文字: 决定速度单位 (字/分 或 词/分) */
  const bookScript = ref<Script>('cjk')
  /** 固定版式 EPUB 不支持打字机 / 按词着色 */
  const supported = ref(true)
  const reducedMotion = ref(false)

  const speedUnit = computed<'cpm' | 'wpm'>(() => (bookScript.value === 'cjk' ? 'cpm' : 'wpm'))
  const speedLimits = computed(() => speedRange(bookScript.value))
  const presets = computed(() => speedPresets(bookScript.value))
  const speed = computed<number>({
    get: () => (speedUnit.value === 'cpm' ? tw.value.cpm : tw.value.wpm),
    set: v => {
      const n = clampSpeed(v, bookScript.value)
      if (speedUnit.value === 'cpm') settings.readingMode.typewriter.cpm = n
      else settings.readingMode.typewriter.wpm = n
    },
  })
  const speedText = computed(() => t(speedUnit.value === 'cpm' ? 'readingMode.cpm' : 'readingMode.wpm', { n: speed.value }))

  // ---- 系统「减少动态效果」: 翻页停顿延长; 首次使用时默认粒度改为逐句 (画面跳动更少) ----
  let motionQuery: MediaQueryList | null = null
  const onMotionChange = () => { reducedMotion.value = !!motionQuery?.matches }
  try {
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    onMotionChange()
    motionQuery?.addEventListener?.('change', onMotionChange)
    if (reducedMotion.value && localStorage.getItem(REDUCED_DEFAULT_KEY) !== '1') {
      if (settings.readingMode.typewriter.unit === 'char') settings.readingMode.typewriter.unit = 'sentence'
      localStorage.setItem(REDUCED_DEFAULT_KEY, '1')
    }
  } catch { /* 存储或 matchMedia 不可用 */ }

  // =====================================================================
  // 预设 (夜间 / 护眼 / 墨水屏 / 大字): 快照与恢复, 见 services/readingModes/presets.ts
  // =====================================================================

  const read = (key: string): unknown => {
    const [ns, k] = key.split('.')
    if (ns === 'reader') return (settings.reader as any)[k]
    if (ns === 'typewriter') return (settings.readingMode.typewriter as any)[k]
    return undefined
  }
  const write = (vals: PresetValues) => {
    for (const [key, v] of Object.entries(vals)) {
      const [ns, k] = key.split('.')
      const target: any = ns === 'reader' ? settings.reader : ns === 'typewriter' ? settings.readingMode.typewriter : null
      if (target && !sameValue(target[k], v)) target[k] = v
    }
  }
  /** 开启预设; 返回是否真的改了设置 */
  function engage(id: string, values: PresetValues): boolean {
    const { records, writes } = engagePreset(settings.readingMode.presets as any, id, values, read)
    const changed = Object.entries(writes).some(([k, v]) => !sameValue(read(k), v))
    write(writes)
    settings.readingMode.presets = records as any
    return changed
  }
  function release(id: string): PresetValues {
    if (!settings.readingMode.presets[id]) return {}
    const { records, writes, custom } = releasePreset(settings.readingMode.presets as any, id, read)
    write(writes)
    settings.readingMode.presets = records as any
    return custom
  }

  // ---- 夜间 (手动开为预设 night, 定时开为 nightAuto: 离开时间段时只关定时开的那个, 重启后也认得) ----
  const theme = computed(() => settings.reader.theme as ThemeName)
  const nightOn = computed(() => isNightTheme(theme.value, appDark()))

  function setNight(on: boolean, by: 'user' | 'schedule' = 'user') {
    if (on === nightOn.value) return
    if (on) {
      engage(by === 'schedule' ? 'nightAuto' : 'night', { 'reader.theme': 'dark' })
      return
    }
    for (const id of ['nightAuto', 'night']) {
      if (settings.readingMode.presets[id] && theme.value === 'dark') release(id)
    }
    if (isNightTheme(theme.value, appDark())) settings.reader.theme = themeAfterRelease(theme.value, 'night', appDark())
  }
  function toggleNight() { setNight(!nightOn.value) }

  // ---- 护眼: 暖色主题 + 休息提醒 (调暗是排版里的通用值, 见下方 dimLevel) ----
  const eyeCareOn = computed(() => isEyeCareTheme(theme.value))
  function setEyeCare(on: boolean) {
    if (on === eyeCareOn.value) return
    if (on) {
      engage('eyeCare', { 'reader.theme': settings.readingMode.eyeCare.theme })
      breakTimer = newBreakTimer(Date.now())
      return
    }
    if (settings.readingMode.presets.eyeCare && isEyeCareTheme(theme.value)) release('eyeCare')
    if (isEyeCareTheme(theme.value)) settings.reader.theme = themeAfterRelease(theme.value, 'eyeCare', appDark())
    reminderDue.value = false
  }
  function toggleEyeCare() { setEyeCare(!eyeCareOn.value) }
  function setEyeCareTheme(v: 'sepia' | 'green') {
    settings.readingMode.eyeCare.theme = v
    if (eyeCareOn.value) engage('eyeCare', { 'reader.theme': v })
  }

  // 用户在设置里直接换了主题: 夜间 / 护眼的快照不再适用, 丢掉 (下次开关从当时的主题记起)
  watch(theme, th => {
    // 护眼的底色就是排版里最后选的暖色主题 (不再单独选一份)
    if (isEyeCareTheme(th)) settings.readingMode.eyeCare.theme = th as 'sepia' | 'green'
    for (const id of ['night', 'nightAuto', 'eyeCare']) {
      const cur = settings.readingMode.presets
      const rec = cur[id]
      if (rec && holderOf(cur as any, 'reader.theme') === id && th !== rec.applied['reader.theme']) {
        const next = { ...cur }
        delete next[id]
        settings.readingMode.presets = next
      }
    }
  })

  // 调暗是排版「配色」里的通用值, 对所有主题生效 (原先只在护眼时生效)。
  // 迁移一次: 当时不是暖色主题而调暗 > 0 的, 原本看不到效果, 清零以免老用户突然变暗
  try {
    if (localStorage.getItem(DIM_GENERAL_KEY) !== '1') {
      if (!eyeCareOn.value && settings.readingMode.eyeCare.dim > 0) settings.readingMode.eyeCare.dim = 0
      localStorage.setItem(DIM_GENERAL_KEY, '1')
    }
  } catch { /* 存储不可用: 不迁移 */ }
  const dimLevel = computed(() => clampDim(settings.readingMode.eyeCare.dim))
  /** 调暗遮罩 (阅读器正文之上, pointer-events:none); 0 时为 null */
  const dimOverlayStyle = computed(() => {
    if (opts.presentationSuppressed?.() || settings.readingMode.eink.enabled) return null
    const bg = dimBackground(dimLevel.value)
    return bg ? { background: bg } : null
  })

  // ---- 墨水屏 ----
  const einkActive = computed(() => !!settings.readingMode.eink.enabled)
  function setEink(on: boolean) {
    if (on === einkActive.value) return
    if (on) {
      settings.readingMode.eink.enabled = true
      engage('eink', einkValues(read))
    } else {
      release('eink')
      settings.readingMode.eink.enabled = false
    }
    settings.readingMode.eink.suggestDismissed = true
  }
  function toggleEink() { setEink(!einkActive.value) }
  const einkDevice = (() => {
    try {
      return looksLikeEinkDevice(navigator.userAgent, {
        update: window.matchMedia?.('(update: slow)')?.matches ? 'slow' : undefined,
        monochrome: !!window.matchMedia?.('(monochrome)')?.matches,
      })
    } catch {
      return false
    }
  })()
  /** 识别到墨水屏设备且用户还没处理过: 阅读器可提示一次「要开启墨水屏吗？」 */
  const einkSuggested = computed(() => einkDevice && !settings.readingMode.eink.enabled && !settings.readingMode.eink.suggestDismissed)
  function dismissEinkSuggestion() { settings.readingMode.eink.suggestDismissed = true }

  // ---- 大字 ----
  const largeTextOn = computed(() => !!settings.readingMode.largeText.enabled)
  function setLargeText(on: boolean) {
    if (on === largeTextOn.value) return
    const lt = settings.readingMode.largeText
    if (on) {
      engage('largeText', largeTextValues(lt.size, lt.custom))
      lt.enabled = true
      return
    }
    const custom = release('largeText')
    const keep: PresetValues = {}
    for (const key of Object.keys(largeTextValues(lt.size))) if (key in custom) keep[key] = custom[key]
    lt.custom = { ...lt.custom, ...keep }
    lt.enabled = false
  }
  function toggleLargeText() { setLargeText(!largeTextOn.value) }
  function setLargeTextSize(size: 'large' | 'xlarge') {
    const lt = settings.readingMode.largeText
    if (lt.size === size) return
    lt.size = size
    lt.custom = {}
    if (lt.enabled) engage('largeText', largeTextValues(size))
  }

  // ---- 沉浸 ----
  const immersive = computed(() => !!settings.readingMode.immersive.enabled)
  function toggleImmersive() { settings.readingMode.immersive.enabled = !settings.readingMode.immersive.enabled }
  /** 页眉页脚: 沉浸时不写章名与本章剩余; 再开「隐藏页码」连页脚也留空 */
  const marginalsPolicy = computed(() => ({
    head: !immersive.value,
    footLeft: !immersive.value,
    footRight: !(immersive.value && settings.readingMode.immersive.hideFooter),
  }))
  watch(immersive, on => {
    opts.onImmersiveChange?.(on)
    opts.refreshMarginals?.()
  }, { immediate: immersive.value })
  watch(() => settings.readingMode.immersive.hideFooter, () => opts.refreshMarginals?.())

  // =====================================================================
  // 带读: 打字机
  // =====================================================================

  const config = (): TypewriterConfig => ({
    unit: tw.value.unit,
    unitsPerMinute: speed.value,
    ghost: tw.value.upcoming === 'ghost',
    punctuationPause: tw.value.punctuationPause,
    freshInk: tw.value.freshInk,
    pageDwellMs: reducedMotion.value ? Math.max(1200, tw.value.pageDwellMs) : tw.value.pageDwellMs,
  })

  // ---- foliate 适配 ----
  const renderer = () => opts.getView()?.renderer
  /**
   * 跨章连续滚动 (docs/continuous-scroll.md §11): 同时有多个分节文档 (上下预载的邻章), getContents() 主章排第一;
   * load 对预载的邻章也会发, 不代表翻到了那一章。打字机只在一个分节上工作, 跟随主章切换 (section-change)。
   * 旧版渲染器没有 continuous, 以下分支都不走
   */
  const isContinuous = () => !!renderer()?.continuous
  type Slot = { doc: Document; index: number; overlayer?: any }
  const slots = (): Slot[] => {
    try { return (renderer()?.getContents?.() ?? []).filter((c: any) => c?.doc) } catch { return [] }
  }
  const contentOf = (doc: Document): Slot | null => slots().find(c => c.doc === doc) ?? null
  /** 正在显示的分节 (阅读线所在的主章): 按最近一次 relocate 的分节号, 否则取第一个 */
  function primary(): Slot | null {
    const list = slots()
    const current = opts.getView()?.lastLocation?.section?.current
    return (typeof current === 'number' ? list.find(c => c.index === current) : undefined) ?? list[0] ?? null
  }
  const host: TypewriterHost = {
    contents: primary,
    contentOf,
    visibleRange: () => opts.getView()?.lastLocation?.range ?? null,
    scrolled: () => !!renderer()?.scrolled,
    atBookEnd: () => {
      const view = opts.getView()
      const r = view?.renderer
      if (!r) return true
      if (!r.scrolled) return !!r.atEnd
      const c = controller.value
      return lastSection(c?.active ? c.section : undefined)
    },
    nextPage: () => (opts.nextPage ? opts.nextPage() : opts.getView()?.next()),
    nextSection: () => guideNextSection(controller.value?.section ?? -1),
    scrollForward: px => {
      const r = renderer()
      if (!r || px <= 0) return
      // 跨章连续滚动: 原始滚动即可 (光标在阅读线之下, 主章不会因此越过本节)
      if (r.continuous) {
        r.scrollBy?.(0, px)
        return
      }
      // 只在本节内滚动: 到底时 renderer.next 会跨节, 交给节末逻辑
      if (r.viewSize - r.end > 2) void r.next(px)
    },
    viewportRect: () => renderer()?.getBoundingClientRect?.() ?? null,
    colors: () => opts.getColors(),
    lang: () => {
      const doc = host.contents()?.doc
      return doc?.documentElement?.lang || opts.getView()?.language?.canonical || (bookScript.value === 'cjk' ? 'zh' : 'en')
    },
  }
  /** index (默认主章) 之后已没有线性分节 */
  function lastSection(index: number = host.contents()?.index ?? -1): boolean {
    const view = opts.getView()
    const sections: any[] = view?.book?.sections ?? []
    return !sections.slice(index + 1).some(s => s?.linear !== 'no')
  }

  let sound: TypingSound | null = null
  let soundCount = 0
  let lastPing = 0

  const controller = shallowRef<TypewriterController | null>(null)
  const ensureController = () => {
    if (!controller.value) {
      controller.value = new TypewriterController(host, config(), {
        onState: s => { typewriterState.value = s },
        onAdvance: ticks => {
          pingAuto()
          if (!tw.value.sound || ticks <= 0 || opts.isTTSActive?.()) return
          soundCount += ticks
          if (soundCount >= soundEvery(speed.value)) {
            soundCount = 0
            sound?.click()
          }
        },
        onFinish: reason => {
          if (reason === 'book-end') toast(t('readingMode.bookEnd'), 'success')
          else toast(t('readingMode.error'), 'error', 4000)
        },
      })
    }
    return controller.value
  }

  /** 带读推进时的阅读计时 (与听书同口径), 顺带记一次休息提醒的阅读活动 */
  function pingAuto() {
    const now = Date.now()
    if (now - lastPing > 1000) {
      lastPing = now
      opts.pingReadingAuto()
      noteActivity()
    }
  }

  const refreshBookInfo = () => {
    const view = opts.getView()
    supported.value = !!view && !view.isFixedLayout
    const isCJK = view?.language?.isCJK
    bookScript.value = isCJK === false ? 'latin' : 'cjk'
  }

  // ---- 文档级监听: 选区越过光标 ----
  const watchedDocs = new WeakSet<Document>()
  const ensureDocListeners = (doc: Document | null | undefined) => {
    if (!doc || watchedDocs.has(doc)) return
    watchedDocs.add(doc)
    doc.addEventListener('selectionchange', () => {
      const c = controller.value
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return
      if (!c?.active || c.doc !== doc) return
      // 打字机: 暂停, 选区越过光标时把光标推进到选区末尾
      c.pause()
      c.revealSelection(sel.getRangeAt(0))
    })
  }

  /** 开始打字机 (从本页开始); 互斥: 停自动翻页、暂停听书 */
  function start(): boolean {
    if (opts.presentationSuppressed?.()) return false
    refreshBookInfo()
    if (!supported.value) {
      toast(t('readingMode.fixedLayoutUnsupported'), 'error')
      return false
    }
    const hadAuto = !!opts.isAutoReading?.()
    const hadTTS = !!opts.isTTSActive?.()
    opts.onExclusiveStart?.()
    if (hadAuto) toast(t('readingMode.autoStopped'))
    else if (hadTTS) toast(t('readingMode.ttsPaused'))
    if (tw.value.sound) {
      sound ??= createTypingSound({ preset: tw.value.soundPreset, volume: tw.value.soundVolume })
      sound.warm()
    }
    const c = ensureController()
    c.setConfig(config())
    ensureDocListeners(host.contents()?.doc)
    panelOpen.value = false
    const ok = c.start()
    if (!ok) toast(t('readingMode.startFailed'), 'error')
    return ok
  }

  function toggleTypewriter() {
    if (typewriterActive.value) controller.value?.stop()
    else start()
  }

  // =====================================================================
  // 带读的统一控制 (迷你条、面板、快捷键、自动暂停)
  // =====================================================================

  const activeGuide = computed<GuideKind | null>(() => typewriterActive.value ? 'typewriter' : null)
  /** 打字机在运行: 阅读器据此计算进度 / 剩余时间 */
  const progressActive = computed(() => activeGuide.value !== null)
  /** 统一的运行状态 (迷你条用) */
  const guideState = typewriterState

  function pause() {
    controller.value?.pause()
  }
  function resume() {
    if (typewriterActive.value) controller.value?.resume()
  }
  function stop() {
    controller.value?.stop()
  }
  function togglePause() {
    if (typewriterActive.value) {
      const s = typewriterState.value
      if (s === 'running' || s === 'turning') controller.value?.pause()
      else if (s === 'paused') {
        panelOpen.value = false
        controller.value?.resume()
      }
      return
    }
  }

  /** 另一种带读 (自动翻页 / 听书) 开始前调用: 退出打字机 */
  function stopForExternal(_kind: 'auto' | 'tts') {
    if (typewriterActive.value) {
      controller.value?.stop()
      toast(t('readingMode.typewriterStopped'))
    }
  }
  /** 旧名 (v1.6 接线) */
  const stopTypewriterFor = stopForExternal

  function adjustSpeed(dir: 1 | -1) {
    speed.value = clampSpeed(stepSpeed(speed.value, dir), bookScript.value)
  }

  // ---- 面板 ----
  function openPanel(tab?: ReadingModeTab) {
    opts.beforePanelOpen?.()
    refreshBookInfo()
    if (tab) panelTab.value = tab
    else if (typewriterActive.value) panelTab.value = 'typewriter'
    else if (opts.isAutoReading?.()) panelTab.value = 'auto'
    panelOpen.value = true
  }
  function closePanel() { panelOpen.value = false }
  function togglePanel(tab?: ReadingModeTab) {
    if (panelOpen.value) closePanel()
    else openPanel(tab)
  }

  // 打开任何面板 / 浮层时暂停 (WCAG 2.2.2: 移动内容可暂停, 且不在用户看别处时继续跑)
  watch(panelOpen, open => { if (open) pause() })
  if (opts.pauseWhen) watch(() => opts.pauseWhen!(), v => { if (v) pause() })
  if (opts.presentationSuppressed) watch(() => opts.presentationSuppressed!(), value => { if (value) stop() })

  watch(
    () => [tw.value.unit, tw.value.upcoming, tw.value.punctuationPause, tw.value.freshInk, tw.value.pageDwellMs, speed.value, reducedMotion.value],
    () => controller.value?.setConfig(config()),
  )
  watch(() => tw.value.sound, on => {
    if (on && typewriterActive.value) {
      sound ??= createTypingSound({ preset: tw.value.soundPreset, volume: tw.value.soundVolume })
      sound.warm()
    }
  })
  // 打字声音色 / 音量改了立即生效
  watch(() => tw.value.soundPreset, id => sound?.setPreset(id))
  watch(() => tw.value.soundVolume, v => sound?.setVolume(v))
  watch(() => opts.getColors(), () => {
    controller.value?.refreshColors()
  })

  // 切到后台 / 页面隐藏: 暂停
  const onVisibility = () => { if (document.hidden) pause() }
  const onPageHide = () => pause()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  // =====================================================================
  // 单栏约束、正文样式、外壳类名
  // =====================================================================

  /** 大字运行时强制单栏 (不改用户的双栏设置) */
  const forceSingleColumn = computed(() => largeTextOn.value)

  /** 传给 getReaderCSS / resolveReaderColors 的附加样式 */
  const readerStyle = computed<ReaderModeStyle>(() => ({ publication: !!opts.presentationSuppressed?.(), eink: einkActive.value, largeText: largeTextOn.value, wordGuideIntensity: guideIntensity(settings.readingMode.wordGuide), wordGuideColor: settings.readingMode.wordGuide.color }))
  /** 影响排版 / 样式的模式状态: 阅读器 watch 它来重新 applyPrefs */
  const renderKey = computed(() => `${opts.presentationSuppressed?.() ? 'p' : ''}${einkActive.value ? 1 : 0}${largeTextOn.value ? 1 : 0}${forceSingleColumn.value ? 1 : 0}|${guideIntensity(settings.readingMode.wordGuide).toFixed(2)}|${settings.readingMode.wordGuide.color ?? ''}`)
  /** 阅读器根元素的类名 (样式在 ReadingModeLayer.vue 里) */
  const shellClass = computed(() => ({
    'lr-eink': einkActive.value,
    'lr-large-ui': largeTextOn.value,
    'lr-immersive': immersive.value,
  }))
  const largeUi = largeTextOn

  // =====================================================================
  // 按词着色 = 点睛阅读基础版 (开关见 useDianjing; 只在选了基础版时绘制)
  // =====================================================================

  /** Highlight API 可用 (旧 WebView 画不了按词着色) */
  const wordGuideSupported = ref(true)
  /** 「重点词」的数据来源 (阅读器设置) */
  const kwSource = shallowRef<KeyWordSource | null>(null)
  /** 这本书的正文以中文为主 (「重点词」只支持中文; 按当前分节的文字判断) */
  const keyWordsSupported = ref(true)
  /** 智能版在这本书上开着, 且标记里勾了重点词 */
  const smartKeyWords = computed(() => {
    const src = kwSource.value
    const dj = settings.dianjing
    return !!src && normalizeLevel(dj.level) === 'smart' && smartOnFor(dj, src.bookId) && dj.kinds?.kw !== false
  })
  /**
   * 基础版 / 智能版在正文上画什么: 词与词 (交替着色)、重点词 (基础版: 离线; 智能版: AI 词 + 离线兜底), 或不画。
   * 基础版选了重点词但这本书不是中文: 改画词与词 (面板上说明一次)。
   */
  const guideKind = computed<'off' | 'boundary' | 'keywords' | 'smart'>(() => {
    if (!supported.value || opts.presentationSuppressed?.()) return 'off'
    const level = normalizeLevel(settings.dianjing.level)
    if (level === 'basic') {
      if (!settings.readingMode.wordGuide.enabled) return 'off'
      return settings.readingMode.wordGuide.mark === 'keywords' && keyWordsSupported.value && kwSource.value ? 'keywords' : 'boundary'
    }
    return smartKeyWords.value && keyWordsSupported.value ? 'smart' : 'off'
  })
  const wordGuideActive = computed(() => guideKind.value !== 'off')
  /** 每个分节文档一层 (跨章连续滚动时上下预载的邻章也要着色; 单章渲染时只留当前文档) */
  const wgLayers = new Map<Document, WordGuideLayer | KeyWordLayer>()
  function disposeWordGuides(keep?: ReadonlySet<Document>) {
    for (const [doc, layer] of wgLayers) {
      if (keep?.has(doc)) continue
      try { layer.dispose() } catch { /* 文档已卸载 */ }
      wgLayers.delete(doc)
    }
  }
  function sectionIndexOf(doc: Document): number {
    return contentOf(doc)?.index ?? (host.contents()?.doc === doc ? host.contents()?.index : undefined) ?? -1
  }
  function wordGuideFor(doc: Document): WordGuideLayer | KeyWordLayer | null {
    let layer = wgLayers.get(doc) ?? null
    const kind = guideKind.value
    const wantKw = kind === 'keywords' || kind === 'smart'
    if (layer && (layer instanceof KeyWordLayer) !== wantKw) {
      try { layer.dispose() } catch { /* 文档已卸载 */ }
      wgLayers.delete(doc)
      layer = null
    }
    if (!layer) {
      const src = kwSource.value
      const section = sectionIndexOf(doc)
      if (wantKw && src && section >= 0) {
        layer = KeyWordLayer.create(doc, {
          section,
          service: keyWordService(src.bookId),
          host: src,
          params: () => kwParams(doc, section),
          onPicked: info => src.onPicked?.(info),
        })
      } else if (!wantKw) layer = WordGuideLayer.create(doc, wgOptions())
      else return null
      wordGuideSupported.value = !!layer
      if (layer) wgLayers.set(doc, layer)
    }
    return layer
  }

  function kwParams(doc: Document, section: number): { level: KwLevel; spoilerSafe: boolean; smart: KwSmartInput | null } {
    const src = kwSource.value
    const d = settings.dianjing.density
    const level: KwLevel = d === 'low' || d === 'high' ? d : 'normal'
    return {
      level,
      spoilerSafe: !!src?.fiction(),
      smart: guideKind.value === 'smart' && src ? src.smart(doc, section) : null,
    }
  }

  /** 重点词: 参数或 AI 结果变了, 各层重新取词 (请求没变的层不动) */
  function refreshKeyWords() {
    for (const layer of wgLayers.values()) if (layer instanceof KeyWordLayer) layer.refresh()
  }

  /** 按当前分节的文字判断这本书是不是中文 (「重点词」能不能用) */
  function refreshKeyWordSupport(doc: Document | null | undefined) {
    if (!doc?.body) return
    const zh = looksChinese(doc, host.lang())
    if (zh !== keyWordsSupported.value) keyWordsSupported.value = zh
  }

  function setKeyWordSource(src: KeyWordSource | null) {
    kwSource.value = src
    if (!src) disposeKeyWordService()
  }

  const wgOptions = () => ({
    style: settings.readingMode.wordGuide.style,
    strength: settings.readingMode.wordGuide.strength,
    lang: host.lang(),
  })

  function syncWordGuide(doc?: Document | null, visible?: Range | null) {
    try {
      if (!wordGuideActive.value) {
        disposeWordGuides()
        return
      }
      const d = doc ?? host.contents()?.doc
      if (!d) return
      if (isContinuous()) {
        const live = new Set<Document>(slots().map(c => c.doc))
        live.add(d)
        disposeWordGuides(live)
        // 开关 / 选项变化时 (未指定文档) 给屏上其他分节也补上
        if (!doc) for (const c of slots()) if (c.doc !== d) syncWordGuideSlot(c.doc, c.index)
      } else disposeWordGuides(new Set([d]))
      wordGuideFor(d)?.update(visible === undefined ? host.visibleRange() : visible)
    } catch (e) {
      console.warn('word guide failed', e)
    }
  }

  /** 跨章连续滚动: 预载的邻章着色 (上方的章从末尾附近着色, 下方的从开头) */
  function syncWordGuideSlot(doc: Document, index: number) {
    try {
      const layer = wordGuideFor(doc)
      if (!layer) return
      const p = primary()
      if (p?.doc === doc) {
        layer.update(host.visibleRange())
        return
      }
      if (p && index < p.index && doc.body) {
        const end = doc.createRange()
        end.selectNodeContents(doc.body)
        end.collapse(false)
        layer.update(end)
      } else layer.update(null)
    } catch (e) {
      console.warn('word guide failed', e)
    }
  }

  /** 基础版开关 (由 useDianjing 调用; 选版本在那里) */
  function setWordGuide(on: boolean) {
    settings.readingMode.wordGuide.enabled = on
  }

  watch(guideKind, () => {
    // 换了画法 (词与词 / 重点词 / 智能): 旧层全部换掉
    disposeWordGuides()
    syncWordGuide()
  })
  watch(
    () => [settings.readingMode.wordGuide.style, settings.readingMode.wordGuide.strength],
    () => {
      for (const layer of wgLayers.values()) if (layer instanceof WordGuideLayer) layer.setOptions(wgOptions())
      syncWordGuide()
    },
  )
  // 重点词: 密度档、体裁变了就重新取词
  watch(() => [settings.dianjing.density, kwSource.value?.fiction()], () => refreshKeyWords())

  // =====================================================================
  // 休息提醒 (20-20-20) 与夜间定时
  // =====================================================================

  let breakTimer = newBreakTimer(Date.now())
  let lastActivity = 0
  /** 休息提醒正在显示 */
  const reminderDue = ref(false)

  /** 记一次阅读活动 (翻页、轻点、带读推进), 10 秒节流 */
  function noteActivity() {
    const now = Date.now()
    if (now - lastActivity < ACTIVITY_THROTTLE_MS) return
    if (typeof document !== 'undefined' && document.hidden) return
    lastActivity = now
    breakTimer = noteBreakActivity(breakTimer, now)
  }

  function checkReminder() {
    const e = settings.readingMode.eyeCare
    if (!eyeCareOn.value || !e.reminder || reminderDue.value) return
    if (!isReminderDue(breakTimer, Date.now(), e.intervalMin)) return
    reminderDue.value = true
    pause()
    opts.onReminder?.()
  }

  /** 处理休息提醒: done 休息完 / skip 跳过 / snooze 30 分钟内不再提醒 */
  function dismissReminder(action: 'done' | 'skip' | 'snooze' = 'done') {
    breakTimer = afterReminder(breakTimer, Date.now(), action)
    reminderDue.value = false
  }

  let prevInWindow: boolean | null = null
  function checkNight() {
    const n = settings.readingMode.night
    if (!n.schedule || settings.readingMode.eink.enabled) {
      prevInWindow = null
      return
    }
    const inWindow = inNightWindow(minutesOfDay(new Date()), n.from, n.to)
    const autoApplied = !!settings.readingMode.presets.nightAuto
    const action = nightScheduleAction({ inWindow, prevIn: prevInWindow, nightOn: nightOn.value, autoApplied })
    prevInWindow = inWindow
    if (action === 'on') setNight(true, 'schedule')
    else if (action === 'off') setNight(false)
  }
  watch(() => [settings.readingMode.night.schedule, settings.readingMode.night.from, settings.readingMode.night.to], () => {
    prevInWindow = null
    checkNight()
  })
  const minuteTimer = setInterval(() => {
    checkReminder()
    checkNight()
  }, REMINDER_CHECK_MS)
  checkNight()


  // =====================================================================
  // ReaderView 事件
  // =====================================================================

  // ---- 跨章连续滚动: 跟随主章 ----

  /**
   * 主章切换 (section-change, 或 relocate 的范围落在另一个分节里)。打字机控制着视口时不跟:
   * 短章撑不满一屏时阅读线会先落进下一章, 而光标 / 当前行还在本章里。只有这些情况才换到主章:
   * 章末正等着进入下一章 (turning) 且主章在后面; 原分节已卸载; 光标 / 当前行已不在视口 (用户滚走或跳转)
   */
  function followPrimary(doc: Document | null | undefined, index: number) {
    if (!doc || !isContinuous()) return
    ensureDocListeners(doc)
    const vis = host.visibleRange()
    const visIn = vis && vis.startContainer?.ownerDocument === doc ? vis : null
    const c = controller.value
    if (c?.active && c.doc !== doc) {
      const forward = c.state === 'turning' && index > c.section
      if (forward || !c.doc || !contentOf(c.doc) || !c.cursorInView()) {
        c.onSectionLoad(doc, index)
        if (visIn) c.onRelocate(visIn)
      }
    }
    if (wordGuideActive.value) syncWordGuide(doc, visIn)
    syncVeil()
  }

  /**
   * 打字机章末进入下一章。跨章连续滚动时下一章多半已在下方排好: 主章已在后面 (短章) 就直接接上,
   * 否则让渲染器滚到下一章顶部, 主章切换后接上 (section-change 也会触发, 重复调用无副作用)
   */
  async function guideNextSection(from: number): Promise<void> {
    const r = renderer()
    if (!r) return
    if (!r.continuous || from < 0) return r.nextSection?.()
    const ahead = () => {
      const p = primary()
      if (p && p.index > from) followPrimary(p.doc, p.index)
      return !!p && p.index > from
    }
    if (ahead()) return
    await r.nextSection?.()
    ahead()
  }

  // 打字机运行时, 屏上排在它后面的分节 (预载在下方的下一章) 整节隐藏 / 淡显, 不能先于光标露出来
  const veils = new Map<Document, { hl: any; name: string }>()
  function clearVeil(doc: Document) {
    const v = veils.get(doc)
    if (!v) return
    veils.delete(doc)
    try {
      const reg = (doc.defaultView as any)?.CSS?.highlights
      if (reg?.get(v.name) === v.hl) reg.delete(v.name)
    } catch { /* 文档已卸载 */ }
  }
  function clearVeils() {
    for (const doc of [...veils.keys()]) clearVeil(doc)
  }
  function syncVeil() {
    const c = controller.value
    const want = new Set<Document>()
    if (c?.active && c.section >= 0 && isContinuous()) {
      for (const s of slots()) if (s.index > c.section && s.doc !== c.doc) want.add(s.doc)
    }
    const name = tw.value.upcoming === 'ghost' ? HL_GHOST : HL_HIDDEN
    for (const [doc, v] of [...veils]) if (!want.has(doc) || v.name !== name) clearVeil(doc)
    for (const doc of want) {
      const win = doc.defaultView as any
      if (veils.has(doc) || !doc.body || !supportsHighlights(win)) continue
      try {
        const hl = new win.Highlight()
        try { hl.priority = 100 } catch { /* 旧实现无 priority */ }
        const all = doc.createRange()
        all.selectNodeContents(doc.body)
        hl.add(all)
        win.CSS.highlights.set(name, hl)
        veils.set(doc, { hl, name })
      } catch { /* 忽略 */ }
    }
  }
  watch(typewriterState, () => syncVeil())
  watch(() => tw.value.upcoming, () => syncVeil())

  /** 渲染器 section-change 的 e.detail (跨章连续滚动: 主章切换) */
  function onSectionChange(detail: { doc?: Document | null; index?: number } | null | undefined) {
    if (!detail?.doc || typeof detail.index !== 'number') return
    followPrimary(detail.doc, detail.index)
  }

  /** 渲染器 unload 的 e.detail (跨章连续滚动: 远处的分节被卸载, 文档随后销毁) */
  function onSectionUnload(detail: { doc?: Document | null; index?: number } | null | undefined) {
    const doc = detail?.doc
    if (!doc) return
    const layer = wgLayers.get(doc)
    if (layer) {
      try { layer.dispose() } catch { /* 文档已卸载 */ }
      wgLayers.delete(doc)
    }
    clearVeil(doc)
    const p = primary()
    const next = p && p.doc !== doc ? p : null
    const vis = host.visibleRange()
    const visIn = next && vis && vis.startContainer?.ownerDocument === next.doc ? vis : null
    // 换到当前主章; 还没有 (跳到未载的章, 槽位整体重建) 就等新主章的 load / section-change 接上
    const c = controller.value
    if (c?.active && c.doc === doc && next) {
      c.onSectionLoad(next.doc, next.index)
      if (visIn) c.onRelocate(visIn)
    }
    syncVeil()
  }

  /** foliate relocate 的 e.detail */
  function onRelocate(detail: { range?: Range | null; reason?: string } | null | undefined) {
    if (isContinuous()) {
      // 主章切换时渲染器会立即派发一次 relocate; 没有 section-change 时也据此跟随
      const doc = detail?.range?.startContainer?.ownerDocument
      const slot = doc ? contentOf(doc) : null
      if (slot) followPrimary(slot.doc, slot.index)
    }
    controller.value?.onRelocate(detail?.range ?? null)
    if (wordGuideActive.value) syncWordGuide(detail?.range?.startContainer?.ownerDocument ?? null, detail?.range ?? null)
    noteActivity()
  }

  /** foliate load 的 e.detail */
  function onSectionLoad(detail: { doc: Document; index: number } | null | undefined) {
    if (!detail?.doc) return
    ensureDocListeners(detail.doc)
    if (!isContinuous() || slots()[0]?.doc === detail.doc) refreshKeyWordSupport(detail.doc)
    if (isContinuous()) {
      // 预载的邻章也会 load: 只着色 / 遮挡, 打字机跟随主章 (section-change)
      if (wordGuideActive.value) syncWordGuideSlot(detail.doc, detail.index)
      if (slots()[0]?.doc === detail.doc) followPrimary(detail.doc, detail.index)
      syncVeil()
      return
    }
    controller.value?.onSectionLoad(detail.doc, detail.index)
    if (wordGuideActive.value) syncWordGuide(detail.doc, null)
  }

  /**
   * 轻点正文。带读未运行时返回 false (按原逻辑翻页 / 呼出工具栏)。
   * - 打字机: 轻点任意位置切换暂停 / 继续 → 'paused' | 'resumed' (不翻页, 防误触);
   */
  function onContentTap(): false | 'paused' | 'resumed' {
    noteActivity()
    const s = typewriterState.value
    if (s !== 'idle') {
      if (s === 'paused') {
        controller.value?.resume()
        return 'resumed'
      }
      controller.value?.pause()
      return 'paused'
    }
    return false
  }

  /** 键盘; 返回 true 表示已处理 (调用方直接 return) */
  function handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
    const el = e.target as HTMLElement | null
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''))) return false
    noteActivity()
    const key = e.key
    const consume = () => { e.preventDefault(); return true }
    if ((key === 'm' || key === 'M') && !e.shiftKey) {
      togglePanel()
      return consume()
    }
    if ((key === 'T' || key === 't') && e.shiftKey) {
      toggleTypewriter()
      return consume()
    }
    if (key === 'Escape' && panelOpen.value && !progressActive.value) {
      closePanel()
      return false
    }
    if (!typewriterActive.value) return false
    const c = controller.value!
    if (key === ' ' || key === 'Spacebar') {
      togglePause()
      return consume()
    }
    if (e.shiftKey && key === 'ArrowUp') {
      adjustSpeed(1)
      return consume()
    }
    if (e.shiftKey && key === 'ArrowDown') {
      adjustSpeed(-1)
      return consume()
    }
    if (key === 'ArrowRight' && !e.shiftKey) {
      c.revealParagraph()
      return consume()
    }
    if (key === 'ArrowLeft' && !e.shiftKey) {
      c.retypeSentence()
      return consume()
    }
    if (key === 'Escape') {
      c.stop()
      closePanel()
      return false // 让 ReaderView 继续处理 Esc (收起其他面板等)
    }
    return false
  }

  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    controller.value?.dispose()
    controller.value = null
    disposeWordGuides()
    disposeKeyWordService()
    clearVeils()
    sound?.dispose()
    sound = null
    clearInterval(minuteTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    motionQuery?.removeEventListener?.('change', onMotionChange)
    if (immersive.value) opts.onImmersiveChange?.(false)
    try {
      for (const c of opts.getView()?.renderer?.getContents?.() ?? []) clearReadingModeMarks(c?.doc, READING_MODE_PREFIXES)
    } catch { /* 已卸载 */ }
  }
  onScopeDispose(dispose)

  return {
    // ---- 通用状态 ----
    panelOpen,
    panelTab,
    supported,
    reducedMotion,
    bookScript,
    speed,
    speedUnit,
    speedText,
    speedLimits,
    presets,
    // ---- 面板 ----
    openPanel,
    closePanel,
    togglePanel,
    // ---- 显示: 夜间 / 护眼 / 墨水屏 / 大字 ----
    nightOn,
    toggleNight,
    setNight,
    eyeCareOn,
    toggleEyeCare,
    setEyeCare,
    setEyeCareTheme,
    dimLevel,
    dimOverlayStyle,
    einkActive,
    toggleEink,
    setEink,
    einkSuggested,
    dismissEinkSuggestion,
    largeTextOn,
    largeUi,
    toggleLargeText,
    setLargeText,
    setLargeTextSize,
    readerStyle,
    renderKey,
    shellClass,
    // ---- 沉浸 / 单栏约束 ----
    immersive,
    toggleImmersive,
    marginalsPolicy,
    forceSingleColumn,
    // ---- 带读: 统一控制 ----
    activeGuide,
    progressActive,
    guideState,
    pause,
    resume,
    stop,
    togglePause,
    adjustSpeed,
    stopForExternal,
    stopTypewriterFor,
    // ---- 打字机 ----
    typewriterState,
    typewriterActive,
    start,
    startTypewriter: start,
    toggleTypewriter,
    // ---- 按词着色 / 重点词 (点睛阅读) ----
    wordGuideActive,
    wordGuideSupported,
    setWordGuide,
    guideKind,
    keyWordsSupported,
    setKeyWordSource,
    refreshKeyWords,
    // ---- 休息提醒 ----
    reminderDue,
    dismissReminder,
    noteActivity,
    // ---- ReaderView 事件 ----
    onRelocate,
    onSectionLoad,
    onSectionChange,
    onSectionUnload,
    onContentTap,
    handleKey,
    dispose,
  }
}

export type ReadingModes = ReturnType<typeof useReadingModes>
