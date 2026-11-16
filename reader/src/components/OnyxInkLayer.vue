<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { onyxEpd } from '../services/onyxEpd'
import {
  eraseIntersectingStrokes,
  findIntersectingStrokeIds,
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
    legacyPageKey?: string
    enabled?: boolean
    active?: boolean
    modalOpen?: boolean
  }>(),
  {
    legacyPageKey: '',
    enabled: false,
    active: true,
    modalOpen: false,
  },
)

const emit = defineEmits<{
  (e: 'update:enabled', val: boolean): void
}>()

const sharedBrushState = ((globalThis as { __pagewiseOnyxBrush?: { tool: OnyxBrushTool; width: number } }).__pagewiseOnyxBrush ??= {
  tool: 'fountain',
  width: 3.5,
})

const containerRef = ref<HTMLElement | null>(null)
const toolbarRef = ref<HTMLElement | null>(null)
const tool = ref<OnyxBrushTool>(sharedBrushState.tool)
const strokeWidth = ref(sharedBrushState.width)
const strokes = ref<OnyxInkStroke[]>([])
const activePoints = ref<OnyxTouchPointCss[]>([])
const drawingPointerId = ref<number | null>(null)
const erasingIds = ref<Set<string>>(new Set())
const penDetected = ref(false)
const barrelErasing = ref(false)
let regalTimer: ReturnType<typeof setTimeout> | undefined
let geometryRaf = 0
let containerObserver: ResizeObserver | undefined

const HOST_EXCLUDE_SELECTORS = '.bar.top, .bar.bottom, .pdf-header, .pdf-toolbar, .pdf-bottom-bar, .pdf-ai-dock, .companion-dock, .tts-mini'

function pointInRect(pt: OnyxTouchPointCss, rect: OnyxCssRect | null): boolean {
  return !!rect && pt.x >= rect.left - 2 && pt.x <= rect.right + 2 && pt.y >= rect.top - 2 && pt.y <= rect.bottom + 2
}

function nativeHostRect(): OnyxCssRect | null {
  const local = currentLimitRect()
  const el = containerRef.value
  const host = el?.closest('.spread-host, .pane-left, .paged-box') as HTMLElement | null
  if (!host) return local
  const hr = host.getBoundingClientRect()
  if (hr.width <= 1 || hr.height <= 1) return local
  const viewport = el?.closest('.paged-box, .pane-left') as HTMLElement | null
  const vr = viewport && viewport !== host ? viewport.getBoundingClientRect() : null
  const left = Math.round(vr && vr.width > 1 ? Math.max(hr.left, vr.left) : hr.left)
  const top = Math.round(vr && vr.height > 1 ? Math.max(hr.top, vr.top) : hr.top)
  const right = Math.round(vr && vr.width > 1 ? Math.min(hr.right, vr.right) : hr.right)
  const bottom = Math.round(vr && vr.height > 1 ? Math.min(hr.bottom, vr.bottom) : hr.bottom)
  if (right <= left + 1 || bottom <= top + 1) return local
  return { left, top, right, bottom }
}

function scheduleRegalRepaint() {
  clearTimeout(regalTimer)
  regalTimer = setTimeout(() => {
    regalTimer = undefined
    onyxEpd.repaint('regal')
  }, 200)
}

function loadCurrentStrokes() {
  const loaded = onyxScribble.loadPageStrokes(props.bookId, props.pageKey)
  if (!loaded.length && props.legacyPageKey && props.legacyPageKey !== props.pageKey) {
    strokes.value = onyxScribble.loadPageStrokes(props.bookId, props.legacyPageKey)
  } else {
    strokes.value = loaded
  }
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
  const pushEl = (el: Element | null) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 1 && r.height > 1) {
      out.push({
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      })
    }
  }
  pushEl(toolbarRef.value)
  if (typeof document !== 'undefined') {
    for (const el of document.querySelectorAll(HOST_EXCLUDE_SELECTORS)) pushEl(el)
  }
  return out
}

function syncNativeGeometry() {
  if (!props.active) return
  onyxScribble.configure({
    enabled: props.enabled,
    tool: tool.value,
    strokeWidth: strokeWidth.value,
    limitRect: nativeHostRect(),
    excludeRects: currentExcludeRects(),
  })
}

function scheduleGeometrySync() {
  if (!props.active || !props.enabled || props.modalOpen || typeof requestAnimationFrame !== 'function') return
  if (geometryRaf) return
  geometryRaf = requestAnimationFrame(() => {
    geometryRaf = 0
    syncNativeGeometry()
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

  const baseWidth = widthOverride ?? strokeWidth.value
  const meanP = normPoints.reduce((acc, p) => acc + p.p, 0) / normPoints.length
  const effectiveWidth = Math.round(baseWidth * (0.65 + 0.7 * meanP) * 100) / 100

  const nextStroke: OnyxInkStroke = {
    id: `ink-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tool: tool.value,
    width: effectiveWidth,
    points: normPoints,
    createdAt: Date.now(),
  }
  strokes.value = [...strokes.value, nextStroke]
  persistCurrentStrokes()
  scheduleRegalRepaint()
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
  sharedBrushState.tool = tool.value
  sharedBrushState.width = strokeWidth.value
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pagewise:scribble-tool', { detail: { tool: tool.value, width: strokeWidth.value } }))
  }
  syncNativeGeometry()
}

function onSharedToolSync(event: Event) {
  const detail = (event as CustomEvent<{ tool?: OnyxBrushTool; width?: number }>).detail
  if (!detail?.tool) return
  tool.value = detail.tool
  if (typeof detail.width === 'number') strokeWidth.value = detail.width
}

function onPointerDown(e: PointerEvent) {
  if (!props.enabled || props.modalOpen) return
  if (e.pointerType === 'pen') penDetected.value = true
  // 电磁笔已激活期间拒斥单指误触 (Palm Rejection)
  if (e.pointerType === 'touch' && penDetected.value) return
  clearTimeout(regalTimer)
  regalTimer = undefined
  const isBarrelErase = e.button === 5 || (e.buttons & 32) !== 0
  barrelErasing.value = isBarrelErase
  if (tool.value === 'eraser' || isBarrelErase) {
    onyxEpd.enterFastMode('scribble-erase', 'a2')
  }
  drawingPointerId.value = e.pointerId
  activePoints.value = [{ x: e.clientX, y: e.clientY, p: e.pressure || 0.5, t: Date.now() }]
  ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (drawingPointerId.value !== e.pointerId || !props.enabled || props.modalOpen) return
  activePoints.value.push({ x: e.clientX, y: e.clientY, p: e.pressure || 0.5, t: Date.now() })
  if ((tool.value === 'eraser' || barrelErasing.value) && strokes.value.length) {
    const rect = currentLimitRect()
    if (rect) {
      erasingIds.value = findIntersectingStrokeIds(strokes.value, normalizePointsToRect(activePoints.value, rect))
    }
  }
}

function onPointerUp(e: PointerEvent) {
  if (drawingPointerId.value !== e.pointerId) return
  drawingPointerId.value = null
  const pts = activePoints.value
  const eraseGesture = tool.value === 'eraser' || barrelErasing.value
  barrelErasing.value = false
  activePoints.value = []
  erasingIds.value = new Set()
  if (eraseGesture) onyxEpd.exitFastModeNow()
  commitPoints(pts, eraseGesture ? 'erase' : 'stroke')
}

const activeDraftStroke = computed<OnyxInkStroke | null>(() => {
  if (!activePoints.value.length || tool.value === 'eraser' || barrelErasing.value) return null
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
  () => [props.bookId, props.pageKey, props.legacyPageKey],
  () => {
    loadCurrentStrokes()
    void nextTick(() => syncNativeGeometry())
  },
  { immediate: true },
)

watch(
  () => [props.enabled, props.active],
  () => {
    void nextTick(() => syncNativeGeometry())
  },
)

watch(
  () => props.modalOpen,
  suspended => {
    if (props.active) {
      onyxScribble.setModalSuspended(Boolean(suspended))
      if (!suspended) scheduleGeometrySync()
    }
  },
  { immediate: true },
)

onMounted(() => {
  unsubscribeNative = onyxScribble.subscribe(ev => {
    if (!props.enabled || props.modalOpen) return
    if (!ev.points.length || !pointInRect(ev.points[0], currentLimitRect())) return
    commitPoints(ev.points, ev.kind, ev.width)
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('pagewise:scribble-tool', onSharedToolSync)
    window.addEventListener('scroll', scheduleGeometrySync, { capture: true, passive: true })
    window.addEventListener('resize', scheduleGeometrySync, { passive: true })
  }
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    containerObserver = new ResizeObserver(() => scheduleGeometrySync())
    containerObserver.observe(containerRef.value)
  }
  syncNativeGeometry()
})

onBeforeUnmount(() => {
  clearTimeout(regalTimer)
  regalTimer = undefined
  if (geometryRaf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(geometryRaf)
    geometryRaf = 0
  }
  containerObserver?.disconnect()
  containerObserver = undefined
  if (typeof window !== 'undefined') {
    window.removeEventListener('pagewise:scribble-tool', onSharedToolSync)
    window.removeEventListener('scroll', scheduleGeometrySync, true)
    window.removeEventListener('resize', scheduleGeometrySync)
  }
  unsubscribeNative?.()
  if (props.active) {
    onyxScribble.configure({ enabled: false, limitRect: null, excludeRects: [] })
  }
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
        :stroke-opacity="erasingIds.has(s.id) ? 0.42 : (s.tool === 'marker' ? 0.38 : 1)"
        :stroke-dasharray="erasingIds.has(s.id) ? '4 4' : (s.tool === 'pencil' ? '2 1' : undefined)"
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
      v-if="enabled && active && !modalOpen"
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
        :aria-label="t('reader.scribblePen')"
        @click="selectTool('fountain')"
      >
        {{ t('reader.scribblePen') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'pencil' }"
        :aria-pressed="tool === 'pencil'"
        :aria-label="t('reader.scribblePencil')"
        @click="selectTool('pencil')"
      >
        {{ t('reader.scribblePencil') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'marker' }"
        :aria-pressed="tool === 'marker'"
        :aria-label="t('reader.scribbleMarker')"
        @click="selectTool('marker')"
      >
        {{ t('reader.scribbleMarker') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :class="{ active: tool === 'eraser' }"
        :aria-pressed="tool === 'eraser'"
        :aria-label="t('reader.scribbleEraser')"
        @click="selectTool('eraser')"
      >
        {{ t('reader.scribbleEraser') }}
      </button>
      <button
        v-if="strokes.length"
        type="button"
        class="onyx-ink-btn"
        :aria-label="t('reader.scribbleClear')"
        @click="clearPageInk"
      >
        {{ t('reader.scribbleClear') }}
      </button>
      <button
        type="button"
        class="onyx-ink-btn"
        :aria-label="t('common.close')"
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
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  background: var(--card, #ffffff);
  color: var(--text, #111111);
  border: 2px solid currentColor;
  border-radius: 0;
  pointer-events: auto;
  z-index: 8;
}
.onyx-ink-btn {
  min-inline-size: 48px;
  min-block-size: 48px;
  padding: 6px 12px;
  font-size: 13px;
  border: 1.5px solid currentColor;
  background: var(--card, #ffffff);
  color: var(--text, #111111);
  border-radius: 0;
  cursor: pointer;
}
.onyx-ink-btn.active {
  background: var(--text, #000000);
  color: var(--bg, #ffffff);
  font-weight: 600;
}
</style>
