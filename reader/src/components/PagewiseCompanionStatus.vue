<script setup lang="ts">
/**
 * 阅读区角落的伴读状态点 (§4.2 / §6.8 R8): 伴读中为灰点, 不打扰阅读;
 * 额度用完 / 出错 / 离线时变成可点的小图标, 点开说明原因 (额度或密钥问题可跳设置)。
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { t } from '../i18n'
import type { PagewiseCompanionController } from '../composables/usePagewiseCompanion'

const props = defineProps<{ dj: PagewiseCompanionController }>()
const emit = defineEmits<{ 'open-settings': [] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const popId = useId()
const viewportHeight = ref('100dvh')
let frame = 0
function schedule() {
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0
    viewportHeight.value = `${window.visualViewport?.height ?? window.innerHeight}px`
  })
}
function close(restore = false) {
  open.value = false
  if (restore) trigger.value?.focus({ preventScroll: true })
}
function onKey(event: KeyboardEvent) {
  if (open.value && event.key === 'Escape' && !event.isComposing) {
    event.preventDefault()
    event.stopImmediatePropagation()
    close(true)
  }
}
function onPointer(event: PointerEvent) {
  if (open.value && !event.composedPath().includes(root.value as EventTarget)) close()
}
function onFocus(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) close()
}
onMounted(() => {
  schedule()
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('pointerdown', onPointer, true)
  window.removeEventListener('resize', schedule)
  window.visualViewport?.removeEventListener('resize', schedule)
})
const status = computed(() => props.dj.status.value)
const visible = computed(() => props.dj.active.value && ['loading', 'quota', 'error', 'offline'].includes(status.value))
const alert = computed(() => status.value !== 'loading')
watch(visible, value => { if (!value) close() })
const message = computed(() => {
  const code = props.dj.errorCode.value
  if (status.value === 'quota') return t(code === 'budget' ? 'companion.statusBudget' : 'companion.statusQuota')
  if (status.value === 'offline') return t('companion.statusOffline')
  if (status.value === 'error') {
    if (code === 'version') return t('companion.statusVersion')
    if (code === 'config') return t('companion.statusConfig')
    if (code === 'auth') return t('companion.statusAuth')
    return t('companion.statusError')
  }
  return t('companion.statusLoading', { pct: Math.round(props.dj.progress.value * 100) })
})
const canFix = computed(() => status.value === 'quota' || ['config', 'auth', 'version'].includes(props.dj.errorCode.value ?? ''))
/** 智能版眼下用不了: 一步换成伴读基础版 (不联网) */
const offerBasic = computed(() => canFix.value || status.value === 'offline')
</script>

<template>
  <div v-if="visible" ref="root" class="dj-status-dot" :class="{ alert }" :style="{ '--dj-viewport-height': viewportHeight }" @focusout="onFocus">
    <button
      ref="trigger"
      type="button"
      class="dj-dot-btn"
      :aria-label="t('companion.statusDot') + ' · ' + message"
      :title="message"
      :aria-expanded="open"
      :aria-controls="open ? popId : undefined"
      aria-haspopup="dialog"
      @click.stop="open = !open"
    >
      <svg v-if="alert" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 4.5v4.2M8 10.8v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <span v-else class="dj-dot" aria-hidden="true"></span>
    </button>
    <div v-if="open" :id="popId" class="dj-pop" role="dialog" :aria-label="t('companion.statusDot')">
      <p role="status">{{ message }}</p>
      <div v-if="canFix || offerBasic" class="dj-pop-actions">
        <button v-if="canFix" type="button" class="btn btn-sm btn-primary" @click="open = false; emit('open-settings')">{{ t('companion.openSettings') }}</button>
        <button v-if="offerBasic" type="button" class="btn btn-sm" @click="open = false; dj.switchToBasic()">{{ t('companion.useBasic') }}</button>
      </div>
      <button type="button" class="btn btn-sm" @click="close(true)">{{ t('companion.close') }}</button>
    </div>
  </div>
</template>

<style scoped>
.dj-status-dot {
  --dj-footer-offset: 0px;
  position: fixed;
  right: max(12px, var(--lr-safe-right, 0px));
  bottom: calc(var(--dj-footer-offset) + var(--lr-safe-bottom, 0px) + 12px);
  display: inline-flex;
  z-index: 40;
}
.reader.bars-on .dj-status-dot {
  --dj-footer-offset: var(--footer-h, 64px);
}
.dj-dot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: none;
  background: var(--card);
  color: var(--warning);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
}
.dj-dot-btn:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: -3px;
}
.dj-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  opacity: 0.7;
}
.dj-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  box-sizing: border-box;
  width: min(300px, calc(100vw - max(12px, var(--lr-safe-left, 0px)) - max(12px, var(--lr-safe-right, 0px))));
  max-height: calc(var(--dj-viewport-height) - var(--dj-footer-offset) - var(--lr-safe-bottom, 0px) - var(--lr-safe-top, 0px) - 84px);
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  z-index: 40;
}
.dj-pop p {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
}
.dj-pop button {
  min-width: 48px;
  min-height: 48px;
  height: auto;
  white-space: normal;
}
.dj-pop button:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: -3px;
}
.dj-pop .btn-primary {
  background: var(--text);
  color: var(--card);
  border-color: var(--text);
}
.dj-pop .btn-primary:focus-visible {
  outline-color: var(--card);
}
.dj-pop-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
