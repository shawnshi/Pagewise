<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { FORMAT_LABELS } from '../services/format'
import { countLibraryCategories, UNCLASSIFIED_CATEGORY, queryLibraryBooks, type LibraryQueryOptions } from '../services/libraryQuery'
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
import { BOOK_CATEGORIES } from '../services/bookClassification'
import { bookFileProblem, type AvailabilityFilter } from '../services/bookAvailability'
import { clearBookClassifications } from '../services/bookTagActions'
import { getStorage } from '../storage'
import { useNativeBack } from '../composables/useNativeBack'
import {
  saveLibrarySession,
  loadLibrarySession,
  createFilterDraft,
  commitFilterDraft,
  queryLibrarySession,
  type AdvancedFilterDraft,
  type LibrarySessionState,
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
    await library.refresh()
    const status = folderLibrary.value?.status.value
    if (status && ['partial', 'error', 'permission-denied'].includes(status.state)) {
      const message = status.state === 'partial' ? [t('folder.status.partial'), status.error].filter(Boolean).join(' · ') : status.error || t('library.filePermission')
      throw new Error(message)
    }
    toast(t('common.done'), 'success', 2000)
  } catch (err: any) {
    toast(err?.message || t('common.unknownError'), 'error')
  }
}

const keyword = ref('')
const sortBy = ref<LibrarySortBy>('added')
const statusFilter = ref<ReadingStatus | ''>('')
const availabilityFilter = ref<AvailabilityFilter>('')
const unavailableCount = computed(() => allBooks.value.filter(book => bookFileProblem(book)).length)
const folderStatus = computed(() => folderLibrary.value.status.value)
const scanning = computed(() => folderStatus.value.state === 'scanning')
const hasFolderIssue = computed(() => ['partial', 'error', 'permission-denied'].includes(folderStatus.value.state))
const folderIssueMessage = computed(() => {
  const status = folderLibrary.value.status.value
  if (status.state === 'permission-denied') return t('library.filePermission')
  if (hasFolderIssue.value) return [t('folder.status.' + status.state), status.error].filter(Boolean).join(' · ')
  return t('library.unavailableCount', { count: unavailableCount.value })
})
const categoryFilter = ref('')
const classificationStatusFilter = ref<'all' | 'complete' | 'incomplete' | 'unclassified' | ''>('')
const audienceFilter = ref('')
const textbookFilter = ref<'all' | 'true' | 'false' | 'unknown' | ''>('')
const ancientTextFilter = ref<'all' | 'true' | 'false' | 'unknown' | ''>('')
const workCountryFilter = ref('')
const workPeriodFilter = ref('')

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
const filterPanel = ref<HTMLElement>()
const categoryNav = ref<HTMLElement>()
const unavailableReturn = ref<LibrarySessionState>()
const pageJump = ref<number | undefined>()
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
  rememberResultOrder()
  saveLibrarySession({
    keyword: keyword.value,
    sortBy: sortBy.value,
    tagFilter: tagFilter.value,
    tagMode: tagMode.value,
    formatFilter: formatFilter.value,
    languageFilter: languageFilter.value,
    statusFilter: statusFilter.value,
    availabilityFilter: availabilityFilter.value,
    unavailableReturn: unavailableReturn.value,
    returnedFromReader: false,
    categoryFilter: categoryFilter.value,
    classificationStatusFilter: classificationStatusFilter.value,
    audienceFilter: audienceFilter.value,
    textbookFilter: textbookFilter.value,
    ancientTextFilter: ancientTextFilter.value,
    workCountryFilter: workCountryFilter.value,
    workPeriodFilter: workPeriodFilter.value,
    page: page.value,
    pageSize: pageSize.value,
    orderedBookIds: orderedBookIds.value,
    lastViewedBookId: lastViewedBookId.value,
  })
}

function restoreSession(session: LibrarySessionState) {
  keyword.value = session.keyword ?? ''
  sortBy.value = session.sortBy ?? 'added'
  tagFilter.value = session.tagFilter ?? []
  tagMode.value = session.tagMode ?? 'and'
  formatFilter.value = session.formatFilter ?? ''
  languageFilter.value = session.languageFilter ?? ''
  statusFilter.value = session.statusFilter ?? ''
  categoryFilter.value = session.categoryFilter ?? ''
  classificationStatusFilter.value = session.classificationStatusFilter ?? ''
  audienceFilter.value = session.audienceFilter ?? ''
  textbookFilter.value = session.textbookFilter ?? ''
  ancientTextFilter.value = session.ancientTextFilter ?? ''
  workCountryFilter.value = session.workCountryFilter ?? ''
  workPeriodFilter.value = session.workPeriodFilter ?? ''
  page.value = session.page ?? 1
  pageSize.value = session.pageSize ?? 12
  orderedBookIds.value = session.orderedBookIds ?? []
  lastViewedBookId.value = session.lastViewedBookId
  availabilityFilter.value = session.availabilityFilter ?? ''
  unavailableReturn.value = session.unavailableReturn
}

onMounted(async () => {
  refreshToday()
  stopReadingLog = onReadingLogChange(refreshToday)
  window.addEventListener('keydown', onGlobalKeydown)

  try {
    const session = loadLibrarySession()
    await library.refresh()
    if (session) restoreSession(session)
    if (session?.returnedFromReader || sortBy.value === 'published') {
      orderedBookIds.value = []
      rememberResultOrder()
      const index = orderedBookIds.value.indexOf(lastViewedBookId.value ?? '')
      if (index >= 0) page.value = Math.floor(index / pageSize.value) + 1
    } else rememberResultOrder()
    restoringSession.value = false
    saveCurrentSession()
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
  }
  saveCurrentSession()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  stopReadingLog?.()
})

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (!dismissLibraryLayer()) return
  e.preventDefault()
}

/** 逐层关闭书库弹层/管理态; 返回 false 表示没有需要关闭的层。 */
function dismissLibraryLayer(): boolean {
  if (filterDraft.value) { closeAdvancedFilter(); return true }
  if (showTagModal.value) { showTagModal.value = false; return true }
  if (manageMode.value) { toggleManage(); return true }
  return false
}

// Android 侧滑/返回键与 Esc 行为一致: 先退出弹层与管理态，再交给路由回退。
useNativeBack(dismissLibraryLayer)

// 包含所有书籍 (退休的 paper 格式书籍也在藏书中统一展示)
const allBooks = computed(() => library.books)

const totalReadingTime = computed(() => {
  const total = allBooks.value.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  return total >= 60 ? formatReadingTime(total) : ''
})

const categoryLabels = new Set(BOOK_CATEGORIES.map(c => c.label))
const categoryCounts = computed(() => countLibraryCategories(allBooks.value))
const availableCategories = computed(() => {
  const counts = categoryCounts.value
  const knownIds = new Set(BOOK_CATEGORIES.map(category => category.id))
  const known = BOOK_CATEGORIES.filter(category => counts.has(category.id))
    .map(category => ({ ...category, count: counts.get(category.id)! }))
  const other = [...counts].filter(([id]) => id !== UNCLASSIFIED_CATEGORY && !knownIds.has(id))
    .sort(([a], [b]) => a.localeCompare(b, 'zh'))
    .map(([id, count]) => ({ id, label: id, count }))
  const unclassified = counts.get(UNCLASSIFIED_CATEGORY)
  return [...known, ...other, ...(unclassified ? [{ id: UNCLASSIFIED_CATEGORY, label: t('classification.categoryEmpty'), count: unclassified }] : [])]
})
const categoryTabs = computed(() => [
  { id: '', label: t('library.categoryAll'), count: allBooks.value.length },
  ...availableCategories.value,
])
const categoryLabel = (id: string) => categoryTabs.value.find(category => category.id === id)?.label ?? id

function selectCategory(id: string) {
  if (categoryFilter.value === id) return
  batchFilterCommit(() => { categoryFilter.value = id })
  if (filterDraft.value) filterDraft.value.category = id
}

watch([availableCategories, restoringSession], () => {
  if (!library.loaded || restoringSession.value) return
  const available = new Set(availableCategories.value.map(category => category.id))
  if (categoryFilter.value && !available.has(categoryFilter.value)) categoryFilter.value = ''
  if (filterDraft.value?.category && !available.has(filterDraft.value.category)) filterDraft.value.category = ''
})
watch([categoryFilter, availableCategories], async () => {
  await nextTick()
  categoryNav.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
}, { flush: 'post' })

const allTags = computed(() => {
  const tags = new Set<string>()
  for (const book of allBooks.value) {
    for (const tag of book.tags || []) {
      if (!categoryLabels.has(tag)) tags.add(tag)
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh'))
})

const queryOptions = computed<LibraryQueryOptions>(() => ({
  search: keyword.value,
  tags: tagFilter.value,
  tagMode: tagMode.value,
  category: categoryFilter.value || undefined,
  classificationStatus: classificationStatusFilter.value || undefined,
  audience: audienceFilter.value || undefined,
  textbook: textbookFilter.value || undefined,
  ancientText: ancientTextFilter.value || undefined,
  workCountry: workCountryFilter.value || undefined,
  workPeriod: workPeriodFilter.value || undefined,
  formats: formatFilter.value ? [formatFilter.value] : [],
  languages: languageFilter.value ? [languageFilter.value] : [],
  statuses: statusFilter.value ? [statusFilter.value] : undefined,
  availability: availabilityFilter.value,
  sortBy: sortBy.value === 'recent' ? 'lastRead' : sortBy.value === 'added' ? 'addedAt' : sortBy.value === 'published' ? 'publicationDate' : sortBy.value,
  pinnedFirst: true,
  page: page.value,
  pageSize: pageSize.value,
}))

watch([queryOptions, page, pageSize], saveCurrentSession, { flush: 'post' })

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

let isBatchUpdatingFilters = false
function batchFilterCommit(action: () => void) {
  isBatchUpdatingFilters = true
  try {
    action()
  } finally {
    isBatchUpdatingFilters = false
  }
  if (!restoringSession.value) {
    onFilterChange()
  }
}

function onFilterChange() {
  orderedBookIds.value = []
  if (page.value !== 1) page.value = 1
  if (selectedIds.value.size > 0) selectedIds.value = new Set()
  rememberResultOrder()
}

watch([keyword, tagFilter, tagMode, formatFilter, languageFilter, statusFilter, availabilityFilter, categoryFilter, classificationStatusFilter, audienceFilter, textbookFilter, ancientTextFilter, workCountryFilter, workPeriodFilter, sortBy, pageSize], () => {
  if (restoringSession.value || isBatchUpdatingFilters) return
  onFilterChange()
}, { flush: 'sync' })

watch(() => query.value.page, value => {
  if (!restoringSession.value && page.value !== value) page.value = value
})

watch(() => library.books.map(book => book.id), ids => {
  const existing = new Set(ids)
  selectedIds.value = new Set([...selectedIds.value].filter(id => existing.has(id)))
  if (restoringSession.value) return
  const matching = queryLibraryBooks(allBooks.value, {
    ...queryOptions.value, page: 1, pageSize: Number.MAX_SAFE_INTEGER,
  }).items.map(book => book.id)
  if (sortBy.value === 'published') {
    orderedBookIds.value = matching
    return
  }
  const matches = new Set(matching)
  const remembered = new Set(orderedBookIds.value)
  orderedBookIds.value = [
    ...orderedBookIds.value.filter(id => matches.has(id)),
    ...matching.filter(id => !remembered.has(id)),
  ]
}, { flush: 'sync' })

const hasActiveChips = computed(() => {
  return !!keyword.value.trim() || !!tagFilter.value.length || !!formatFilter.value || !!languageFilter.value || !!statusFilter.value || !!availabilityFilter.value
    || !!categoryFilter.value || !!classificationStatusFilter.value || !!audienceFilter.value || !!textbookFilter.value || !!ancientTextFilter.value || !!workCountryFilter.value || !!workPeriodFilter.value
})

const lastReadingBook = computed(() =>
  hasActiveChips.value ? undefined : [...allBooks.value].filter(book => !!book.lastReadAt).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0])

const topicTags = computed(() => [...new Set(allBooks.value.flatMap(book => book.classification?.topics.map(tag => tag.value) ?? []))].sort())
const secondaryTags = computed(() => allTags.value.filter(tag => !topicTags.value.includes(tag)))
const filterTags = computed(() => topicTags.value.filter(tag => tag.toLowerCase().includes(filterTagQuery.value.toLowerCase())))
const visibleFilterTags = computed(() => filterTags.value.slice((filterTagPage.value - 1) * 24, filterTagPage.value * 24))
watch(filterTagQuery, () => { filterTagPage.value = 1 })

const filterPreviewCount = computed(() => {
  const draft = filterDraft.value
  return draft
    ? queryLibraryBooks(allBooks.value, {
        ...queryOptions.value,
        tags: draft.tags,
        tagMode: draft.tagMode,
        category: draft.category,
        classificationStatus: draft.classificationStatus || undefined,
        audience: draft.audience,
        textbook: draft.textbook,
        ancientText: draft.ancientText,
        workCountry: draft.workCountry,
        workPeriod: draft.workPeriod,
        formats: draft.format ? [draft.format] : [],
        languages: draft.language ? [draft.language] : [],
        statuses: draft.status ? [draft.status] : [],
        availability: draft.availability,
      }).total
    : query.value.total
})

async function openAdvancedFilter() {
  if (filterDraft.value) { closeAdvancedFilter(); return }
  filterDraft.value = createFilterDraft({
    tagFilter: tagFilter.value,
    tagMode: tagMode.value,
    formatFilter: formatFilter.value,
    languageFilter: languageFilter.value,
    statusFilter: statusFilter.value,
    availabilityFilter: availabilityFilter.value,
    categoryFilter: categoryFilter.value,
    classificationStatusFilter: classificationStatusFilter.value,
    audienceFilter: audienceFilter.value,
    textbookFilter: textbookFilter.value,
    ancientTextFilter: ancientTextFilter.value,
    workCountryFilter: workCountryFilter.value,
    workPeriodFilter: workPeriodFilter.value,
    sortBy: sortBy.value,
  })
  filterTagQuery.value = ''
  filterTagPage.value = 1
  await nextTick()
  filterPanel.value?.querySelector<HTMLElement>('select, input')?.focus()
}

function closeAdvancedFilter() {
  filterDraft.value = null
}

function applyAdvancedFilter() {
  if (!filterDraft.value) return
  const committed = commitFilterDraft(filterDraft.value)
  batchFilterCommit(() => {
    tagFilter.value = committed.tagFilter
    tagMode.value = committed.tagMode
    formatFilter.value = committed.formatFilter
    languageFilter.value = committed.languageFilter
    statusFilter.value = committed.statusFilter
    availabilityFilter.value = committed.availabilityFilter
    categoryFilter.value = committed.categoryFilter
    classificationStatusFilter.value = committed.classificationStatusFilter
    audienceFilter.value = committed.audienceFilter
    textbookFilter.value = committed.textbookFilter
    ancientTextFilter.value = committed.ancientTextFilter
    workCountryFilter.value = committed.workCountryFilter
    workPeriodFilter.value = committed.workPeriodFilter
    sortBy.value = committed.sortBy
  })
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
      availability: '',
      category: '',
      classificationStatus: '',
      audience: '',
      textbook: '',
      ancientText: '',
      workCountry: '',
      workPeriod: '',
      sortBy: 'added',
    })
  }
}

function toggleTag(tag: string) {
  tagFilter.value = tagFilter.value.includes(tag)
    ? tagFilter.value.filter(value => value !== tag)
    : [...tagFilter.value, tag]
}

function clearFilters() {
  batchFilterCommit(() => {
    keyword.value = ''
    tagFilter.value = []
    formatFilter.value = ''
    languageFilter.value = ''
    statusFilter.value = ''
    availabilityFilter.value = ''
    categoryFilter.value = ''
    classificationStatusFilter.value = ''
    audienceFilter.value = ''
    textbookFilter.value = ''
    ancientTextFilter.value = ''
    workCountryFilter.value = ''
    workPeriodFilter.value = ''
  })
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
  if (!tags.length) return
  const books = library.books.filter(book => selectedIds.value.has(book.id))
  if (books.some(book => book.classification)) {
    toast('自由标签仅可批量添加到未分类书籍；请在详情页编辑已有分类。', 'info')
    return
  }
  try {
    const storage = await getStorage()
    await storage.updateBookClassifications([], books.map(book => ({
      id: book.id, expectedTags: book.tags, tags: [...new Set([...book.tags, ...tags])],
    })))
    showTagModal.value = false
    tagDraft.value = ''
    await library.refresh()
    toast(t('library.tagsAdded', { count: books.length }), 'success')
  } catch (err: any) {
    toast(err?.message || t('common.saveFailed'), 'error')
  }
}

async function togglePin(book: BookMeta) {
  const storage = await (await import('../storage')).getStorage()
  const pinnedAt = book.pinnedAt ? 0 : Date.now()
  await storage.updateBook(book.id, { pinnedAt })
  book.pinnedAt = pinnedAt || undefined
  orderedBookIds.value = []
  rememberResultOrder()
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
  orderedBookIds.value = []
  rememberResultOrder()
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

function showUnavailable() {
  if (!unavailableReturn.value) {
    saveCurrentSession()
    unavailableReturn.value = loadLibrarySession() ?? undefined
  }
  batchFilterCommit(() => {
    keyword.value = ''
    tagFilter.value = []
    formatFilter.value = ''
    languageFilter.value = ''
    statusFilter.value = ''
    categoryFilter.value = ''
    classificationStatusFilter.value = ''
    audienceFilter.value = ''
    textbookFilter.value = ''
    ancientTextFilter.value = ''
    workCountryFilter.value = ''
    workPeriodFilter.value = ''
    availabilityFilter.value = 'unavailable'
  })
  closeAdvancedFilter()
}

async function restoreUnavailableFilters() {
  const previous = unavailableReturn.value
  if (!previous) return
  restoringSession.value = true
  restoreSession(previous)
  unavailableReturn.value = undefined
  restoringSession.value = false
  saveCurrentSession()
  await nextTick()
  if (lastViewedBookId.value) document.getElementById(`book-card-${lastViewedBookId.value}`)?.scrollIntoView({ block: 'nearest' })
}

function jumpToPage() {
  if (!Number.isInteger(pageJump.value) || !pageJump.value) return
  page.value = Math.max(1, Math.min(query.value.totalPages, pageJump.value))
  pageJump.value = undefined
}

function openReader(book: BookMeta) {
  rememberResultOrder()
  lastViewedBookId.value = book.id
  saveCurrentSession()
  const problem = bookFileProblem(book)
  router.push(problem === 'permission-denied' ? '/settings?section=folder'
    : problem ? `/book/${book.id}?recover=1` : readerPath(book))
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

async function clearSelectedTags() {
  if (!confirm('清空所选书籍的分类标签（含锁定标签）？历史标签保留，书籍源文件不变。')) return
  try {
    const storage = await getStorage()
    await clearBookClassifications(storage, [...selectedIds.value])
    showTagModal.value = false
    await library.refresh()
    toast(t('library.tagsCleared'), 'success')
  } catch (err: any) {
    toast(err?.message || t('common.saveFailed'), 'error')
  }
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
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="published">{{ t('library.sortPublished') }}</option>
        <option value="title">{{ t('library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
        <option value="progress">{{ t('library.sortProgress') }}</option>
      </select>
      <button v-if="allBooks.length" class="btn" :class="{ 'btn-primary': manageMode }" :aria-pressed="manageMode" @click="toggleManage">
        {{ manageMode ? t('common.done') : t('library.manage') }}
      </button>
      <span class="row-break" aria-hidden="true" />
    </header>

    <!-- 首次扫描时库里还没有任何记录: 明确告知正在扫描, 而不是显示“空书库”。 -->
    <section v-if="scanning && !allBooks.length" class="library-notice" role="status" aria-live="polite">
      <span>{{ t('folder.status.scanning') }}<template v-if="folderStatus.indexed"> · {{ t('folder.indexedCount', { n: folderStatus.indexed }) }}</template></span>
    </section>

    <section v-if="unavailableCount || hasFolderIssue" class="library-notice" role="status">
      <span>{{ folderIssueMessage }}</span>
      <button v-if="unavailableCount && !hasFolderIssue" type="button" class="btn" @click="showUnavailable">{{ t('library.viewUnavailable') }}</button>
      <RouterLink v-if="hasFolderIssue" class="btn" to="/settings?section=folder">{{ t('library.folderSettings') }}</RouterLink>
    </section>

    <div v-if="allBooks.length" class="category-toolbar">
      <button type="button" class="btn open-filter" :aria-expanded="!!filterDraft" aria-controls="library-filters" @click="openAdvancedFilter">{{ t('library.filters') }}{{ hasActiveChips ? ' · ' + query.total : '' }}</button>
      <nav ref="categoryNav" class="category-tabs" :aria-label="t('library.categoryNavigation')">
        <button v-for="category in categoryTabs" :key="category.id" type="button"
          class="btn category-tab" :class="{ 'category-active': categoryFilter === category.id }"
          :data-category="category.id" :aria-pressed="categoryFilter === category.id"
          @click="selectCategory(category.id)">
          <span>{{ category.label }}</span><span class="category-count">{{ category.count }}</span>
        </button>
      </nav>
    </div>

    <section v-if="lastReadingBook && !manageMode" class="resume-card" :aria-label="t('catalog.continueReading')">
      <strong>{{ lastReadingBook.title }}</strong>
      <span>{{ Math.round((lastReadingBook.progress ?? 0) * 100) }}%</span>
      <button type="button" class="btn btn-primary" @click="openReader(lastReadingBook)">{{ bookFileProblem(lastReadingBook) ? t(bookFileProblem(lastReadingBook) === 'missing' ? 'library.relink' : 'library.reauthorize') : t('catalog.continueReading') }}</button>
    </section>

    <section v-if="allBooks.length" class="library-filters" :aria-label="t('library.filters')">
      <div v-if="unavailableReturn" class="filter-toolbar">
        <button type="button" class="btn" @click="restoreUnavailableFilters">{{ t('library.restoreFilters') }}</button>
      </div>
      <div v-if="filterDraft" id="library-filters" ref="filterPanel" class="filter-panel">
        <fieldset>
          <legend>{{ t('library.primaryCategory') }}</legend>
          <select v-model="filterDraft.category" class="input" :aria-label="t('classification.category')"><option value="">{{ t('library.allCategories') }}</option><option v-for="cat in availableCategories" :key="cat.id" :value="cat.id">{{ cat.label }}</option></select>
        </fieldset>
        <fieldset class="topic-group">
          <legend>{{ t('library.topicTags') }}</legend>
          <div class="topic-tools">
            <input v-model="filterTagQuery" class="input" :placeholder="t('uiV02.searchCategories')" :aria-label="t('uiV02.searchCategories')">
            <select v-model="filterDraft.tagMode" class="input" :aria-label="t('library.tagMode')"><option value="and">{{ t('library.allTopics') }}</option><option value="or">{{ t('library.anyTopic') }}</option></select>
          </div>
          <div class="filter-topics"><label v-for="tag in visibleFilterTags" :key="tag"><input v-model="filterDraft.tags" type="checkbox" :value="tag">{{ tag }} <span>{{ allBooks.filter(book => book.tags.includes(tag)).length }}</span></label></div>
          <div v-if="filterTags.length > 24" class="filter-topic-pages"><button class="btn" :disabled="filterTagPage <= 1" @click="filterTagPage--">{{ t('common.prev') }}</button><span>{{ filterTagPage }} / {{ Math.ceil(filterTags.length / 24) }}</span><button class="btn" :disabled="filterTagPage * 24 >= filterTags.length" @click="filterTagPage++">{{ t('common.next') }}</button></div>
        </fieldset>
        <fieldset>
          <legend>{{ t('library.readingState') }} / {{ t('library.fileState') }}</legend>
          <label>{{ t('uiV02.readingStatus') }}<select v-model="filterDraft.status" class="input" :aria-label="t('uiV02.readingStatus')"><option value="">{{ t('uiV02.allStatuses') }}</option><option v-for="status in READING_STATUSES" :key="status" :value="status">{{ t('uiV02.status.' + status) }}</option></select></label>
          <label>{{ t('library.fileState') }}<select v-model="filterDraft.availability" class="input" :aria-label="t('library.fileState')"><option value="">{{ t('library.allFileStates') }}</option><option value="available">{{ t('library.availableOnly') }}</option><option value="unavailable">{{ t('library.unavailableOnly') }}</option><option value="missing">{{ t('library.fileMissing') }}</option><option value="permission-denied">{{ t('library.filePermission') }}</option></select></label>
        </fieldset>
        <fieldset><legend>{{ t('library.filterLanguage') }}</legend><label>{{ t('library.filterLanguage') }}<select v-model="filterDraft.language" class="input" :aria-label="t('library.filterLanguage')"><option value="">{{ t('library.allLanguages') }}</option><option v-for="language in languages" :key="language" :value="language">{{ language }}</option></select></label></fieldset>
        <fieldset><legend>{{ t('library.filterFormat') }}</legend><label>{{ t('library.filterFormat') }}<select v-model="filterDraft.format" class="input" :aria-label="t('library.filterFormat')"><option value="">{{ t('library.allFormats') }}</option><option v-for="format in formats" :key="format" :value="format">{{ FORMAT_LABELS[format] || format }}</option></select></label></fieldset>
        <details class="more-filters">
          <summary>{{ t('library.moreConditions') }}</summary>
          <div class="advanced-fields"><label>{{ t('classification.status') }}<select v-model="filterDraft.classificationStatus" class="input" :aria-label="t('classification.status')"><option value="">{{ t('common.all') }}</option><option value="complete">{{ t('classification.statusComplete') }}</option><option value="incomplete">{{ t('classification.statusIncomplete') }}</option><option value="unclassified">{{ t('classification.statusUnclassified') }}</option></select></label>
<label>{{ t('classification.audience') }}<input v-model="filterDraft.audience" class="input" :placeholder="t('classification.audiencePlaceholder')" :aria-label="t('classification.audience')" /></label>
<label>{{ t('classification.textbook') }}<select v-model="filterDraft.textbook" class="input" :aria-label="t('classification.textbook')"><option value="">{{ t('classification.facetAny') }}</option><option value="true">{{ t('classification.textbookYes') }}</option><option value="false">{{ t('classification.textbookNo') }}</option><option value="unknown">{{ t('classification.facetUnknown') }}</option></select></label>
<label>{{ t('classification.ancientText') }}<select v-model="filterDraft.ancientText" class="input" :aria-label="t('classification.ancientText')"><option value="">{{ t('classification.facetAny') }}</option><option value="true">{{ t('classification.ancientYes') }}</option><option value="false">{{ t('classification.ancientNo') }}</option><option value="unknown">{{ t('classification.facetUnknown') }}</option></select></label>
<label>{{ t('classification.workCountry') }}<input v-model="filterDraft.workCountry" class="input" :placeholder="t('classification.countryPlaceholder')" :aria-label="t('classification.workCountry')" /></label>
<label>{{ t('classification.workPeriod') }}<input v-model="filterDraft.workPeriod" class="input" :placeholder="t('classification.periodPlaceholder')" :aria-label="t('classification.workPeriod')" /></label></div>
          <div v-if="secondaryTags.length" class="filter-topics"><label v-for="tag in secondaryTags" :key="tag"><input v-model="filterDraft.tags" type="checkbox" :value="tag">{{ tag }}</label></div>
        </details>
        <footer><button type="button" class="btn" @click="closeAdvancedFilter">{{ t('common.cancel') }}</button><button type="button" class="btn" @click="resetFilterDraft">{{ t('uiV02.resetDraft') }}</button><button type="button" class="btn btn-primary apply-filter" @click="applyAdvancedFilter">{{ t('uiV02.applyFilter', { count: filterPreviewCount }) }}</button></footer>
      </div>
    </section>

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
      <span v-if="availabilityFilter" class="chip">
        {{ t('library.fileState') }}: {{ t(availabilityFilter === 'available' ? 'library.availableOnly' : availabilityFilter === 'missing' ? 'library.fileMissing' : availabilityFilter === 'permission-denied' ? 'library.filePermission' : 'library.unavailableOnly') }}
        <button type="button" class="chip-remove" :aria-label="t('common.clear')" @click="availabilityFilter = ''">×</button>
      </span>
      <span v-if="statusFilter" class="chip">
        {{ t("uiV02.copy.状态:") }} {{ t('uiV02.status.' + statusFilter) }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除状态筛选')" @click="statusFilter = ''">×</button>
      </span>
      <span v-if="categoryFilter" class="chip">
        {{ t('classification.category') }}: {{ categoryLabel(categoryFilter) }}
        <button type="button" class="chip-remove" aria-label="清除类别筛选" @click="categoryFilter = ''">×</button>
      </span>
      <span v-if="classificationStatusFilter" class="chip">
        {{ t('classification.status') }}: {{ classificationStatusFilter === 'complete' ? t('classification.statusComplete') : classificationStatusFilter === 'incomplete' ? t('classification.statusIncomplete') : t('classification.statusUnclassified') }}
        <button type="button" class="chip-remove" aria-label="清除分类状态筛选" @click="classificationStatusFilter = ''">×</button>
      </span>
      <span v-if="audienceFilter" class="chip">
        {{ t('classification.audience') }}: {{ audienceFilter }}
        <button type="button" class="chip-remove" aria-label="清除受众筛选" @click="audienceFilter = ''">×</button>
      </span>
      <span v-if="textbookFilter" class="chip">
        {{ t('classification.textbook') }}: {{ textbookFilter === 'true' ? t('classification.textbookYes') : textbookFilter === 'false' ? t('classification.textbookNo') : t('classification.facetUnknown') }}
        <button type="button" class="chip-remove" aria-label="清除教材筛选" @click="textbookFilter = ''">×</button>
      </span>
      <span v-if="ancientTextFilter" class="chip">
        {{ t('classification.ancientText') }}: {{ ancientTextFilter === 'true' ? t('classification.ancientYes') : ancientTextFilter === 'false' ? t('classification.ancientNo') : t('classification.facetUnknown') }}
        <button type="button" class="chip-remove" aria-label="清除古籍筛选" @click="ancientTextFilter = ''">×</button>
      </span>
      <span v-if="workCountryFilter" class="chip">
        {{ t('classification.workCountry') }}: {{ workCountryFilter }}
        <button type="button" class="chip-remove" aria-label="清除原作国别筛选" @click="workCountryFilter = ''">×</button>
      </span>
      <span v-if="workPeriodFilter" class="chip">
        {{ t('classification.workPeriod') }}: {{ workPeriodFilter }}
        <button type="button" class="chip-remove" aria-label="清除创作年代筛选" @click="workPeriodFilter = ''">×</button>
      </span>
      <button type="button" class="btn btn-sm btn-clear-chips" @click="clearFilters">{{ t("uiV02.copy.清空全部") }}</button>
    </div>

    <!-- 加载骨架屏 (首次扫描完成前不要冒充“空书库”) -->
    <div v-if="!library.loaded || (scanning && !allBooks.length)" class="grid" aria-busy="true" :aria-label="t('library.loading')">
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
        @rescan="onRescan"
      />
    </div>

    <nav v-if="library.loaded && filtered.length" class="pagination" :aria-label="t('library.pageSummary', { total: query.total, page: query.page, pages: query.totalPages })">
      <span role="status">{{ query.totalPages > 1 ? t('library.pageSummary', { total: query.total, page: query.page, pages: query.totalPages }) : t('library.bookCount', { count: query.total }) }}</span>
      <template v-if="query.totalPages > 1">
        <button type="button" class="btn" :disabled="query.page <= 1" @click="page--">{{ t('library.previousPage') }}</button>
        <button type="button" class="btn" :disabled="query.page >= query.totalPages" @click="page++">{{ t('library.nextPage') }}</button>
        <form class="page-jump" @submit.prevent="jumpToPage">
          <input v-model.number="pageJump" class="input" type="number" min="1" :max="query.totalPages" :aria-label="t('library.jumpPage')">
          <button type="submit" class="btn">{{ t('library.goPage') }}</button>
        </form>
      </template>
      <RouterLink to="/settings?section=library-display">{{ t('library.displaySettings') }}</RouterLink>
    </nav>
    <div v-if="library.loaded && filtered.length" class="colophon-tailpiece" aria-hidden="true">
      <span>──────  ◇  ──────</span>
      <span>EX LIBRIS CATALOG · {{ query.total }}</span>
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
        <option v-for="status in READING_STATUSES" :key="status" :value="status">{{ t('uiV02.status.' + status) }}</option>
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
  font-family: var(--font-serif);
  font-size: 24px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
  letter-spacing: -0.01em;
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
  width: 148px;
  min-height: 48px;
}
.category-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-bottom: 12px;
}
.category-toolbar > .open-filter {
  flex: 0 0 auto;
  white-space: nowrap;
}
.category-tabs {
  display: flex;
  flex: 1;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: 4px;
  scrollbar-width: thin;
}
.category-tab {
  flex: 0 0 auto;
  white-space: nowrap;
  transition: none;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--card);
}
.category-tab.category-active {
  color: var(--card);
  background: var(--eink-ink);
  border-color: var(--eink-ink);
  font-weight: 700;
}
.category-tab:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}
.category-count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.btn {
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.library-notice, .filter-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.library-notice { padding: 8px 12px; border: 1px solid var(--text); }
.library-notice > span { flex: 1; min-width: 160px; font-weight: 600; }
.library-filters { margin-bottom: 12px; }
.filter-panel { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding: 16px; border: 1px solid var(--text); background: var(--card); }
.filter-panel fieldset { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--border); }
.filter-panel legend { padding: 0 6px; font-weight: 700; }
.filter-panel label { display: grid; gap: 6px; margin-bottom: 8px; }
.filter-panel .input { width: 100%; min-width: 0; }
.topic-group, .more-filters, .filter-panel footer { grid-column: 1 / -1; }
.topic-tools, .filter-topic-pages, .filter-panel footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.topic-tools > .input { flex: 1; min-width: 140px; }
.filter-topics { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; }
.filter-topics label { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: 0; }
.filter-topics input, .more-filters input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--text); }
.filter-topics label:has(input:checked) { font-weight: 700; text-decoration: underline; text-underline-offset: 5px; }
.more-filters summary { cursor: pointer; padding-block: 12px; font-weight: 600; }
.advanced-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.filter-panel footer { justify-content: flex-end; }
.resume-card { display: flex; align-items: center; gap: 12px; padding: 6px 0; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
.resume-card strong { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resume-card > span { white-space: nowrap; }
.page-jump { display: flex; gap: 6px; }
.page-jump .input { width: 76px; min-height: 44px; }
@media (max-width: 600px) { .filter-panel, .advanced-fields { grid-template-columns: 1fr; } .filter-panel { padding: 10px; } }

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
  padding: 3px 8px;
  border-radius: 2px;
  background: var(--eink-surface-pure);
  border: 1px solid var(--eink-border-hairline);
  font-size: 12px;
  color: var(--eink-text-primary);
}
.chip-remove {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-3);
}
/* 网格与卡片 */
.grid {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.empty {
  padding: 56px 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  border: 1px dashed var(--eink-border-hairline);
  background: var(--card);
}
.empty-icon {
  color: var(--text-3);
}
.empty-title {
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 700;
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
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--eink-border-hairline);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
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
  border: 1.5px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: none;
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
  background: var(--eink-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--eink-surface-pure);
  border-radius: 2px;
  border: 2px solid var(--eink-solid-black);
  padding: 24px;
  width: 90%;
  max-width: 440px;
  box-shadow: none;
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
@media (max-width: 720px) {
  .library {
    padding: 14px 12px calc(48px + var(--lr-safe-bottom));
  }
  .toolbar { flex-direction: row; align-items: center; }
  .heading, .search-field { flex: 1 1 100%; }
  .toolbar .spacer { display: none; }
  .toolbar .sort { flex: 1; width: auto; }
  .search {
    width: 100%;
  }
  .row-break {
    display: none;
  }
}
</style>
