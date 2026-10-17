<script setup lang="ts">
/**
 * 阅读模式在阅读器外壳上的覆盖层 (挂在 .reader 里, 与 ReadingModeMini 同级):
 * - 护眼的应用内调暗: 黑色半透明遮罩, pointer-events:none (Android 可改用原生窗口亮度, 数值同一来源);
 * - 20-20-20 休息提醒: 不打断阅读的轻提示, 20 秒倒计时, 可「跳过」或「30 分钟内不再提醒」;
 * - (可选) 墨水屏设备提示: suggestEink 为 true 时显示一次;
 * - 全局样式: .reader.lr-eink (去掉一切过渡动画) / .lr-large-ui (工具栏按钮放大) / .lr-immersive (边缘悬停不呼出工具栏)。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import type { ReadingModes } from '../composables/useReadingModes'

const props = defineProps<{
  modes: ReadingModes
  /** 显示墨水屏设备提示 (阅读器按 modes.einkSuggested 决定) */
  suggestEink?: boolean
}>()

const settings = useSettings()

// ---- 休息提醒: 20 秒倒计时 ----
const REST_SECONDS = 20
const left = ref(REST_SECONDS)
let tick: ReturnType<typeof setInterval> | undefined
watch(() => props.modes.reminderDue.value, due => {
  clearInterval(tick)
  left.value = REST_SECONDS
  if (due) tick = setInterval(() => {
    if (left.value > 0) left.value--
    else clearInterval(tick)
  }, 1000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(tick))

const interval = computed(() => settings.readingMode.eyeCare.intervalMin)

function acceptEink() {
  props.modes.setEink(true)
  props.modes.dismissEinkSuggestion()
}
</script>

<template>
  <div v-if="modes.dimOverlayStyle.value" class="rm-dim" :style="modes.dimOverlayStyle.value" aria-hidden="true" />

  <div v-if="modes.reminderDue.value" class="rm-banner card" role="status" aria-live="polite">
    <svg class="rm-banner-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 5c4.6 0 8.3 3 9.9 6.6a1 1 0 0 1 0 .8C20.3 16 16.6 19 12 19s-8.3-3-9.9-6.6a1 1 0 0 1 0-.8C3.7 8 7.4 5 12 5zm0 2c-3.5 0-6.5 2.2-7.9 5 1.4 2.8 4.4 5 7.9 5s6.5-2.2 7.9-5c-1.4-2.8-4.4-5-7.9-5zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>
    <div class="rm-banner-text">
      <strong>{{ t('readingMode.reminderTitle') }}</strong>
      <span>{{ t('readingMode.reminderBody', { n: interval }) }}<template v-if="left > 0"> · {{ t('readingMode.reminderCountdown', { n: left }) }}</template></span>
    </div>
    <div class="rm-banner-actions">
      <button type="button" class="btn btn-primary" @click="modes.dismissReminder('done')">{{ t('readingMode.reminderDone') }}</button>
      <button type="button" class="btn" @click="modes.dismissReminder('skip')">{{ t('readingMode.reminderSkip') }}</button>
      <button type="button" class="btn" @click="modes.dismissReminder('snooze')">{{ t('readingMode.reminderSnooze') }}</button>
    </div>
  </div>

  <div v-else-if="suggestEink" class="rm-banner card" role="status">
    <div class="rm-banner-text">
      <span>{{ t('readingMode.einkSuggest') }}</span>
    </div>
    <div class="rm-banner-actions">
      <button type="button" class="btn btn-primary" @click="acceptEink">{{ t('readingMode.modeEink') }}</button>
      <button type="button" class="btn" @click="modes.dismissEinkSuggestion()">{{ t('common.close') }}</button>
    </div>
  </div>
</template>

<style scoped>
.rm-dim {
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
}
.rm-banner {
  position: absolute;
  top: calc(12px + var(--safe-top, 0px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  width: min(440px, calc(100% - 32px));
  padding: 12px 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  box-shadow: var(--shadow-md);
  color: var(--text);
}
.rm-banner-icon {
  flex-shrink: 0;
  color: var(--brand);
}
.rm-banner-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  line-height: 1.5;
}
.rm-banner-text span {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.rm-banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  justify-content: flex-end;
}
@media (pointer: coarse) {
  .rm-banner-actions .btn {
    min-height: 44px;
  }
}
</style>

<!-- 阅读器外壳的模式类名 (useReadingModes().shellClass); 只作用于 .reader 之内 -->
<style>
/* 墨水屏: 外壳去掉一切过渡与动画 (翻页动画由阅读器去掉 foliate 的 animated 属性) */
.reader.lr-eink,
.reader.lr-eink *,
.reader.lr-eink *::before,
.reader.lr-eink *::after {
  transition: none !important;
  animation: none !important;
  scroll-behavior: auto !important;
}
/* 大字: 工具栏图标 28px, 触控区域 ≥60×60 (工信部适老化规范) */
.reader.lr-large-ui .icon-btn {
  width: 44px;
  height: 44px;
}
.reader.lr-large-ui .icon-btn svg {
  width: 24px;
  height: 24px;
}
@media (pointer: coarse) {
  .reader.lr-large-ui .icon-btn {
    width: 60px;
    height: 60px;
  }
  .reader.lr-large-ui .icon-btn svg,
  .reader.lr-large-ui .dock button svg {
    width: 28px;
    height: 28px;
  }
  .reader.lr-large-ui .dock button {
    min-height: 60px;
    font-size: 14px;
  }
}
/* 沉浸: 鼠标移到上下边缘不呼出工具栏, 只在轻点时出现 */
.reader.lr-immersive .bar-peek {
  display: none;
}
</style>
