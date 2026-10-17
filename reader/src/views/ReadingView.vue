<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import type { BookMeta } from '../storage'
import { resolveReadingStatus } from '../services/readingStatus'
import { FORMAT_LABELS, isSupportedBookFormat } from '../services/format'
import { readerPath } from '../services/readerRoute'
import { formatReadingTime } from '../composables/useReadingTimer'
import { saveLibrarySession } from '../services/librarySession'
import AppIcon from '../components/AppIcon.vue'
import { t } from '../i18n'

const router = useRouter()
const library = useLibrary()

type TabKind = 'reading' | 'recent' | 'paused' | 'finished'
const currentTab = ref<TabKind>('reading')

onMounted(async () => {
  if (!library.loaded) {
    await library.refresh().catch(() => {})
  }
})

const books = computed(() => library.books)

const readingBooks = computed(() => {
  return books.value.filter(b => {
    const status = resolveReadingStatus(b)
    return status.effective === 'reading'
  }).sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
})

const recentBooks = computed(() => {
  return books.value
    .filter(b => typeof b.lastReadAt === 'number' && b.lastReadAt > 0)
    .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))
})

const pausedBooks = computed(() => {
  return books.value.filter(b => {
    const status = resolveReadingStatus(b)
    return status.effective === 'paused'
  }).sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
})

const finishedBooks = computed(() => {
  return books.value.filter(b => {
    const status = resolveReadingStatus(b)
    return status.effective === 'finished'
  }).sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
})

const displayedBooks = computed(() => {
  switch (currentTab.value) {
    case 'reading': return readingBooks.value
    case 'recent': return recentBooks.value
    case 'paused': return pausedBooks.value
    case 'finished': return finishedBooks.value
  }
})

function openDetail(book: BookMeta) {
  saveLibrarySession({ lastViewedBookId: book.id })
  router.push(`/book/${book.id}`)
}

function openReader(book: BookMeta) {
  saveLibrarySession({ lastViewedBookId: book.id })
  router.push(readerPath(book))
}

function getProgress(book: BookMeta) {
  if (book.progress == null) return null
  return Math.min(100, Math.max(0, Math.round(book.progress * 100)))
}
</script>

<template>
  <div class="reading-view">
    <header class="reading-header">
      <div class="header-main">
        <h1 class="view-title">{{ t("uiV02.copy.正在阅读") }}</h1>
        <p class="view-subtitle">{{ t("uiV02.copy.快速接续阅读进度与近期记录") }}</p>
      </div>

      <nav class="segmented" role="tablist" :aria-label="t('uiV02.copy.阅读分组')">
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'reading' }"
          role="tab"
          :aria-selected="currentTab === 'reading'"
          @click="currentTab = 'reading'"
        >
          {{ t("uiV02.copy.在读 (") }}{{ readingBooks.length }})
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'recent' }"
          role="tab"
          :aria-selected="currentTab === 'recent'"
          @click="currentTab = 'recent'"
        >
          {{ t("uiV02.copy.最近阅读") }}
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'paused' }"
          role="tab"
          :aria-selected="currentTab === 'paused'"
          @click="currentTab = 'paused'"
        >
          {{ t("uiV02.copy.搁置 (") }}{{ pausedBooks.length }})
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'finished' }"
          role="tab"
          :aria-selected="currentTab === 'finished'"
          @click="currentTab = 'finished'"
        >
          {{ t("uiV02.copy.已读完 (") }}{{ finishedBooks.length }})
        </button>
      </nav>
    </header>

    <div v-if="!displayedBooks.length" class="empty card">
      <div class="empty-icon" aria-hidden="true">
        <AppIcon name="reading" :size="48" aria-hidden="true" />
      </div>
      <p class="empty-title">{{ t("uiV02.copy.当前分类暂无书籍") }}</p>
      <p class="empty-hint">{{ t("uiV02.copy.在藏书中打开一本书或将其标为在读，进度将自动汇总在此。") }}</p>
      <router-link to="/library" class="btn btn-primary">
        {{ t("uiV02.copy.前往藏书") }}
      </router-link>
    </div>

    <div v-else class="book-list">
      <article
        v-for="book in displayedBooks"
        :key="book.id"
        class="card reading-card"
        tabindex="0"
        role="button"
        :aria-label="t('uiV02.copy.\u67E5\u770B\u8BE6\u60C5\uFF1A{v0}', { v0: book.title })"
        @click="openDetail(book)"
        @keydown.enter.prevent="openDetail(book)"
        @keydown.space.prevent="openDetail(book)"
      >
        <div class="card-cover">
          <img v-if="library.coverUrls[book.id]" :src="library.coverUrls[book.id]" alt="" class="cover-image" loading="lazy" />
          <div v-else class="cover-fallback">
            <span>{{ book.title }}</span>
          </div>
          <span class="cover-format">{{ FORMAT_LABELS[book.format] }}</span>
        </div>

        <div class="card-body">
          <div class="card-header-row">
            <h2 class="book-title">{{ book.title }}</h2>
            <span
              v-if="resolveReadingStatus(book).effective"
              class="status-pill"
              :class="resolveReadingStatus(book).effective"
            >
              {{ t('uiV02.status.' + (resolveReadingStatus(book).effective!)) }}
            </span>
          </div>
          <p class="book-author">
            <span>{{ book.author || t('book.unknownAuthor') }}</span>
            <span class="meta-sep">·</span>
            <span>{{ book.publisher || t('book.unknownPublisher') }}</span>
            <span class="meta-sep">·</span>
            <span>{{ book.publicationDate || t('book.unknownDate') }}</span>
          </p>
          <div v-if="book.tags?.length" class="card-tags">
            <span v-for="tag in book.tags.slice(0, 3)" :key="tag" class="tag-chip-mini">{{ tag }}</span>
          </div>

          <div v-if="getProgress(book) != null" class="progress-container">
            <div class="progress-bar-track" role="progressbar" :aria-valuenow="getProgress(book)!" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar-fill" :style="{ width: `${getProgress(book)}%` }" />
            </div>
            <span class="progress-label">{{ getProgress(book) }}%</span>
          </div>

          <div class="meta-row">
            <span v-if="book.lastReadAt" class="meta-hint">
              {{ t("uiV02.copy.上次读过：") }}{{ new Date(book.lastReadAt).toLocaleDateString() }}
            </span>
            <span v-if="book.readingSeconds && book.readingSeconds >= 60" class="meta-hint">
              {{ t("uiV02.copy.累计：") }}{{ formatReadingTime(book.readingSeconds) }}
            </span>
          </div>
        </div>

        <div class="card-action-col">
          <button
            type="button"
            class="btn btn-primary btn-continue"
            :disabled="!isSupportedBookFormat(book.format)"
            :aria-label="t('uiV02.copy.\u7EE7\u7EED\u9605\u8BFB\u300A{v0}\u300B', { v0: book.title })"
            @click.stop="openReader(book)"
          >
            {{ t("uiV02.copy.继续阅读") }}
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.reading-view {
  padding: 20px 24px 40px;
  max-width: 960px;
  margin: 0 auto;
}
.reading-header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}
.view-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.view-subtitle {
  font-size: 13px;
  color: var(--text-2);
  margin: 4px 0 0;
}
.segmented {
  display: inline-flex;
  background: var(--surface-2);
  padding: 3px;
  border-radius: var(--radius);
  gap: 2px;
  align-self: flex-start;
}
.segmented-btn {
  background: transparent;
  border: none;
  padding: 6px 14px;
  border-radius: calc(var(--radius) - 2px);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.segmented-btn:hover {
  color: var(--text);
}
.segmented-btn.active {
  background: var(--card);
  color: var(--brand);
  box-shadow: var(--shadow-sm);
}
.book-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.reading-card {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 16px;
  cursor: pointer;
  border-radius: var(--radius);
  outline: none;
  transition: transform var(--dur-fast), box-shadow var(--dur-fast);
}
.reading-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}
.reading-card:focus-visible {
  box-shadow: var(--ring), var(--shadow-md);
}
.card-cover {
  position: relative;
  width: 72px;
  aspect-ratio: 3 / 4.2;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-2);
}
.cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.cover-format {
  position: absolute;
  top: 4px;
  left: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
}
.card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.card-header-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.book-title {
  font-size: 16px;
  font-weight: 650;
  margin: 0;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.book-author {
  font-size: 13px;
  color: var(--text-2);
  margin: 0;
}
.status-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-2);
  flex-shrink: 0;
}
.status-pill.reading {
  background: var(--brand);
  color: var(--on-brand, #fff);
}
.status-pill.finished {
  background: #2e7d32;
  color: #fff;
}
.status-pill.paused {
  background: #e65100;
  color: #fff;
}
.progress-container {
  display: flex;
  align-items: center;
  gap: 10px;
}
.progress-bar-track {
  width: 160px;
  height: 5px;
  border-radius: 2.5px;
  background: var(--surface-2);
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--brand);
}
.progress-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}
.meta-row {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-3);
}
.card-action-col {
  flex-shrink: 0;
}
.btn-continue {
  min-height: 48px;
  min-width: 48px;
  white-space: nowrap;
}
.meta-sep {
  opacity: 0.5;
  margin: 0 4px;
}
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.tag-chip-mini {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.empty {
  padding: 48px 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.empty-icon {
  color: var(--text-3);
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.empty-hint {
  font-size: 13px;
  color: var(--text-2);
  margin: 0 0 8px;
  max-width: 380px;
}
</style>
