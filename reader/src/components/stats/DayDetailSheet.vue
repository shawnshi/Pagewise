<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../i18n'
import type { BookMeta } from '../../storage'
import { addDays, type DayEntry } from '../../services/readingStats'
import StatsBookList, { type StatsBookRow } from './StatsBookList.vue'
import { durationParts, fmtDayLong } from './format'

/**
 * 当天详情: 桌面是右侧面板, 手机是底部弹出面板. 有遮罩, 点遮罩 / Esc / 关闭按钮关闭;
 * 打开时焦点移入并在面板内循环, 关闭后还给触发它的元素. 面板内可前后翻天.
 */
const props = defineProps<{
  day: string | null
  today: string
  firstDay: string
  entry?: DayEntry
  goalMinutes: number
  booksById: Map<string, BookMeta>
  /** 关闭后焦点回到这里 */
  returnFocus?: HTMLElement | null
}>()
const emit = defineEmits<{ close: []; navigate: [day: string]; open: [book: BookMeta] }>()

const panel = ref<HTMLElement>()
const closeBtn = ref<HTMLButtonElement>()
const seconds = computed(() => props.entry?.seconds ?? 0)
const parts = computed(() => durationParts(seconds.value))
const met = computed(() => props.goalMinutes > 0 && seconds.value >= props.goalMinutes * 60)
const canPrev = computed(() => !!props.day && props.day > props.firstDay)
const canNext = computed(() => !!props.day && props.day < props.today)
const rows = computed<StatsBookRow[]>(() => {
  const total = Math.max(1, seconds.value)
  return (props.entry?.books ?? []).map(b => {
    const book = b.bookId ? props.booksById.get(b.bookId) : undefined
    return { key: b.key, title: book?.title || b.title, seconds: b.seconds, kind: b.kind, book, share: b.seconds / total }
  })
})
const title = computed(() => (props.day ? fmtDayLong(props.day, props.today) : ''))
const isToday = computed(() => props.day === props.today)

watch(() => props.day, async (day, prev) => {
  if (day && !prev) {
    await nextTick()
    closeBtn.value?.focus()
  } else if (!day && prev) {
    const el = props.returnFocus
    if (el && document.contains(el)) el.focus()
  }
})

function go(delta: number) {
  if (!props.day) return
  if (delta < 0 && !canPrev.value) return
  if (delta > 0 && !canNext.value) return
  emit('navigate', addDays(props.day, delta))
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault()
    go(e.key === 'ArrowLeft' ? -1 : 1)
    return
  }
  if (e.key !== 'Tab' || !panel.value) return
  // 焦点在面板内循环
  const focusables = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
  if (!focusables.length) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

// 手机底部面板: 按住顶部往下拖可关闭 (只动 transform)
const dragY = ref(0)
let dragStart: number | null = null
function onDragStart(e: PointerEvent) {
  if (e.pointerType === 'mouse' || !window.matchMedia('(max-width: 720px)').matches) return
  if ((e.target as HTMLElement).closest('button')) return
  dragStart = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onDragMove(e: PointerEvent) {
  if (dragStart == null) return
  dragY.value = Math.max(0, e.clientY - dragStart)
}
function onDragEnd() {
  if (dragStart == null) return
  dragStart = null
  if (dragY.value > 90) emit('close')
  dragY.value = 0
}

// 打开时锁住背后的滚动容器
watch(() => !!props.day, open => {
  document.documentElement.classList.toggle('lr-sheet-open', open)
})
onBeforeUnmount(() => document.documentElement.classList.remove('lr-sheet-open'))
</script>

<template>
  <Teleport to="body">
    <Transition name="dd">
      <div v-if="day" class="dd-mask" @click.self="emit('close')" @keydown="onKey">
        <div
          ref="panel"
          class="dd-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="stats-day-title"
          :class="{ dragging: dragY > 0 }"
          :style="dragY ? { transform: `translateY(${dragY}px)` } : undefined"
        >
          <header
            class="dd-head"
            @pointerdown="onDragStart"
            @pointermove="onDragMove"
            @pointerup="onDragEnd"
            @pointercancel="onDragEnd"
          >
            <div class="dd-nav">
              <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.prevDay')" :aria-label="t('stats.prevDay')" :disabled="!canPrev" @click="go(-1)">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.41 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z" /></svg>
              </button>
              <h2 id="stats-day-title" aria-live="polite">
                {{ title }}<span v-if="isToday" class="today-tag">{{ t('stats.todayShort') }}</span>
              </h2>
              <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.nextDay')" :aria-label="t('stats.nextDay')" :disabled="!canNext" @click="go(1)">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 18.7a1 1 0 0 1 0-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0z" /></svg>
              </button>
            </div>
            <button ref="closeBtn" type="button" class="btn btn-ghost btn-icon close" :title="t('common.close')" :aria-label="t('common.close')" @click="emit('close')">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3a1 1 0 0 0 1.4-1.42L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58 6.7 5.3z" /></svg>
            </button>
          </header>

          <div class="dd-body">
            <div class="dd-total">
              <span class="value">
                <template v-for="(p, i) in parts" :key="i"><span class="n">{{ p.n }}</span><span class="u">{{ p.u }}</span></template>
              </span>
              <span v-if="met" class="met">
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9.55 17.3a1 1 0 0 1-.7-.3l-4.2-4.2a1 1 0 1 1 1.41-1.41l3.5 3.49 8.28-8.29a1 1 0 1 1 1.42 1.42l-9 9a1 1 0 0 1-.71.29z" /></svg>
                {{ t('stats.dayGoalMet') }}
              </span>
            </div>
            <p v-if="!rows.length" class="empty-day">{{ t('stats.dayEmpty') }}</p>
            <StatsBookList v-else :rows="rows" @open="emit('open', $event)" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dd-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  justify-content: flex-end;
  background: var(--overlay);
}
.dd-panel {
  width: min(420px, 100%);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  padding-top: var(--lr-safe-top);
}
.dd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 12px 6px 14px;
}
.dd-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
h2 {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px;
  font-size: 16px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.today-tag {
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
}
.dd-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 8px 22px calc(24px + var(--lr-safe-bottom));
}
.dd-total {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 16px;
}
.value {
  display: inline-flex;
  align-items: baseline;
}
.n {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.u {
  margin: 0 6px 0 3px;
  color: var(--text-2);
  font-size: 14px;
}
.u:last-child {
  margin-right: 0;
}
.met {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-pill);
  background: var(--success-soft);
  color: var(--success);
  font-size: 12px;
  font-weight: 600;
}
.empty-day {
  padding: 24px 0;
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
}

/* 进出场: 遮罩淡入, 面板从右侧滑入 (手机从底部) */
.dd-enter-active,
.dd-leave-active {
  transition: opacity var(--dur-slow) var(--ease);
}
.dd-enter-active .dd-panel,
.dd-leave-active .dd-panel {
  transition: transform var(--dur-slow) var(--ease);
}
.dd-enter-from,
.dd-leave-to {
  opacity: 0;
}
.dd-enter-from .dd-panel,
.dd-leave-to .dd-panel {
  transform: translateX(32px);
}

@media (max-width: 720px) {
  .dd-mask {
    align-items: flex-end;
  }
  .dd-panel {
    width: 100%;
    height: auto;
    max-height: 82vh;
    max-height: 82dvh;
    border-left: 0;
    border-top: 1px solid var(--border);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding-top: 6px;
  }
  .dd-panel::before {
    content: '';
    align-self: center;
    width: 36px;
    height: 4px;
    margin-top: 2px;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .dd-head {
    padding: 8px 8px 4px 10px;
    touch-action: none;
  }
  .dd-body {
    padding: 6px 16px calc(20px + var(--lr-safe-bottom));
  }
  .dd-enter-from .dd-panel,
  .dd-leave-to .dd-panel {
    transform: translateY(100%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dd-enter-active,
  .dd-leave-active,
  .dd-enter-active .dd-panel,
  .dd-leave-active .dd-panel {
    transition: none;
  }
}
/* 禁用的幽灵按钮不显示边框底色 */
.btn-ghost:disabled {
  border-color: transparent;
  background: transparent;
}
</style>

<style>
/* 底部面板打开时锁住应用主滚动区 (主区域是 .main, 不是 body) */
html.lr-sheet-open .main {
  overflow: hidden;
}
</style>
