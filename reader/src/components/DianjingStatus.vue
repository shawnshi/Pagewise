<script setup lang="ts">
/**
 * 阅读区角落的点睛状态点 (§4.2 / §6.8 R8): 点睛中为灰点, 不打扰阅读;
 * 额度用完 / 出错 / 离线时变成可点的小图标, 点开说明原因 (额度或密钥问题可跳设置)。
 */
import { computed, ref } from 'vue'
import { t } from '../i18n'
import type { Dianjing } from '../composables/useDianjing'

const props = defineProps<{ dj: Dianjing }>()
const emit = defineEmits<{ 'open-settings': [] }>()

const open = ref(false)
const status = computed(() => props.dj.status.value)
const visible = computed(() => props.dj.active.value && ['loading', 'quota', 'error', 'offline'].includes(status.value))
const alert = computed(() => status.value !== 'loading')
const message = computed(() => {
  const code = props.dj.errorCode.value
  if (status.value === 'quota') return t(code === 'budget' ? 'dianjing.statusBudget' : 'dianjing.statusQuota')
  if (status.value === 'offline') return t('dianjing.statusOffline')
  if (status.value === 'error') {
    if (code === 'config') return t('dianjing.statusConfig')
    if (code === 'auth') return t('dianjing.statusAuth')
    return t('dianjing.statusError')
  }
  return t('dianjing.statusLoading', { pct: Math.round(props.dj.progress.value * 100) })
})
const canFix = computed(() => status.value === 'quota' || ['config', 'auth'].includes(props.dj.errorCode.value ?? ''))
/** 智能版眼下用不了: 一步换成点睛阅读基础版 (不联网) */
const offerBasic = computed(() => canFix.value || status.value === 'offline')
</script>

<template>
  <div v-if="visible" class="dj-status-dot" :class="{ alert }">
    <button
      type="button"
      class="dj-dot-btn"
      :aria-label="t('dianjing.statusDot') + ' · ' + message"
      :title="message"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <svg v-if="alert" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 4.5v4.2M8 10.8v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <span v-else class="dj-dot" aria-hidden="true"></span>
    </button>
    <div v-if="open" class="dj-pop" role="status">
      <p>{{ message }}</p>
      <div v-if="canFix || offerBasic" class="dj-pop-actions">
        <button v-if="canFix" type="button" class="btn btn-sm btn-primary" @click="open = false; emit('open-settings')">{{ t('dianjing.openSettings') }}</button>
        <button v-if="offerBasic" type="button" class="btn btn-sm" @click="open = false; dj.switchToBasic()">{{ t('dianjing.useBasic') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dj-status-dot {
  position: relative;
  display: inline-flex;
}
.dj-dot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--warning);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
}
.dj-dot-btn:focus-visible {
  box-shadow: var(--ring);
  outline: none;
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
  width: min(260px, 80vw);
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
.dj-pop-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
