<script setup lang="ts">
/**
 * 伴读卡片 (§4.3 §4.4 §4.7): 概念释义 / 注 / 要句「为什么标」。
 * 位置贴着原文 (在其下方, 放不下时在上方), 样式与选中工具条同级; 手机上为底部抽屉。
 * 所有 AI 内容标明来源 (R5); 每条都能一键否掉 (R4)。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { rangeHostRect } from '../services/PagewiseCompanion/cardGeometry'
import { t } from '../i18n'
import type { PagewiseCompanionController } from '../composables/usePagewiseCompanion'
import type { KeyItem, NoteItem, TermItem } from '../services/PagewiseCompanion/protocol'

const props = defineProps<{ dj: PagewiseCompanionController }>()
const emit = defineEmits<{ close: []; inspect: [] }>()

const el = ref<HTMLElement | null>(null)
const pos = ref<Record<string, string>>({ visibility: 'hidden' })
let frame = 0
let disposed = false
let stopObserving = () => {}
type FocusableElement = Element & { focus(options?: FocusOptions): void }
let previousFocus: FocusableElement[] = []

function captureFocusPath(): FocusableElement[] {
  const path: FocusableElement[] = []
  const seen = new Set<Element>()
  const appendActivePath = (start: Element | null) => {
    let active = start
    while (active && !seen.has(active)) {
      seen.add(active)
      if (typeof (active as FocusableElement).focus === 'function') path.push(active as FocusableElement)
      active = active.shadowRoot?.activeElement
        ?? (active.localName === 'iframe' ? (active as HTMLIFrameElement).contentDocument?.activeElement : null)
        ?? null
    }
  }
  appendActivePath(document.activeElement)
  // Foliate's closed roots retarget activeElement. Use the Range's known source
  // document only when focus actually came from that document.
  const source = state.value?.target.range.startContainer.ownerDocument
  if (source && source !== document && source.hasFocus()) {
    const frames: Element[] = []
    const documents = new Set<Document>()
    let current: Document | null = source
    while (current && current !== document && !documents.has(current)) {
      documents.add(current)
      const sourceFrame: Element | null = current.defaultView?.frameElement ?? null
      if (!sourceFrame) break
      frames.unshift(sourceFrame)
      current = sourceFrame.ownerDocument
    }
    frames.forEach(appendActivePath)
    appendActivePath(source.activeElement)
  }
  return path
}

const state = computed(() => props.dj.card.value)
const kind = computed(() => state.value?.target.kind ?? 'term')
const item = computed(() => state.value?.target.item)
const term = computed(() => (kind.value === 'term' ? (item.value as TermItem) : null))
const note = computed(() => (kind.value === 'note' ? (item.value as NoteItem) : null))
const key = computed(() => (kind.value === 'key' ? (item.value as KeyItem) : null))
const heading = computed(() => t(kind.value === 'key' ? 'companion.keySentence' : kind.value === 'note' ? 'companion.note' : 'companion.concept'))
const noteKind = computed(() => {
  const k = note.value?.k
  return k === 'allusion' ? t('companion.noteAllusion') : k === 'history' ? t('companion.noteHistory') : t('companion.noteCulture')
})

function close() {
  if (!state.value) return
  props.dj.closeCard()
  emit('close')
}

function place() {
  const s = state.value
  const box = el.value
  if (disposed || !s || !box) return
  const anchor = rangeHostRect(s.target.range)
  if (!anchor) { close(); return }
  const viewport = window.visualViewport
  const css = getComputedStyle(box)
  const inset = (name: string) => Math.max(12, parseFloat(css.getPropertyValue(name)) || 0)
  const leftEdge = (viewport?.offsetLeft ?? 0) + inset('--lr-safe-left')
  const topEdge = (viewport?.offsetTop ?? 0) + inset('--lr-safe-top')
  const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - inset('--lr-safe-right')
  const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - inset('--lr-safe-bottom')
  const width = Math.max(0, rightEdge - leftEdge)
  const height = Math.max(0, bottomEdge - topEdge)
  const mobile = window.matchMedia('(max-width: 600px)').matches
  box.style.maxHeight = `${height}px`
  box.style.width = `${mobile ? width : Math.min(380, width)}px`
  const w = box.getBoundingClientRect().width
  const h = box.getBoundingClientRect().height
  const left = mobile ? leftEdge : Math.max(leftEdge, Math.min((anchor.left + anchor.right - w) / 2, rightEdge - w))
  let top = mobile ? bottomEdge - h : anchor.bottom + 10
  if (!mobile && top + h > bottomEdge) top = anchor.top - h - 10
  top = Math.max(topEdge, Math.min(top, bottomEdge - h))
  pos.value = { left: `${left}px`, top: `${top}px`, width: box.style.width, maxHeight: box.style.maxHeight }
}

function schedule() {
  if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; place() })
}

function observe() {
  stopObserving()
  const cleanups: (() => void)[] = []
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  if (el.value) resize?.observe(el.value)
  let doc: Document | null = state.value?.target.range.startContainer.ownerDocument ?? null
  const docs = new Set<Document>()
  while (doc && !docs.has(doc)) {
    docs.add(doc)
    const view: Window | null = doc.defaultView
    if (!view) break
    view.addEventListener('resize', schedule)
    doc.addEventListener('scroll', schedule, true)
    doc.addEventListener('load', schedule, true)
    const current = doc
    cleanups.push(() => {
      view.removeEventListener('resize', schedule)
      current.removeEventListener('scroll', schedule, true)
      current.removeEventListener('load', schedule, true)
    })
    resize?.observe(doc.documentElement)
    if (typeof MutationObserver !== 'undefined') {
      const mutations = new MutationObserver(records => {
        if (records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest('.dj-card-layer, .dj-status-dot'))) schedule()
      })
      mutations.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
      cleanups.push(() => mutations.disconnect())
    }
    if (view === window) break
    try {
      const frameElement = view.frameElement
      if (frameElement) resize?.observe(frameElement)
      doc = frameElement?.ownerDocument ?? null
    } catch { break }
  }
  const viewport = window.visualViewport
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  stopObserving = () => {
    resize?.disconnect()
    cleanups.forEach(cleanup => cleanup())
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
  }
  schedule()
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close() }
  if (e.key !== 'Tab') return
  const buttons = el.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')
  const first = buttons?.[0], last = buttons?.[buttons.length - 1]
  if (!first || !last) { e.preventDefault(); el.value?.focus({ preventScroll: true }); return }
  if (e.shiftKey && (document.activeElement === first || document.activeElement === el.value)) { e.preventDefault(); last.focus({ preventScroll: true }) }
  else if (!e.shiftKey && (document.activeElement === last || document.activeElement === el.value)) { e.preventDefault(); first.focus({ preventScroll: true }) }
}
watch(() => state.value?.target.range, () => nextTick(() => { if (!disposed) observe() }))
// Own content changes still reposition when ResizeObserver is unavailable.
watch(state, schedule, { flush: 'post' })
onMounted(async () => {
  previousFocus = captureFocusPath()
  await nextTick()
  if (disposed) return
  observe()
  place()
  // Commit measured visibility before focusing; hidden elements reject focus.
  await nextTick()
  if (disposed) return
  el.value?.focus({ preventScroll: true })
  window.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  disposed = true
  stopObserving()
  cancelAnimationFrame(frame)
  window.removeEventListener('keydown', onKey, true)
  if (el.value?.contains(document.activeElement) || document.activeElement === document.body) {
    // Activate outer contexts before restoring their exact original inner control.
    for (const origin of previousFocus) if (origin.isConnected) origin.focus({ preventScroll: true })
  }
})
</script>

<template>
  <div v-if="state" class="dj-card-layer" @click.self="close" @pointerdown.stop @touchstart.stop @touchend.stop>
    <div
      ref="el"
      class="dj-card"
      :class="'is-' + kind"
      role="dialog"
      aria-modal="true"
      :aria-label="heading"
      tabindex="-1"
      :style="pos"
    >
      <header class="dj-card-head">
        <span class="dj-card-kind">
          <span class="dj-mark" aria-hidden="true"></span>
          {{ heading }}
        </span>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" :aria-label="t('companion.close')" :title="t('companion.close')" @click="close">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </header>

      <div class="dj-card-body" tabindex="0" :aria-label="heading">
      <template v-if="term">
        <p class="dj-card-term">{{ term.q }}</p>
        <p class="dj-card-text">{{ term.def }}</p>
      </template>
      <template v-else-if="note">
        <p class="dj-card-term">{{ note.q }} <span class="tag">{{ noteKind }}</span></p>
        <p class="dj-card-text">{{ note.text }}</p>
      </template>
      <template v-else-if="key">
        <p class="dj-card-label">{{ t('companion.why') }}</p>
        <p class="dj-card-text">{{ key.why || '—' }}</p>
      </template>

      <p v-if="state.translation" class="dj-card-tr">{{ state.translation }}</p>
      <p v-if="state.translating" class="dj-card-muted" role="status">{{ t('companion.translating') }}</p>
      <p v-else-if="state.translateError" class="dj-card-muted" role="status">{{ t('companion.translateFailed') }}</p>

      <p class="dj-card-source">
        {{ t('companion.aiSource') }}<template v-if="note && note.k !== 'allusion'"> · {{ t('companion.outside') }}</template>
      </p>

      <p class="dj-card-source">{{ t('companion.sourceText') }} · {{ state.target.text }}</p>
      </div>
      <div class="dj-card-actions">
        <button type="button" class="btn btn-sm" @click="emit('inspect')">{{ t('companion.viewSource') }}</button>
        <template v-if="kind === 'term'">
          <button type="button" class="btn btn-sm" @click="dj.expand()">{{ t('companion.expand') }}</button>
          <button type="button" class="btn btn-sm" :disabled="state.translating || (!!state.translation && !state.translateError)" @click="dj.translate()">{{ t('companion.translate') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="dj.dismiss()">{{ t('companion.notThis') }}</button>
        </template>
        <template v-else-if="kind === 'note'">
          <button type="button" class="btn btn-sm" @click="dj.expand()">{{ t('companion.expand') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="dj.dismiss()">{{ t('companion.notThis') }}</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-sm btn-primary" :title="t('companion.agreeHint')" @click="dj.adopt(false)">{{ t('companion.agree') }}</button>
          <button type="button" class="btn btn-sm" @click="dj.adopt(true)">{{ t('companion.addNote') }}</button>
          <button type="button" class="btn btn-sm" :disabled="state.translating || (!!state.translation && !state.translateError)" @click="dj.translate()">{{ t('companion.translate') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="dj.dismiss()">{{ t('companion.notKey') }}</button>
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
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  overflow: hidden;
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
.dj-card-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.dj-card button {
  min-width: 48px;
  min-height: 48px;
  height: auto;
  white-space: normal;
}
.dj-card button:focus-visible,
.dj-card-body:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: -3px;
}
.dj-card .btn-primary {
  background: var(--text);
  color: var(--card);
  border-color: var(--text);
}
.dj-card .btn-primary:focus-visible {
  outline: 2px solid var(--card);
  outline-offset: -3px;
}
.dj-card-head {
  flex-shrink: 0;
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
  flex-shrink: 0;
  overflow-wrap: anywhere;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
@media (max-width: 600px) {
  .dj-card {
    border-radius: var(--radius-xl);
    padding: var(--space-3);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dj-card, .dj-card button {
    animation: none;
    transition: none;
  }
}
</style>
