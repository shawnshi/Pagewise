<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n'
import type { BookMeta } from '../../storage'
import { isSupportedBookFormat } from '../../services/format'
import BookThumb from './BookThumb.vue'
import { durationParts, fmtDuration, pct } from './format'

const props = defineProps<{
  today: string
  todaySeconds: number
  yesterdaySeconds: number
  goalMinutes: number
  streak: number
  /** 今天读满 1 分钟 (算作阅读天) */
  todayActive: boolean
  yesterdayActive: boolean
  continueBook?: BookMeta
}>()
const emit = defineEmits<{ setGoal: [minutes: number]; open: [book: BookMeta] }>()

const goalSeconds = computed(() => props.goalMinutes * 60)
const hasGoal = computed(() => props.goalMinutes > 0)
const ratio = computed(() => (hasGoal.value ? Math.min(1, props.todaySeconds / goalSeconds.value) : 0))
const reached = computed(() => hasGoal.value && props.todaySeconds >= goalSeconds.value)
const remainingMinutes = computed(() => Math.max(1, Math.ceil((goalSeconds.value - props.todaySeconds) / 60)))

const R = 64
const C = 2 * Math.PI * R
const dashOffset = computed(() => C * (1 - ratio.value))
const parts = computed(() => durationParts(props.todaySeconds))

/** 一句话说清今天的状态 */
const status = computed(() => {
  if (!hasGoal.value) return props.todaySeconds >= 60 ? t('stats.statusNoGoal', { time: fmtDuration(props.todaySeconds) }) : t('stats.statusNotStarted')
  if (reached.value) return t('stats.statusDone')
  if (props.todaySeconds < 60) return t('stats.statusNotStarted')
  return t('stats.statusRemaining', { m: remainingMinutes.value })
})
const subline = computed(() => {
  if (reached.value || (!hasGoal.value && props.todaySeconds >= 60)) {
    const diff = props.todaySeconds - props.yesterdaySeconds
    if (props.yesterdaySeconds < 60) return t('stats.readToday', { time: fmtDuration(props.todaySeconds) })
    if (Math.abs(diff) < 60) return t('stats.vsYesterdaySame')
    return diff > 0
      ? t('stats.vsYesterdayMore', { time: fmtDuration(diff) })
      : t('stats.vsYesterdayLess', { time: fmtDuration(-diff) })
  }
  if (hasGoal.value && props.todaySeconds >= 60) return t('stats.progressLine', { time: fmtDuration(props.todaySeconds), pct: pct(ratio.value) })
  if (hasGoal.value) return t('stats.goalNudge', { m: props.goalMinutes })
  return ''
})
const keepStreakHint = computed(() => !props.todayActive && props.yesterdayActive && props.streak > 0)

const ringAria = computed(() => hasGoal.value
  ? t('stats.ringAria', { time: fmtDuration(props.todaySeconds), goal: props.goalMinutes, pct: pct(ratio.value) })
  : t('stats.ringAriaNoGoal', { time: fmtDuration(props.todaySeconds) }))

// ---- 目标: 胶囊按钮展开一组分段选项 ----
const GOAL_PRESETS = [0, 10, 15, 20, 30, 45, 60, 90, 120]
const goalOptions = computed(() => [...new Set([...GOAL_PRESETS, props.goalMinutes])].sort((a, b) => a - b))
const pickerOpen = ref(false)
const pillEl = ref<HTMLButtonElement>()
const pickerEl = ref<HTMLElement>()
async function togglePicker() {
  pickerOpen.value = !pickerOpen.value
  if (pickerOpen.value) {
    await nextTick()
    pickerEl.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus()
  }
}
function pickGoal(m: number) {
  emit('setGoal', m)
  pickerOpen.value = false
  void nextTick(() => pillEl.value?.focus())
}
function onPickerKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    pickerOpen.value = false
    pillEl.value?.focus()
    return
  }
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!dir) return
  e.preventDefault()
  const buttons = [...(pickerEl.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[(i + dir + buttons.length) % buttons.length]?.focus()
}

// ---- 当天首次达成: 一次轻量庆祝 (transform / opacity, 尊重减少动态效果) ----
const CELEBRATED_KEY = 'lightread-stats-celebrated'
const celebrate = ref(false)
function maybeCelebrate() {
  if (!reached.value) return
  let seen = ''
  try { seen = localStorage.getItem(CELEBRATED_KEY) ?? '' } catch { /* 隐私模式 */ }
  if (seen === props.today) return
  try { localStorage.setItem(CELEBRATED_KEY, props.today) } catch { /* 忽略 */ }
  celebrate.value = true
  window.setTimeout(() => { celebrate.value = false }, 1400)
}
onMounted(maybeCelebrate)
watch(reached, v => { if (v) maybeCelebrate() })

const continueReadable = computed(() => Boolean(props.continueBook && isSupportedBookFormat(props.continueBook.format)))
const continueProgress = computed(() => props.continueBook?.progress == null ? null : pct(props.continueBook.progress))
</script>

<template>
  <section class="card today" :class="{ reached, celebrate }" aria-labelledby="stats-today-status">
    <div class="today-main">
      <div class="ring" role="img" :aria-label="ringAria">
        <svg viewBox="0 0 148 148" aria-hidden="true">
          <circle class="ring-track" cx="74" cy="74" :r="R" />
          <circle
            v-if="hasGoal"
            class="ring-fill"
            cx="74"
            cy="74"
            :r="R"
            :stroke-dasharray="C"
            :stroke-dashoffset="dashOffset"
          />
        </svg>
        <span class="sparks" aria-hidden="true"><i v-for="n in 8" :key="n" :style="{ '--a': `${n * 45}deg` }" /></span>
        <div class="ring-center" aria-hidden="true">
          <div class="ring-value">
            <template v-for="(p, i) in parts" :key="i"><span class="n">{{ p.n }}</span><span class="u">{{ p.u }}</span></template>
          </div>
          <div v-if="reached" class="ring-done">
            <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M9.55 17.3a1 1 0 0 1-.7-.3l-4.2-4.2a1 1 0 1 1 1.41-1.41l3.5 3.49 8.28-8.29a1 1 0 1 1 1.42 1.42l-9 9a1 1 0 0 1-.71.29z" /></svg>
            {{ t('stats.ringDone') }}
          </div>
          <div v-else-if="hasGoal" class="ring-goal">{{ t('stats.ringOfGoal', { m: goalMinutes }) }}</div>
          <div v-else class="ring-goal">{{ t('stats.todayShort') }}</div>
        </div>
      </div>

      <div class="today-text">
        <h2 id="stats-today-status" class="status">{{ status }}</h2>
        <p v-if="subline" class="sub">{{ subline }}</p>
        <div class="chips">
          <span v-if="streak > 0" class="chip streak-chip">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12.6 2.2a1 1 0 0 0-1.6.8c0 2.3-1 3.7-2.3 5.2C7.3 9.8 5.5 11.7 5.5 15a6.5 6.5 0 0 0 13 0c0-2.6-1.2-4.8-2.9-6.4a1 1 0 0 0-1.68.8c.03.92-.24 1.66-.71 2.13.1-3.42-1.28-6.7-2.6-9.33zM8.9 13.9c.55-.85 1.2-1.6 1.85-2.33.55-.62 1.1-1.25 1.55-1.95.34 1.4.45 2.9.2 4.48a1 1 0 0 0 1.45 1.05 3.98 3.98 0 0 0 1.68-1.7c.24.5.37 1.03.37 1.55a4.5 4.5 0 0 1-9 0c0-.37.04-.73.12-1.1h-.22z" /></svg>
            {{ t('stats.streakBadge', { n: streak }) }}
          </span>
          <button
            ref="pillEl"
            type="button"
            class="chip goal-pill"
            :aria-expanded="pickerOpen"
            aria-controls="stats-goal-picker"
            @click="togglePicker"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" /></svg>
            {{ hasGoal ? t('stats.goalPill', { m: goalMinutes }) : t('stats.goalPillOff') }}
            <svg class="chev" :class="{ open: pickerOpen }" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.3 9.3a1 1 0 0 1 1.4 0L12 13.58l4.3-4.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.42z" /></svg>
          </button>
        </div>
        <p v-if="keepStreakHint" class="hint">{{ t('stats.streakKeep') }}</p>
      </div>
    </div>
    <div
      v-if="pickerOpen"
      id="stats-goal-picker"
      ref="pickerEl"
      class="goal-picker"
      role="group"
      :aria-label="t('stats.goalPickerAria')"
      @keydown="onPickerKey"
    >
      <div class="goal-options">
        <button
          v-for="opt in goalOptions"
          :key="opt"
          type="button"
          class="goal-opt"
          :class="{ active: opt === goalMinutes }"
          :aria-pressed="opt === goalMinutes"
          @click="pickGoal(opt)"
        >{{ opt === 0 ? t('stats.goalOff') : opt }}</button>
      </div>
      <p class="goal-hint">{{ t('stats.goalHint') }}</p>
    </div>

    <div v-if="continueBook" class="continue">
      <BookThumb :book="continueBook" :title="continueBook.title" :kind="continueBook.kind" size="md" />
      <div class="continue-text">
        <div class="continue-title">{{ continueBook.title }}</div>
        <div class="continue-meta">
          <span v-if="continueProgress != null" class="continue-bar" aria-hidden="true"><span :style="{ transform: `scaleX(${continueProgress / 100})` }" /></span>
          <span>{{ continueProgress != null ? t('stats.readTo', { pct: continueProgress }) : (continueBook.author || '') }}</span>
        </div>
      </div>
      <button type="button" class="btn btn-primary continue-btn" :disabled="!continueReadable" :title="continueReadable ? undefined : t('library.retiredFormat')" :aria-label="continueReadable ? t('stats.openBook', { title: continueBook.title }) : t('library.retiredFormat')" @click="continueReadable && emit('open', continueBook)">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11.03-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z" /></svg>
        {{ continueReadable ? t('stats.continueAction') : t('stats.formatUnavailable') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.today {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.today-main {
  display: flex;
  align-items: center;
  gap: 28px;
}

/* ---- 进度环 ---- */
.ring {
  position: relative;
  flex-shrink: 0;
  width: 148px;
  height: 148px;
}
.ring > svg {
  display: block;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring-track,
.ring-fill {
  fill: none;
  stroke-width: 12;
}
.ring-track {
  stroke: var(--surface-3);
}
.ring-fill {
  stroke: var(--brand);
  stroke-linecap: round;
}
.reached .ring-fill {
  stroke: var(--success);
}
.ring-center {
  position: absolute;
  inset: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
}
.ring-value {
  display: flex;
  align-items: baseline;
  justify-content: center;
  flex-wrap: wrap;
  line-height: 1;
}
.ring-value .n {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.ring-value .u {
  margin: 0 3px 0 2px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
}
.ring-value .u:last-child {
  margin-right: 0;
}
.ring-value .n:nth-of-type(2) {
  font-size: 26px;
}
.ring-goal {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.ring-done {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-pill);
  background: var(--success-soft);
  color: var(--success);
  font-size: 12px;
  font-weight: 600;
}

/* 当天首次达成: 环轻弹 + 一圈光点向外散开 */
.sparks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.sparks i {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px;
  border-radius: 50%;
  background: var(--success);
  opacity: 0;
}
.celebrate .ring {
  animation: ring-pop 700ms var(--ease);
}
.celebrate .sparks i {
  animation: spark 900ms var(--ease) forwards;
}
.celebrate .ring-done {
  animation: done-in 500ms var(--ease) 150ms both;
}
@keyframes ring-pop {
  0% { transform: scale(1); }
  35% { transform: scale(1.05); }
  100% { transform: scale(1); }
}
@keyframes spark {
  0% { opacity: 0; transform: rotate(var(--a)) translateY(-60px) scale(0.4); }
  25% { opacity: 1; }
  100% { opacity: 0; transform: rotate(var(--a)) translateY(-86px) scale(1); }
}
@keyframes done-in {
  from { opacity: 0; transform: translateY(4px) scale(0.9); }
  to { opacity: 1; transform: none; }
}

/* ---- 文案 ---- */
.today-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.status {
  font-size: 20px;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--text);
  text-wrap: balance;
}
.sub {
  color: var(--text-2);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 48px;
  padding: 0 12px 0 10px;
  border-radius: 2px;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--border, #555555);
}
.streak-chip {
  background: var(--surface-2, #F5F5F5);
  color: var(--text, #000000);
  font-weight: 500;
}
:root[data-theme='dark'] .streak-chip {
  background: #1E1E1E;
  color: #FFFFFF;
}
.goal-pill {
  border: 1px solid var(--border, #555555);
  background: var(--bg, #FFFFFF);
  color: var(--text, #000000);
  padding: 0 12px;
  min-height: 48px;
  border-radius: 2px;
  cursor: pointer;
}
@media (hover: hover) {
  .goal-pill:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
    color: var(--text);
  }
}
.goal-pill:focus-visible {
  outline: 2px solid var(--text, #000000);
  border-color: var(--text, #000000);
}
.goal-pill[aria-expanded='true'] {
  border-color: var(--text, #000000);
  background: var(--eink-selected-surface, #DDDDDD);
}
:root[data-theme='dark'] .goal-pill[aria-expanded='true'] {
  border-color: #FFFFFF;
  background: var(--eink-selected-surface, #2A2A2A);
}
.chev {
  transition: transform var(--dur) var(--ease);
}
.chev.open {
  transform: rotate(180deg);
}
.hint {
  color: var(--text-3);
  font-size: 12px;
}
.goal-picker {
  margin-top: -4px;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  animation: picker-in var(--dur) var(--ease);
}
@keyframes picker-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.goal-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.goal-opt {
  min-width: 48px;
  min-height: 48px;
  padding: 0 12px;
  border: 1px solid var(--border, #555555);
  border-radius: 2px;
  background: var(--bg, #FFFFFF);
  color: var(--text, #000000);
  font-size: 14px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
@media (hover: hover) {
  .goal-opt:hover {
    background: var(--surface-2);
    color: var(--text);
  }
}
.goal-opt.active {
  border-color: var(--text, #000000);
  background: var(--eink-selected-surface, #DDDDDD);
  color: var(--text, #000000);
  font-weight: 500;
}
:root[data-theme='dark'] .goal-opt.active {
  border-color: #FFFFFF;
  background: var(--eink-selected-surface, #2A2A2A);
  color: #FFFFFF;
}
.continue-btn {
  min-height: 56px;
  padding: 0 20px;
  border-radius: 2px;
  font-weight: 500;
}
.goal-opt:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.goal-hint {
  margin-top: 8px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}

/* ---- 继续阅读 ---- */
.continue {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
}
.continue-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.continue-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
}
.continue-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.continue-bar {
  flex: 0 1 140px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}
.continue-bar span {
  display: block;
  height: 100%;
  background: var(--brand);
  border-radius: 2px;
  transform-origin: left center;
}
.continue-btn {
  flex-shrink: 0;
}

@media (max-width: 560px) {
  .today {
    padding: 20px 16px 16px;
    gap: 18px;
  }
  .today-main {
    gap: 18px;
  }
  .ring {
    width: 120px;
    height: 120px;
  }
  .ring-center {
    inset: 10px;
  }
  .ring-value .n {
    font-size: 28px;
  }
  .ring-value .n:nth-of-type(2) {
    font-size: 20px;
  }
  .status {
    font-size: 17px;
  }
  .sub {
    font-size: 13px;
  }
  .continue {
    padding: 12px;
    gap: 12px;
  }
  .continue-btn {
    padding: 0 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chev {
    transition: none;
  }
  .celebrate .ring,
  .celebrate .sparks i,
  .celebrate .ring-done,
  .goal-picker {
    animation: none;
  }
}
</style>
