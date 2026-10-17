<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n'
import type { BookMeta } from '../../storage'
import { milestones, type DailyMap } from '../../services/readingStats'
import BookThumb from './BookThumb.vue'
import { durationParts, fmtDay, fmtDuration } from './format'

const props = defineProps<{
  daily: DailyMap
  today: string
  booksById: Map<string, BookMeta>
  /** 书上累计的 readingSeconds 之和: 包含每日记录上线前的历史 */
  legacySeconds: number
}>()
const emit = defineEmits<{ selectDay: [day: string, trigger: HTMLElement]; open: [book: BookMeta] }>()

const ms = computed(() => milestones(props.daily))
const total = computed(() => Math.max(ms.value.totalSeconds, props.legacySeconds))
const totalParts = computed(() => {
  const s = total.value
  if (s < 3600) return durationParts(s)
  const h = s / 3600
  return [{ n: h >= 100 ? String(Math.round(h)) : String(Math.round(h * 10) / 10), u: t('stats.unitHours') }]
})
const firstDay = computed(() => Object.keys(props.daily).filter(d => props.daily[d].seconds > 0).sort()[0])
const totalHint = computed(() => {
  if (props.legacySeconds > ms.value.totalSeconds + 60) return t('stats.msIncludesEarly')
  return firstDay.value ? t('stats.msSince', { date: fmtDay(firstDay.value, { year: 'numeric', month: 'short', day: 'numeric' }) }) : ''
})
const topBook = computed(() => {
  const b = ms.value.topBook
  if (!b) return null
  const book = b.bookId ? props.booksById.get(b.bookId) : undefined
  return { title: book?.title || b.title, seconds: b.seconds, kind: b.kind, book }
})
</script>

<template>
  <section class="card ms" aria-labelledby="stats-ms-title">
    <h2 id="stats-ms-title">{{ t('stats.milestonesTitle') }}</h2>
    <dl class="facts">
      <div class="fact">
        <dt>{{ t('stats.msTotal') }}</dt>
        <dd class="v">
          <span class="value"><template v-for="(p, i) in totalParts" :key="i"><span class="n">{{ p.n }}</span><span class="u">{{ p.u }}</span></template></span>
        </dd>
        <dd v-if="totalHint" class="hint">{{ totalHint }}</dd>
      </div>
      <div class="fact">
        <dt>{{ t('stats.msDays') }}</dt>
        <dd class="v"><span class="value"><span class="n">{{ ms.activeDays }}</span><span class="u">{{ t('stats.unitDays') }}</span></span></dd>
      </div>
      <div class="fact">
        <dt>{{ t('stats.msLongest') }}</dt>
        <dd class="v"><span class="value"><span class="n">{{ ms.longestStreak }}</span><span class="u">{{ t('stats.unitDays') }}</span></span></dd>
      </div>
      <div class="fact">
        <dt>{{ t('stats.msBestDay') }}</dt>
        <dd v-if="ms.bestDay" class="v">
          <button
            type="button"
            class="value link"
            :title="t('stats.msBestDayOpen')"
            @click="emit('selectDay', ms.bestDay.day, $event.currentTarget as HTMLElement)"
          >
            <template v-for="(p, i) in durationParts(ms.bestDay.seconds)" :key="i"><span class="n">{{ p.n }}</span><span class="u">{{ p.u }}</span></template>
          </button>
        </dd>
        <dd v-else class="v"><span class="value"><span class="n">—</span></span></dd>
        <dd v-if="ms.bestDay" class="hint">{{ fmtDay(ms.bestDay.day, { year: 'numeric', month: 'short', day: 'numeric' }) }}</dd>
      </div>
    </dl>

    <component
      :is="topBook.book ? 'button' : 'div'"
      v-if="topBook"
      class="top"
      :class="{ missing: !topBook.book }"
      :type="topBook.book ? 'button' : undefined"
      :title="topBook.book ? t('stats.openBook', { title: topBook.title }) : t('stats.bookMissing')"
      @click="topBook.book && emit('open', topBook.book)"
    >
      <BookThumb :book="topBook.book" :title="topBook.title" :kind="topBook.kind" size="md" />
      <span class="top-text">
        <span class="top-label">{{ t('stats.msTopBook') }}</span>
        <span class="top-title">{{ topBook.title }}</span>
        <span class="top-time">{{ fmtDuration(topBook.seconds) }}<template v-if="!topBook.book"> · {{ t('stats.bookMissing') }}</template></span>
      </span>
    </component>
  </section>
</template>

<style scoped>
.ms {
  padding: 18px 20px 20px;
}
h2 {
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 14px;
}
.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 16px;
}
.ms {
  container-type: inline-size;
}
.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* 读屏顺序: 标签 → 数值; 视觉上数值在上 */
.fact .v {
  order: -1;
  min-width: 0;
}
dt {
  color: var(--text-2);
  font-size: 12px;
}
@container (min-width: 560px) {
  .facts {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.value {
  display: inline-flex;
  align-items: baseline;
  line-height: 1.2;
}
.n {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.u {
  margin: 0 4px 0 2px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
}
.u:last-child {
  margin-right: 0;
}
.hint {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  border-radius: var(--radius-sm);
}
.link .n {
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
}
@media (hover: hover) {
  .link:hover .n {
    text-decoration-color: var(--brand);
  }
}
.link:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.top {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 18px;
  padding: 12px;
  border: 0;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  text-align: left;
}
button.top {
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
@media (hover: hover) {
  button.top:hover {
    background: var(--surface-3);
  }
}
button.top:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.top-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.top-label {
  color: var(--text-3);
  font-size: 12px;
}
.top-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}
.top-time {
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.top.missing .top-title {
  color: var(--text-2);
}
</style>
