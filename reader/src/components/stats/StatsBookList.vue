<script setup lang="ts">
import { t } from '../../i18n'
import type { BookMeta } from '../../storage'
import { isSupportedBookFormat } from '../../services/format'
import BookThumb from './BookThumb.vue'
import { fmtDuration, pct } from './format'

export interface StatsBookRow {
  key: string
  title: string
  seconds: number
  kind: 'book' | 'paper'
  /** 仍在书架上的书; 缺失时行不可点 */
  book?: BookMeta
  /** 占本期 / 当天总时长的比例 0–1 */
  share: number
}

defineProps<{ rows: StatsBookRow[]; dense?: boolean }>()
const emit = defineEmits<{ open: [book: BookMeta] }>()

function canOpen(book?: BookMeta): boolean {
  return Boolean(book && isSupportedBookFormat(book.format))
}

function progressOf(book?: BookMeta): number | null {
  return book?.progress == null ? null : pct(book.progress)
}
</script>

<template>
  <ul class="rows" :class="{ dense }">
    <li v-for="row in rows" :key="row.key">
      <component
        :is="row.book ? 'button' : 'div'"
        class="row"
        :class="{ missing: !row.book }"
        :type="row.book ? 'button' : undefined"
        :disabled="row.book ? !canOpen(row.book) : undefined"
        :title="row.book ? (canOpen(row.book) ? t('stats.openBook', { title: row.title }) : t('library.retiredFormat')) : t('stats.bookMissing')"
        @click="row.book && canOpen(row.book) && emit('open', row.book)"
      >
        <BookThumb :book="row.book" :title="row.title" :kind="row.kind" />
        <span class="main">
          <span class="line">
            <span class="title">{{ row.title }}</span>
            <span class="time">{{ fmtDuration(row.seconds) }}</span>
          </span>
          <span class="meta">
            <span class="share" aria-hidden="true"><span :style="{ transform: `scaleX(${Math.max(0.02, row.share)})` }" /></span>
            <span class="share-pct">{{ t('stats.shareOf', { pct: pct(row.share) }) }}</span>
            <span v-if="!row.book" class="tag-mini">{{ t('stats.bookMissing') }}</span>
            <template v-else>
              <span v-if="!canOpen(row.book)" class="tag-mini">{{ t('stats.formatUnavailable') }}</span>
              <span v-if="row.kind === 'paper'" class="tag-mini">{{ t('stats.kindPaper') }}</span>
              <span v-if="progressOf(row.book) != null" class="progress">{{ t('stats.readTo', { pct: progressOf(row.book)! }) }}</span>
            </template>
          </span>
        </span>
      </component>
    </li>
  </ul>
</template>

<style scoped>
.rows {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% + 16px);
  min-height: var(--tap-min);
  margin: 0 -8px;
  padding: 8px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
}
button.row {
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
@media (hover: hover) {
  button.row:not(:disabled):hover {
    background: var(--surface-2);
  }
}
button.row:not(:disabled):active {
  background: var(--surface-3);
}
button.row:disabled {
  cursor: default;
  opacity: 1;
}
button.row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.line {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}
.time {
  flex-shrink: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.share {
  flex: 0 1 120px;
  min-width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}
.share span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--brand);
  transform-origin: left center;
}
.share-pct {
  min-width: 3.2em;
}
.tag-mini {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11px;
}
.progress {
  overflow: hidden;
  text-overflow: ellipsis;
}
.missing .title,
.missing .time {
  color: var(--text-3);
}
.missing .share span {
  background: var(--text-3);
}
.dense .row {
  padding-block: 6px;
}
</style>
