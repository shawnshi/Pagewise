<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { FORMAT_LABELS } from '../services/format'
import { queryLibraryBooks, type LibraryQueryOptions } from '../services/libraryQuery'
import { toast } from '../services/toast'
import { formatReadingTime } from '../composables/useReadingTimer'
import { readerPath } from '../services/readerRoute'
import { acquireLibraryCover } from '../services/libraryCovers'
import { loadDaily, localDay, onReadingLogChange } from '../services/readingLog'
import BookCard from '../components/BookCard.vue'
import AppIcon from '../components/AppIcon.vue'
import type { BookMeta } from '../storage'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { useFolderLibrary } from '../services/folderLibrary'
import {
  saveLibrarySession,
  loadLibrarySession,
  createFilterDraft,
  commitFilterDraft,
  queryLibrarySession,
  type AdvancedFilterDraft,
  type LibrarySortBy,
} from '../services/librarySession'
import {
  READING_STATUSES,
  type ReadingStatus,
} from '../services/readingStatus'

const router = useRouter()
const library = useLibrary()
const settings = useSettings()

const folderLibrary = computed(() => useFolderLibrary())

async function onChooseFolder() {
  try {
    await folderLibrary.value?.chooseFolder()
  } catch (err: any) {
    toast(err?.message || t('common.unknownError'), 'error')
  }
}

async function onRescan() {
  try {
    await folderLibrary.value?.rescan()
    toast(t('common.done'), 'success', 2000)
  } catch (err: any) {
    toast(err?.message || t('common.unknownError'), 'error')
  }
}

const keyword = ref('')
const sortBy = ref<LibrarySortBy>('recent')
const statusFilter = ref<ReadingStatus | ''>('')

// 批量管理
const manageMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const tagFilter = ref<string[]>([])
const tagMode = ref<'and' | 'or'>('and')
const formatFilter = ref('')
const languageFilter = ref('')
const page = ref(1)
const pageSize = ref(12)
const restoringSession = ref(true)
const orderedBookIds = ref<string[]>([])
const lastViewedBookId = ref<string>()
const filterDraft = ref<AdvancedFilterDraft | null>(null)
const filterDialog = ref<HTMLDialogElement>()
const filterTagQuery = ref('')
const filterTagPage = ref(1)
const showTagModal = ref(false)
const tagDraft = ref('')

// 今日阅读目标
const todayMinutes = ref(0)
let stopReadingLog: (() => void) | undefined
async function refreshToday() {
  const d = await loadDaily()
  todayMinutes.value = Math.floor((d[localDay()]?.seconds ?? 0) / 60)
}
const goalMinutes = computed(() => settings.dailyGoalMinutes)
const todayDone = computed(() => goalMinutes.value > 0 && todayMinutes.value >= goalMinutes.value)
const todayRatio = computed(() =>
  goalMinutes.value > 0 ? Math.min(1, todayMinutes.value / goalMinutes.value) : 0)
const TODAY_RING_C = 2 * Math.PI * 5.5

function saveCurrentSession() {
  if (restoringSession.value) return
  saveLibrarySession({
    keyword: keyword.value,
    sortBy: sortBy.value,
    tagFilter: tagFilter.value,
    tagMode: tagMode.value,
    formatFilter: formatFilter.value,
    languageFilter: languageFilter.value,
    statusFilter: statusFilter.value,
    page: page.value,
    pageSize: pageSize.value,
    orderedBookIds: orderedBookIds.value,
    lastViewedBookId: lastViewedBookId.value,
  })
}

onMounted(async () => {
  refreshToday()
  stopReadingLog = onReadingLogChange(refreshToday)
  window.addEventListener('keydown', onGlobalKeydown)

  try {
    if (!library.loaded) await library.refresh()
    const session = loadLibrarySession()
    if (session) {
      keyword.value = session.keyword ?? ''
      sortBy.value = session.sortBy ?? 'recent'
      tagFilter.value = session.tagFilter ?? []
      tagMode.value = session.tagMode ?? 'and'
      formatFilter.value = session.formatFilter ?? ''
      languageFilter.value = session.languageFilter ?? ''
      statusFilter.value = session.statusFilter ?? ''
      page.value = session.page ?? 1
      pageSize.value = session.pageSize ?? 12
      orderedBookIds.value = session.orderedBookIds ?? []
      lastViewedBookId.value = session.lastViewedBookId
    }
    restoringSession.value = false
    await nextTick()
    if (session?.lastViewedBookId) {
      document.getElementById(`book-card-${session.lastViewedBookId}`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    }
  } catch {
    restoringSession.value = false
    toast(t('library.loadFailed'), 'error')
  }
})

onBeforeRouteLeave(() => {
  if (filterDraft.value) {
    closeAdvancedFilter()
    return false
  }
  saveCurrentSession()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  stopReadingLog?.()
})

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (filterDraft.value) {
    closeAdvancedFilter()
    e.preventDefault()
    return
  }
  if (showTagManage.value) showTagManage.value = false
  else if (showTagModal.value) showTagModal.value = false
  else if (manageMode.value) toggleManage()
  else return
  e.preventDefault()
}

// 包含所有书籍 (退休的 paper 格式书籍也在藏书中统一展示)
const allBooks = computed(() => library.books)

const totalReadingTime = computed(() => {
  const total = allBooks.value.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  return total >= 60 ? formatReadingTime(total) : ''
})

const allTags = computed(() => {
  const tags = new Set<string>()
  for (const book of allBooks.value) {
    for (const tag of book.tags || []) tags.add(tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh'))
})

const queryOptions = computed<LibraryQueryOptions>(() => ({
  search: keyword.value,
  tags: tagFilter.value,
  tagMode: tagMode.value,
  formats: formatFilter.value ? [formatFilter.value] : [],
  languages: languageFilter.value ? [languageFilter.value] : [],
  statuses: statusFilter.value ? [statusFilter.value] : undefined,
  sortBy: sortBy.value === 'recent' ? 'lastRead' : sortBy.value === 'added' ? 'addedAt' : sortBy.value,
  pinnedFirst: true,
  page: page.value,
  pageSize: pageSize.value,
}))

const query = computed(() => queryLibrarySession(allBooks.value, queryOptions.value, orderedBookIds.value))
const filtered = computed(() => query.value.items)
const coverUrls = ref<Record<string, string>>({})
watch(() => filtered.value.filter(book => book.hasCover).map(book => book.id), (ids, _previous, onCleanup) => {
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
const formats = computed(() => [...new Set(allBooks.value.map(book => book.format))].sort())
const languages = computed(() => [...new Set(allBooks.value.map(book => book.language).filter((language): language is string => !!language))].sort())

watch([keyword, tagFilter, tagMode, formatFilter, languageFilter, statusFilter, sortBy, pageSize], () => {
  if (restoringSession.value) return
  orderedBookIds.value = []
  page.value = 1
  selectedIds.value = new Set()
}, { flush: 'sync' })

watch(() => query.value.page, value => {
  if (!restoringSession.value) page.value = value
})

watch(() => library.books.map(book => book.id), ids => {
  const existing = new Set(ids)
  selectedIds.value = new Set([...selectedIds.value].filter(id => existing.has(id)))
})

const hasActiveChips = computed(() => {
  return !!keyword.value.trim() || !!tagFilter.value.length || !!formatFilter.value || !!languageFilter.value || !!statusFilter.value
})

const lastReadingBook = computed(() =>
  hasActiveChips.value ? undefined : [...allBooks.value].filter(book => !!book.lastReadAt).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0])

const filterTags = computed(() => allTags.value.filter(tag => tag.toLowerCase().includes(filterTagQuery.value.toLowerCase())))
const visibleFilterTags = computed(() => filterTags.value.slice((filterTagPage.value - 1) * 24, filterTagPage.value * 24))
watch(filterTagQuery, () => { filterTagPage.value = 1 })

const filterPreviewCount = computed(() => {
  const draft = filterDraft.value
  return draft
    ? queryLibraryBooks(allBooks.value, {
        ...queryOptions.value,
        tags: draft.tags,
        tagMode: draft.tagMode,
        formats: draft.format ? [draft.format] : [],
        languages: draft.language ? [draft.language] : [],
        statuses: draft.status ? [draft.status] : [],
      }).total
    : query.value.total
})

async function openAdvancedFilter() {
  filterDraft.value = createFilterDraft({
    tagFilter: tagFilter.value,
    tagMode: tagMode.value,
    formatFilter: formatFilter.value,
    languageFilter: languageFilter.value,
    statusFilter: statusFilter.value,
    sortBy: sortBy.value,
  })
  filterTagQuery.value = ''
  filterTagPage.value = 1
  await nextTick()
  filterDialog.value?.showModal()
}

function closeAdvancedFilter() {
  filterDialog.value?.close()
  filterDraft.value = null
}

function applyAdvancedFilter() {
  if (!filterDraft.value) return
  const committed = commitFilterDraft(filterDraft.value)
  tagFilter.value = committed.tagFilter
  tagMode.value = committed.tagMode
  formatFilter.value = committed.formatFilter
  languageFilter.value = committed.languageFilter
  statusFilter.value = committed.statusFilter
  sortBy.value = committed.sortBy
  page.value = 1
  closeAdvancedFilter()
}

function resetFilterDraft() {
  if (filterDraft.value) {
    Object.assign(filterDraft.value, {
      tags: [],
      tagMode: 'or',
      format: '',
      language: '',
      status: '',
      sortBy: 'recent',
    })
  }
}

function refreshResultOrder() {
  orderedBookIds.value = []
  page.value = 1
}

function toggleTag(tag: string) {
  tagFilter.value = tagFilter.value.includes(tag)
    ? tagFilter.value.filter(value => value !== tag)
    : [...tagFilter.value, tag]
}

function clearFilters() {
  keyword.value = ''
  tagFilter.value = []
  formatFilter.value = ''
  languageFilter.value = ''
  statusFilter.value = ''
}

function toggleManage() {
  manageMode.value = !manageMode.value
  if (!manageMode.value) selectedIds.value = new Set()
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

const pageSelected = computed(() =>
  filtered.value.length > 0 && filtered.value.every(book => selectedIds.value.has(book.id)))

const isAllMatchingSelected = computed(() =>
  query.value.total > 0 && selectedIds.value.size === query.value.total)

function selectAll() {
  const next = new Set(selectedIds.value)
  if (pageSelected.value) {
    for (const book of filtered.value) next.delete(book.id)
  } else {
    for (const book of filtered.value) next.add(book.id)
  }
  selectedIds.value = next
}

function selectAllMatching() {
  selectedIds.value = new Set(
    queryLibraryBooks(allBooks.value, {
      ...queryOptions.value,
      page: 1,
      pageSize: Number.MAX_SAFE_INTEGER,
    }).items.map(book => book.id),
  )
}

async function batchSetStatus(status: ReadingStatus) {
  if (!selectedIds.value.size) return
  const ids = [...selectedIds.value]
  const { succeeded, failed, failedIds } = await library.batchSetReadingStatus(ids, status)
  selectedIds.value = new Set(failedIds)
  if (failed === 0) {
    toast(t('uiV02.copy.已将 {v0} 本书标为{v1}', { v0: succeeded, v1: t('uiV02.status.' + status) }), 'success')
  } else {
    toast(t('uiV02.copy.已将 {v0} 本标为{v1}，{v2} 本更新失败', { v0: succeeded, v1: t('uiV02.status.' + status), v2: failed }), 'info')
  }
}

async function batchDelete() {
  const count = selectedIds.value.size
  if (!count) return

  const selectedBooks = [...selectedIds.value]
    .map(id => library.books.find(b => b.id === id))
    .filter((b): b is BookMeta => !!b)
  const sourceBooks = selectedBooks.filter(b => !!b.sourceRef)
  const copiedBooks = selectedBooks.filter(b => !b.sourceRef)

  if (sourceBooks.length > 0 && copiedBooks.length === 0) {
    toast(t('book.sourceManagedHint'), 'info', 5000)
    return
  }

  if (sourceBooks.length > 0) {
    toast(t('book.sourceManagedHint'), 'info', 5000)
  }

  if (!confirm(t('library.batchDeleteConfirm', { count: copiedBooks.length }))) return
  const idsToDelete = copiedBooks.map(b => b.id)
  const { succeeded, failed, failedIds } = await library.batchRemoveBooks(idsToDelete)
  selectedIds.value = new Set([...sourceBooks.map(b => b.id), ...failedIds])
  if (failed === 0) {
    toast(t('library.batchDeleted', { count: succeeded }), 'success')
  } else {
    toast(t('library.batchDeleteFailed', { deleted: succeeded, msg: `${failed} 本删除失败` }), 'error', 7000)
  }
}

async function batchTag() {
  const tags = tagDraft.value.split(/[,，、]/).map(t => t.trim()).filter(Boolean)
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    const merged = [...new Set([...book.tags, ...tags])]
    await storage.updateBook(id, { tags: merged })
    book.tags = merged
  }
  showTagModal.value = false
  tagDraft.value = ''
  toast(t('library.tagsAdded', { count: selectedIds.value.size }), 'success')
}

async function togglePin(book: BookMeta) {
  const storage = await (await import('../storage')).getStorage()
  const pinnedAt = book.pinnedAt ? 0 : Date.now()
  await storage.updateBook(book.id, { pinnedAt })
  book.pinnedAt = pinnedAt || undefined
  toast(pinnedAt ? t('library.pinned') : t('library.unpinned'), 'success')
}

async function batchPin(pin: boolean) {
  const storage = await (await import('../storage')).getStorage()
  let stamp = Date.now()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    const pinnedAt = pin ? stamp-- : 0
    await storage.updateBook(id, { pinnedAt })
    book.pinnedAt = pinnedAt || undefined
  }
  toast(pin ? t('library.pinned') : t('library.unpinned'), 'success')
}

function rememberResultOrder() {
  if (!orderedBookIds.value.length) {
    orderedBookIds.value = queryLibraryBooks(allBooks.value, {
      ...queryOptions.value, page: 1, pageSize: Number.MAX_SAFE_INTEGER,
    }).items.map(book => book.id)
  }
}

function openDetail(book: BookMeta) {
  rememberResultOrder()
  lastViewedBookId.value = book.id
  saveCurrentSession()
  router.push(`/book/${book.id}`)
}

function openReader(book: BookMeta) {
  rememberResultOrder()
  lastViewedBookId.value = book.id
  saveCurrentSession()
  router.push(readerPath(book))
}

async function removeBook(book: BookMeta) {
  if (book.sourceRef) {
    toast(t('book.sourceManagedHint'), 'info', 5000)
    return
  }
  if (!confirm(t('library.deleteConfirm', { title: book.title }))) return
  try {
    await library.removeBook(book.id)
    toast(t('library.deleted'), 'success')
  } catch (err: any) {
    toast(t('library.deleteFailed', { msg: err?.message ?? err }), 'error')
  }
}

// 标签管理
const showTagManage = ref(false)
const tagManageEditing = ref<string | null>(null)
const tagManageRename = ref('')

function openTagManage() {
  tagManageEditing.value = null
  tagManageRename.value = ''
  showTagManage.value = true
}

function tagCount(tag: string) {
  return allBooks.value.filter(b => b.tags.includes(tag)).length
}

async function renameTag(oldTag: string) {
  const newTag = tagManageRename.value.trim()
  if (!newTag || newTag === oldTag) {
    tagManageEditing.value = null
    return
  }
  const storage = await (await import('../storage')).getStorage()
  for (const book of allBooks.value) {
    if (!book.tags.includes(oldTag)) continue
    const next = [...new Set(book.tags.map(t => (t === oldTag ? newTag : t)))]
    await storage.updateBook(book.id, { tags: next })
    book.tags = next
  }
  tagFilter.value = tagFilter.value.map(t => (t === oldTag ? newTag : t))
  tagManageEditing.value = null
  toast(t('library.tagRenamed', { old: oldTag, new: newTag }), 'success')
}

async function deleteTag(tag: string) {
  if (!confirm(t('library.deleteTagConfirm', { tag }))) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of allBooks.value) {
    if (!book.tags.includes(tag)) continue
    const next = book.tags.filter(t => t !== tag)
    await storage.updateBook(book.id, { tags: next })
    book.tags = next
  }
  tagFilter.value = tagFilter.value.filter(t => t !== tag)
  toast(t('library.tagDeleted', { tag }), 'success')
}

async function clearSelectedTags() {
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { tags: [] })
    book.tags = []
  }
  showTagModal.value = false
  toast(t('library.tagsCleared'), 'success')
}
</script>

<template>
  <div class="library">
    <!-- 顶栏：标题、搜索、排序、管理 -->
    <header class="toolbar">
      <div class="heading">
        <h1>{{ t('library.title') }}</h1>
        <span v-if="library.loaded" class="count">
          {{ t('library.bookCount', { count: allBooks.length }) }}<template v-if="totalReadingTime"> · {{ t('library.totalReading', { time: totalReadingTime }) }}</template>
        </span>
        <router-link
          to="/stats"
          class="today-link"
          :class="{ done: todayDone }"
          :title="t('stats.libraryTodayTitle', { m: todayMinutes })"
          :aria-label="t('stats.libraryTodayTitle', { m: todayMinutes })"
        >
          <svg v-if="goalMinutes > 0" class="today-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" class="today-ring-track" />
            <circle
              cx="7"
              cy="7"
              r="5.5"
              class="today-ring-fill"
              :stroke-dasharray="TODAY_RING_C"
              :stroke-dashoffset="TODAY_RING_C * (1 - todayRatio)"
            />
          </svg>
          <AppIcon v-else name="history" :size="14" aria-hidden="true" />
          <span>{{ goalMinutes > 0 && !todayDone ? t('stats.libraryTodayGoal', { m: todayMinutes, goal: goalMinutes }) : t('stats.libraryToday', { m: todayMinutes }) }}</span>
        </router-link>
      </div>
      <div class="spacer" />
      <div class="search-field">
        <AppIcon class="search-icon" name="search" :size="16" aria-hidden="true" />
        <input
          v-model="keyword"
          class="input search"
          type="search"
          :placeholder="t('library.searchPlaceholder')"
          :aria-label="t('common.search')"
          autocomplete="off"
          spellcheck="false"
        />
        <button v-if="keyword" type="button" class="search-clear" :aria-label="t('common.clear')" @click="keyword = ''">
          <AppIcon name="close" :size="14" aria-hidden="true" />
        </button>
      </div>
      <select v-model="sortBy" class="input sort" :aria-label="t('common.sortBy')">
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="title">{{ t('library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
      </select>
      <button v-if="allBooks.length" class="btn" :class="{ 'btn-primary': manageMode }" :aria-pressed="manageMode" @click="toggleManage">
        {{ manageMode ? t('common.done') : t('library.manage') }}
      </button>
      <span class="row-break" aria-hidden="true" />
    </header>

    <!-- 监测文件夹横幅状态 -->
    <section class="monitored-folder-banner card" role="region" :aria-label="t('folder.monitoredTitle')">
      <div class="folder-banner-main">
        <div class="folder-banner-icon-col">
          <AppIcon name="folder" :size="24" aria-hidden="true" />
        </div>
        <div class="folder-banner-text">
          <div class="folder-banner-title-row">
            <span class="folder-banner-label">
              {{ folderLibrary?.status?.value?.folderLabel || t('folder.status.unconfigured') }}
            </span>
            <span class="badge" :class="folderLibrary?.status?.value?.state || 'unconfigured'">
              {{ t('folder.status.' + (folderLibrary?.status?.value?.state === 'permission-denied' ? 'permissionDenied' : (folderLibrary?.status?.value?.state || 'unconfigured'))) }}
            </span>
          </div>
          <p v-if="!folderLibrary?.status?.value?.folderLabel || folderLibrary?.status?.value?.state === 'unconfigured'" class="folder-banner-hint">
            {{ t('folder.status.unconfiguredHint') }}
          </p>
          <p v-else class="folder-banner-stats">
            <span>{{ t('folder.indexedCount', { n: folderLibrary?.status?.value?.indexed ?? 0 }) }}</span>
            <span v-if="folderLibrary?.status?.value?.unavailable" class="unavailable-hint"> · {{ t('folder.unavailableCount', { n: folderLibrary.status.value.unavailable }) }}</span>
            <span class="readonly-hint"> · {{ t('folder.sourceFilesReadOnly') }}</span>
          </p>
          <p v-if="folderLibrary?.status?.value?.error" class="folder-banner-error" role="alert">
            {{ folderLibrary.status.value.error }}
          </p>
        </div>
      </div>
      <div class="folder-banner-actions">
        <button
          class="btn btn-primary"
          :disabled="folderLibrary?.status?.value?.state === 'scanning'"
          @click="onChooseFolder"
        >
          <AppIcon name="folder" :size="16" aria-hidden="true" />
          <span>{{ (!folderLibrary?.status?.value?.folderLabel || folderLibrary?.status?.value?.state === 'unconfigured') ? t('folder.choose') : t('folder.change') }}</span>
        </button>
        <button
          v-if="folderLibrary?.status?.value?.folderLabel && folderLibrary?.status?.value?.state !== 'unconfigured'"
          class="btn"
          :disabled="folderLibrary?.status?.value?.state === 'scanning'"
          @click="onRescan"
        >
          <AppIcon name="refresh" :size="16" aria-hidden="true" />
          <span>{{ t('folder.rescan') }}</span>
        </button>
      </div>
    </section>

    <!-- 标签筛选行 -->
    <div v-if="allTags.length" class="tag-row">
      <button class="tag-chip" :class="{ active: !tagFilter.length }" :aria-pressed="!tagFilter.length" @click="tagFilter = []">{{ t('library.filterAll') }}</button>
      <select v-model="tagMode" class="input" :aria-label="t('library.tagMode')">
        <option value="and">{{ t('library.tagsAnd') }}</option>
        <option value="or">{{ t('library.tagsOr') }}</option>
      </select>
      <button
        v-for="tag in allTags.slice(0, 5)"
        :key="tag"
        class="tag-chip"
        :class="{ active: tagFilter.includes(tag) }"
        :aria-pressed="tagFilter.includes(tag)"
        @click="toggleTag(tag)"
      >{{ tag }}</button>
      <button class="tag-chip tag-manage" :title="t('library.manageTags')" @click="openTagManage">
        <AppIcon name="more" :size="12" aria-hidden="true" />
        {{ t('library.manageTags') }}
      </button>
    </div>

    <div class="advanced-filter-entry">
      <button type="button" class="btn open-filter" @click="openAdvancedFilter">{{ t('uiV02.filters') }}</button>
      <button v-if="orderedBookIds.length" type="button" class="btn" @click="refreshResultOrder">{{ t('uiV02.refreshOrder') }}</button>
    </div>

    <!-- 最近阅读卡片 -->
    <section v-if="lastReadingBook && !manageMode" class="resume-card">
      <div><strong>{{ lastReadingBook.title }}</strong><p>{{ t('uiV02.resumePosition') }} · {{ Math.round((lastReadingBook.progress ?? 0) * 100) }}%</p></div>
      <button type="button" class="btn btn-primary" @click="openReader(lastReadingBook)">{{ t('catalog.continueReading') }}</button>
    </section>

    <!-- 高级筛选模态框 -->
    <dialog v-if="filterDraft" ref="filterDialog" class="advanced-filter-dialog" :aria-label="t('uiV02.filters')" @cancel.prevent="closeAdvancedFilter">
      <header><h2>{{ t('uiV02.filters') }}</h2><button autofocus type="button" class="btn filter-close" @click="closeAdvancedFilter">{{ t('common.close') }}</button></header>
      <label>{{ t('uiV02.searchCategories') }}<input v-model="filterTagQuery" class="input" :aria-label="t('uiV02.searchCategories')" /></label>
      <div class="filter-topics"><label v-for="tag in visibleFilterTags" :key="tag"><input v-model="filterDraft.tags" type="checkbox" :value="tag" />{{ tag }} <span>{{ tagCount(tag) }}</span></label></div>
      <div v-if="filterTags.length > 24" class="filter-topic-pages"><button class="btn" :disabled="filterTagPage <= 1" @click="filterTagPage--">{{ t('common.prev') }}</button><span>{{ filterTagPage }} / {{ Math.ceil(filterTags.length / 24) }}</span><button class="btn" :disabled="filterTagPage * 24 >= filterTags.length" @click="filterTagPage++">{{ t('common.next') }}</button></div>
      <label>{{ t('library.tagMode') }}<select v-model="filterDraft.tagMode" class="input"><option value="or">{{ t('library.tagsOr') }}</option><option value="and">{{ t('library.tagsAnd') }}</option></select></label>
      <label>{{ t('library.filterFormat') }}<select v-model="filterDraft.format" class="input" :aria-label="t('library.filterFormat')"><option value="">{{ t('library.allFormats') }}</option><option v-for="format in formats" :key="format" :value="format">{{ FORMAT_LABELS[format] || format }}</option></select></label>
      <label>{{ t('library.filterLanguage') }}<select v-model="filterDraft.language" class="input" :aria-label="t('library.filterLanguage')"><option value="">{{ t('library.allLanguages') }}</option><option v-for="language in languages" :key="language" :value="language">{{ language }}</option></select></label>
      <label>{{ t('uiV02.readingStatus') }}<select v-model="filterDraft.status" class="input" :aria-label="t('uiV02.readingStatus')"><option value="">{{ t('uiV02.allStatuses') }}</option><option v-for="status in READING_STATUSES" :key="status" :value="status">{{ t('uiV02.status.' + status) }}</option></select></label>
      <footer><button class="btn" @click="resetFilterDraft">{{ t('uiV02.resetDraft') }}</button><button class="btn btn-primary apply-filter" @click="applyAdvancedFilter">{{ t('uiV02.applyFilter', { count: filterPreviewCount }) }}</button></footer>
    </dialog>

    <!-- 激活的筛选胶囊 -->
    <div v-if="hasActiveChips" class="active-chips" role="region" :aria-label="t('uiV02.copy.已应用筛选条件')">
      <span v-if="keyword" class="chip">
        {{ t("uiV02.copy.搜索:") }} {{ keyword }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除搜索关键字')" @click="keyword = ''">×</button>
      </span>
      <span v-for="tag in tagFilter" :key="tag" class="chip">
        {{ t("uiV02.copy.标签:") }} {{ tag }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除标签 {v0}', { v0: tag })" @click="toggleTag(tag)">×</button>
      </span>
      <span v-if="formatFilter" class="chip">
        {{ t("uiV02.copy.格式:") }} {{ FORMAT_LABELS[formatFilter as keyof typeof FORMAT_LABELS] || formatFilter }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除格式筛选')" @click="formatFilter = ''">×</button>
      </span>
      <span v-if="languageFilter" class="chip">
        {{ t("uiV02.copy.语言:") }} {{ languageFilter }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除语言筛选')" @click="languageFilter = ''">×</button>
      </span>
      <span v-if="statusFilter" class="chip">
        {{ t("uiV02.copy.状态:") }} {{ t('uiV02.status.' + statusFilter) }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除状态筛选')" @click="statusFilter = ''">×</button>
      </span>
      <button type="button" class="btn btn-sm btn-clear-chips" @click="clearFilters">{{ t("uiV02.copy.清空全部") }}</button>
    </div>

    <!-- 加载骨架屏 -->
    <div v-if="!library.loaded" class="grid" aria-busy="true" :aria-label="t('library.loading')">
      <div v-for="i in 12" :key="i" class="skeleton-card">
        <div class="skeleton skeleton-cover" />
        <div class="skeleton skeleton-line" />
        <div class="skeleton skeleton-line short" />
      </div>
    </div>

    <!-- 空库状态 -->
    <div v-else-if="!allBooks.length" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <AppIcon name="library" :size="48" aria-hidden="true" />
      </div>
      <p class="empty-title">{{ t('library.emptyTitle') }}</p>
      <p class="hint">
        {{ t('folder.status.unconfiguredHint') }}
      </p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="onChooseFolder">
          <AppIcon name="folder" :size="16" aria-hidden="true" />
          <span>{{ t('folder.choose') }}</span>
        </button>
      </div>
    </div>

    <!-- 筛选无结果 -->
    <div v-else-if="!filtered.length" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <AppIcon name="search" :size="48" aria-hidden="true" />
      </div>
      <p class="empty-title">{{ t('reader.noResults') }}</p>
      <div class="empty-actions">
        <button class="btn" @click="clearFilters">{{ t('common.clear') }}</button>
      </div>
    </div>

    <!-- 藏书列表 -->
    <div v-else class="grid">
      <BookCard
        v-for="book in filtered"
        :id="`book-card-${book.id}`"
        :key="book.id"
        :book="book"
        :cover-url="coverUrls[book.id]"
        :selectable="manageMode"
        :selected="selectedIds.has(book.id)"
        @open="openDetail(book)"
        @read="openReader(book)"
        @remove="removeBook(book)"
        @toggle-select="toggleSelect(book.id)"
        @toggle-pin="togglePin(book)"
      />
    </div>

    <!-- 分页器 -->
    <div v-if="library.loaded && filtered.length" class="pagination">
      <span role="status">{{ t('library.pageSummary', { total: query.total, page: query.page, pages: query.totalPages }) }}</span>
      <label>{{ t('library.pageSize') }}
        <select v-model.number="pageSize" class="input">
          <option :value="12">12</option><option :value="24">24</option>
        </select>
      </label>
      <button class="btn btn-sm" :disabled="query.page <= 1" @click="page--">{{ t('library.previousPage') }}</button>
      <button class="btn btn-sm" :disabled="query.page >= query.totalPages" @click="page++">{{ t('library.nextPage') }}</button>
    </div>

    <!-- 批量管理操作栏 -->
    <div v-if="manageMode" class="batch-bar card" role="toolbar" :aria-label="t('library.manage')">
      <span class="batch-count">{{ t('library.selectedCount', { count: selectedIds.size }) }}</span>
      <span v-if="selectedIds.size" class="batch-scope-badge">
        {{ pageSelected ? t("uiV02.copy.（当前页全部）") : (isAllMatchingSelected ? t("uiV02.copy.（全匹配结果）") : '') }}
      </span>
      <button class="btn btn-sm" @click="selectAll">
        {{ pageSelected ? t('library.deselectPage') : t('library.selectPage') }}
      </button>
      <button class="btn btn-sm" :disabled="!query.total" @click="selectAllMatching">{{ t('library.selectMatching', { count: query.total }) }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="selectedIds = new Set()">{{ t('library.deselectAll') }}</button>
      <select
        class="input input-sm batch-status-select"
        :disabled="!selectedIds.size"
        :aria-label="t('uiV02.copy.批量设置阅读状态')"
        @change="batchSetStatus(($event.target as HTMLSelectElement).value as ReadingStatus); ($event.target as HTMLSelectElement).value = ''"
      >
        <option value="" disabled selected>{{ t("uiV02.copy.标为状态…") }}</option>
        <option value="reading">{{ t("uiV02.copy.标为在读") }}</option>
        <option value="finished">{{ t("uiV02.copy.标为已读") }}</option>
        <option value="unread">{{ t("uiV02.copy.标为未读") }}</option>
        <option value="paused">{{ t("uiV02.copy.标为搁置") }}</option>
      </select>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(true)">{{ t('library.pin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(false)">{{ t('library.unpin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">{{ t('library.setTags') }}</button>
      <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">{{ t('common.delete') }}</button>
      <button class="btn btn-sm" @click="toggleManage">{{ t('common.done') }}</button>
    </div>

    <!-- 批量设置标签弹窗 -->
    <div v-if="showTagModal" class="modal-mask" @click.self="showTagModal = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
        <h3 id="tag-modal-title">{{ t('library.setTags') }}</h3>
        <p class="modal-description">{{ t('library.tagsBatchHint', { count: selectedIds.size }) }}</p>
        <input
          v-model="tagDraft"
          class="input"
          :placeholder="t('library.tagsPlaceholder')"
          :aria-label="t('library.tagsPlaceholder')"
          autofocus
          @keyup.enter="batchTag"
        />
        <div class="form-actions">
          <button class="btn btn-sm" @click="showTagModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-ghost" @click="clearSelectedTags">{{ t('library.clearTags') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 标签管理弹窗 -->
    <div v-if="showTagManage" class="modal-mask" @click.self="showTagManage = false">
      <div class="modal tag-manage-modal" role="dialog" aria-modal="true" aria-labelledby="tag-manage-title">
        <h3 id="tag-manage-title">{{ t('library.manageTags') }}</h3>
        <ul v-if="allTags.length" class="tag-manage-list">
          <li v-for="tag in allTags" :key="tag" class="tag-manage-item">
            <template v-if="tagManageEditing === tag">
              <input
                v-model="tagManageRename"
                class="input input-sm tag-rename-input"
                autofocus
                :aria-label="t('library.renameTag')"
                @keyup.enter="renameTag(tag)"
                @keyup.esc="tagManageEditing = null"
              />
              <button class="btn btn-sm btn-primary" @click="renameTag(tag)">{{ t('common.save') }}</button>
              <button class="btn btn-sm" @click="tagManageEditing = null">{{ t('common.cancel') }}</button>
            </template>
            <template v-else>
              <span class="tag-manage-name">{{ tag }}</span>
              <span class="tag-manage-count">({{ tagCount(tag) }})</span>
              <button class="btn btn-sm" @click="tagManageEditing = tag; tagManageRename = tag">{{ t('library.renameTag') }}</button>
              <button class="btn btn-sm btn-danger" @click="deleteTag(tag)">{{ t('common.delete') }}</button>
            </template>
          </li>
        </ul>
        <div class="form-actions">
          <button class="btn btn-sm btn-primary" @click="showTagManage = false">{{ t('common.done') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library {
  padding: 20px 24px calc(48px + var(--lr-safe-bottom));
  max-width: 1200px;
  margin: 0 auto;
}
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
}
.heading h1 {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.count {
  font-size: 13px;
  color: var(--text-2);
}
.today-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
  text-decoration: none;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.spacer {
  flex: 1;
}
.search-field {
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-3);
  pointer-events: none;
}
.search {
  padding-left: 32px;
  padding-right: 28px;
  width: 200px;
}
.search-clear {
  position: absolute;
  right: 6px;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px;
}
.sort {
  width: 120px;
}
.btn {
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 监测文件夹横幅 */
.monitored-folder-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 14px 18px;
  margin-bottom: 18px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.folder-banner-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 240px;
}
.folder-banner-icon-col {
  color: var(--text-2);
  flex-shrink: 0;
}
.folder-banner-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.folder-banner-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.folder-banner-hint,
.folder-banner-stats {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.readonly-hint {
  color: var(--text-3);
}
.folder-banner-error {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}
.folder-banner-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
}
.badge.unconfigured { background: var(--surface-3); color: var(--text-2); }
.badge.idle { background: var(--brand-light); color: var(--brand); }
.badge.scanning { background: color-mix(in srgb, var(--brand) 20%, transparent); color: var(--brand); }
.badge.partial, .badge.permissionDenied, .badge.permission-denied { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }
.badge.error { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }

/* 标签行 */
.tag-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.tag-chip {
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  min-height: 36px;
}
.tag-chip.active {
  background: var(--text);
  color: var(--card);
  border-color: var(--text);
}
.advanced-filter-entry {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.active-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 12px;
}
.chip-remove {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-3);
}
.resume-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  margin-bottom: 18px;
  border-radius: var(--radius);
  background: var(--card);
  border: 1px solid var(--border);
}
.resume-card p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-2);
}

/* 网格与卡片 */
.grid {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.empty {
  padding: 64px 24px;
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
  margin: 0;
}
.hint {
  font-size: 13px;
  color: var(--text-2);
  margin: 0 0 8px;
  max-width: 420px;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
  font-size: 13px;
  color: var(--text-2);
}
.batch-bar {
  position: fixed;
  bottom: calc(20px + var(--lr-safe-bottom));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 18px;
  background: var(--card);
  border: 1px solid var(--text);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 100;
}
.batch-count {
  font-weight: 600;
  font-size: 13px;
  margin-right: 4px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--card);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 90%;
  max-width: 440px;
  box-shadow: var(--shadow-lg);
}
.modal h3 {
  margin: 0 0 8px;
  font-size: 18px;
}
.modal-description {
  font-size: 13px;
  color: var(--text-2);
  margin: 0 0 16px;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.tag-manage-list {
  list-style: none;
  padding: 0;
  margin: 12px 0;
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tag-manage-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.tag-manage-name {
  flex: 1;
  font-size: 14px;
}
.tag-manage-count {
  font-size: 12px;
  color: var(--text-3);
}

@media (max-width: 720px) {
  .library {
    padding: 14px 12px calc(48px + var(--lr-safe-bottom));
  }
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .search {
    width: 100%;
  }
  .row-break {
    display: none;
  }
}
</style>
