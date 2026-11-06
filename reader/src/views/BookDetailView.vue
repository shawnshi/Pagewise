<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { getStorage, type AnnotationRec, type BookMeta, type ReadingStatus } from '../storage'
import { isSupportedBookFormat, FORMAT_LABELS, isFoliateNative } from '../services/format'
import { readerPath } from '../services/readerRoute'
import { resolveReadingStatus, READING_STATUSES } from '../services/readingStatus'
import { formatReadingTime } from '../composables/useReadingTimer'
import { restorableView } from '../services/navigationSession'
import { useNativeBack } from '../composables/useNativeBack'
import AppIcon from '../components/AppIcon.vue'
import BookClassificationPanel from '../components/BookClassificationPanel.vue'
import BookRelinkDialog from '../components/BookRelinkDialog.vue'
import BookIntroductionDialog from '../components/BookIntroductionDialog.vue'
import BookMetadataDialog from '../components/BookMetadataDialog.vue'
import ReadingManagerDialog from '../components/ReadingManagerDialog.vue'
import BookRecommendationsPanel from '../components/BookRecommendationsPanel.vue'
import {
  buildLocalAnnotationMarkdown,
  buildLocalCatchupSnapshot,
  formatAnnotationJumpPath,
  generateReadingCatchupWithAi,
  synthesizeBookAnnotationsWithAi,
  ReadingManagerAiError,
  type AnnotationSynthesisResult,
  type ReadingCatchupResult,
} from '../services/readingManagerAi'
import { bookFileProblem } from '../services/bookAvailability'
import { useFolderLibrary } from '../services/folderLibrary'
import { toast } from '../services/toast'
import { t } from '../i18n'

const folderLibrary = useFolderLibrary()
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
const fileProblem = computed(() => book.value ? bookFileProblem(book.value) : undefined)
const showRelink = ref(false)
const showIntroduction = ref(false)
const showMetadata = ref(false)
const showReadingManager = ref(false)
const showCatchup = ref(false)
const introductionDialog = ref<{ requestClose(): void; isSaving(): boolean } | null>(null)

const progress = computed(() => {
  if (!book.value || book.value.progress == null) return null
  return Math.min(100, Math.max(0, Math.round(book.value.progress * 100)))
})

const statusInfo = computed(() => {
  return book.value ? resolveReadingStatus(book.value) : { isLegacy: true }
})

// 阅读状态选择
const selectedStatus = ref<ReadingStatus>('unmarked')
const statusSaving = ref(false)

async function changeReadingStatus(newStatus: string) {
  if (!book.value || statusSaving.value) return
  if (!(READING_STATUSES as readonly string[]).includes(newStatus)) return
  const previous = selectedStatus.value
  const statusToSave = newStatus as ReadingStatus
  selectedStatus.value = statusToSave
  statusSaving.value = true
  try {
    await library.setReadingStatus(book.value.id, statusToSave)
    toast(t('common.saved'), 'success', 2000)
  } catch (err: any) {
    selectedStatus.value = previous
    toast(err?.message || t('common.saveFailed'), 'error')
  } finally {
    statusSaving.value = false
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

// P1: 断点前情提要状态
const catchupLoading = ref(false)
const catchupResult = ref<ReadingCatchupResult | null>(null)
const catchupError = ref('')
let catchupController: AbortController | null = null

const catchupSnapshot = computed(() => {
  if (!book.value) return null
  return buildLocalCatchupSnapshot(book.value, annotations.value)
})

async function runAiCatchup() {
  if (!book.value || catchupLoading.value) return
  if (catchupController) catchupController.abort()
  const controller = new AbortController()
  catchupController = controller
  catchupLoading.value = true
  catchupError.value = ''
  try {
    const tocTitles = toc.value.map(item => item.label || item.title || '').filter(Boolean)
    const res = await generateReadingCatchupWithAi({
      book: book.value,
      annotations: annotations.value,
      tocTitles,
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    catchupResult.value = res
  } catch (err: any) {
    if (controller.signal.aborted) return
    if (err instanceof ReadingManagerAiError && err.code === 'unconfigured') {
      catchupError.value = t('bookIntroduction.error.unconfigured')
    } else {
      catchupError.value = err?.message || t('bookMetadata.error')
    }
  } finally {
    if (catchupController === controller) {
      catchupLoading.value = false
      catchupController = null
    }
  }
}

// P0: 单书批注聚类综述与 Markdown 导出状态
const synthesisLoading = ref(false)
const synthesisResult = ref<AnnotationSynthesisResult | null>(null)
const synthesisError = ref('')
let synthesisController: AbortController | null = null

async function runAnnotationSynthesis() {
  if (!book.value || synthesisLoading.value) return
  if (synthesisController) synthesisController.abort()
  const controller = new AbortController()
  synthesisController = controller
  synthesisLoading.value = true
  synthesisError.value = ''
  try {
    const res = await synthesizeBookAnnotationsWithAi({
      book: book.value,
      annotations: annotations.value,
      signal: controller.signal,
    })
    if (controller.signal.aborted) return
    synthesisResult.value = res
  } catch (err: any) {
    if (controller.signal.aborted) return
    if (err instanceof ReadingManagerAiError && err.code === 'unconfigured') {
      synthesisError.value = t('bookIntroduction.error.unconfigured')
    } else {
      synthesisError.value = err?.message || t('bookMetadata.error')
    }
  } finally {
    if (synthesisController === controller) {
      synthesisLoading.value = false
      synthesisController = null
    }
  }
}

async function copyNotesMarkdown() {
  if (!book.value) return
  const md = buildLocalAnnotationMarkdown(book.value, annotations.value, synthesisResult.value)
  try {
    await navigator.clipboard.writeText(md)
    toast(t('readingManager.copiedSuccess'), 'success', 2000)
  } catch {
    toast(t('bookMetadata.error'), 'error')
  }
}

function exportNotesMarkdown() {
  if (!book.value) return
  const md = buildLocalAnnotationMarkdown(book.value, annotations.value, synthesisResult.value)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const safeTitle = (book.value.title || '读书笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  a.download = `${safeTitle}-读书笔记.md`
  a.click()
  URL.revokeObjectURL(url)
  toast(t('readingManager.exportedSuccess'), 'success', 2000)
}

function jumpToAnnotationCfi(cfi: string) {
  if (!book.value) return
  const path = formatAnnotationJumpPath(book.value, cfi)
  if (path) router.push(path)
}

function openTocItem(item: TocItem) {
  if (!book.value) return
  if (item.href) {
    jumpToAnnotationCfi(item.href)
  } else {
    openReader()
  }
}

// 墨水屏定高步进分页 (消除长目录与长批注列表滚动拖影)
const DETAIL_PAGE_SIZE = 10
const tocPage = ref(1)
const tocTotalPages = computed(() => Math.max(1, Math.ceil(toc.value.length / DETAIL_PAGE_SIZE)))
const pagedToc = computed(() => {
  const start = (tocPage.value - 1) * DETAIL_PAGE_SIZE
  return toc.value.slice(start, start + DETAIL_PAGE_SIZE).map((item, idx) => ({
    item,
    globalIndex: start + idx,
  }))
})

const recordsPage = ref(1)
const recordsTotalPages = computed(() => Math.max(1, Math.ceil(annotations.value.length / DETAIL_PAGE_SIZE)))
const pagedAnnotations = computed(() => {
  const start = (recordsPage.value - 1) * DETAIL_PAGE_SIZE
  return annotations.value.slice(start, start + DETAIL_PAGE_SIZE)
})

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
    selectedStatus.value = resolveReadingStatus(book.value).effective ?? 'unmarked'
    showRelink.value = route.query.recover === '1' && fileProblem.value === 'missing'
    if (route.query.catchup === '1') showCatchup.value = true
    coverUrl.value = await storage.getCoverUrl(book.value.id) || null
    void loadAnnotations()
  }
})

function goBack() {
  // 返回进入详情页之前的位置 (书库 / 在读 / 阅读记录), 而不是无条件回到书库。
  const origin = restorableView(window.history.state?.back)
  if (origin && origin !== route.path) router.back()
  else router.push('/library')
}

// Android 返回键: 先关重关联对话框，再走页面返回。
useNativeBack(() => {
  if (showIntroduction.value) { introductionDialog.value?.requestClose(); return true }
  if (showRelink.value) { showRelink.value = false; return true }
  return false
})

function openReader() {
  if (!book.value || !readable.value) {
    toast(t('library.retiredFormat'), 'info')
    return
  }
  if (fileProblem.value === 'permission-denied') { router.push('/settings?section=folder'); return }
  if (fileProblem.value) { showRelink.value = true; return }
  router.push(readerPath(book.value))
}

async function onFileRecovered() {
  showRelink.value = false
  try {
    await library.refresh()
    rawBook.value = await (await getStorage()).getBook(bookId.value) ?? null
    if (route.query.recover) await router.replace({ query: { ...route.query, recover: undefined } })
  } catch (err) {
    toast(t('library.operationFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
  }
}

async function rescanFile() {
  try {
    await folderLibrary.rescan()
    await library.refresh()
    const status = folderLibrary.status.value
    if (['partial', 'error', 'permission-denied'].includes(status.state)) {
      const message = status.state === 'partial' ? [t('folder.status.partial'), status.error].filter(Boolean).join(' · ') : status.error || t('library.filePermission')
      throw new Error(message)
    }
    await onFileRecovered()
  } catch (err) {
    toast(t('library.operationFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
  }
}

async function togglePin() {
  if (!book.value) return
  const storage = await getStorage()
  const nextPinned = book.value.pinnedAt ? 0 : Date.now()
  await storage.updateBook(book.value.id, { pinnedAt: nextPinned })
  book.value.pinnedAt = nextPinned
  toast(t(nextPinned ? 'library.pinned' : 'library.unpinned'), 'success')
}

function onIntroductionSaved(id: string, description: string) {
  if (id !== bookId.value || book.value?.id !== id) return
  book.value.description = description
  if (rawBook.value?.id === id) rawBook.value.description = description
  void library.refresh().catch(() => { toast(t('bookIntroduction.refreshAfterSave'), 'info') })
}

function onMetadataSaved(id: string, patch: any) {
  if (id !== bookId.value || book.value?.id !== id) return
  if (patch.author !== undefined) book.value.author = patch.author
  if (patch.publisher !== undefined) book.value.publisher = patch.publisher
  if (patch.publicationDate !== undefined) book.value.publicationDate = patch.publicationDate
  if (patch.language !== undefined) book.value.language = patch.language

  if (rawBook.value?.id === id) {
    if (patch.author !== undefined) rawBook.value.author = patch.author
    if (patch.publisher !== undefined) rawBook.value.publisher = patch.publisher
    if (patch.publicationDate !== undefined) rawBook.value.publicationDate = patch.publicationDate
    if (patch.language !== undefined) rawBook.value.language = patch.language
  }
  void library.refresh().catch(() => {})
}

async function onClassificationUpdated() {
  await library.refresh().catch(() => {})
  if (bookId.value) {
    const storage = await getStorage()
    const fetched = await storage.getBook(bookId.value)
    if (fetched) rawBook.value = fetched
  }
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

const activeTab = ref<'overview' | 'toc' | 'records' | 'recommendations'>('overview')
const recommendationWriting = ref(false)
const recommendationCount = ref<number | null>(null)
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
      <!-- 顶部信息卡片 (Ex Libris 双线馆藏著录卡) -->
      <section class="card hero-card ex-libris-card">
        <div class="cover-wrapper archival-cover-plate">
          <img v-if="coverUrl" :src="coverUrl" alt="" class="cover-img" />
          <div v-else class="cover-placeholder">
            <span>{{ book.title }}</span>
          </div>
          <span class="format-tag">{{ FORMAT_LABELS[book.format] }}</span>
        </div>

        <div class="meta-section">
          <div class="ex-libris-header">EX LIBRIS · 馆藏著录卡</div>
          <h1 class="book-title">{{ book.title }}</h1>
          <p v-if="book.author || book.publicationDate" class="book-author">{{ [book.author, book.publicationDate].filter(Boolean).join(' · ') }}</p>

          <div class="status-row">
            <span class="label">{{ t("uiV02.copy.阅读状态：") }}</span>
            <select
              :value="selectedStatus"
              :disabled="statusSaving"
              class="input input-sm status-select"
              :aria-label="t('uiV02.copy.设置阅读状态')"
              @change="changeReadingStatus(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="status in READING_STATUSES" :key="status" :value="status">{{ t('uiV02.status.' + status) }}</option>
            </select>
            <span v-if="statusInfo.effective" class="badge" :class="statusInfo.effective">
              {{ t('uiV02.status.' + (statusInfo.effective)) }}
            </span>
            <button
              type="button"
              class="btn btn-primary btn-read btn-sm"
              :disabled="!readable"
              @click="openReader"
            >
              {{ fileProblem ? t(fileProblem === 'missing' ? 'library.relink' : 'library.reauthorize') : progress && progress > 0 ? t('catalog.continueReading') : t('settings.navReading') }}
            </button>
            <button type="button" class="btn btn-sm" @click="togglePin">
              <AppIcon name="pin" :size="16" aria-hidden="true" />
              <span>{{ book.pinnedAt ? t('library.unpin') : t('library.pin') }}</span>
            </button>
            <button
              v-if="catchupSnapshot?.needsCatchup"
              type="button"
              class="btn btn-sm"
              @click="showCatchup = !showCatchup"
            >
              <AppIcon name="history" :size="16" aria-hidden="true" />
              <span>{{ t('readingManager.catchupBtn') }}</span>
            </button>
            <button type="button" class="btn btn-sm" @click="showReadingManager = true">
              <AppIcon name="ai" :size="16" aria-hidden="true" />
              <span>{{ t('readingManager.hubBtn') }}</span>
            </button>
            <button v-if="!book.sourceRef" type="button" class="btn btn-danger btn-sm" @click="removeBook">
              <AppIcon name="delete" :size="16" aria-hidden="true" />
              <span>{{ t('book.removeFromLibrary') }}</span>
            </button>
          </div>

          <div v-if="progress != null" class="fore-edge-gauge">
            <div class="fore-edge-track" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
              <div class="fore-edge-fill" :style="{ width: `${progress}%` }" />
              <div class="fore-edge-notch" :style="{ left: `${progress}%` }" />
            </div>
            <span class="fore-edge-text">{{ progress }}%</span>
          </div>
        </div>
      </section>

      <section v-if="fileProblem" class="file-recovery card" role="status">
        <strong>{{ t(fileProblem === 'missing' ? 'library.fileMissing' : 'library.filePermission') }}</strong>
        <p>{{ t('library.recoverHint') }}</p>
        <button type="button" class="btn" :disabled="folderLibrary.status.value.state === 'scanning'" @click="rescanFile">{{ t('folder.rescan') }}</button>
        <RouterLink class="btn" to="/settings?section=folder">{{ t('library.folderSettings') }}</RouterLink>
      </section>
      <BookRelinkDialog v-if="showRelink && book" :book="book" @close="showRelink = false" @recovered="onFileRecovered" />
      <BookIntroductionDialog ref="introductionDialog" v-model="showIntroduction" :book-id="bookId" :book="book?.id === bookId ? book : null" @saved="onIntroductionSaved" />
      <BookMetadataDialog v-model="showMetadata" :book-id="bookId" :book="book?.id === bookId ? book : null" @saved="onMetadataSaved" />
      <ReadingManagerDialog v-model="showReadingManager" :default-book-id="bookId" />

      <!-- P1: 断点前情提要面板 -->
      <section v-if="showCatchup && catchupSnapshot" class="card catchup-card" role="region" :aria-label="t('readingManager.catchupTitle')">
        <header class="catchup-header">
          <div class="catchup-title-group">
            <strong>{{ t('readingManager.catchupTitle') }}</strong>
            <span v-if="catchupSnapshot.daysSinceLastRead != null" class="badge">
              {{ t('readingManager.catchupDaysAgo', { v0: catchupSnapshot.daysSinceLastRead }) }}
            </span>
          </div>
          <div class="catchup-actions">
            <button type="button" class="btn btn-primary btn-sm" :disabled="catchupLoading" @click="runAiCatchup">
              {{ catchupLoading ? t('readingManager.catchupGenerating') : t('readingManager.catchupGenerateBtn') }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="showCatchup = false">✕</button>
          </div>
        </header>

        <div v-if="catchupError" class="manager-inline-error" role="alert">{{ catchupError }}</div>

        <div v-if="catchupResult" class="catchup-ai-body">
          <div class="catchup-block">
            <h4>{{ t('readingManager.catchupWhereLeftOff') }}</h4>
            <p>{{ catchupResult.whereYouLeftOff }}</p>
          </div>
          <div v-if="catchupResult.keyThreads.length" class="catchup-block">
            <h4>{{ t('readingManager.catchupKeyThreads') }}</h4>
            <ul>
              <li v-for="(thread, i) in catchupResult.keyThreads" :key="i">{{ thread }}</li>
            </ul>
          </div>
          <div class="catchup-block">
            <h4>{{ t('readingManager.catchupNextStep') }}</h4>
            <p>{{ catchupResult.nextStepSuggestion }}</p>
          </div>
        </div>

        <div v-if="catchupSnapshot.recentAnnotations.length" class="catchup-recent">
          <h4>{{ t('readingManager.catchupRecentNotes') }}</h4>
          <ul class="catchup-notes-list">
            <li v-for="ann in catchupSnapshot.recentAnnotations.slice(0, 3)" :key="ann.id">
              <span>“{{ (ann.text || ann.note || '').slice(0, 90) }}”</span>
              <button v-if="ann.cfi" type="button" class="link-jump-btn" @click="jumpToAnnotationCfi(ann.cfi)">
                [定位原文]
              </button>
            </li>
          </ul>
        </div>
      </section>

      <!-- 选项卡导航 -->
      <nav class="tabs-nav" role="tablist">
        <button
          type="button"
          class="tab-btn"
          :class="{ active: activeTab === 'overview' }"
          :disabled="recommendationWriting"
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
          :disabled="recommendationWriting"
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
          :disabled="recommendationWriting"
          role="tab"
          :aria-selected="activeTab === 'records'"
          @click="activeTab = 'records'"
        >
          {{ t("uiV02.copy.阅读记录 (") }}{{ annotations.length }})
        </button>
        <button type="button" class="tab-btn" :class="{ active: activeTab === 'recommendations' }" :disabled="recommendationWriting || book.id !== bookId" role="tab" :aria-selected="activeTab === 'recommendations'" @click="activeTab = 'recommendations'">{{ t('recommendations.detailTab') }}<template v-if="recommendationCount != null"> ({{ recommendationCount }})</template></button>
      </nav>

      <!-- 概览面板 -->
      <section v-if="activeTab === 'overview'" class="tab-panel card" role="tabpanel">
        <div class="overview-header-row">
          <span class="overview-section-title">{{ t("uiV02.copy.概览信息") }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="book.id !== bookId"
            @click="showMetadata = true"
          >
            <AppIcon name="info" :size="14" aria-hidden="true" />
            <span>{{ t('bookMetadata.triggerButton') }}</span>
          </button>
        </div>
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
          <div class="meta-item full-width intro-item">
            <div class="intro-header">
              <dt>{{ t("uiV02.copy.书籍简介：") }}</dt>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="book.id !== bookId" @click="showIntroduction = true">{{ t('bookIntroduction.generate') }}</button>
            </div>
            <dd class="description-text">{{ book.description || t('bookIntroduction.empty') }}</dd>
          </div>
        </dl>

        <!-- 结构化分类与标签编辑面板 -->
        <BookClassificationPanel :book="book" @updated="onClassificationUpdated" />
      </section>

      <!-- 目录面板 (支持点击直跳章节 + 定高步进翻页) -->
      <section v-else-if="activeTab === 'toc'" class="tab-panel card" role="tabpanel">
        <div v-if="loadingToc" class="loading-box">{{ t('common.loading') }}</div>
        <div v-else-if="tocError" class="empty-box">{{ tocError }}</div>
        <div v-else-if="!toc.length" class="empty-box">{{ t("uiV02.copy.暂无目录或格式不支持提取目录") }}</div>
        <template v-else>
          <div v-if="tocTotalPages > 1" class="step-pager-bar">
            <span class="pager-meta">{{ toc.length }} 章</span>
            <div class="pager-controls">
              <button type="button" class="btn btn-sm" :disabled="tocPage <= 1" @click="tocPage--">‹</button>
              <span class="pager-num">{{ tocPage }} / {{ tocTotalPages }}</span>
              <button type="button" class="btn btn-sm" :disabled="tocPage >= tocTotalPages" @click="tocPage++">›</button>
            </div>
          </div>
          <ul class="toc-list">
            <li v-for="{ item, globalIndex } in pagedToc" :key="globalIndex" class="toc-item">
              <button type="button" class="toc-jump-btn" @click="openTocItem(item)">
                <span class="toc-title">{{ item.label || item.title || t("uiV02.copy.\u7B2C {v0} \u8282", { v0: globalIndex + 1 }) }}</span>
                <span class="toc-arrow" aria-hidden="true">→</span>
              </button>
            </li>
          </ul>
        </template>
      </section>

      <!-- 标注与记录面板 (P0 批注聚类综述与结构化导出 + 定高步进翻页) -->
      <section v-else-if="activeTab === 'records'" class="tab-panel card" role="tabpanel">
        <div v-if="annotations.length > 0" class="records-toolbar">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="synthesisLoading"
            @click="runAnnotationSynthesis"
          >
            {{ synthesisLoading ? t('readingManager.synthesisGenerating') : t('readingManager.synthesisBtn') }}
          </button>
          <button type="button" class="btn btn-sm" @click="copyNotesMarkdown">
            {{ t('readingManager.copyMarkdownBtn') }}
          </button>
          <button type="button" class="btn btn-sm" @click="exportNotesMarkdown">
            {{ t('readingManager.exportMarkdownBtn') }}
          </button>
          <div v-if="recordsTotalPages > 1" class="pager-controls ml-auto">
            <button type="button" class="btn btn-sm" :disabled="recordsPage <= 1" @click="recordsPage--">‹</button>
            <span class="pager-num">{{ recordsPage }} / {{ recordsTotalPages }}</span>
            <button type="button" class="btn btn-sm" :disabled="recordsPage >= recordsTotalPages" @click="recordsPage++">›</button>
          </div>
        </div>

        <div v-if="synthesisError" class="manager-inline-error" role="alert">{{ synthesisError }}</div>

        <div v-if="synthesisResult" class="synthesis-box">
          <h3 class="synthesis-heading">{{ t('readingManager.synthesisTitle') }}</h3>
          <p class="synthesis-summary">{{ synthesisResult.summary }}</p>

          <div v-if="synthesisResult.themes.length" class="synthesis-themes">
            <h4>{{ t('readingManager.synthesisThemes') }}</h4>
            <div v-for="(theme, tIdx) in synthesisResult.themes" :key="tIdx" class="theme-cluster-item">
              <strong>{{ tIdx + 1 }}. {{ theme.title }}</strong>
              <p>{{ theme.insight }}</p>
            </div>
          </div>

          <div v-if="synthesisResult.keyTakeaways.length" class="synthesis-takeaways">
            <h4>{{ t('readingManager.synthesisTakeaways') }}</h4>
            <ul>
              <li v-for="(item, kIdx) in synthesisResult.keyTakeaways" :key="kIdx">{{ item }}</li>
            </ul>
          </div>
        </div>

        <div v-if="loadingAnnotations" class="loading-box">{{ t('common.loading') }}</div>
        <div v-else-if="!annotations.length" class="empty-box">{{ t("uiV02.copy.暂无笔记与高亮标注") }}</div>
        <ul v-else class="annotations-list">
          <li v-for="ann in pagedAnnotations" :key="ann.id" class="annotation-item">
            <div class="annotation-header">
              <span class="badge">{{ ann.kind === 'bookmark' ? t("uiV02.copy.\u4E66\u7B7E") : t("uiV02.copy.\u9AD8\u4EAE") }}</span>
              <span class="annotation-time">{{ new Date(ann.createdAt).toLocaleDateString() }}</span>
              <button v-if="ann.cfi" type="button" class="link-jump-btn" @click="jumpToAnnotationCfi(ann.cfi)">
                [定位原文]
              </button>
            </div>
            <p v-if="ann.text" class="annotation-text">“{{ ann.text }}”</p>
            <p v-if="ann.note" class="annotation-note">{{ t("uiV02.copy.想法：") }}{{ ann.note }}</p>
          </li>
        </ul>
      </section>
      <section v-else-if="activeTab === 'recommendations' && book.id === bookId" class="tab-panel card" role="tabpanel">
        <BookRecommendationsPanel mode="detail" :reference-id="bookId" @writing="recommendationWriting = $event" @count="recommendationCount = $event" @navigate="id => router.push(`/book/${encodeURIComponent(id)}`)" />
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
  gap: 28px;
  padding: 24px;
  margin-bottom: 20px;
  border: 2px solid var(--eink-solid-black);
  outline: 1px solid var(--eink-border-hairline);
  outline-offset: -5px;
  border-radius: 0;
  background: var(--card);
  box-shadow: none;
}
.cover-wrapper {
  position: relative;
  width: 140px;
  height: 188px;
  aspect-ratio: 3 / 4;
  flex-shrink: 0;
  border-radius: 0;
  overflow: hidden;
  border: 1px solid var(--eink-solid-black);
  padding: 3px;
  background: var(--surface-2);
  box-shadow: none;
}
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-placeholder {
  width: 100%;
  height: 100%;
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-2);
}
.format-tag {
  position: absolute;
  top: 4px;
  left: 4px;
  background: var(--eink-ink);
  color: var(--eink-paper);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 2px;
}
.meta-section {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.book-title {
  font-family: var(--font-serif);
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
  margin: 0;
  color: var(--text);
  letter-spacing: -0.01em;
}
.book-author {
  font-size: 14px;
  color: var(--text-2);
  margin: 0;
}
.status-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
.status-select {
  padding: 4px 8px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--card);
}
.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 2px;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}
.badge.reading {
  background: var(--eink-ink);
  color: var(--eink-paper);
  border-color: var(--eink-ink);
}
.badge.finished {
  background: var(--card);
  color: var(--eink-ink);
  border-color: var(--eink-ink);
}
.badge.paused {
  background: var(--surface-2);
  color: var(--text-2);
  border-color: var(--border);
}
.badge.unread {
  background: var(--surface-2);
  color: var(--text-2);
}
.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;
}
.progress-bar-track {
  flex: 1;
  max-width: 240px;
  height: 5px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--eink-ink);
}
.progress-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  font-feature-settings: "tnum" 1;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: auto;
  padding-top: 10px;
}
.btn-read {
  min-width: 110px;
  font-weight: 600;
}
.tabs-nav {
  display: flex;
  gap: 6px;
  border-bottom: 1.5px solid var(--eink-solid-black);
  margin-bottom: 16px;
  padding-bottom: 2px;
}
.tab-btn {
  background: var(--eink-surface-pure);
  border: 1px solid var(--eink-border-hairline);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--eink-text-secondary);
  cursor: pointer;
  border-radius: 2px;
}
.tab-btn:hover {
  background: var(--eink-surface-subtle);
  color: var(--eink-text-primary);
  border-color: var(--eink-solid-black);
}
.tab-btn.active {
  background: var(--eink-solid-black);
  color: var(--eink-surface-pure);
  border-color: var(--eink-solid-black);
  font-weight: 600;
}
.tab-panel {
  padding: 20px;
  border: 1px solid var(--eink-border-hairline);
  border-radius: 2px;
  background: var(--eink-surface-pure);
}
.overview-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--eink-border-hairline, #eee);
}
.overview-section-title {
  font-weight: 600;
  font-size: 14px;
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
.intro-item {
  flex-direction: column !important;
  gap: 8px;
}
.intro-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.intro-header dt {
  margin: 0;
  width: auto;
}
.description-text {
  font-family: var(--font-serif);
  line-height: 1.73;
  white-space: pre-wrap;
  font-size: 15px;
  color: var(--eink-text-primary);
  text-indent: 2em;
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
  border-radius: var(--radius-sm);
  background: var(--card);
  border: 1px solid var(--border);
  font-size: 13px;
}
.toc-jump-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.toc-jump-btn:active {
  background: var(--eink-solid-black, #000000);
  color: var(--eink-surface-pure, #ffffff);
}
.toc-arrow {
  font-size: 14px;
  font-weight: 700;
}
.step-pager-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #bbbbbb);
  font-size: 12px;
}
.pager-controls {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pager-controls.ml-auto {
  margin-left: auto;
}
.pager-num {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.annotation-item {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--card);
  border: 1px solid var(--border);
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
  font-feature-settings: "tnum" 1;
}
.annotation-text {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  font-style: italic;
  line-height: 1.5;
  border-left: 2px solid var(--border-strong);
  padding-left: 8px;
}
.annotation-note {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
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
  color: var(--text);
  border: 1px solid var(--text);
  padding: 1px 4px;
}
.source-status-badge.denied {
  color: var(--text-2);
  border: 1px solid var(--border);
  padding: 1px 4px;
}

.catchup-card {
  padding: 16px 20px;
  margin-bottom: 18px;
  border: 1px solid var(--eink-solid-black, #111);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.catchup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.catchup-title-group,
.catchup-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.catchup-ai-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border, #ddd);
  padding-top: 10px;
}
.catchup-block h4,
.catchup-recent h4,
.synthesis-themes h4,
.synthesis-takeaways h4 {
  margin: 0 0 4px;
  font-size: 13px;
}
.catchup-block p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.catchup-block ul,
.catchup-notes-list,
.synthesis-takeaways ul {
  margin: 0;
  padding-inline-start: 18px;
  font-size: 13px;
  line-height: 1.5;
}
.records-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border, #ddd);
}
.synthesis-box {
  padding: 14px;
  margin-bottom: 16px;
  border: 1px solid var(--text, #111);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.synthesis-heading {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.synthesis-summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.theme-cluster-item {
  margin-top: 6px;
  font-size: 13px;
}
.theme-cluster-item p {
  margin: 4px 0 0;
  line-height: 1.5;
}
.manager-inline-error {
  padding: 8px 12px;
  border-inline-start: 3px solid var(--text, #111);
  font-size: 13px;
  margin-bottom: 10px;
}
.link-jump-btn {
  background: none;
  border: none;
  padding: 0 4px;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
  color: inherit;
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
