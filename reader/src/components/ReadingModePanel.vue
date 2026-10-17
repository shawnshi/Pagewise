<script setup lang="ts">
import { AUTO_SPEED_LEVELS, AUTO_SPEED_STEPS, speedPosition, secondsAtPosition } from '../services/autoReadSpeed'
import LevelSlider from './LevelSlider.vue'
/**
 * 「阅读模式」面板 (docs/reader-panels.md §3.2): 书页怎么动、怎么带你读。桌面为顶栏下的浮层卡片, 手机为底部抽屉
 * (遮罩由 ReaderView 的 sheet-scrim 提供)。自上而下:
 *   #top 插槽 (点睛阅读: 总开关 + 基础 / 智能, 见 DianjingToggle) → 运行进度 → 场景 (夜读 / 护眼 / 墨水屏 / 大字 / 沉浸)
 *   → 带读 [自动翻页 | 打字机 | 听书] (同一时间只运行一个)。
 * 场景是开关卡片: 一键套用一组「排版」里的值 (记快照, 关闭写回), 自己不保存也不提供这些值的控件;
 * 点卡片角上的 ⓘ 展开「会调整什么」、场景自己的选项 (定时、休息提醒、大 / 特大…) 和「在排版里微调」。
 * 自动翻页沿用 ReaderView 的实现 (props/emits), 容器保留 .auto-panel 类名供 e2e 使用。
 */
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import type { ReadingModes, ReadingModeTab } from '../composables/useReadingModes'
import { TYPING_SOUND_PRESETS } from '../services/readingModes/soundPresets'
import { previewTypingSound } from '../services/readingModes/sound'
import type { ReadingModeProgress } from '../services/readingModes/progress'
import { largeTextValues } from '../services/readingModes/presets'
import type { TypographySection } from './TypographyPanel.vue'

const props = defineProps<{
  modes: ReadingModes
  /** 自动翻页是否在运行 (ReaderView 的 autoReading) */
  autoReading: boolean
  /** 自动翻页速度, 秒/页 (v-model:auto-read-seconds); 滚动模式下为秒/屏 */
  autoReadSeconds: number
  /** 当前为滚动模式: 自动翻页改为匀速平滑滚动 */
  autoScrolled?: boolean
  /** 打字机运行时的进度与剩余时间 (阅读器计算); 未运行为 null */
  progress?: ReadingModeProgress | null
  /** 听书正在播放 */
  ttsActive?: boolean
}>()

const emit = defineEmits<{
  'start-auto': []
  'stop-auto': []
  'update:autoReadSeconds': [value: number]
  /** 「听书」分段的主按钮: 打开现有听书面板 */
  'open-tts': []
  /** 场景详情的「在排版里微调」: 打开排版面板并滚到对应分区 */
  'open-typography': [section: TypographySection]
  close: []
}>()

const settings = useSettings()
const tw = computed(() => settings.readingMode.typewriter)
const eye = computed(() => settings.readingMode.eyeCare)

const tab = computed<ReadingModeTab>({
  get: () => props.modes.panelTab.value,
  set: v => { props.modes.panelTab.value = v },
})
const twState = computed(() => props.modes.typewriterState.value)
const twActive = computed(() => twState.value !== 'idle')
const supported = computed(() => props.modes.supported.value)

// ---- 场景卡片 ----
type SceneId = 'night' | 'eyeCare' | 'eink' | 'largeText' | 'immersive'
const detail = ref<SceneId | null>(null)

interface SceneCard {
  id: SceneId
  key: string
  on: boolean
  toggle: () => void
  /** 「在排版里微调」跳到的分区; 不改排版值的场景没有 */
  tune?: TypographySection
}

const sceneCards = computed<SceneCard[]>(() => [
  { id: 'night', key: 'readingMode.modeNight', on: props.modes.nightOn.value, toggle: props.modes.toggleNight, tune: 'color' },
  { id: 'eyeCare', key: 'readingMode.modeEyeCare', on: props.modes.eyeCareOn.value, toggle: props.modes.toggleEyeCare, tune: 'color' },
  { id: 'eink', key: 'readingMode.modeEink', on: props.modes.einkActive.value, toggle: props.modes.toggleEink },
  { id: 'largeText', key: 'readingMode.modeLargeText', on: props.modes.largeTextOn.value, toggle: props.modes.toggleLargeText, tune: 'text' },
  { id: 'immersive', key: 'readingMode.modeImmersive', on: props.modes.immersive.value, toggle: props.modes.toggleImmersive },
])
const detailCard = computed(() => sceneCards.value.find(c => c.id === detail.value) ?? null)

function toggleCard(c: SceneCard) {
  c.toggle()
  // 刚打开的卡片顺带展开它的详情; 关掉时收起
  detail.value = c.on ? (detail.value === c.id ? null : detail.value) : c.id
}
function toggleDetail(id: SceneId) {
  detail.value = detail.value === id ? null : id
}

/** 场景会调整的东西 (只读说明; 数值在排版里调) */
const sceneChanges = computed<string[]>(() => {
  switch (detail.value) {
    case 'night':
      return [t('readingMode.chgTheme', { name: t('reader.themeDark') })]
    case 'eyeCare':
      return [t('readingMode.chgTheme', { name: t(eye.value.theme === 'green' ? 'reader.themeGreen' : 'reader.themeSepia') })]
    case 'eink':
      return ['chgEinkColors', 'chgBold', 'chgNoAnimation', 'chgTypewriterSentence'].map(k => t(`readingMode.${k}`))
    case 'largeText': {
      const lt = settings.readingMode.largeText
      const v = largeTextValues(lt.size, lt.custom)
      return [
        t('readingMode.chgFontSize', { n: Number(v['reader.fontSize']) }),
        t('readingMode.chgLineHeight'),
        t('readingMode.chgLetterSpacing'),
        t('readingMode.chgMargin', { n: Number(v['reader.gap']) }),
        t('readingMode.chgHeiti'),
        t('readingMode.chgNoJustify'),
        t('readingMode.chgSingleColumn'),
        t('readingMode.chgLargeUi'),
      ]
    }
    case 'immersive':
      return ['chgHideHeader', 'chgAutoHideBars', 'chgSystemBars'].map(k => t(`readingMode.${k}`))
    default:
      return []
  }
})

function tune(section: TypographySection) {
  emit('open-typography', section)
}

const reminderIntervals = [20, 30, 45] as const

function onClock(which: 'from' | 'to', e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (/^\d{1,2}:\d{2}$/.test(v)) settings.readingMode.night[which] = v
}

// ---- 带读 ----
const guideTabs = computed(() => [
  // 滚动方式下自动翻页是匀速滚动, 页签随之改名
  { value: 'auto' as const, key: props.autoScrolled ? 'readingMode.tabAutoScroll' : 'readingMode.tabAuto' },
  { value: 'typewriter' as const, key: 'readingMode.tabTypewriter' },
  { value: 'tts' as const, key: 'readingMode.tabTts' },
])

const runningTab = computed<ReadingModeTab | null>(() => {
  if (props.autoReading) return 'auto'
  if (twActive.value) return 'typewriter'
  if (props.ttsActive) return 'tts'
  return null
})

const units = [
  { value: 'char', key: 'readingMode.unitChar' },
  { value: 'sentence', key: 'readingMode.unitSentence' },
  { value: 'line', key: 'readingMode.unitLine' },
] as const

const presetLabels = ['readingMode.presetSlow', 'readingMode.presetMedium', 'readingMode.presetFast']

const showSpeed = computed(() => tab.value === 'typewriter')

function close() {
  props.modes.closePanel()
  emit('close')
}



function toggleAuto() {
  if (props.autoReading) {
    emit('stop-auto')
    return
  }
  props.modes.stopForExternal('auto')
  // 手机上面板是盖住正文的底部抽屉: 开始后收起 (同打字机), 暂停、调速用底部迷你条或轻点正文
  if (window.matchMedia?.('(max-width: 600px)').matches) close()
  emit('start-auto')
}

function openTts() {
  props.modes.closePanel()
  emit('open-tts')
}

/** 输入框给出具体值: 失焦或回车生效, 越界 / 非数字时收敛并把实际生效的值写回输入框 */
function onSpeedExact(e: Event) {
  const el = e.target as HTMLInputElement
  const n = Number(el.value)
  if (el.value.trim() && Number.isFinite(n)) props.modes.speed.value = n
  el.value = String(props.modes.speed.value)
}

function onSpeedInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n)) props.modes.speed.value = n
}
</script>

<template>
  <section class="rm-panel card" role="dialog" :aria-label="t('readingMode.title')">
    <header class="rm-head">
      <strong>{{ t('readingMode.title') }}</strong>
      <button class="rm-close" type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="close">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </header>

    <!-- 主会话放点睛阅读开关 -->
    <slot name="top" />

    <!-- 打字机运行中: 读到哪、还要多久 -->
    <div v-if="progress" class="rm-progress">
      <div class="rm-progress-head">
        <span class="rm-progress-chapter">{{ progress.chapter }}</span>
        <span class="rm-progress-eta">{{ progress.chapterLeft || progress.percent }}</span>
      </div>
      <div
        class="rm-progress-track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(progress.chapterProgress * 100)"
        :aria-label="t('tts.chapterProgress')"
      >
        <span :style="{ transform: `scaleX(${progress.chapterProgress})` }" />
      </div>
      <div class="rm-progress-sub">
        <span>{{ progress.finish }}</span>
        <span>{{ progress.book }}</span>
      </div>
    </div>

    <!-- 场景: 一键套用一组排版值, 关闭恢复; 数值本身在「排版」里调 -->
    <section class="rm-group" :aria-label="t('readingMode.groupScenes')">
      <h3 class="rm-group-title">{{ t('readingMode.groupScenes') }}</h3>
      <div class="rm-cards">
        <div v-for="c in sceneCards" :key="c.id" class="rm-card" :class="{ on: c.on, open: detail === c.id }">
          <button
            type="button"
            class="rm-card-main"
            role="switch"
            :aria-checked="c.on"
            @click="toggleCard(c)"
          >
            <svg v-if="c.id === 'night'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11.2 3.05a1 1 0 0 1 .3 1.06A7 7 0 0 0 19.9 12.5a1 1 0 0 1 1.36 1.06A9.5 9.5 0 1 1 10.15 2.73a1 1 0 0 1 1.05.32zM8.96 5.3a7.5 7.5 0 1 0 9.74 9.74A9 9 0 0 1 8.96 5.3z"/></svg>
            <svg v-else-if="c.id === 'eyeCare'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0-7a1 1 0 0 1 1 1v1.5a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm0 17.5a1 1 0 0 1 1 1V21a1 1 0 1 1-2 0v-.5a1 1 0 0 1 1-1zM3 11h1.5a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2zm16.5 0H21a1 1 0 1 1 0 2h-1.5a1 1 0 1 1 0-2z"/></svg>
            <svg v-else-if="c.id === 'eink'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M7 2h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7zm2 3h6a1 1 0 1 1 0 2H9a1 1 0 0 1 0-2zm0 4h6a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2zm0 4h3a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2z"/></svg>
            <svg v-else-if="c.id === 'largeText'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8.9 4.4a1 1 0 0 1 1.86 0l5.5 14.2a1 1 0 1 1-1.87.72L12.9 15.5H6.76l-1.5 3.82a1 1 0 0 1-1.86-.72L8.9 4.4zM7.54 13.5h4.58L9.83 7.6l-2.3 5.9zM18.5 10a1 1 0 0 1 1 1v1.5H21a1 1 0 1 1 0 2h-1.5V16a1 1 0 1 1-2 0v-1.5H16a1 1 0 1 1 0-2h1.5V11a1 1 0 0 1 1-1z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 3h4a1 1 0 0 1 0 2H6.41l3.3 3.3a1 1 0 0 1-1.42 1.4L5 6.42V8a1 1 0 0 1-2 0V4a1 1 0 0 1 1-1zm12 0h4a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V6.41l-3.3 3.3a1 1 0 1 1-1.4-1.42L17.58 5H16a1 1 0 1 1 0-2zM9.7 14.3a1 1 0 0 1 0 1.4L6.42 19H8a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1v-4a1 1 0 1 1 2 0v1.59l3.3-3.3a1 1 0 0 1 1.4 0zm4.6 0a1 1 0 0 1 1.4 0l3.3 3.29V16a1 1 0 1 1 2 0v4a1 1 0 0 1-1 1h-4a1 1 0 1 1 0-2h1.59l-3.3-3.3a1 1 0 0 1 0-1.4z"/></svg>
            <span class="rm-card-name">{{ t(c.key) }}</span>
            <span class="rm-card-state">{{ c.on ? t('readingMode.stateOn') : t('readingMode.stateOff') }}</span>
          </button>
          <button
            type="button"
            class="rm-card-info"
            :aria-expanded="detail === c.id"
            :aria-label="t('readingMode.details', { name: t(c.key) })"
            :title="t('readingMode.details', { name: t(c.key) })"
            @click="toggleDetail(c.id)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 6a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1zm0-4a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 12 6z"/></svg>
          </button>
        </div>
      </div>
      <p v-if="!detailCard" class="rm-hint">{{ t('readingMode.scenesHint') }}</p>

      <div v-else class="rm-detail">
        <!-- 会调整什么 (只读) -->
        <div class="rm-changes">
          <span class="rm-changes-label">{{ t('readingMode.sceneChanges') }}</span>
          <span v-for="chg in sceneChanges" :key="chg" class="rm-change">{{ chg }}</span>
        </div>
        <p v-if="detail === 'night'" class="rm-hint">{{ t('readingMode.nightDesc') }}</p>
        <p v-else-if="detail === 'eyeCare'" class="rm-hint">{{ t('readingMode.eyeCareDesc') }}</p>
        <p v-else-if="detail === 'eink'" class="rm-hint">{{ t('readingMode.einkDesc') }}</p>
        <p v-else-if="detail === 'largeText'" class="rm-hint">{{ t('readingMode.largeTextDesc') }}</p>
        <p v-else class="rm-hint">{{ t('readingMode.immersiveDesc') }}</p>

        <!-- 夜读: 定时开启 -->
        <template v-if="detail === 'night'">
          <label class="rm-toggle">
            <span>{{ t('readingMode.nightSchedule') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.night.schedule" type="checkbox" role="switch" :aria-checked="settings.readingMode.night.schedule" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <div v-if="settings.readingMode.night.schedule" class="rm-row rm-clock">
            <span class="rm-label">{{ t('readingMode.nightFrom') }}</span>
            <input class="rm-time" type="time" :value="settings.readingMode.night.from" :aria-label="t('readingMode.nightFrom')" @change="onClock('from', $event)" />
            <span>{{ t('readingMode.nightTo') }}</span>
            <input class="rm-time" type="time" :value="settings.readingMode.night.to" :aria-label="t('readingMode.nightTo')" @change="onClock('to', $event)" />
          </div>
          <p v-if="settings.readingMode.night.schedule" class="rm-hint">{{ t('readingMode.nightScheduleHint') }}</p>
        </template>

        <!-- 护眼: 休息提醒 -->
        <template v-else-if="detail === 'eyeCare'">
          <label class="rm-toggle">
            <span>{{ t('readingMode.reminder') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.eyeCare.reminder" type="checkbox" role="switch" :aria-checked="eye.reminder" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <div v-if="eye.reminder" class="segmented rm-self-start">
            <button
              v-for="n in reminderIntervals"
              :key="n"
              type="button"
              :class="{ active: eye.intervalMin === n }"
              :aria-pressed="eye.intervalMin === n"
              @click="settings.readingMode.eyeCare.intervalMin = n"
            >
              {{ t('readingMode.minutes', { n }) }}
            </button>
          </div>
        </template>

        <!-- 大字: 大 / 特大 (选哪一套, 不是字号本身) -->
        <div v-else-if="detail === 'largeText'" class="segmented rm-self-start">
          <button
            type="button"
            :class="{ active: settings.readingMode.largeText.size === 'large' }"
            :aria-pressed="settings.readingMode.largeText.size === 'large'"
            @click="modes.setLargeTextSize('large')"
          >
            {{ t('readingMode.sizeLarge') }} 24
          </button>
          <button
            type="button"
            :class="{ active: settings.readingMode.largeText.size === 'xlarge' }"
            :aria-pressed="settings.readingMode.largeText.size === 'xlarge'"
            @click="modes.setLargeTextSize('xlarge')"
          >
            {{ t('readingMode.sizeXLarge') }} 30
          </button>
        </div>

        <!-- 沉浸: 连页码也隐藏 -->
        <label v-else-if="detail === 'immersive'" class="rm-toggle">
          <span>{{ t('readingMode.hideFooter') }}</span>
          <span class="rm-switch">
            <input v-model="settings.readingMode.immersive.hideFooter" type="checkbox" role="switch" :aria-checked="settings.readingMode.immersive.hideFooter" />
            <span class="rm-switch-track" aria-hidden="true"></span>
          </span>
        </label>

        <button v-if="detailCard.tune" type="button" class="rm-tune" @click="tune(detailCard.tune)">
          {{ t('readingMode.tuneInTypography') }}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
        </button>
      </div>
    </section>

    <!-- 带读: 同一时间只运行一个 -->
    <section class="rm-group" :aria-label="t('readingMode.groupGuide')">
      <h3 class="rm-group-title">{{ t('readingMode.groupGuide') }}</h3>
      <div class="segmented rm-tabs">
        <button
          v-for="g in guideTabs"
          :key="g.value"
          type="button"
          :class="{ active: tab === g.value, running: runningTab === g.value }"
          :aria-pressed="tab === g.value"
          @click="tab = g.value"
        >
          {{ t(g.key) }}
        </button>
      </div>

      <!-- 自动翻页 (原自动阅读): 行为不变, 秒/页 3–60 -->
      <div v-if="tab === 'auto'" class="auto-panel rm-body">
        <p class="rm-hint">{{ t(autoScrolled ? 'readingMode.autoScrollHint' : 'readingMode.autoHint') }}</p>
        <div class="rm-row">
          <span class="rm-label">{{ t('reader.speed') }}</span>
          <LevelSlider
            :model-value="speedPosition(autoReadSeconds)"
            :min="1"
            :max="AUTO_SPEED_STEPS"
            :step="1"
            :stops="AUTO_SPEED_LEVELS.map(l => ({ value: l.position, label: t(l.key) }))"
            :value-text="String(speedPosition(autoReadSeconds))"
            :label="t('reader.speed')"
            @update:model-value="emit('update:autoReadSeconds', secondsAtPosition($event))"
          />
        </div>
        <button type="button" class="btn btn-primary rm-main" @click="toggleAuto">
          <svg v-if="autoReading" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
          {{ autoReading ? t('common.pause') : t('common.start') }}
        </button>
      </div>

      <!-- 听书: 只放入口, 设置仍在听书面板里 (不复制一份) -->
      <div v-else-if="tab === 'tts'" class="tts-entry rm-body">
        <p class="rm-hint">{{ t('readingMode.ttsHint') }}</p>
        <div class="rm-actions">
          <button type="button" class="btn btn-primary rm-main" @click="openTts">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>
            {{ t('readingMode.openTts') }}
          </button>
        </div>
      </div>

      <!-- 打字机 -->
      <div v-else class="rm-body tw-panel">
        <p v-if="!supported" class="rm-note" role="note">{{ t('readingMode.modeUnsupported') }}</p>
        <fieldset class="rm-fields" :disabled="!supported">
          <!-- 打字机: 粒度 -->
          <div v-if="tab === 'typewriter'" class="rm-row">
            <span class="rm-label">{{ t('readingMode.granularity') }}</span>
            <div class="segmented">
              <button
                v-for="u in units"
                :key="u.value"
                type="button"
                :class="{ active: tw.unit === u.value }"
                :aria-pressed="tw.unit === u.value"
                @click="settings.readingMode.typewriter.unit = u.value"
              >
                {{ t(u.key) }}
              </button>
            </div>
          </div>

          <!-- 打字机速度 -->
          <template v-if="showSpeed">
            <div class="rm-row">
              <span class="rm-label">{{ t('readingMode.speed') }}</span>
              <button type="button" class="rm-step" :title="t('readingMode.slower')" :aria-label="t('readingMode.slower')" @click="modes.adjustSpeed(-1)">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5 12a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
              </button>
              <input
                class="rm-range"
                type="range"
                :min="modes.speedLimits.value[0]"
                :max="modes.speedLimits.value[1]"
                step="10"
                :value="modes.speed.value"
                :aria-label="t('readingMode.speed')"
                :aria-valuetext="modes.speedText.value"
                @input="onSpeedInput"
              />
              <button type="button" class="rm-step" :title="t('readingMode.faster')" :aria-label="t('readingMode.faster')" @click="modes.adjustSpeed(1)">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"/></svg>
              </button>
              <!-- 直接输入具体速度; 越界时收敛到可用范围并回显 -->
              <label class="rm-value rm-speed-field">
                <input
                  class="rm-speed-input"
                  type="number"
                  inputmode="numeric"
                  :min="modes.speedLimits.value[0]"
                  :max="modes.speedLimits.value[1]"
                  step="10"
                  :value="modes.speed.value"
                  :aria-label="t('readingMode.speedExact', { min: modes.speedLimits.value[0], max: modes.speedLimits.value[1] })"
                  :title="t('readingMode.speedExact', { min: modes.speedLimits.value[0], max: modes.speedLimits.value[1] })"
                  @change="onSpeedExact"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <span>{{ modes.speedUnit.value === 'cpm' ? t('readingMode.unitCpm') : t('readingMode.unitWpm') }}</span>
              </label>
            </div>
            <div class="rm-presets">
              <button
                v-for="(n, i) in modes.presets.value"
                :key="n"
                type="button"
                class="rm-chip"
                :class="{ on: modes.speed.value === n }"
                :aria-pressed="modes.speed.value === n"
                :title="modes.speedUnit.value === 'cpm' ? t('readingMode.cpm', { n }) : t('readingMode.wpm', { n })"
                @click="modes.speed.value = n"
              >
                {{ t(presetLabels[i]) }}
              </button>
            </div>
          </template>

          <!-- 打字机: 后文 / 开关 -->
          <template v-if="tab === 'typewriter'">
            <div class="rm-row">
              <span class="rm-label">{{ t('readingMode.upcoming') }}</span>
              <div class="segmented">
                <button
                  type="button"
                  :class="{ active: tw.upcoming === 'hidden' }"
                  :aria-pressed="tw.upcoming === 'hidden'"
                  @click="settings.readingMode.typewriter.upcoming = 'hidden'"
                >
                  {{ t('readingMode.upcomingHidden') }}
                </button>
                <button
                  type="button"
                  :class="{ active: tw.upcoming === 'ghost' }"
                  :aria-pressed="tw.upcoming === 'ghost'"
                  @click="settings.readingMode.typewriter.upcoming = 'ghost'"
                >
                  {{ t('readingMode.upcomingGhost') }}
                </button>
              </div>
            </div>
          </template>

          <div class="rm-toggles">
            <label class="rm-toggle">
              <span>{{ t('readingMode.punctuationPause') }}</span>
              <span class="rm-switch">
                <input v-model="settings.readingMode.typewriter.punctuationPause" type="checkbox" role="switch" :aria-checked="tw.punctuationPause" />
                <span class="rm-switch-track" aria-hidden="true"></span>
              </span>
            </label>
            <template v-if="tab === 'typewriter'">
              <label class="rm-toggle">
                <span>{{ t('readingMode.freshInk') }}</span>
                <span class="rm-switch">
                  <input v-model="settings.readingMode.typewriter.freshInk" type="checkbox" role="switch" :aria-checked="tw.freshInk" />
                  <span class="rm-switch-track" aria-hidden="true"></span>
                </span>
              </label>
              <label class="rm-toggle">
                <span>{{ t('readingMode.sound') }}</span>
                <span class="rm-switch">
                  <input v-model="settings.readingMode.typewriter.sound" type="checkbox" role="switch" :aria-checked="tw.sound" />
                  <span class="rm-switch-track" aria-hidden="true"></span>
                </span>
              </label>
              <!-- 打字声音色 (CC0 录音, 见 docs/ambient-sources.md) + 音量 + 试听 -->
              <div v-if="tw.sound" class="rm-sound">
                <div class="rm-sound-presets" role="radiogroup" :aria-label="t('readingMode.soundPreset')">
                  <button
                    v-for="p in TYPING_SOUND_PRESETS"
                    :key="p.id"
                    type="button"
                    role="radio"
                    class="rm-chip"
                    :class="{ on: tw.soundPreset === p.id }"
                    :aria-checked="tw.soundPreset === p.id"
                    @click="settings.readingMode.typewriter.soundPreset = p.id; void previewTypingSound(p.id, tw.soundVolume)"
                  >{{ t(p.nameKey) }}</button>
                </div>
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.soundVolume') }}</span>
                  <input
                    v-model.number="settings.readingMode.typewriter.soundVolume"
                    class="rm-sound-volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    :aria-label="t('readingMode.soundVolume')"
                  />
                  <span class="rm-value">{{ Math.round(tw.soundVolume * 100) }}%</span>
                  <button type="button" class="btn btn-sm" @click="void previewTypingSound(tw.soundPreset, tw.soundVolume)">{{ t('readingMode.soundPreview') }}</button>
                </div>
              </div>
            </template>
          </div>

          <p class="rm-hint">{{ t('readingMode.typewriterHint') }}</p>
          <p v-if="modes.reducedMotion.value && tab === 'typewriter'" class="rm-hint">{{ t('readingMode.reducedMotionHint') }}</p>
        </fieldset>

        <!-- 打字机 -->
        <div v-if="tab === 'typewriter'" class="rm-actions">
          <template v-if="!twActive">
            <button type="button" class="btn btn-primary rm-main" :disabled="!supported" @click="modes.start()">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
              {{ t('readingMode.startFromPage') }}
            </button>
          </template>
          <template v-else>
            <button type="button" class="btn btn-primary rm-main" @click="modes.togglePause()">
              <svg v-if="twState === 'paused'" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
              <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
              {{ twState === 'paused' ? t('common.resume') : t('common.pause') }}
            </button>
            <button type="button" class="btn rm-main" @click="modes.stop()">
              {{ t('readingMode.exitTypewriter') }}
            </button>
          </template>
        </div>
        <p class="rm-keys">{{ t('readingMode.keysHint') }}</p>
      </div>
      <p class="rm-hint">{{ t('readingMode.guideExclusive') }}</p>
    </section>

  </section>
</template>

<style scoped>
.rm-sound {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 6px;
}
.rm-sound-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rm-sound-volume {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.rm-panel {
  position: absolute;
  top: calc(52px + var(--safe-top, 0px));
  right: 12px;
  z-index: 25;
  width: min(400px, calc(100% - 24px));
  max-height: calc(100% - 72px - var(--safe-top, 0px) - var(--safe-bottom, 0px));
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
}
.rm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rm-head strong {
  font-size: 15px;
}
.rm-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.rm-close:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rm-progress-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.rm-progress-chapter {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 12px;
}
.rm-progress-eta {
  flex-shrink: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.rm-progress-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  overflow: hidden;
}
.rm-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--brand);
  transform-origin: left center;
  transition: transform 0.4s ease;
}
.rm-progress-sub {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rm-progress-sub span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm-tabs {
  align-self: flex-start;
}
.rm-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rm-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.rm-fields:disabled {
  opacity: 0.5;
}
.rm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.rm-label {
  flex-shrink: 0;
  width: 64px;
  font-size: 13px;
  color: var(--text-2);
}
.rm-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.rm-speed-field {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.rm-speed-input {
  width: 64px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.rm-speed-input::-webkit-outer-spin-button,
.rm-speed-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.rm-speed-input:focus {
  outline: none;
  border-color: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-soft);
}
.rm-value {
  flex-shrink: 0;
  min-width: 72px;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rm-step {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-step:hover {
  color: var(--brand);
  border-color: var(--brand);
}
.rm-step:focus-visible,
.rm-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 74px;
}
.rm-chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.rm-chip:hover {
  color: var(--text);
}
.rm-chip.on {
  border-color: var(--brand);
  background: var(--brand-light);
  color: var(--brand);
}
.rm-toggles {
  display: flex;
  flex-direction: column;
}
.rm-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.rm-toggle + .rm-toggle {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.rm-switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
}
.rm-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.rm-switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.rm-switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--on-brand);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.rm-switch input:checked + .rm-switch-track {
  background: var(--brand);
}
.rm-switch input:checked + .rm-switch-track::after {
  transform: translateX(16px);
}
.rm-switch input:focus-visible + .rm-switch-track {
  box-shadow: var(--ring);
}
.rm-hint,
.rm-keys,
.rm-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.rm-note {
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-2);
}
.rm-actions {
  display: flex;
  gap: 8px;
}
.rm-main {
  flex: 1;
  justify-content: center;
}
.auto-panel .rm-main {
  flex: none;
  align-self: stretch;
}
@media (hover: none) {
  .rm-keys {
    display: none;
  }
}
@media (max-width: 600px) {
  /* 16px 以下 iOS 聚焦时会放大页面 */
  .rm-speed-input {
    font-size: 16px;
  }
  .rm-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 78%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right, 0px)) calc(16px + var(--safe-bottom, 0px)) max(16px, var(--lr-safe-left, 0px));
    box-shadow: var(--shadow-lg);
    gap: 14px;
    animation: rm-sheet-up var(--dur-slow) var(--ease);
  }
  .rm-panel::before {
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
  .rm-label {
    width: 52px;
  }
  .rm-presets {
    padding-left: 62px;
  }
  .rm-value {
    min-width: 64px;
  }
  .rm-step,
  .rm-close {
    width: 44px;
    height: 44px;
  }
  .rm-chip {
    height: 32px;
  }
  .rm-main {
    min-height: 44px;
  }
}
@keyframes rm-sheet-up {
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
  .rm-panel,
  .rm-switch-track,
  .rm-switch-track::after {
    animation: none;
    transition: none;
  }
}

/* 点睛开关 (插槽) 自带下边线, 与下方分组的上边线重复: 只留一条 */
.rm-panel :slotted(.dj-toggle) {
  border-bottom: none;
}

/* ---- 分组与开关卡片 ---- */
.rm-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.rm-group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.rm-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.rm-card {
  position: relative;
  min-width: 0;
}
.rm-card-main {
  width: 100%;
  min-height: 72px;
  /* 顶部留出角上 ⓘ 的位置 */
  padding: 14px 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.rm-card-main:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.rm-card-main:focus-visible,
.rm-card-info:focus-visible,
.rm-time:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-card.on .rm-card-main {
  border-color: var(--brand);
  background: var(--brand-light);
  color: var(--brand);
}
.rm-card.open .rm-card-main {
  box-shadow: 0 0 0 1px var(--brand) inset;
}
.rm-card-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: inherit;
}
.rm-card-state {
  font-size: 11px;
  color: var(--text-3);
}
.rm-card.on .rm-card-state {
  color: var(--brand);
}
.rm-card-info {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-card-info:hover,
.rm-card.open .rm-card-info {
  color: var(--brand);
}
.rm-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
}
.rm-detail .rm-toggle + .rm-toggle {
  border-top: none;
}
.rm-changes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.rm-changes-label {
  margin-right: 2px;
  font-size: 12px;
  color: var(--text-3);
}
.rm-change {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.rm-self-start {
  align-self: flex-start;
}
.rm-tune {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 28px;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-sm);
}
.rm-tune:hover {
  text-decoration: underline;
}
.rm-tune:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-clock {
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--text-2);
}
.rm-time {
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.rm-tabs button.running {
  position: relative;
}
.rm-tabs button.running::after {
  content: '';
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}
@media (pointer: coarse) {
  .rm-card-info {
    width: 30px;
    height: 30px;
    top: 0;
    right: 0;
  }
  /* 触屏: 可点区域往卡片外扩 (卡片中部仍归开关) */
  .rm-card-info::before {
    content: '';
    position: absolute;
    inset: -6px -6px 0 0;
  }
  .rm-tune {
    min-height: 44px;
  }
  .rm-panel .segmented button {
    min-height: 40px;
  }
  .rm-chip {
    height: 40px;
  }
  .rm-step,
  .rm-close {
    width: 44px;
    height: 44px;
  }
  .rm-speed-input,
  .rm-time {
    height: 40px;
  }
  .rm-toggle,
  .rm-main {
    min-height: 44px;
  }
}
@media (max-width: 600px) {
  .rm-card-main {
    min-height: 76px;
  }
}
@media (max-width: 360px) {
  .rm-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (prefers-reduced-motion: reduce) {
  .rm-card-main {
    transition: none;
  }
}
</style>
