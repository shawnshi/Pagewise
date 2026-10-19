<script setup lang="ts">
/**
 * 点睛卡片 (§4.3 §4.4 §4.7): 概念释义 / 注 / 要句「为什么标」。
 * 位置贴着原文 (在其下方, 放不下时在上方), 样式与选中工具条同级; 手机上为底部抽屉。
 * 所有 AI 内容标明来源 (R5); 每条都能一键否掉 (R4)。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import type { Dianjing } from '../composables/useDianjing'
import type { KeyItem, NoteItem, TermItem } from '../services/dianjing/protocol'

const props = defineProps<{ dj: Dianjing }>()
const emit = defineEmits<{ close: []; inspect: [] }>()

const el = ref<HTMLElement | null>(null)
const pos = ref<{ left: number; top: number } | null>(null)

const state = computed(() => props.dj.card.value)
const kind = computed(() => state.value?.target.kind ?? 'term')
const item = computed(() => state.value?.target.item)
const term = computed(() => (kind.value === 'term' ? (item.value as TermItem) : null))
const note = computed(() => (kind.value === 'note' ? (item.value as NoteItem) : null))
const key = computed(() => (kind.value === 'key' ? (item.value as KeyItem) : null))
const heading = computed(() => t(kind.value === 'key' ? 'dianjing.keySentence' : kind.value === 'note' ? 'dianjing.note' : 'dianjing.concept'))
const noteKind = computed(() => {
  const k = note.value?.k
  return k === 'allusion' ? t('dianjing.noteAllusion') : k === 'history' ? t('dianjing.noteHistory') : t('dianjing.noteCulture')
})

function close() {
  props.dj.closeCard()
  emit('close')
}

function place() {
  const s = state.value
  const box = el.value
  if (!s || !box) return
  if (window.matchMedia?.('(max-width: 600px)').matches) { pos.value = null; return }
  const w = box.offsetWidth
  const h = box.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = Math.min(Math.max(12, (s.rect.left + s.rect.right) / 2 - w / 2), vw - w - 12)
  let top = s.rect.bottom + 10
  if (top + h > vh - 12) top = Math.max(12, s.rect.top - h - 10)
  pos.value = { left, top }
}

const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close() } }
onMounted(async () => {
  await nextTick()
  place()
  el.value?.focus()
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', place)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', place)
})
</script>

<template>
  <div v-if="state" class="dj-card-layer" @click.self="close" @pointerdown.stop @touchstart.stop @touchend.stop>
    <div
      ref="el"
      class="dj-card"
      :class="'is-' + kind"
      role="dialog"
      :aria-label="heading"
      tabindex="-1"
      :style="pos ? { left: pos.left + 'px', top: pos.top + 'px' } : undefined"
    >
      <header class="dj-card-head">
        <span class="dj-card-kind">
          <span class="dj-mark" aria-hidden="true"></span>
          {{ heading }}
        </span>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" :aria-label="t('dianjing.close')" :title="t('dianjing.close')" @click="close">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </header>

      <template v-if="term">
        <p class="dj-card-term">{{ term.q }}</p>
        <p class="dj-card-text">{{ term.def }}</p>
      </template>
      <template v-else-if="note">
        <p class="dj-card-term">{{ note.q }} <span class="tag">{{ noteKind }}</span></p>
        <p class="dj-card-text">{{ note.text }}</p>
      </template>
      <template v-else-if="key">
        <p class="dj-card-label">{{ t('dianjing.why') }}</p>
        <p class="dj-card-text">{{ key.why || '—' }}</p>
      </template>

      <p v-if="state.translation" class="dj-card-tr">{{ state.translation }}</p>
      <p v-if="state.translating" class="dj-card-muted">{{ t('dianjing.translating') }}</p>
      <p v-else-if="state.translateError" class="dj-card-muted">{{ t('dianjing.translateFailed') }}</p>

      <p class="dj-card-source">
        {{ t('dianjing.aiSource') }}<template v-if="note && note.k !== 'allusion'"> · {{ t('dianjing.outside') }}</template>
      </p>

      <p class="dj-card-source">{{ t('reader.analysisAvailable') }} · {{ state.target.text }}</p>
      <div class="dj-card-actions">
        <button type="button" class="btn btn-sm" @click="emit('inspect')">{{ t('reader.viewSource') }}</button>
        <template v-if="kind === 'term'">
          <button type="button" class="btn btn-sm" @click="dj.expand()">{{ t('dianjing.expand') }}</button>
          <button type="button" class="btn btn-sm" :disabled="state.translating || (!!state.translation && !state.translateError)" @click="dj.translate()">{{ t('dianjing.translate') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="dj.dismiss()">{{ t('dianjing.notThis') }}</button>
        </template>
        <template v-else-if="kind === 'note'">
          <button type="button" class="btn btn-sm" @click="dj.expand()">{{ t('dianjing.expand') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="dj.dismiss()">{{ t('dianjing.notThis') }}</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-sm btn-primary" :title="t('dianjing.agreeHint')" @click="dj.adopt(false)">{{ t('dianjing.agree') }}</button>
          <button type="button" class="btn btn-sm" @click="dj.adopt(true)">{{ t('dianjing.addNote') }}</button>
          <button type="button" class="btn btn-sm" :disabled="state.translating || (!!state.translation && !state.translateError)" @click="dj.translate()">{{ t('dianjing.translate') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="dj.dismiss()">{{ t('dianjing.notKey') }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dj-card-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.dj-card {
  position: fixed;
  left: 50%;
  top: 30%;
  width: min(340px, calc(100vw - 24px));
  background: var(--card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-3) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  outline: 2px solid var(--text);
  outline-offset: 2px;
}
.dj-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dj-card-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
}
/* 与正文标记相同的线型图例: 实线 / 点线 / 圆点 */
.dj-mark {
  display: inline-block;
  width: 14px;
  border-bottom: 2px solid var(--text-2);
}
.is-term .dj-mark {
  border-bottom: 1px dotted var(--text-2);
}
.is-note .dj-mark {
  width: 6px;
  height: 6px;
  border: none;
  border-radius: 50%;
  background: var(--text-2);
}
.dj-card-term {
  font-weight: 600;
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.dj-card-label {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
}
.dj-card-text {
  margin: 0;
  line-height: 1.6;
  font-size: 14px;
}
.dj-card-tr {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius);
  line-height: 1.6;
  font-size: 14px;
}
.dj-card-muted,
.dj-card-source {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.dj-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
@media (max-width: 600px) {
  .dj-card {
    left: 0 !important;
    right: 0;
    top: auto !important;
    bottom: 0;
    width: 100%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding-bottom: calc(var(--space-4) + var(--lr-safe-bottom));
  }
  .dj-card-actions .btn {
    min-height: 40px;
  }
}
</style>
