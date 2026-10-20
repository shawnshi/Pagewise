<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { onyxEpd } from '../services/onyxEpd'
import {
  eraseIntersectingStrokes,
  normalizePointsToRect,
  onyxScribble,
  strokeToSvgPath,
  type OnyxBrushTool,
  type OnyxCssRect,
  type OnyxInkStroke,
  type OnyxTouchPointCss,
} from '../services/onyxScribble'

const props = withDefaults(
  defineProps<{
    bookId: string
    pageKey: string
    enabled?: boolean
    modalOpen?: boolean
  }>(),
  {
    enabled: false,
    modalOpen: false,
  },
)

const emit = defineEmits<{
  (e: 'update:enabled', val: boolean): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const toolbarRef = ref<HTMLElement | null>(null)
const tool = ref<OnyxBrushTool>('fountain')
const strokeWidth = ref(3)
const strokes = ref<OnyxInkStroke[]>([])
const activePoints = ref<OnyxTouchPointCss[]>([])
const drawingPointerId = ref<number | null>(null)

function loadCurrentStrokes() {
  strokes.value = onyxScribble.loadPageStrokes(props.bookId, props.pageKey)
}

function persistCurrentStrokes() {
  onyxScribble.savePageStrokes(props.bookId, props.pageKey, strokes.value)
}

function currentLimitRect(): OnyxCssRect | null {
  const el = containerRef.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 1 || r.height <= 1) return null
  return {
    left: Math.round(r.left),
    top: Math.round(r.top),
    right: Math.round(r.right),
    bottom: Math.round(r.bottom),
  }
}

function currentExcludeRects(): OnyxCssRect[] {
  const out: OnyxCssRect[] = []
  const bar = toolbarRef.value
  if (bar) {
    const r = bar.getBoundingClientRect()
    if (r.width > 1 && r.height > 1) {
      out.push({
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      })
    }
  }
  return out
}

function syncNativeGeometry() {
  onyxScribble.configure({
    enabled: props.enabled,
    tool: tool.value,
    strokeWidth: strokeWidth.value,
    limitRect: currentLimitRect(),
    excludeRects: currentExcludeRects(),
  })
}

function commitPoints(rawPoints: OnyxTouchPointCss[], kind: 'stroke' | 'erase', widthOverride?: number) {
  const rect = currentLimitRect()
  if (!rect || !rawPoints.length) return
  const normPoints = normalizePointsToRect(rawPoints, rect)
  if (!normPoints.length) return

  if (kind === 'erase' || tool.value === 'eraser') {
    const { remaining, removedIds } = eraseIntersectingStrokes(strokes.value, normPoints)
    if (removedIds.length > 0) {
      strokes.value = remaining
      persistCurrentStrokes()
      onyxEpd.repaint('regal')
    }
    return
  }

  const nextStroke: OnyxInkStroke = {
    id: `ink-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tool: tool.value,
    width: widthOverride ?? strokeWidth.value,
    points: normPoints,
    createdAt: Date.now(),
  }
  strokes.value = [...strokes.value, nextStroke]
  persistCurrentStrokes()
}

function clearPageInk() {
  if (!strokes.value.length) return
  strokes.value = []
  persistCurrentStrokes()
  onyxEpd.repaint('gc')
}

function selectTool(nextTool: OnyxBrushTool) {
  tool.value = nextTool
  if (nextTool === 'marker') strokeWidth.value = 10
  else if (nextTool === 'pencil') strokeWidth.value = 2
  else if (nextTool === 'fountain') strokeWidth.value = 3.5
  syncNativeGeometry()
}

function onPointerDown(e: PointerEvent) {
  if (!props.enabled || props.modalOpen) return
  // 若只允许笔或鼠标/触控在手写开启态下绘制
  drawingPointerId.value = e.pointerId
  activePoints.value = [{ x: e.clientX, y: e.clientY, p: e.pressure || 0.5, t: Date.now() }]
  ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (drawingPointerId.value !== e.pointerId || !props.enabled) return
  activePoints.value.push({ x: e.clientX, y: e.clientY, p: e.pressure || 0.5, t: Date.now() })
}

function onPointerUp(e: PointerEvent) {
  if (drawingPointerId.value !== e.pointerId) return
  drawingPointerId.value = null
  const pts = activePoints.value
  activePoints.value = []
  commitPoints(pts, tool.value === 'eraser' ? 'erase' : 'stroke')
}

const activeDraftStroke = computed<OnyxInkStroke | null>(() => {
  if (!activePoints.value.length || tool.value === 'eraser') return null
  const rect = currentLimitRect()
  if (!rect) return null
  return {
    id: 'draft',
    tool: tool.value,
    width: strokeWidth.value,
    points: normalizePointsToRect(activePoints.value, rect),
    createdAt: 0,
  }
})

let unsubscribeNative: (() => void) | null = null

watch(
  () => [props.bookId, props.pageKey],
  () => {
    loadCurrentStrokes()
    void nextTick(() => syncNativeGeometry())
  },
  { immediate: true },
)

watch(
  () => props.enabled,
  () => {
    void nextTick(() => syncNativeGeometry())
  },
)

watch(
  () => props.modalOpen,
  suspended => {
    onyxScribble.setModalSuspended(Boolean(suspended))
  },
  { immediate: true },
)

onMounted(() => {
  unsubscribeNative = onyxScribble.subscribe(ev => {
    if (!props.enabled || props.modalOpen) return
    commitPoints(ev.points, ev.kind, ev.width)
  })
  syncNativeGeometry()
})

onBeforeUnmount(() => {
  unsubscribeNative?.()
  onyxScribble.configure({ enabled: false, limitRect: null, excludeRects: [] })
})
</script>

<template>
  <div
    ref="containerRef"
    class="onyx-ink-layer"
    :class="{ 'is-active': enabled && !modalOpen }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <svg
      v-if="strokes.length || activeDraftStroke"
      class="onyx-ink-svg"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        v-for="s in strokes"
        :key="s.id"
        :d="strokeToSvgPath(s, 1000, 1000)"
        :stroke-width="s.width * 1.4"
        :stroke-opacity="s.tool === 'marker' ? 0.38 : 1"
        :stroke-dasharray="s.tool === 'pencil' ? '2 1' : undefined"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        v-if="activeDraftStroke"
        :d="strokeToSvgPath(activeDraftStroke, 1000, 1000)"
        :stroke-width="activeDraftStroke.width * 1.4"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>

    <div
      v-if="enabled"
      ref="toolbarRef"
      class="onyx-ink-toolbar"
      role="toolbar"
      :aria-label="t('reader.scribble')"
      @pointerdown.stop
    >
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'fountain' }"
        :aria-pressed="tool === 'fountain'"
        @click="selectTool('fountain')"
      >
        {{ t('reader.scribblePen') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'pencil' }"
        :aria-pressed="tool === 'pencil'"
        @click="selectTool('pencil')"
      >
        {{ t('reader.scribblePencil') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'marker' }"
        :aria-pressed="tool === 'marker'"
        @click="selectTool('marker')"
      >
        {{ t('reader.scribbleMarker') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'eraser' }"
        :aria-pressed="tool === 'eraser'"
        @click="selectTool('eraser')"
      >
        {{ t('reader.scribbleEraser') }}
      </button>
      <button
        v-if="strokes.length"
        type="button"
        class="onyx-ink-btn"
        @click="clearPageInk"
      >
        {{ t('reader.scribbleClear') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        @click="emit('update:enabled', false)"
      >
        {{ t('common.close') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.onyx-ink-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 6;
  color: var(--text, #000000);
}
.onyx-ink-layer.is-active {
  pointer-events: auto;
  touch-action: none;
}
.onyx-ink-svg {
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}
.onyx-ink-toolbar {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  background: var(--surface, #ffffff);
  border: 1.5px solid var(--border, #000000);
  border-radius: 8px;
  pointer-events: auto;
  z-index: 8;
}
.onyx-ink-btn {
  padding: 4px 10px;
  font-size: 13px;
  border: 1px solid var(--border, #000000);
  background: var(--surface, #ffffff);
  color: var(--text, #000000);
  border-radius: 5px;
  cursor: pointer;
}
.onyx-ink-btn.active {
  background: var(--text, #000000);
  color: var(--bg, #ffffff);
  font-weight: 600;
}
</style>
