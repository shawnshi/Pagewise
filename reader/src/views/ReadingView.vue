<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import type { BookMeta } from '../storage'
import { resolveReadingStatus } from '../services/readingStatus'
import { FORMAT_LABELS, isSupportedBookFormat } from '../services/format'
import { readerPath } from '../services/readerRoute'
import { formatReadingTime } from '../composables/useReadingTimer'
import { saveLibrarySession } from '../services/librarySession'
import { acquireLibraryCover } from '../services/libraryCovers'
import AppIcon from '../components/AppIcon.vue'
import BookRecommendationsPanel from '../components/BookRecommendationsPanel.vue'
import { t } from '../i18n'

const router = useRouter()
const library = useLibrary()

type TabKind = 'reading' | 'recent' | 'wanted' | 'paused' | 'finished' | 'abandoned'
const currentTab = ref<TabKind | 'recommendations'>('reading')
const recommendationWriting = ref(false)
const recommendationCount = ref<number | null>(null)

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

const wantedBooks = computed(() => {
  return books.value.filter(b => {
    const status = resolveReadingStatus(b)
    return status.effective === 'wanted'
  }).sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
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

const abandonedBooks = computed(() => {
  return books.value.filter(b => {
    const status = resolveReadingStatus(b)
    return status.effective === 'abandoned'
  }).sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
})

const displayedBooks = computed(() => {
  switch (currentTab.value) {
    case 'reading': return readingBooks.value
    case 'recent': return recentBooks.value
    case 'wanted': return wantedBooks.value
    case 'paused': return pausedBooks.value
    case 'finished': return finishedBooks.value
    case 'abandoned': return abandonedBooks.value
    case 'recommendations': return []
  }
})

// 分类可能包含数百本; 首屏只挂载一页, 墨水屏滚动和新书封面解码都不再随全库线性变慢。
const PAGE_SIZE = 24
const visibleCount = ref(PAGE_SIZE)
watch(currentTab, () => { visibleCount.value = PAGE_SIZE })
const visibleBooks = computed(() => displayedBooks.value.slice(0, visibleCount.value))
const hasMore = computed(() => displayedBooks.value.length > visibleBooks.value.length)
function showMore() { visibleCount.value += PAGE_SIZE }

// 进度与状态在 computed 里每本求一次, 模板不再重复解折
const progressById = computed(() => {
  const map = new Map<string, number>()
  for (const book of displayedBooks.value) {
    if (book.progress == null) continue
    map.set(book.id, Math.min(100, Math.max(0, Math.round(book.progress * 100))))
  }
  return map
})
const statusById = computed(() => {
  const map = new Map<string, string>()
  for (const book of displayedBooks.value) {
    const effective = resolveReadingStatus(book).effective
    if (effective) map.set(book.id, effective)
  }
  return map
})

const coverUrls = ref<Record<string, string>>({})
watch(() => visibleBooks.value.filter(book => book.hasCover).map(book => book.id), (ids, _previous, onCleanup) => {
  let active = true
  coverUrls.value = {}
  const leases = ids.map(id => {
    const lease = acquireLibraryCover(id)
    void lease.ready.then(url => {
      if (active && url) coverUrls.value[id] = url
    }).catch(error => console.warn('Pagewise: cover read failed', error))
    return lease
  })
  onCleanup(() => {
    active = false
    leases.forEach(lease => lease.release())
  })
}, { immediate: true })

function openDetail(book: BookMeta) {
  saveLibrarySession({ lastViewedBookId: book.id })
  router.push(`/book/${book.id}`)
}

function openReader(book: BookMeta) {
  saveLibrarySession({ lastViewedBookId: book.id })
  router.push(readerPath(book))
}

function getProgress(book: BookMeta) {
  return progressById.value.get(book.id) ?? null
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
          :disabled="recommendationWriting"
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
          :disabled="recommendationWriting"
          role="tab"
          :aria-selected="currentTab === 'recent'"
          @click="currentTab = 'recent'"
        >
          {{ t("uiV02.copy.最近阅读") }}
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'wanted' }"
          :disabled="recommendationWriting"
          role="tab"
          :aria-selected="currentTab === 'wanted'"
          @click="currentTab = 'wanted'"
        >
          {{ t('uiV02.status.wanted') }} ({{ wantedBooks.length }})
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'paused' }"
          :disabled="recommendationWriting"
          role="tab"
          :aria-selected="currentTab === 'paused'"
          @click="currentTab = 'paused'"
        >
          {{ t('uiV02.status.paused') }} ({{ pausedBooks.length }})
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'finished' }"
          :disabled="recommendationWriting"
          role="tab"
          :aria-selected="currentTab === 'finished'"
          @click="currentTab = 'finished'"
        >
          {{ t('uiV02.status.finished') }} ({{ finishedBooks.length }})
        </button>
        <button
          type="button"
          class="segmented-btn"
          :class="{ active: currentTab === 'abandoned' }"
          :disabled="recommendationWriting"
          role="tab"
          :aria-selected="currentTab === 'abandoned'"
          @click="currentTab = 'abandoned'"
        >
          {{ t('uiV02.status.abandoned') }} ({{ abandonedBooks.length }})
        </button>
        <button type="button" class="segmented-btn" :class="{ active: currentTab === 'recommendations' }" :disabled="recommendationWriting" :aria-pressed="currentTab === 'recommendations'" @click="currentTab = 'recommendations'">{{ t('recommendations.tab') }}<template v-if="recommendationCount != null"> ({{ recommendationCount }})</template></button>
      </nav>
    </header>

    <BookRecommendationsPanel v-if="currentTab === 'recommendations'" mode="reading" @writing="recommendationWriting = $event" @count="recommendationCount = $event" @navigate="id => router.push(`/book/${encodeURIComponent(id)}`)" />
    <div v-else-if="!displayedBooks.length" class="empty card">
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
        v-for="(book, index) in visibleBooks"
        :key="book.id"
        class="card reading-card"
        :class="{ 'hero-reading-card': currentTab === 'reading' && index === 0 }"
        tabindex="0"
        role="button"
        :aria-label="t('uiV02.copy.\u67E5\u770B\u8BE6\u60C5\uFF1A{v0}', { v0: book.title })"
        @click="openDetail(book)"
        @keydown.enter.prevent="openDetail(book)"
        @keydown.space.prevent="openDetail(book)"
      >
        <div class="card-cover archival-cover-plate">
          <img v-if="coverUrls[book.id]" :src="coverUrls[book.id]" alt="" class="cover-image" loading="lazy" decoding="async" />
          <div v-else class="cover-fallback">
            <span>{{ book.title }}</span>
          </div>
          <span class="cover-format">{{ FORMAT_LABELS[book.format] }}</span>
        </div>

        <div class="card-body">
          <div v-if="currentTab === 'reading' && index === 0" class="hero-active-badge">
            <span>EX LIBRIS · 焦点在读</span>
            <span v-if="book.readingSeconds" class="hero-active-time">已读 {{ formatReadingTime(book.readingSeconds) }}</span>
          </div>
          <div class="card-header-row">
            <h2 class="book-title">{{ book.title }}</h2>
            <span
              v-if="statusById.get(book.id)"
              class="status-pill"
              :class="statusById.get(book.id)"
            >
              {{ t('uiV02.status.' + statusById.get(book.id)) }}
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

          <div v-if="getProgress(book) != null" class="fore-edge-gauge">
            <div class="fore-edge-track" role="progressbar" :aria-valuenow="getProgress(book)!" aria-valuemin="0" aria-valuemax="100">
              <div class="fore-edge-fill" :style="{ width: `${getProgress(book)}%` }" />
              <div class="fore-edge-notch" :style="{ left: `${getProgress(book)}%` }" />
            </div>
            <span class="fore-edge-text">{{ getProgress(book) }}%</span>
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
      <button
        v-if="hasMore"
        type="button"
        class="btn load-more"
        @click="showMore"
      >
        {{ t('catalog.loadMore') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.reading-view {
  padding: 24px 32px 48px;
  max-width: 1040px;
  margin: 0 auto;
}
.reading-header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}
.view-title {
  font-family: var(--font-serif);
  font-size: 24px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
  letter-spacing: -0.01em;
}
.view-subtitle {
  font-size: 13px;
  color: var(--text-2);
  margin: 4px 0 0;
}
.segmented {
  display: inline-flex;
  background: var(--card);
  padding: 3px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  gap: 4px;
  align-self: flex-start;
  max-width: 100%;
  overflow-x: auto;
}
.segmented-btn {
  flex-shrink: 0;
  white-space: nowrap;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  cursor: pointer;
}
.segmented-btn:hover {
  color: var(--text);
  border-color: var(--border);
}
.segmented-btn.active {
  background: var(--eink-ink) !important;
  color: var(--eink-paper) !important;
  border-color: var(--eink-ink) !important;
  font-weight: 600;
}
.book-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.load-more {
  align-self: center;
  min-height: 44px;
  margin-top: 12px;
  padding: 0 24px;
  border: 1px solid var(--border-strong);
}
.reading-card {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 18px 20px;
  cursor: pointer;
  border-radius: 2px;
  border: 1px solid var(--eink-border-hairline);
  background: var(--eink-surface-pure);
  box-shadow: none;
  outline: none;
}
.hero-reading-card {
  border: 2px solid var(--eink-solid-black) !important;
  outline: 1px solid var(--eink-border-hairline) !important;
  outline-offset: -5px;
  background: var(--card) !important;
  padding: 22px 24px;
}
.hero-active-badge {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-2);
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.hero-active-time {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.reading-card:hover {
  border-color: var(--eink-solid-black);
  background: var(--eink-surface-subtle);
}
.reading-card:focus-visible {
  outline: 2px solid var(--eink-solid-black);
  outline-offset: 2px;
}
.card-cover {
  position: relative;
  width: 72px;
  height: 102px;
  aspect-ratio: 1 / 1.414;
  flex-shrink: 0;
  border-radius: 2px;
  overflow: hidden;
  border: 1px solid var(--eink-border-hairline);
  background: var(--eink-surface-subtle);
  box-sizing: border-box;
  padding: 1px;
}
.cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-family: var(--font-serif);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.cover-format {
  position: absolute;
  top: 3px;
  left: 3px;
  background: var(--eink-ink);
  color: var(--eink-paper);
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 2px;
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
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 700;
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
  padding: 1px 7px;
  border-radius: 2px;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.status-pill.reading {
  background: var(--eink-ink);
  color: var(--eink-paper);
  border-color: var(--eink-ink);
}
.status-pill.finished {
  background: var(--card);
  color: var(--eink-ink);
  border-color: var(--eink-ink);
}
.status-pill.paused {
  background: var(--surface-2);
  color: var(--text-2);
  border-color: var(--border);
}
.progress-container {
  display: flex;
  align-items: center;
  gap: 12px;
}
.progress-bar-track {
  width: 160px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--eink-ink);
}
.progress-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  font-feature-settings: "tnum" 1;
}
.meta-row {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-3);
  font-feature-settings: "tnum" 1;
}
.card-action-col {
  flex-shrink: 0;
}
.btn-continue {
  min-height: 44px;
  min-width: 48px;
  white-space: nowrap;
  font-weight: 600;
  border-radius: 2px;
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
  padding: 56px 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--card);
}
.empty-icon {
  color: var(--text-2);
}
.empty-title {
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}
.empty-hint {
  font-size: 13px;
  color: var(--text-2);
  margin: 0 0 12px;
  max-width: 380px;
  line-height: 1.5;
}
</style>
