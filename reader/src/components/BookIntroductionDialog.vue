<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import type { BookMeta } from '../storage'
import { createBookIntroductionActions } from '../services/bookIntroductionActions.ts'
import { BOOK_INTRODUCTION_MAX_LENGTH } from '../services/bookDescription.ts'
import { t } from '../i18n'

const props = defineProps<{ modelValue: boolean; bookId: string; book: BookMeta | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [bookId: string, description: string] }>()
const actions = createBookIntroductionActions()
const dialog = ref<HTMLDialogElement | null>(null)
const series = ref('')
const text = ref('')
const sourceTitle = ref('')
const phase = ref<'idle' | 'generating' | 'preview' | 'saving' | 'unknown' | 'error'>('idle')
const errorCode = ref('')
let epoch = 0
let alive = true
let requestId = ''
let proposal = ''
let ownerBook = ''
const errors = new Set(['unconfigured', 'settings_recovery_required', 'settings_unavailable', 'source_changed', 'commit_outcome_unknown', 'busy', 'timeout', 'empty_output', 'output_too_long', 'invalid_metadata', 'stale_preview', 'preview_limit', 'unsupported_storage'])
function message(): string { return t('bookIntroduction.error.' + (errors.has(errorCode.value) ? errorCode.value : 'generation_failed')) }
function cancelProposal() {
  if (ownerBook && requestId) void actions.bookIntroductionCancel({ bookId: ownerBook, requestId, token: proposal }).catch(() => {})
  requestId = ''; proposal = ''
}
function requestClose() {
  if (phase.value === 'saving') return
  epoch++; cancelProposal(); dialog.value?.close(); emit('update:modelValue', false)
}
defineExpose({ requestClose, isSaving: () => phase.value === 'saving' })
watch(() => props.modelValue, async open => {
  if (!open) {
    if (phase.value === 'saving') { emit('update:modelValue', true); return }
    epoch++; cancelProposal(); dialog.value?.close(); return
  }
  epoch++; cancelProposal(); ownerBook = props.bookId; series.value = ''; text.value = ''; errorCode.value = ''; sourceTitle.value = props.book?.title ?? ''; phase.value = 'idle'
  await nextTick()
  if (alive && props.modelValue && !dialog.value?.open) dialog.value?.showModal()
}, { immediate: true })
watch(() => props.bookId, () => { if (props.modelValue && phase.value !== 'saving') requestClose() })
function beforeNavigate() {
  if (phase.value === 'saving') return false
  if (props.modelValue) requestClose()
  return true
}
onBeforeRouteLeave(beforeNavigate)
onBeforeRouteUpdate(beforeNavigate)
onBeforeUnmount(() => { alive = false; epoch++; cancelProposal() })
async function generate() {
  if (phase.value === 'unknown' || phase.value === 'saving' || phase.value === 'generating' || !props.book || props.book.id !== props.bookId) return
  cancelProposal()
  const owner = ++epoch
  const id = props.bookId, title = props.book.title
  ownerBook = id; requestId = crypto.randomUUID()
  const rid = requestId
  errorCode.value = ''; phase.value = 'generating'
  let reply
  try { reply = await actions.bookIntroductionGenerate({ bookId: id, requestId: rid, series: series.value }) }
  catch { reply = { ok: false, code: 'generation_failed' } }
  if (!alive || owner !== epoch || !props.modelValue || props.bookId !== id) {
    void actions.bookIntroductionCancel({ bookId: id, requestId: rid }).catch(() => {}); return
  }
  if (!reply.ok) { errorCode.value = String(reply.code ?? 'generation_failed'); phase.value = 'error'; return }
  if (reply.bookId !== id || reply.requestId !== rid || typeof reply.token !== 'string' || typeof reply.text !== 'string') { errorCode.value = 'generation_failed'; phase.value = 'error'; return }
  proposal = reply.token; text.value = reply.text; sourceTitle.value = title; phase.value = 'preview'
}
async function save() {
  if (phase.value !== 'preview' || !proposal || !text.value.trim() || text.value.length > BOOK_INTRODUCTION_MAX_LENGTH || ownerBook !== props.bookId) return
  const owner = epoch, id = ownerBook, token = proposal, value = text.value
  phase.value = 'saving'; errorCode.value = ''
  let reply
  try { reply = await actions.bookIntroductionSave({ bookId: id, token, text: value, confirmReplace: true }) }
  catch { reply = { ok: false, code: 'commit_outcome_unknown' } }
  if (!alive || owner !== epoch || props.bookId !== id) return
  if (!reply.ok) { errorCode.value = String(reply.code ?? 'commit_outcome_unknown'); phase.value = reply.code === 'commit_outcome_unknown' ? 'unknown' : 'error'; return }
  if (reply.bookId !== id || reply.saved !== true || typeof reply.description !== 'string') { errorCode.value = 'commit_outcome_unknown'; phase.value = 'unknown'; return }
  phase.value = 'idle'; proposal = ''; emit('saved', id, reply.description); requestClose()
}
</script>

<template>
  <dialog ref="dialog" class="book-introduction-dialog" aria-labelledby="book-introduction-title" @cancel.prevent="requestClose">
    <header><h2 id="book-introduction-title">{{ t('bookIntroduction.title') }}</h2><p class="source-title">{{ sourceTitle }}</p></header>
    <p class="intro-notice">{{ t('bookIntroduction.privacy') }}</p>
    <label class="series-field">{{ t('bookIntroduction.series') }}<input v-model="series" maxlength="1024" :disabled="phase === 'generating' || phase === 'saving'" autocomplete="off" /></label>
    <p class="intro-notice">{{ t('bookIntroduction.unverified') }}</p>
    <p v-if="phase === 'generating' || phase === 'saving'" role="status" aria-live="polite">{{ t(phase === 'generating' ? 'bookIntroduction.generating' : 'bookIntroduction.saving') }}</p>
    <p v-if="errorCode" class="intro-error" role="alert">{{ message() }}</p>
    <label class="preview-field">{{ t('bookIntroduction.preview') }}<textarea v-model="text" :maxlength="BOOK_INTRODUCTION_MAX_LENGTH" :disabled="phase === 'generating' || phase === 'saving'" rows="12" spellcheck="false" /></label>
    <p class="intro-notice">{{ t('bookIntroduction.replaceHint') }}</p>
    <footer>
      <button type="button" class="btn" :disabled="phase === 'unknown' || phase === 'generating' || phase === 'saving'" @click="generate">{{ t(text ? 'bookIntroduction.regenerate' : 'bookIntroduction.generate') }}</button>
      <button type="button" class="btn btn-primary" :disabled="phase !== 'preview' || !text.trim()" @click="save">{{ t('bookIntroduction.replace') }}</button>
      <button type="button" class="btn" :disabled="phase === 'saving'" @click="requestClose">{{ t('bookIntroduction.close') }}</button>
    </footer>
  </dialog>
</template>

<style scoped>
.book-introduction-dialog { width: min(860px, calc(100vw - 32px)); max-height: 90vh; padding: 24px; border: 2px solid var(--text, #111); border-radius: 8px; background: var(--bg, #fff); color: var(--text, #111); overflow: auto; }
.book-introduction-dialog::backdrop { background: rgba(0, 0, 0, .35); }
h2 { margin: 0 0 8px; font-size: 20px; }
.source-title { margin: 0; overflow-wrap: anywhere; }
.intro-notice { font-size: 14px; line-height: 1.5; }
.series-field, .preview-field { display: grid; gap: 8px; margin: 16px 0; }
input, textarea { width: 100%; box-sizing: border-box; min-height: 48px; border: 1px solid currentColor; border-radius: 4px; padding: 10px; color: inherit; background: inherit; font: inherit; }
textarea { resize: vertical; line-height: 1.5; white-space: pre-wrap; }
footer { display: flex; flex-wrap: wrap; gap: 8px; }
button { min-height: 48px; white-space: normal; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: .55; }
.intro-error { border-inline-start: 3px solid currentColor; padding-inline-start: 10px; }
@media (max-width: 480px) { .book-introduction-dialog { padding: 16px; width: calc(100vw - 16px); } footer > button { flex: 1 1 100%; } }
@media (prefers-reduced-motion: reduce) { * { transition: none; animation: none; } }
</style>
