<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n'
import { fmtDay, fmtDayLong, fmtDuration } from './format'

const props = defineProps<{
  days: Array<{ day: string; seconds: number; ratio: number; met: boolean; future: boolean; isToday: boolean }>
  goalMinutes: number
  today: string
}>()
const emit = defineEmits<{ select: [day: string, trigger: HTMLElement] }>()

const R = 17
const C = 2 * Math.PI * R
const metCount = computed(() => props.days.filter(d => d.met).length)
const total = computed(() => props.days.reduce((s, d) => s + d.seconds, 0))
const summary = computed(() => props.goalMinutes > 0
  ? t('stats.weekSummaryGoal', { n: metCount.value, time: fmtDuration(total.value) })
  : t('stats.weekSummaryNoGoal', { n: metCount.value, time: fmtDuration(total.value) }))

function aria(d: { day: string; seconds: number; met: boolean }): string {
  const base = t('stats.cellLabel', { date: fmtDayLong(d.day, props.today), time: fmtDuration(d.seconds) })
  return d.met && props.goalMinutes > 0 ? `${base}${t('stats.metSuffix')}` : base
}
</script>

<template>
  <section class="card week" aria-labelledby="stats-week-title">
    <div class="head">
      <h2 id="stats-week-title">{{ t('stats.weekTitle') }}</h2>
      <p class="summary">{{ summary }}</p>
    </div>
    <ol class="days">
      <li v-for="d in days" :key="d.day">
        <button
          type="button"
          class="day"
          :class="{ met: d.met, today: d.isToday, future: d.future, some: d.seconds > 0 }"
          :disabled="d.future"
          :aria-label="aria(d)"
          :title="d.future ? undefined : aria(d)"
          @click="emit('select', d.day, $event.currentTarget as HTMLElement)"
        >
          <span class="wd" aria-hidden="true">{{ fmtDay(d.day, { weekday: 'narrow' }) }}</span>
          <span class="mini" aria-hidden="true">
            <svg viewBox="0 0 40 40">
              <circle class="track" cx="20" cy="20" :r="R" />
              <circle
                v-if="d.ratio > 0"
                class="fill"
                cx="20"
                cy="20"
                :r="R"
                :stroke-dasharray="C"
                :stroke-dashoffset="C * (1 - d.ratio)"
              />
            </svg>
            <span class="num">{{ Number(d.day.slice(8)) }}</span>
          </span>
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.week {
  padding: 18px 20px 16px;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
h2 {
  font-size: 15px;
  font-weight: 650;
}
.summary {
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.days {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 2px;
}
.day {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 0 8px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  transition: background var(--dur-fast) var(--ease);
}
@media (hover: hover) {
  .day:not(:disabled):hover {
    background: var(--surface-2);
  }
}
.day:not(:disabled):active {
  background: var(--surface-3);
}
.day:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.day:disabled {
  cursor: default;
}
.wd {
  font-size: 12px;
  line-height: 1;
}
.mini {
  position: relative;
  width: 40px;
  height: 40px;
}
.mini svg {
  display: block;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.track,
.fill {
  fill: none;
  stroke-width: 4.5;
}
.track {
  stroke: var(--surface-3);
}
.fill {
  stroke: var(--brand);
  stroke-linecap: round;
}
.met .fill {
  stroke: var(--success);
}
.num {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.met .num {
  color: var(--success);
}
.today .wd {
  color: var(--brand);
  font-weight: 650;
}
.today .num {
  color: var(--text);
}
.today .mini::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -7px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: var(--brand);
}
.future .track {
  stroke-dasharray: 2 4;
  stroke: var(--border-strong);
}
.future .num {
  color: var(--text-3);
  font-weight: 500;
}
</style>
