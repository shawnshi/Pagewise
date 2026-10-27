<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { aiConfigured, chatStream, type AiMessage } from '../services/ai'
import { buildPdfAssistantMessages, PDF_AI_CONTEXT_LIMIT, PDF_AI_QUESTION_LIMIT, PDF_AI_REPLY_LIMIT, PDF_AI_TIMEOUT_MS } from '../services/pdfReadingAssistant'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'

const props = defineProps<{ open: boolean; bookTitle: string; bookAuthor?: string; pageNumber: number; sourceText: string; sourceLoading: boolean; sourceError?: string }>()
const emit = defineEmits<{ close: [] }>()
const settings = useSettings()
const configured = computed(() => aiConfigured())
type Message = { role: 'user' | 'assistant'; content: string; state: 'done' | 'streaming' | 'error' | 'stopped' }
const messages = ref<Message[]>([])
const contextText = ref(props.sourceText.slice(0, PDF_AI_CONTEXT_LIMIT))
const question = ref('')
const questionInput = ref<HTMLTextAreaElement | null>(null)
const streaming = ref(false)
const error = ref('')
let generation = 0
let controller: AbortController | null = null
let timer: number | undefined
let replyIndex = -1
let pendingText = ''

function clearTimer() {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
}
function stopReply() {
  generation++
  controller?.abort()
  controller = null
  clearTimer()
  const reply = messages.value[replyIndex]
  if (reply?.state === 'streaming') {
    reply.content = pendingText
    reply.state = 'stopped'
  }
  replyIndex = -1
  streaming.value = false
}
function close() { stopReply(); emit('close') }
function clearConversation() {
  if (streaming.value) return
  messages.value = []
  error.value = ''
}
watch(() => [props.pageNumber, props.sourceText] as const, () => {
  stopReply()
  messages.value = []
  contextText.value = props.sourceText.slice(0, PDF_AI_CONTEXT_LIMIT)
  error.value = ''
})
watch(() => props.open, async open => {
  if (!open) { stopReply(); return }
  await nextTick()
  if (props.open) questionInput.value?.focus({ preventScroll: true })
})
watch(contextText, () => {
  // Prior answers must not be silently reused against an edited excerpt.
  if (!streaming.value) messages.value = []
})
onBeforeUnmount(stopReply)

async function send() {
  if (streaming.value || props.sourceLoading || !props.open) return
  error.value = ''
  if (!configured.value) { error.value = t('ai.pdfNeedConfig'); return }
  if (!contextText.value.trim()) { error.value = t('ai.pdfNoText'); return }
  const draft = question.value.trim()
  if (!draft) { error.value = t('ai.pdfQuestionRequired'); return }
  const history: AiMessage[] = []
  for (let i = 0; i + 1 < messages.value.length; i += 2) {
    const user = messages.value[i], assistant = messages.value[i + 1]
    if (user?.role === 'user' && assistant?.role === 'assistant' && assistant.state === 'done') {
      history.push({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content })
    }
  }
  const request = buildPdfAssistantMessages({ title: props.bookTitle, author: props.bookAuthor, page: props.pageNumber, text: contextText.value, question: draft, history, language: settings.language === 'en' ? 'en' : 'zh' })
  messages.value.push({ role: 'user', content: draft, state: 'done' }, { role: 'assistant', content: '', state: 'streaming' })
  replyIndex = messages.value.length - 1
  pendingText = ''
  const index = replyIndex, run = ++generation, abort = new AbortController()
  controller = abort
  streaming.value = true
  let timedOut = false, lastPaint = 0
  timer = window.setTimeout(() => { timedOut = true; abort.abort() }, PDF_AI_TIMEOUT_MS)
  try {
    for await (const part of chatStream(request, abort.signal)) {
      if (run !== generation || !props.open) return
      pendingText += part
      if (pendingText.length > PDF_AI_REPLY_LIMIT) throw new Error(t('ai.pdfReplyLimit'))
      // Avoid repainting an e-ink panel for every token; always publish the final text.
      if (Date.now() - lastPaint >= 160) {
        messages.value[index]!.content = pendingText
        lastPaint = Date.now()
      }
    }
    if (run !== generation || !props.open) return
    if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!pendingText.trim()) throw new Error(t('ai.emptyReply'))
    messages.value[index]!.content = pendingText
    messages.value[index]!.state = 'done'
    if (question.value.trim() === draft) question.value = ''
  } catch (cause) {
    if (run !== generation || !props.open) return
    abort.abort()
    messages.value[index]!.content = pendingText.slice(0, PDF_AI_REPLY_LIMIT)
    messages.value[index]!.state = abort.signal.aborted && !timedOut && cause instanceof DOMException && cause.name === 'AbortError' ? 'stopped' : 'error'
    error.value = timedOut ? t('ai.pdfTimeout') : cause instanceof Error ? cause.message : t('ai.requestFailed')
  } finally {
    if (run === generation) {
      clearTimer()
      controller = null
      streaming.value = false
      replyIndex = -1
    }
  }
}
</script>

<template>
  <section v-if="open" class="pdf-reading-assistant card" role="dialog" :aria-label="t('ai.title')" data-testid="pdf-reading-assistant" @keydown.esc.prevent.stop="close">
    <header class="pdf-ai-header">
      <strong>{{ t('ai.title') }} · P{{ pageNumber }}</strong>
      <button type="button" class="btn btn-sm" :aria-label="t('common.close')" @click="close">{{ t('common.close') }}</button>
    </header>
    <p class="pdf-ai-scope">{{ t('ai.pdfScope') }}</p>
    <p v-if="!configured" class="pdf-ai-hint">{{ t('ai.pdfNeedConfig') }} <RouterLink to="/settings">{{ t('ai.goSettings') }}</RouterLink></p>
    <label class="pdf-ai-field">
      <span>{{ t('ai.pdfContext') }} ({{ contextText.length }}/{{ PDF_AI_CONTEXT_LIMIT }})</span>
      <textarea v-model="contextText" class="input" rows="4" :maxlength="PDF_AI_CONTEXT_LIMIT" :disabled="streaming || sourceLoading" :aria-label="t('ai.pdfContext')" data-testid="pdf-ai-context" />
    </label>
    <p v-if="sourceError" class="pdf-ai-error" role="alert">{{ sourceError }}</p>
    <p v-if="sourceLoading" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="!contextText.trim()" class="pdf-ai-hint">{{ t('ai.pdfNoText') }}</p>
    <div class="pdf-ai-messages" role="log" :aria-label="t('ai.title')" aria-live="off">
      <article v-for="(message, index) in messages" :key="index" class="pdf-ai-message" :data-role="message.role" :data-state="message.state">
        <strong>{{ message.role === 'user' ? t('ai.pdfYou') : t('ai.title') }}</strong>
        <p>{{ message.content }}</p>
        <small v-if="message.state === 'stopped'">{{ t('ai.pdfStopped') }}</small>
        <small v-else-if="message.state === 'error'">{{ t('ai.pdfIncomplete') }}</small>
      </article>
    </div>
    <p v-if="error" class="pdf-ai-error" role="alert">{{ error }}</p>
    <label class="pdf-ai-field">
      <span>{{ t('ai.pdfQuestion') }}</span>
      <textarea ref="questionInput" v-model="question" class="input" rows="2" :maxlength="PDF_AI_QUESTION_LIMIT" :disabled="streaming" :aria-label="t('ai.pdfQuestion')" data-testid="pdf-ai-question" @keydown.enter.exact.prevent="send" />
    </label>
    <div class="pdf-ai-actions">
      <button type="button" class="btn btn-sm" :disabled="streaming" @click="clearConversation">{{ t('ai.clear') }}</button>
      <button v-if="streaming" type="button" class="btn btn-sm" data-testid="pdf-ai-stop" @click="stopReply">{{ t('ai.pdfStop') }}</button>
      <button v-else type="button" class="btn btn-primary btn-sm" :disabled="sourceLoading || !configured" data-testid="pdf-ai-send" @click="send">{{ t('ai.send') }}</button>
    </div>
    <p v-if="streaming" role="status">{{ t('ai.pdfThinking') }}</p>
  </section>
</template>

<style scoped>
.pdf-reading-assistant { position: fixed; z-index: 1000; inset: max(12px, env(safe-area-inset-top)) 12px auto auto; box-sizing: border-box; width: min(440px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; padding: 16px; border: 2px solid var(--border); background: var(--bg); color: var(--text); box-shadow: 0 4px 16px #0002; }
.pdf-ai-header, .pdf-ai-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pdf-ai-field { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.pdf-ai-field textarea { width: 100%; resize: vertical; min-height: 64px; white-space: pre-wrap; }
.pdf-ai-scope, .pdf-ai-hint { font-size: 14px; line-height: 1.6; margin: 10px 0; }
.pdf-ai-messages { max-height: 32vh; overflow-y: auto; }
.pdf-ai-message { padding: 10px 0; border-bottom: 1px solid var(--border); }
.pdf-ai-message strong { font-size: 15px; }
.pdf-ai-message p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; font-size: 15px; }
.pdf-ai-field span { font-size: 14px; font-weight: 600; }
.pdf-ai-field textarea { width: 100%; resize: vertical; min-height: 64px; white-space: pre-wrap; font-size: 15px; }
.pdf-ai-actions button { min-height: 48px; font-size: 14px; font-weight: 600; }
.pdf-ai-message small, .pdf-ai-error { font-weight: 600; }
.pdf-ai-error { border-inline-start: 3px solid currentColor; padding-inline-start: 8px; }
.pdf-reading-assistant button { min-height: 48px; }
.pdf-reading-assistant :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
