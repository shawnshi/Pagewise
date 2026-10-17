<script setup lang="ts">
/**
 * 打字机 / 自动翻页运行时的迷你控制条:
 * - 打字机: [暂停/继续] 300 字/分 · 本章约 8 分钟 [−][+] [退出];
 * - 自动翻页 / 自动滚动 (ReaderView 的实现, 经 auto* props 传入): [暂停/继续] 15 秒/屏 [−][+] [退出]。
 * 悬浮在底部居中 (工具栏出现时让到底栏上方); 运行 3 秒后淡出, 暂停 / 即将翻页时常驻。
 * 状态文字在 aria-live 区域里播报。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import type { ReadingModes } from '../composables/useReadingModes'
import type { ReadingModeProgress } from '../services/readingModes/progress'

const props = defineProps<{
  modes: ReadingModes
  /** 阅读器工具栏是否显示 (ReaderView 的 barsVisible) */
  barsVisible?: boolean
  /** 读到哪 / 还要多久 (阅读器计算) */
  progress?: ReadingModeProgress | null
  /** 自动翻页 / 自动滚动的状态 (未开为 null); 打字机优先 */
  autoState?: 'running' | 'paused' | null
  /** 自动翻页的速度文字 (15 秒/页、15 秒/屏) */
  autoSpeedText?: string
  /** 滚动模式: 正文铺满全高, 停靠细条垫上正文底色当页脚, 不和滚过的文字叠在一起 */
  solid?: boolean
}>()

const emit = defineEmits<{
  'auto-toggle': []
  'auto-speed': [dir: 1 | -1]
  'auto-stop': []
}>()

const guide = computed(() => props.modes.activeGuide.value)
/** 自动翻页模式 (没有打字机在跑时) */
const isAuto = computed(() => guide.value === null && !!props.autoState)
const state = computed(() => isAuto.value ? props.autoState! : props.modes.guideState.value)
const visible = computed(() => guide.value !== null || isAuto.value)
const paused = computed(() => state.value === 'paused')
const speedText = computed(() => isAuto.value ? (props.autoSpeedText ?? '') : props.modes.speedText.value)

function togglePause() {
  if (isAuto.value) emit('auto-toggle')
  else props.modes.togglePause()
}
function adjust(dir: 1 | -1) {
  if (isAuto.value) emit('auto-speed', dir)
  else props.modes.adjustSpeed(dir)
}
function exit() {
  if (isAuto.value) emit('auto-stop')
  else props.modes.stop()
}

const statusText = computed(() => {
  if (isAuto.value) return paused.value ? t('readingMode.statusPaused') : t('readingMode.tabAuto')
  if (state.value === 'paused') return t('readingMode.statusPaused')
  if (state.value === 'turning') return t('readingMode.statusTurning')
  return t('readingMode.statusRunning')
})
const label = computed(() => t(isAuto.value ? 'readingMode.tabAuto' : 'readingMode.tabTypewriter'))
const exitLabel = computed(() => t(isAuto.value ? 'readingMode.exitAuto' : 'readingMode.exitTypewriter'))

const faded = ref(false)
let fadeTimer: ReturnType<typeof setTimeout> | undefined

function wake() {
  faded.value = false
  clearTimeout(fadeTimer)
  if (state.value === 'running') fadeTimer = setTimeout(() => { faded.value = true }, 3000)
}

watch([state, () => props.barsVisible, guide, isAuto], wake, { immediate: true })

/**
 * 工具栏隐藏时 (正常阅读) 收成一条细条, 停在正文下方的页脚留白里, 不压正文、不用卡片底;
 * 工具栏出现时才以完整卡片浮在底栏上方 (此时工具栏本就遮着正文)。
 */
const docked = computed(() => !props.barsVisible)
onBeforeUnmount(() => clearTimeout(fadeTimer))
</script>

<template>
  <div
    v-if="visible"
    class="rm-mini"
    :class="[docked ? 'docked' : 'card lifted', { solid: docked && solid }]"
    role="group"
    :aria-label="label"
    @pointerenter="wake"
    @focusin="wake"
  >
    <button
      type="button"
      class="rm-mini-btn primary"
      :title="paused ? t('common.resume') : t('common.pause')"
      :aria-label="paused ? t('common.resume') : t('common.pause')"
      @click="togglePause(); wake()"
    >
      <svg v-if="paused" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
    </button>
    <span class="rm-mini-status" aria-live="polite">
      <span class="rm-mini-state">{{ statusText }}</span>
      <span class="rm-mini-speed">
        {{ speedText }}<template v-if="progress && !isAuto"> · </template><template v-if="progress && !isAuto">{{ progress.chapterLeftShort ? t('readingMode.miniLeft', { time: progress.chapterLeftShort }) : progress.percent }}</template>
      </span>
    </span>
    <template v-if="!docked">
      <button
        type="button"
        class="rm-mini-btn"
        :title="t('readingMode.slower')"
        :aria-label="t('readingMode.slower')"
        @click="adjust(-1); wake()"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5 12a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
      </button>
      <button
        type="button"
        class="rm-mini-btn"
        :title="t('readingMode.faster')"
        :aria-label="t('readingMode.faster')"
        @click="adjust(1); wake()"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"/></svg>
      </button>
    </template>
    <button
      type="button"
      class="rm-mini-btn"
      :title="exitLabel"
      :aria-label="exitLabel"
      @click="exit()"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
    </button>
  </div>
</template>

<style scoped>
.rm-mini {
  position: absolute;
  left: 50%;
  bottom: calc(16px + var(--safe-bottom, 0px));
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-md);
  white-space: nowrap;
  transition:
    opacity var(--dur-slow) var(--ease),
    visibility var(--dur-slow) var(--ease),
    bottom var(--dur) var(--ease);
}
.rm-mini.lifted {
  bottom: calc(var(--footer-h, 64px) + 12px + var(--safe-bottom, 0px));
}
.rm-mini.faded {
  opacity: 0;
  visibility: hidden;
}
/* 停靠: 页脚留白里的一条细条, 透明底, 跟随正文颜色, 低对比 */
.rm-mini.docked {
  left: 0;
  right: 0;
  transform: none;
  bottom: var(--safe-bottom, 0px);
  height: 36px;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  border-radius: 0;
  background: none;
  box-shadow: none;
  color: inherit;
  opacity: 0.72;
}
.rm-mini.docked .rm-mini-btn {
  width: 30px;
  height: 30px;
  color: inherit;
}
.rm-mini.docked .rm-mini-btn.primary {
  background: none;
  color: inherit;
}
.rm-mini.docked .rm-mini-btn:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.rm-mini.docked .rm-mini-status {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.rm-mini.docked .rm-mini-state,
.rm-mini.docked .rm-mini-speed {
  color: inherit;
  font-size: 12px;
}
@media (min-width: 601px) {
  .rm-mini.docked {
    height: 48px;
  }
}
/* 底色取阅读器根元素的正文主题背景 (父元素内联 background) */
.rm-mini.docked.solid {
  background: inherit;
  opacity: 1;
}
.rm-mini.docked.solid .rm-mini-status,
.rm-mini.docked.solid .rm-mini-btn {
  opacity: 0.72;
}
.rm-mini-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.rm-mini-btn:hover {
  background: var(--brand-light);
  color: var(--brand);
}
.rm-mini-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-mini-btn.primary {
  background: var(--brand);
  color: var(--on-brand);
}
.rm-mini-btn.primary:hover {
  background: var(--brand-hover);
  color: var(--on-brand);
}
.rm-mini-status {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 0 6px;
  line-height: 1.25;
  min-width: 64px;
}
.rm-mini-state {
  font-size: 11px;
  color: var(--text-3);
}
.rm-mini-speed {
  font-size: 13px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
@media (pointer: coarse), (max-width: 600px) {
  .rm-mini-btn {
    width: 44px;
    height: 44px;
  }
}
/* 停靠细条的按钮看起来 30px (塞进页脚留白不压正文), 触屏上用透明外扩把可点区域补到 44px */
@media (pointer: coarse) {
  .rm-mini.docked .rm-mini-btn {
    position: relative;
  }
  .rm-mini.docked .rm-mini-btn::before {
    content: '';
    position: absolute;
    inset: -7px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rm-mini {
    transition: none;
  }
}
</style>
