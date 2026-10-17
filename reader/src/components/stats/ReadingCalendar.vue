<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n'
import {
  ACTIVE_DAY_SECONDS,
  addDays,
  heatmap,
  makeDay,
  monthCalendar,
  weekStartOf,
  yearsWithData,
  type DailyMap,
} from '../../services/readingStats'
import { fmtDay, fmtDayLong, fmtDuration, heatLevel } from './format'

const props = defineProps<{ daily: DailyMap; today: string; selectedDay: string | null }>()
const emit = defineEmits<{ select: [day: string, trigger: HTMLElement] }>()

// ---- 宽卡片画年度热力图, 窄卡片 (手机) 画月历: 按卡片实际宽度切换, 不依赖视口断点 ----
const root = ref<HTMLElement>()
const compact = ref(false)
let ro: ResizeObserver | undefined
onMounted(() => {
  const el = root.value
  if (!el) return
  const measure = (w: number) => { compact.value = w < 600 }
  measure(el.clientWidth)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(entries => measure(entries[0].contentRect.width))
    ro.observe(el)
  }
})
onBeforeUnmount(() => ro?.disconnect())

const focusDay = ref(props.selectedDay ?? props.today)
watch(() => props.selectedDay, d => { if (d) focusDay.value = d })

const firstDay = computed(() => Object.keys(props.daily).filter(d => props.daily[d].seconds > 0).sort()[0] ?? props.today)
const secondsOf = (day: string) => props.daily[day]?.seconds ?? 0
const cellLabel = (day: string) => t('stats.cellLabel', { date: fmtDayLong(day, props.today), time: fmtDuration(secondsOf(day)) })

// ================= 热力图 =================
type Scope = 'recent' | number
const scope = ref<Scope>('recent')
const years = computed(() => yearsWithData(props.daily))
/** 只有今年之前也有记录时才给年份切换 (近一年 + 各年, 最多 4 年) */
const scopes = computed<Scope[]>(() => {
  const ys = years.value
  const thisYear = Number(props.today.slice(0, 4))
  return ys.some(y => y < thisYear) ? ['recent', ...ys.slice(0, 4)] : []
})

type Cell = { day: string; seconds: number } | null
const cols = computed<Cell[][]>(() => {
  if (scope.value === 'recent') return heatmap(props.daily, props.today, 53, 1)
  const y = scope.value
  const from = weekStartOf(makeDay(y, 1, 1))
  const end = makeDay(y, 12, 31)
  const out: Cell[][] = []
  for (let start = from; start <= end; start = addDays(start, 7)) {
    const col: Cell[] = []
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i)
      col.push(day.startsWith(`${y}-`) && day <= props.today ? { day, seconds: secondsOf(day) } : null)
    }
    out.push(col)
  }
  return out
})
const firstCell = computed(() => cols.value.flat().find(c => c)?.day ?? props.today)
const lastCell = computed(() => [...cols.value.flat()].reverse().find(c => c)?.day ?? props.today)
const monthLabels = computed(() => {
  const labels: Array<{ col: number; text: string }> = []
  let last = ''
  cols.value.forEach((col, ci) => {
    const first = col.find(c => c)
    if (!first) return
    const ym = first.day.slice(0, 7)
    if (ym !== last) {
      labels.push({ col: ci, text: fmtDay(first.day, { month: 'short' }) })
      last = ym
    }
  })
  if (labels.length > 1 && labels[1].col - labels[0].col < 3) labels.shift()
  return labels
})
// 周一起: 显示一 / 三 / 五
const weekdayLabels = computed(() => [0, 1, 2, 3, 4, 5, 6].map(i => (i % 2 === 0 && i < 6 ? fmtDay(addDays('2024-01-01', i), { weekday: 'short' }) : '')))
const heatFocus = computed(() => {
  const d = focusDay.value
  return d >= firstCell.value && d <= lastCell.value ? d : lastCell.value
})
const scopeSummary = computed(() => {
  let seconds = 0
  let days = 0
  for (const c of cols.value.flat()) {
    if (!c) continue
    seconds += c.seconds
    if (c.seconds >= ACTIVE_DAY_SECONDS) days++
  }
  return t('stats.calendarSummary', { n: days, time: fmtDuration(seconds) })
})
function scopeLabel(s: Scope) {
  return s === 'recent' ? t('stats.recentYear') : t('stats.yearLabel', { y: s })
}

// ================= 月历 =================
const month = ref(props.today.slice(0, 7))
watch(() => props.selectedDay, d => { if (d && compact.value) month.value = d.slice(0, 7) })
const monthRows = computed(() => monthCalendar(Number(month.value.slice(0, 4)), Number(month.value.slice(5, 7))))
const monthTitle = computed(() => fmtDay(`${month.value}-01`, { year: 'numeric', month: 'long' }))
const canPrevMonth = computed(() => month.value > firstDay.value.slice(0, 7))
const canNextMonth = computed(() => month.value < props.today.slice(0, 7))
function shiftMonth(delta: number) {
  const y = Number(month.value.slice(0, 4))
  const m = Number(month.value.slice(5, 7)) - 1 + delta
  const d = new Date(y, m, 1)
  month.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const monthFocus = computed(() => {
  const d = focusDay.value
  if (d.startsWith(month.value) && d <= props.today) return d
  const last = monthRows.value.flat().filter((x): x is string => !!x && x <= props.today).pop()
  return last ?? `${month.value}-01`
})
const monthSummary = computed(() => {
  let seconds = 0
  let days = 0
  for (const d of monthRows.value.flat()) {
    if (!d) continue
    const s = secondsOf(d)
    seconds += s
    if (s >= ACTIVE_DAY_SECONDS) days++
  }
  return t('stats.calendarSummary', { n: days, time: fmtDuration(seconds) })
})
const weekdayHeads = computed(() => [0, 1, 2, 3, 4, 5, 6].map(i => fmtDay(addDays('2024-01-01', i), { weekday: 'narrow' })))

// ================= 键盘: 方向键移动 (roving tabindex) =================
function onGridKey(e: KeyboardEvent) {
  const map: Record<string, number> = compact.value
    ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    : { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
  const delta = map[e.key]
  if (!delta) return
  e.preventDefault()
  const from = compact.value ? monthFocus.value : heatFocus.value
  const next = addDays(from, delta)
  if (next > props.today) return
  if (compact.value) {
    if (next < firstDay.value && !next.startsWith(month.value)) return
    month.value = next.slice(0, 7)
  } else if (next < firstCell.value || next > lastCell.value) {
    return
  }
  focusDay.value = next
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus())
}
function pick(day: string, e: MouseEvent) {
  focusDay.value = day
  emit('select', day, e.currentTarget as HTMLElement)
}
</script>

<template>
  <section ref="root" class="card cal" aria-labelledby="stats-cal-title">
    <div class="head">
      <h2 id="stats-cal-title">{{ t('stats.calendarTitle') }}</h2>
      <div v-if="!compact && scopes.length" class="segmented scopes" role="group" :aria-label="t('stats.calendarYearAria')">
        <button
          v-for="s in scopes"
          :key="s"
          type="button"
          :class="{ active: scope === s }"
          :aria-pressed="scope === s"
          @click="scope = s"
        >{{ scopeLabel(s) }}</button>
      </div>
      <div v-if="compact" class="month-nav">
        <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.prevMonth')" :aria-label="t('stats.prevMonth')" :disabled="!canPrevMonth" @click="shiftMonth(-1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.41 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z" /></svg>
        </button>
        <span class="month-title" aria-live="polite">{{ monthTitle }}</span>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.nextMonth')" :aria-label="t('stats.nextMonth')" :disabled="!canNextMonth" @click="shiftMonth(1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 18.7a1 1 0 0 1 0-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0z" /></svg>
        </button>
      </div>
    </div>

    <!-- 年度热力图 -->
    <div
      v-if="!compact"
      class="hm"
      role="group"
      :aria-label="t('stats.heatmapAria')"
      :style="{ '--cols': cols.length }"
      @keydown="onGridKey"
    >
      <span
        v-for="m in monthLabels"
        :key="`m${m.col}`"
        class="hm-month"
        :style="{ gridColumn: `${m.col + 2} / span 4` }"
        aria-hidden="true"
      >{{ m.text }}</span>
      <span
        v-for="(w, i) in weekdayLabels"
        :key="`w${i}`"
        class="hm-wd"
        :style="{ gridRow: i + 2 }"
        aria-hidden="true"
      >{{ w }}</span>
      <template v-for="(col, ci) in cols" :key="ci">
        <template v-for="(cell, ri) in col" :key="`${ci}-${ri}`">
          <button
            v-if="cell"
            type="button"
            class="hm-cell"
            :class="[`l${heatLevel(cell.seconds)}`, { today: cell.day === today, selected: cell.day === selectedDay }]"
            :style="{ gridColumn: ci + 2, gridRow: ri + 2 }"
            :data-day="cell.day"
            :tabindex="cell.day === heatFocus ? 0 : -1"
            :title="cellLabel(cell.day)"
            :aria-label="cellLabel(cell.day)"
            @click="pick(cell.day, $event)"
          />
        </template>
      </template>
    </div>

    <!-- 手机: 月历 -->
    <div v-else class="mc" role="group" :aria-label="t('stats.monthCalAria', { month: monthTitle })" @keydown="onGridKey">
      <span v-for="(w, i) in weekdayHeads" :key="`h${i}`" class="mc-head" aria-hidden="true">{{ w }}</span>
      <template v-for="(row, ri) in monthRows" :key="ri">
        <template v-for="(day, di) in row" :key="`${ri}-${di}`">
          <span v-if="!day" class="mc-pad" aria-hidden="true" />
          <button
            v-else
            type="button"
            class="mc-cell"
            :class="[`l${heatLevel(secondsOf(day))}`, { today: day === today, selected: day === selectedDay, future: day > today }]"
            :data-day="day"
            :disabled="day > today"
            :tabindex="day === monthFocus ? 0 : -1"
            :aria-label="cellLabel(day)"
            @click="pick(day, $event)"
          ><span>{{ Number(day.slice(8)) }}</span></button>
        </template>
      </template>
    </div>

    <div class="foot">
      <span class="summary">{{ compact ? monthSummary : scopeSummary }}</span>
      <span class="legend" aria-hidden="true">
        <span>{{ t('stats.heatmapLess') }}</span>
        <span v-for="lv in [0, 1, 2, 3, 4]" :key="lv" class="sw" :class="`l${lv}`" />
        <span>{{ t('stats.heatmapMore') }}</span>
      </span>
    </div>
  </section>
</template>

<style scoped>
.cal {
  padding: 20px 24px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}
h2 {
  font-size: 15px;
  font-weight: 650;
}
.month-nav {
  display: flex;
  align-items: center;
  gap: 2px;
}
.month-title {
  min-width: 96px;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ---- 共用: 0 档用轨道色, 1–4 档是叠在轨道上的品牌色 ---- */
.hm-cell,
.mc-cell,
.sw {
  position: relative;
  padding: 0;
  border: 0;
  background: var(--surface-3);
  isolation: isolate;
}
.hm-cell::before,
.mc-cell::before,
.sw::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--brand);
  opacity: 0;
}
.l1::before { opacity: 0.25; }
.l2::before { opacity: 0.48; }
.l3::before { opacity: 0.72; }
.l4::before { opacity: 1; }

/* ---- 热力图: 列宽自适应撑满卡片 ---- */
.hm {
  display: grid;
  grid-template-columns: auto repeat(var(--cols), minmax(0, 1fr));
  grid-template-rows: 16px;
  column-gap: 3px;
  row-gap: 3px;
}
.hm-month {
  grid-row: 1;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.hm-wd {
  grid-column: 1;
  padding-right: 6px;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1;
  align-self: center;
  text-align: right;
  white-space: nowrap;
}
.hm-cell {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 3px;
  cursor: pointer;
}
.hm-cell.today::after,
.hm-cell.selected::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 4px;
  border: 1.5px solid var(--text-3);
  pointer-events: none;
}
.hm-cell.selected::after {
  border: 2px solid var(--text);
}
.hm-cell:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
  border-radius: 3px;
  z-index: 1;
}
@media (hover: hover) {
  .hm-cell:hover::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 4px;
    border: 1.5px solid var(--text-2);
  }
}

/* ---- 月历 ---- */
.mc {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
}
.mc-head {
  padding-bottom: 4px;
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.mc-cell {
  aspect-ratio: 1;
  max-height: 52px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  display: grid;
  place-items: center;
}
.mc-cell.l4 {
  color: var(--on-brand);
  font-weight: 600;
}
.mc-cell.future {
  background: transparent;
  color: var(--text-3);
  opacity: 0.6;
}
.mc-cell.today {
  box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--brand);
  font-weight: 700;
}
.mc-cell.selected {
  box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--text);
}
.mc-cell:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.mc-cell:not(:disabled):active {
  transform: scale(0.94);
}

/* ---- 底部 ---- */
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 14px;
}
.summary {
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-3);
  font-size: 11px;
}
.legend > span:first-child {
  margin-right: 4px;
}
.legend > span:last-child {
  margin-left: 4px;
}
.sw {
  display: block;
  width: 11px;
  height: 11px;
  border-radius: 3px;
}
@media (max-width: 560px) {
  .cal {
    padding: 16px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mc-cell:not(:disabled):active {
    transform: none;
  }
}
/* 禁用的幽灵按钮不显示边框底色 */
.btn-ghost:disabled {
  border-color: transparent;
  background: transparent;
}
</style>
