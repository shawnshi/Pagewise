<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { getStorage, type AnnotationRec, type BookMeta, type ReadingStatus } from '../storage'
import { isSupportedBookFormat, FORMAT_LABELS, isFoliateNative } from '../services/format'
import { readerPath } from '../services/readerRoute'
import { resolveReadingStatus, READING_STATUSES } from '../services/readingStatus'
import { formatReadingTime } from '../composables/useReadingTimer'
import { loadLibrarySession } from '../services/librarySession'
import AppIcon from '../components/AppIcon.vue'
import { toast } from '../services/toast'
import { t } from '../i18n'

const route = useRoute()
const router = useRouter()
const library = useLibrary()

const bookId = computed(() => String(route.params.id || ''))
const rawBook = ref<BookMeta | null>(null)
const coverUrl = ref<string | null>(null)

const book = computed<BookMeta | null>(() => {
  return library.books.find(b => b.id === bookId.value) || rawBook.value
})

const readable = computed(() => book.value ? isSupportedBookFormat(book.value.format) : false)

const progress = computed(() => {
  if (!book.value || book.value.progress == null) return null
  return Math.min(100, Math.max(0, Math.round(book.value.progress * 100)))
})

const statusInfo = computed(() => {
  return book.value ? resolveReadingStatus(book.value) : { isLegacy: true }
})

// 阅读状态选择
const selectedStatus = ref<string>('')

async function changeReadingStatus(newStatus: string) {
  if (!book.value) return
  selectedStatus.value = newStatus
  const statusToSave = (newStatus && (READING_STATUSES as readonly string[]).includes(newStatus as ReadingStatus))
    ? (newStatus as ReadingStatus)
    : undefined
  try {
    await library.setReadingStatus(book.value.id, statusToSave)
    toast(t('common.saved'), 'success', 2000)
  } catch (err: any) {
    toast(err?.message || t('common.saveFailed'), 'error')
  }
}

// 目录加载 (惰性仅按需解析当前书籍，避免全量解析)
interface TocItem {
  label?: string
  title?: string
  href?: string
  subitems?: TocItem[]
}

const toc = ref<TocItem[]>([])
const loadingToc = ref(false)
const tocLoaded = ref(false)
const tocError = ref('')

async function loadToc() {
  if (!book.value || tocLoaded.value || loadingToc.value) return
  loadingToc.value = true
  tocError.value = ''
  try {
    const storage = await getStorage()
    const blob = await storage.getBookFile(book.value.id)
    if (isFoliateNative(book.value.format)) {
      const file = new File([blob], book.value.fileName || `${book.value.title}.${book.value.format}`, { type: blob.type })
      const { makeFoliateBook } = await import('../services/foliateBook.ts')
      const foliateBook = await makeFoliateBook(file)
      toc.value = foliateBook?.toc ?? []
    } else {
      toc.value = []
    }
    tocLoaded.value = true
  } catch (err: any) {
    tocError.value = err?.message || '无法解析目录'
  } finally {
    loadingToc.value = false
  }
}

// 笔记与划线标注
const annotations = ref<AnnotationRec[]>([])
const loadingAnnotations = ref(false)

async function loadAnnotations() {
  if (!book.value) return
  loadingAnnotations.value = true
  try {
    const storage = await getStorage()
    annotations.value = await storage.listAnnotations(book.value.id)
  } catch {
    annotations.value = []
  } finally {
    loadingAnnotations.value = false
  }
}

onMounted(async () => {
  if (!library.loaded) {
    await library.refresh().catch(() => {})
  }
  const storage = await getStorage()
  if (!rawBook.value) {
    const fetched = await storage.getBook(bookId.value)
    if (fetched) rawBook.value = fetched
  }
  if (book.value) {
    selectedStatus.value = book.value.readingStatus || ''
    coverUrl.value = await storage.getCoverUrl(book.value.id) || null
    void loadAnnotations()
  }
})

function goBack() {
  const session = loadLibrarySession()
  if (book.value) {
    // 确保保留当前书籍作为最后浏览条目
    session.lastViewedBookId = book.value.id
  }
  router.push('/library')
}

function openReader() {
  if (!book.value || !readable.value) {
    toast(t('library.retiredFormat'), 'info')
    return
  }
  router.push(readerPath(book.value))
}

async function togglePin() {
  if (!book.value) return
  const storage = await getStorage()
  const nextPinned = book.value.pinnedAt ? 0 : Date.now()
  await storage.updateBook(book.value.id, { pinnedAt: nextPinned })
  book.value.pinnedAt = nextPinned
  toast(t(nextPinned ? 'library.pinned' : 'library.unpinned'), 'success')
}

async function removeBook() {
  if (!book.value) return
  if (!confirm(t('library.deleteConfirm', { title: book.value.title }))) return
  try {
    await library.removeBook(book.value.id)
    toast(t('library.deleted'), 'success')
    router.push('/library')
  } catch (err: any) {
    toast(t('library.deleteFailed', { msg: err?.message ?? err }), 'error')
  }
}

const activeTab = ref<'overview' | 'toc' | 'records'>('overview')
</script>

<template>
  <div class="book-detail">
    <header class="detail-header">
      <button
        type="button"
        class="btn btn-sm btn-back"
        :aria-label="t('common.back')"
        @click="goBack"
      >
        <AppIcon name="back" :size="20" aria-hidden="true" />
        <span>{{ t('common.back') }}</span>
      </button>
      <div class="header-title">
        <span>{{ book ? book.title : t('common.loading') }}</span>
      </div>
    </header>

    <div v-if="!book" class="empty-state">
      <p>{{ t('common.loading') }}</p>
    </div>

    <div v-else class="detail-content">
      <!-- 顶部信息卡片 -->
      <section class="card hero-card">
        <div class="cover-wrapper">
          <img v-if="coverUrl" :src="coverUrl" alt="" class="cover-img" />
          <div v-else class="cover-placeholder">
            <span>{{ book.title }}</span>
          </div>
          <span class="format-tag">{{ FORMAT_LABELS[book.format] }}</span>
        </div>

        <div class="meta-section">
          <h1 class="book-title">{{ book.title }}</h1>
          <p class="book-author">
            <span>{{ book.author || t('book.unknownAuthor') }}</span>
            <span class="meta-sep">·</span>
            <span>{{ book.publisher || t('book.unknownPublisher') }}</span>
            <span class="meta-sep">·</span>
            <span>{{ book.publicationDate || t('book.unknownDate') }}</span>
          </p>

          <div class="status-row">
            <span class="label">{{ t("uiV02.copy.阅读状态：") }}</span>
            <select
              :value="selectedStatus"
              class="input input-sm status-select"
              :aria-label="t('uiV02.copy.设置阅读状态')"
              @change="changeReadingStatus(($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ statusInfo.isLegacy ? t("uiV02.copy.\u672A\u6807\u8BB0 (\u65E7\u7248\u672A\u77E5)") : t("uiV02.copy.\u6E05\u9664\u72B6\u6001") }}</option>
              <option value="unread">{{ t('uiV02.status.unread') }}</option>
              <option value="reading">{{ t('uiV02.status.reading') }}</option>
              <option value="finished">{{ t('uiV02.status.finished') }}</option>
              <option value="paused">{{ t('uiV02.status.paused') }}</option>
            </select>
            <span v-if="statusInfo.effective" class="badge" :class="statusInfo.effective">
              {{ t('uiV02.status.' + (statusInfo.effective)) }}
            </span>
          </div>

          <div v-if="progress != null" class="progress-section">
            <div class="progress-bar-track" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar-fill" :style="{ width: `${progress}%` }" />
            </div>
            <span class="progress-text">{{ progress }}%</span>
          </div>

          <div class="detail-actions">
            <button
              type="button"
              class="btn btn-primary btn-read"
              :disabled="!readable"
              @click="openReader"
            >
              {{ progress && progress > 0 ? t('catalog.continueReading') : t('settings.navReading') }}
            </button>
            <button type="button" class="btn" @click="togglePin">
              <AppIcon name="pin" :size="16" aria-hidden="true" />
              <span>{{ book.pinnedAt ? t('library.unpin') : t('library.pin') }}</span>
            </button>
            <button v-if="!book.sourceRef" type="button" class="btn btn-danger" @click="removeBook">
              <AppIcon name="delete" :size="16" aria-hidden="true" />
              <span>{{ t('book.removeFromLibrary') }}</span>
            </button>
            <div v-else class="source-managed-notice" :title="t('book.sourceManagedHint')">
              <AppIcon name="folder" :size="16" aria-hidden="true" />
              <span>{{ t('book.sourceManaged') }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 选项卡导航 -->
      <nav class="tabs-nav" role="tablist">
        <button
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'overview' }"
          role="tab"
          :aria-selected="activeTab === 'overview'"
          @click="activeTab = 'overview'"
        >
          {{ t("uiV02.copy.概览信息") }}
        </button>
        <button
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'toc' }"
          role="tab"
          :aria-selected="activeTab === 'toc'"
          @click="activeTab = 'toc'; loadToc()"
        >
          {{ t("uiV02.copy.目录结构") }}
        </button>
        <button
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'records' }"
          role="tab"
          :aria-selected="activeTab === 'records'"
          @click="activeTab = 'records'"
        >
          {{ t("uiV02.copy.阅读记录 (") }}{{ annotations.length }})
        </button>
      </nav>

      <!-- 概览面板 -->
      <section v-if="activeTab === 'overview'" class="tab-panel card" role="tabpanel">
        <dl class="meta-grid">
          <div class="meta-item">
            <dt>{{ t("uiV02.copy.格式：") }}</dt>
            <dd>{{ FORMAT_LABELS[book.format] }} ({{ book.format }})</dd>
          </div>
          <div class="meta-item">
            <dt>{{ t('book.author') }}：</dt>
            <dd>{{ book.author || t('book.unknownAuthor') }}</dd>
          </div>
          <div class="meta-item">
            <dt>{{ t('book.publisher') }}：</dt>
            <dd>{{ book.publisher || t('book.unknownPublisher') }}</dd>
          </div>
          <div class="meta-item">
            <dt>{{ t('book.publicationDate') }}：</dt>
            <dd>{{ book.publicationDate || t('book.unknownDate') }}</dd>
          </div>
          <div class="meta-item">
            <dt>{{ t("uiV02.copy.语言：") }}</dt>
            <dd>{{ book.language || t('uiV02.languageUnknown') }}</dd>
          </div>
          <div v-if="book.sourceRef" class="meta-item full-width">
            <dt>{{ t('book.sourcePath') }}：</dt>
            <dd>
              <code>{{ book.sourceRef.relativePath }}</code>
              <span v-if="book.fileAvailability === 'missing'" class="source-status-badge missing"> · {{ t('book.sourceMissing') }}</span>
              <span v-else-if="book.fileAvailability === 'permission-denied'" class="source-status-badge denied"> · {{ t('book.sourceDenied') }}</span>
            </dd>
          </div>
          <div v-if="book.readingSeconds && book.readingSeconds >= 60" class="meta-item">
            <dt>{{ t("uiV02.copy.累计时长：") }}</dt>
            <dd>{{ formatReadingTime(book.readingSeconds) }}</dd>
          </div>
          <div v-if="book.lastReadAt" class="meta-item">
            <dt>{{ t("uiV02.copy.最后阅读：") }}</dt>
            <dd>{{ new Date(book.lastReadAt).toLocaleString() }}</dd>
          </div>
          <div class="meta-item">
            <dt>{{ t("uiV02.copy.导入时间：") }}</dt>
            <dd>{{ new Date(book.addedAt).toLocaleString() }}</dd>
          </div>
          <div class="meta-item">
            <dt>{{ t("uiV02.copy.文件名：") }}</dt>
            <dd class="text-truncate">{{ book.fileName }}</dd>
          </div>
          <div class="meta-item full-width">
            <dt>{{ t("uiV02.copy.标签：") }}</dt>
            <dd class="tags-list">
              <template v-if="book.tags?.length">
                <span v-for="tag in book.tags" :key="tag" class="tag">{{ tag }}</span>
              </template>
              <span v-else class="tag-placeholder">{{ t('book.noTags') }}</span>
            </dd>
          </div>
          <div v-if="book.description" class="meta-item full-width">
            <dt>{{ t("uiV02.copy.书籍简介：") }}</dt>
            <dd class="description-text">{{ book.description }}</dd>
          </div>
        </dl>
      </section>

      <!-- 目录面板 -->
      <section v-else-if="activeTab === 'toc'" class="tab-panel card" role="tabpanel">
        <div v-if="loadingToc" class="loading-box">{{ t('common.loading') }}</div>
        <div v-else-if="tocError" class="empty-box">{{ tocError }}</div>
        <div v-else-if="!toc.length" class="empty-box">{{ t("uiV02.copy.暂无目录或格式不支持提取目录") }}</div>
        <ul v-else class="toc-list">
          <li v-for="(item, idx) in toc" :key="idx" class="toc-item">
            <span class="toc-title">{{ item.label || item.title || t("uiV02.copy.\u7B2C {v0} \u8282", { v0: idx + 1 }) }}</span>
          </li>
        </ul>
      </section>

      <!-- 标注与记录面板 -->
      <section v-else-if="activeTab === 'records'" class="tab-panel card" role="tabpanel">
        <div v-if="loadingAnnotations" class="loading-box">{{ t('common.loading') }}</div>
        <div v-else-if="!annotations.length" class="empty-box">{{ t("uiV02.copy.暂无笔记与高亮标注") }}</div>
        <ul v-else class="annotations-list">
          <li v-for="ann in annotations" :key="ann.id" class="annotation-item">
            <div class="annotation-header">
              <span class="badge">{{ ann.kind === 'bookmark' ? t("uiV02.copy.\u4E66\u7B7E") : t("uiV02.copy.\u9AD8\u4EAE") }}</span>
              <span class="annotation-time">{{ new Date(ann.createdAt).toLocaleDateString() }}</span>
            </div>
            <p v-if="ann.text" class="annotation-text">“{{ ann.text }}”</p>
            <p v-if="ann.note" class="annotation-note">{{ t("uiV02.copy.想法：") }}{{ ann.note }}</p>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.book-detail {
  padding: 18px 24px 36px;
  max-width: 960px;
  margin: 0 auto;
}
.detail-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
}
.btn-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.header-title {
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-card {
  display: flex;
  gap: 24px;
  padding: 24px;
  margin-bottom: 20px;
}
.cover-wrapper {
  position: relative;
  width: 140px;
  aspect-ratio: 3 / 4.2;
  flex-shrink: 0;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface-2);
  box-shadow: var(--shadow);
}
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-placeholder {
  width: 100%;
  height: 100%;
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.format-tag {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}
.meta-section {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.book-title {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.3;
  margin: 0;
  color: var(--text);
}
.book-author {
  font-size: 14px;
  color: var(--text-2);
  margin: 0;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.status-select {
  padding: 4px 8px;
  height: 32px;
  border-radius: var(--radius);
}
.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-2);
}
.badge.reading {
  background: var(--brand);
  color: var(--on-brand, #fff);
}
.badge.finished {
  background: #2e7d32;
  color: #fff;
}
.badge.paused {
  background: #e65100;
  color: #fff;
}
.badge.unread {
  background: var(--surface-2);
  color: var(--text);
}
.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;
}
.progress-bar-track {
  flex: 1;
  max-width: 240px;
  height: 6px;
  border-radius: 3px;
  background: var(--surface-2);
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--brand);
}
.progress-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: auto;
  padding-top: 10px;
}
.btn-read {
  min-width: 100px;
}
.tabs-nav {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.tab-btn {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.tab-btn:hover {
  color: var(--text);
}
.tab-btn.active {
  color: var(--brand);
  border-bottom-color: var(--brand);
}
.tab-panel {
  padding: 20px;
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px 24px;
  margin: 0;
}
.meta-item {
  display: flex;
  gap: 8px;
  font-size: 13px;
}
.meta-item.full-width {
  grid-column: 1 / -1;
}
.meta-item dt {
  color: var(--text-2);
  flex-shrink: 0;
  width: 72px;
}
.meta-item dd {
  margin: 0;
  color: var(--text);
}
.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
}
.description-text {
  line-height: 1.6;
  white-space: pre-wrap;
}
.loading-box,
.empty-box {
  padding: 32px;
  text-align: center;
  color: var(--text-2);
  font-size: 14px;
}
.toc-list,
.annotations-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toc-item {
  padding: 8px 12px;
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 13px;
}
.annotation-item {
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.annotation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.annotation-time {
  font-size: 11px;
  color: var(--text-3);
}
.annotation-text {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  font-style: italic;
}
.annotation-note {
  margin: 0;
  font-size: 13px;
  color: var(--brand);
}

.meta-sep {
  opacity: 0.5;
  margin: 0 4px;
}
.source-managed-notice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text-2);
}
.source-status-badge {
  font-size: 12px;
  font-weight: 500;
}
.source-status-badge.missing {
  color: var(--danger);
}
.source-status-badge.denied {
  color: var(--warning);
}
.tag-placeholder {
  color: var(--text-3);
  font-style: italic;
}

@media (max-width: 640px) {
  .hero-card {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .meta-section {
    align-items: center;
  }
  .detail-actions {
    justify-content: center;
  }
}
</style>
