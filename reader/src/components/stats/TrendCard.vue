<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../../i18n'
import type { BookMeta } from '../../storage'
import {
  addDays,
  comparePeriods,
  filterDaily,
  monthlyTotals,
  niceTicks,
  periodRange,
  rangeSummary,
  shiftPeriod,
  type DailyMap,
  type KindFilter,
  type PeriodKind,
} from '../../services/readingStats'
import StatsBookList, { type StatsBookRow } from './StatsBookList.vue'
import { durationParts, fmtAxis, fmtDay, fmtDayLong, fmtDuration, isCoarse } from './format'

const props = defineProps<{
  daily: DailyMap
  today: string
  goalMinutes: number
  booksById: Map<string, BookMeta>
}>()
const emit = defineEmits<{ selectDay: [day: string, trigger: HTMLElement]; open: [book: BookMeta] }>()

const KINDS: PeriodKind[] = ['week', 'month', 'year']
const FILTERS: KindFilter[] = ['all', 'book', 'paper']
const kind = ref<PeriodKind>('week')
const anchor = ref(props.today)
const filter = ref<KindFilter>('all')
const showAllBooks = ref(false)

function setKind(k: PeriodKind) {
  if (kind.value === k) return
  kind.value = k
  anchor.value = props.today
}
// 跨过午夜: 停在本期时跟着走
watch(() => props.today, (now, before) => {
  if (anchor.value === before) anchor.value = now
})

const filtered = computed(() => filterDaily(props.daily, filter.value))
const range = computed(() => periodRange(kind.value, anchor.value))
const isCurrent = computed(() => range.value.from <= props.today && props.today <= range.value.to)
const firstDay = computed(() => Object.keys(props.daily).filter(d => props.daily[d].seconds > 0).sort()[0] ?? props.today)
const canPrev = computed(() => range.value.from > firstDay.value)
const canNext = computed(() => range.value.to < props.today)
function shift(delta: number) {
  anchor.value = shiftPeriod(kind.value, anchor.value, delta)
  showAllBooks.value = false
  active.value = null
}
function backToNow() {
  anchor.value = props.today
  active.value = null
}
watch([kind, filter], () => {
  showAllBooks.value = false
  active.value = null
})

const title = computed(() => {
  const { from, to } = range.value
  const thisYear = props.today.slice(0, 4)
  if (kind.value === 'week') {
    const sameYear = from.slice(0, 4) === thisYear && to.slice(0, 4) === thisYear
    const opts: Intl.DateTimeFormatOptions = sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }
    return `${fmtDay(from, opts)} – ${fmtDay(to, opts)}`
  }
  if (kind.value === 'month') return fmtDay(from, { year: 'numeric', month: 'long' })
  return fmtDay(from, { year: 'numeric' })
})
const currentLabel = computed(() => t(`stats.current.${kind.value}`))

// ---- 指标 ----
const cmp = computed(() => comparePeriods(filtered.value, kind.value, anchor.value, props.today))
const summary = computed(() => rangeSummary(filtered.value, range.value.from, range.value.to))
const avg = computed(() => (cmp.value.elapsedDays ? summary.value.seconds / cmp.value.elapsedDays : 0))
const totalParts = computed(() => durationParts(summary.value.seconds))
const delta = computed(() => {
  const r = cmp.value.deltaRatio
  const prev = t(isCurrent.value ? `stats.vsPrevSoFar.${kind.value}` : `stats.vsPrev.${kind.value}`)
  if (r == null) return { dir: 'none' as const, text: prev, value: '—', aria: t('stats.deltaAriaNone', { prev }) }
  const p = Math.round(Math.abs(r) * 100)
  if (p === 0) return { dir: 'flat' as const, text: prev, value: '0%', aria: t('stats.deltaAriaFlat', { prev }) }
  return r > 0
    ? { dir: 'up' as const, text: prev, value: `${p}%`, aria: t('stats.deltaAriaUp', { prev, pct: p }) }
    : { dir: 'down' as const, text: prev, value: `${p}%`, aria: t('stats.deltaAriaDown', { prev, pct: p }) }
})

// ---- 柱状图 ----
interface Bar { key: string; day: string; label: string; aria: string; seconds: number; future: boolean; current: boolean }
const bars = computed<Bar[]>(() => {
  const { from, to } = range.value
  if (kind.value === 'year') {
    return monthlyTotals(filtered.value, Number(from.slice(0, 4))).map(m => {
      const day = `${m.month}-01`
      return {
        key: m.month,
        day,
        label: fmtDay(day, { month: 'short' }),
        aria: t('stats.barLabel', { label: fmtDay(day, { year: 'numeric', month: 'long' }), time: fmtDuration(m.seconds) }),
        seconds: m.seconds,
        future: day > props.today,
        current: m.month === props.today.slice(0, 7),
      }
    })
  }
  const out: Bar[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const seconds = filtered.value[day]?.seconds ?? 0
    const d = Number(day.slice(8))
    out.push({
      key: day,
      day,
      label: kind.value === 'week' ? fmtDay(day, { weekday: 'short' }) : (d === 1 || d % 5 === 0 ? String(d) : ''),
      aria: t('stats.barLabel', { label: fmtDayLong(day, props.today), time: fmtDuration(seconds) }),
      seconds,
      future: day > props.today,
      current: day === props.today,
    })
  }
  return out
})
const goalLine = computed(() => (kind.value !== 'year' && props.goalMinutes > 0 ? props.goalMinutes * 60 : 0))
const ticks = computed(() => niceTicks(Math.max(0, goalLine.value, ...bars.value.map(b => b.seconds))))
const top = computed(() => ticks.value[ticks.value.length - 1] || 1)
/** 与目标线挨得太近的刻度不显示数字, 让给目标值 */
const axisTicks = computed(() => ticks.value.filter(tick => !goalLine.value || tick === 0 || Math.abs(tick - goalLine.value) / top.value > 0.09))
function barPct(seconds: number): number {
  return seconds > 0 ? Math.max(1.5, (seconds / top.value) * 100) : 0
}
const chartAria = computed(() => `${t('stats.chartAria', { range: title.value })}，${t('stats.periodTotal')} ${fmtDuration(summary.value.seconds)}`)

// 读数: 悬停 / 聚焦 / 触屏第一次点按时显示所指柱子的数值 (不依赖 hover)
const active = ref<number | null>(null)
const focusIndex = ref<number | null>(null)
const plotEl = ref<HTMLElement>()
const lastPointer = ref<string>('mouse')
const rovingIndex = computed(() => {
  if (focusIndex.value != null) return focusIndex.value
  const cur = bars.value.findIndex(b => b.current)
  if (cur >= 0) return cur
  const last = bars.value.map(b => !b.future).lastIndexOf(true)
  return Math.max(0, last)
})
const activeBar = computed(() => (active.value != null ? bars.value[active.value] : undefined))
const readout = computed(() => {
  const b = activeBar.value
  if (!b) return null
  const label = kind.value === 'year' ? fmtDay(b.day, { year: 'numeric', month: 'long' }) : fmtDayLong(b.day, props.today)
  return { label, time: fmtDuration(b.seconds) }
})

function onBarPointerEnter(i: number, e: PointerEvent) {
  lastPointer.value = e.pointerType
  if (e.pointerType === 'mouse') active.value = i
}
function onPlotLeave(e: PointerEvent) {
  if (e.pointerType === 'mouse' && focusIndex.value == null) active.value = null
}
function onBarPointerDown(e: PointerEvent) {
  lastPointer.value = e.pointerType
}
function act(i: number, trigger: HTMLElement) {
  const b = bars.value[i]
  if (!b || b.future) return
  if (kind.value === 'year') {
    kind.value = 'month'
    anchor.value = b.day
    active.value = null
    focusIndex.value = null
    void nextTick(() => plotEl.value?.querySelector<HTMLElement>('button.bar-hit[tabindex="0"]')?.focus())
    return
  }
  emit('selectDay', b.day, trigger)
}
function onBarClick(i: number, e: MouseEvent) {
  const touch = lastPointer.value === 'touch' || lastPointer.value === 'pen' || (e.detail > 0 && isCoarse())
  // 触屏: 第一次点按只显示数值, 再点同一根才打开
  if (touch && active.value !== i) {
    active.value = i
    return
  }
  act(i, e.currentTarget as HTMLElement)
}
function onBarFocus(i: number) {
  focusIndex.value = i
  active.value = i
}
function onBarBlur() {
  focusIndex.value = null
  if (lastPointer.value === 'mouse') active.value = null
}
function onBarKey(i: number, e: KeyboardEvent) {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
  let next = i
  if (step) next = i + step
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = bars.value.map(b => !b.future).lastIndexOf(true)
  else return
  e.preventDefault()
  if (next < 0 || next >= bars.value.length || bars.value[next].future) return
  plotEl.value?.querySelectorAll<HTMLElement>('button.bar-hit')[next]?.focus()
}
function readoutAction(e: MouseEvent) {
  if (active.value != null) act(active.value, e.currentTarget as HTMLElement)
}

// ---- 本期书单 ----
const BOOKS_PREVIEW = 6
const bookRows = computed<StatsBookRow[]>(() => {
  const total = Math.max(1, summary.value.seconds)
  return summary.value.books.map(b => {
    const book = b.bookId ? props.booksById.get(b.bookId) : undefined
    return { key: b.key, title: book?.title || b.title, seconds: b.seconds, kind: b.kind, book, share: b.seconds / total }
  })
})
const visibleRows = computed(() => (showAllBooks.value ? bookRows.value : bookRows.value.slice(0, BOOKS_PREVIEW)))

</script>

<template>
  <section class="card trend" aria-labelledby="stats-trend-title">
    <div class="controls">
      <div class="segmented" role="group" :aria-label="t('stats.periodAria')">
        <button
          v-for="k in KINDS"
          :key="k"
          type="button"
          :class="{ active: kind === k }"
          :aria-pressed="kind === k"
          @click="setKind(k)"
        >{{ t(`stats.${k}`) }}</button>
      </div>
      <div class="segmented" role="group" :aria-label="t('stats.filterAria')">
        <button
          v-for="f in FILTERS"
          :key="f"
          type="button"
          :class="{ active: filter === f }"
          :aria-pressed="filter === f"
          @click="filter = f"
        >{{ t(`stats.filter.${f}`) }}</button>
      </div>
    </div>

    <div class="period">
      <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.prev')" :aria-label="t('stats.prev')" :disabled="!canPrev" @click="shift(-1)">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.41 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z" /></svg>
      </button>
      <h2 id="stats-trend-title" class="period-title" aria-live="polite">
        {{ title }}<span v-if="isCurrent" class="period-current">{{ currentLabel }}</span>
      </h2>
      <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.next')" :aria-label="t('stats.next')" :disabled="!canNext" @click="shift(1)">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 18.7a1 1 0 0 1 0-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0z" /></svg>
      </button>
      <button v-if="!isCurrent" type="button" class="btn btn-sm back-now" @click="backToNow">{{ t('stats.backToNow') }}</button>
    </div>

    <div class="metrics">
      <div class="total">
        <span class="sr-only">{{ t('stats.periodTotal') }}</span>
        <span class="total-value">
          <template v-for="(p, i) in totalParts" :key="i"><span class="n">{{ p.n }}</span><span class="u">{{ p.u }}</span></template>
        </span>
        <span class="delta" :class="delta.dir" :aria-label="delta.aria" role="img">
          <svg v-if="delta.dir === 'up'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 4a1 1 0 0 1 .7.3l6 6a1 1 0 1 1-1.4 1.4L13 7.42V19a1 1 0 1 1-2 0V7.41l-4.3 4.3a1 1 0 1 1-1.4-1.42l6-6A1 1 0 0 1 12 4z" /></svg>
          <svg v-else-if="delta.dir === 'down'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 20a1 1 0 0 1-.7-.3l-6-6a1 1 0 1 1 1.4-1.4l4.3 4.28V5a1 1 0 1 1 2 0v11.59l4.3-4.3a1 1 0 0 1 1.4 1.42l-6 6a1 1 0 0 1-.7.29z" /></svg>
          <span class="delta-value">{{ delta.value }}</span>
          <span class="delta-text">{{ delta.text }}</span>
        </span>
      </div>
      <dl class="facts">
        <div><dt>{{ t('stats.dailyAvg') }}</dt><dd>{{ fmtDuration(avg) }}</dd></div>
        <div><dt>{{ t('stats.periodDays') }}</dt><dd>{{ t('stats.daysValue', { n: summary.activeDays }) }}</dd></div>
        <div><dt>{{ t('stats.periodBooks') }}</dt><dd>{{ t('stats.booksValue', { n: summary.books.length }) }}</dd></div>
      </dl>
    </div>

    <div class="chart" :class="`chart-${kind}`">
      <div class="readout" aria-live="polite">
        <template v-if="readout">
          <span class="readout-label">{{ readout.label }}</span>
          <span class="readout-time">{{ readout.time }}</span>
          <button
            v-if="activeBar && !activeBar.future"
            type="button"
            class="readout-action"
            @click="readoutAction"
          >
            {{ kind === 'year' ? t('stats.readoutOpenMonth') : t('stats.readoutOpenDay') }}
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 18.7a1 1 0 0 1 0-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0z" /></svg>
          </button>
        </template>
        <template v-else>
          <span class="readout-hint">{{ kind === 'year' ? t('stats.readoutHintYear') : t('stats.readoutHint') }}</span>
          <span v-if="goalLine" class="goal-legend"><span class="goal-swatch" aria-hidden="true" />{{ t('stats.goalLine', { m: goalMinutes }) }}</span>
        </template>
      </div>

      <div class="chart-body">
        <div class="y-axis" aria-hidden="true">
          <span v-for="tick in axisTicks" :key="tick" :style="{ bottom: `${(tick / top) * 100}%` }">{{ tick === 0 ? '0' : fmtAxis(tick) }}</span>
          <span v-if="goalLine" class="y-goal" :style="{ bottom: `${(goalLine / top) * 100}%` }">{{ fmtAxis(goalLine) }}</span>
        </div>
        <div
          ref="plotEl"
          class="plot"
          role="group"
          :aria-label="chartAria"
          @pointerleave="onPlotLeave"
        >
          <span
            v-for="tick in ticks.slice(1)"
            :key="tick"
            class="grid"
            :style="{ bottom: `${(tick / top) * 100}%` }"
            aria-hidden="true"
          />
          <span v-if="goalLine" class="goal-line" :style="{ bottom: `${(goalLine / top) * 100}%` }" aria-hidden="true" />
          <div :key="`${kind}-${range.from}-${filter}`" class="bars" :class="{ 'has-active': !!activeBar && activeBar.seconds > 0 }">
            <div
              v-for="(bar, i) in bars"
              :key="bar.key"
              class="col"
              :class="{ current: bar.current, future: bar.future, active: active === i }"
            >
              <button
                v-if="!bar.future"
                type="button"
                class="bar-hit"
                :tabindex="i === rovingIndex ? 0 : -1"
                :aria-label="bar.aria"
                @pointerenter="onBarPointerEnter(i, $event)"
                @pointerdown="onBarPointerDown"
                @click="onBarClick(i, $event)"
                @focus="onBarFocus(i)"
                @blur="onBarBlur"
                @keydown="onBarKey(i, $event)"
              >
                <span class="bar" :class="{ zero: bar.seconds <= 0 }" :style="{ height: bar.seconds > 0 ? `${barPct(bar.seconds)}%` : undefined }" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="x-axis" aria-hidden="true">
        <span v-for="(bar, i) in bars" :key="bar.key" :class="{ current: bar.current, odd: i % 2 === 1 }">{{ bar.label }}</span>
      </div>
    </div>

    <div class="books">
      <h3>{{ t('stats.booksInPeriod') }}</h3>
      <p v-if="!bookRows.length" class="muted">{{ t('stats.periodEmpty') }}</p>
      <template v-else>
        <StatsBookList :rows="visibleRows" @open="emit('open', $event)" />
        <button
          v-if="bookRows.length > BOOKS_PREVIEW"
          type="button"
          class="btn btn-ghost btn-sm more"
          :aria-expanded="showAllBooks"
          @click="showAllBooks = !showAllBooks"
        >{{ showAllBooks ? t('stats.showLess') : t('stats.showAllBooks', { n: bookRows.length }) }}</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.trend {
  padding: 20px 24px 16px;
  container-type: inline-size;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.period {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 16px 0 4px -6px;
}
.period-title {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px;
  font-size: 15px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.period-current {
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
}
.back-now {
  margin-left: auto;
}

/* ---- 指标 ---- */
.metrics {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-top: 6px;
}
.total {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.total-value .n {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.total-value .u {
  margin: 0 6px 0 3px;
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
}
.total-value .u:last-child {
  margin-right: 0;
}
.delta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.delta-value {
  font-weight: 650;
}
.delta-text {
  margin-left: 2px;
  color: var(--text-3);
}
.delta.up {
  background: var(--success-soft);
  color: var(--success);
}
.delta.none .delta-value {
  color: var(--text-3);
}
.facts {
  display: flex;
  gap: 24px;
}
.facts dt {
  color: var(--text-3);
  font-size: 12px;
}
.facts dd {
  margin-top: 1px;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ---- 图表 ---- */
.chart {
  margin-top: 18px;
}
.readout {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  margin-bottom: 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.readout-label {
  color: var(--text-2);
}
.readout-time {
  font-weight: 650;
}
.readout-hint {
  color: var(--text-3);
  font-size: 12px;
}
.readout-action {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  margin-left: auto;
  padding: 0 6px 0 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
}
.readout-action:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.chart-body {
  display: flex;
  gap: 8px;
}
.y-axis {
  position: relative;
  flex: 0 0 34px;
  height: 180px;
}
.y-axis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  color: var(--text-3);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.plot {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 180px;
  border-bottom: 1px solid var(--border-strong);
}
.grid {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
  pointer-events: none;
}
.goal-line {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 2;
  border-top: 1.5px dashed var(--success);
  pointer-events: none;
}
.y-axis .y-goal {
  color: var(--success);
  font-weight: 650;
}
.goal-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
}
.goal-swatch {
  width: 14px;
  border-top: 1.5px dashed var(--success);
}
.btn-ghost:disabled {
  border-color: transparent;
  background: transparent;
}
.bars {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 10px;
}
.chart-month .bars {
  gap: 3px;
}
.chart-year .bars {
  gap: 8px;
}
.col {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.bar-hit {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
}
.bar-hit:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.bar {
  display: block;
  width: 100%;
  max-width: 40px;
  border-radius: 5px 5px 1px 1px;
  background: var(--brand);
  opacity: 0.42;
  transform-origin: bottom center;
  animation: bar-grow 420ms var(--ease) both;
  transition: opacity var(--dur-fast) var(--ease);
}
.chart-month .bar {
  border-radius: 3px 3px 1px 1px;
}
.bar.zero {
  height: 2px;
  opacity: 1;
  background: var(--surface-3);
  border-radius: 1px;
  animation: none;
}
.col.current .bar:not(.zero),
:root[data-theme='dark'] .col.current .bar:not(.zero) {
  opacity: 1;
}
.has-active .col .bar:not(.zero) {
  opacity: 0.28;
}
:root[data-theme='dark'] .bar {
  opacity: 0.55;
}
:root[data-theme='dark'] .has-active .col .bar:not(.zero) {
  opacity: 0.35;
}
.has-active .col.active .bar:not(.zero),
:root[data-theme='dark'] .has-active .col.active .bar:not(.zero) {
  opacity: 1;
}
.col.active .bar.zero {
  background: var(--text-3);
}
@keyframes bar-grow {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}
.x-axis {
  display: flex;
  gap: 10px;
  margin: 6px 0 0 42px;
}
.chart-month .x-axis {
  gap: 3px;
}
.chart-year .x-axis {
  gap: 8px;
}
.x-axis span {
  flex: 1;
  min-width: 0;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: visible;
}
.x-axis span.current {
  color: var(--brand);
  font-weight: 650;
}

/* ---- 书单 ---- */
.books {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
h3 {
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
}
.muted {
  color: var(--text-3);
  font-size: 13px;
  padding: 8px 0 4px;
}
.more {
  margin: 4px 0 0 -8px;
  color: var(--brand);
}

@container (max-width: 520px) {
  .facts {
    width: 100%;
    justify-content: space-between;
    gap: 12px;
  }
  .bars,
  .x-axis {
    gap: 6px;
  }
  .chart-month .bars,
  .chart-month .x-axis {
    gap: 2px;
  }
  .chart-year .bars,
  .chart-year .x-axis {
    gap: 4px;
  }
  .chart-year .x-axis span.odd {
    visibility: hidden;
  }
  .y-axis,
  .plot {
    height: 150px;
  }
}
@media (max-width: 560px) {
  .trend {
    padding: 16px 16px 12px;
  }
  .total-value .n {
    font-size: 28px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar {
    animation: none;
    transition: none;
  }
}
</style>
