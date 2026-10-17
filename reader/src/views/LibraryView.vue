<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { importFiles, type LazyImportFile } from '../services/importer'
import { IMPORT_FORMATS, planFolderPick, type FolderPlan } from '../services/folderPick'
import { canPickFolder, loadFolderFile, scanFromFileList, scanNativeFolder, useNativeFolderPicker, type FolderFile, type FolderScan } from '../services/folderSource'
import { ACCEPT, SUPPORTED_EXTS, FORMAT_LABELS, canConvertToEpub, isSupportedBookFormat } from '../services/format'
import { queryLibraryBooks, type LibraryQueryOptions } from '../services/libraryQuery'
import type { CoverUrlLease } from '../services/coverUrlCache'
import { acquireLibraryCover } from '../services/libraryCovers'
import { toast } from '../services/toast'
import { formatReadingTime } from '../composables/useReadingTimer'
import { readerPath } from '../services/readerRoute'
import { loadDaily, localDay, onReadingLogChange } from '../services/readingLog'
import BookCard from '../components/BookCard.vue'
import FolderPickDialog from '../components/FolderPickDialog.vue'
import BooklistWantedPanel from '../components/BooklistWantedPanel.vue'
import BooklistShareDialog from '../components/BooklistShareDialog.vue'
import BooklistImportDialog from '../components/BooklistImportDialog.vue'
import type { BookMeta } from '../storage'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
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
const route = useRoute()
const library = useLibrary()

/** /papers 路由复用本视图, 只显示论文 */
const paperMode = computed(() => route.meta.kind === 'paper')
const pageKind = computed<'book' | 'paper'>(() => (paperMode.value ? 'paper' : 'book'))

// 路由切换 (藏书 ↔ 论文) 时重置筛选与选择状态
watch(paperMode, () => {
  manageMode.value = false
  selectedIds.value = new Set()
  tagFilter.value = []
  activeBooklistId.value = ''
  keyword.value = ''
})

const keyword = ref('')
const sortBy = ref<LibrarySortBy>('recent')
const statusFilter = ref<ReadingStatus | ''>('')
const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)
const importing = ref(false)
const importState = ref({ done: 0, total: 0, current: '' })
// 转换为 EPUB 后作为新书加入，原书保留。
const converting = ref<{ done: number; total: number; current: string; pct: number } | null>(null)
const convertPercent = computed(() => {
  const c = converting.value
  return c ? Math.round(((c.done + c.pct / 100) / Math.max(c.total, 1)) * 100) : 0
})

async function convertBooks(ids: string[]) {
  if (converting.value) {
    toast(t('convert.busy'))
    return
  }
  const books = ids
    .map(id => library.books.find(book => book.id === id))
    .filter((book): book is BookMeta => !!book)
  const targets = books.filter(book => canConvertToEpub(book.format))
  const skipped = books.length - targets.length
  if (!targets.length) {
    toast(t('convert.noneConvertible'), 'info', 5000)
    return
  }
  converting.value = { done: 0, total: targets.length, current: targets[0].title, pct: 0 }
  const created: Array<{ bookId: string; annotations: number }> = []
  try {
    const { convertLibraryBook, convertErrorText } = await import('../services/convertLibraryBook')
    for (const [index, book] of targets.entries()) {
      converting.value = { done: index, total: targets.length, current: book.title, pct: 0 }
      try {
        created.push(await convertLibraryBook(book.id, p => {
          if (converting.value) converting.value.pct = Math.floor(p.fraction * 100)
        }))
      } catch (error) {
        toast(t('convert.failed', { name: book.title, msg: convertErrorText(error) }), 'error', 8000)
      }
    }
  } catch (error: any) {
    toast(error?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    converting.value = null
    await library.refresh()
  }
  if (created.length === 1 && targets.length === 1) {
    const { bookId, annotations } = created[0]
    toast(t(annotations ? 'convert.successNotes' : 'convert.success'), 'success', 8000, {
      label: t('convert.open'),
      run: () => router.push(readerPath({ id: bookId, format: 'epub' })),
    })
  } else if (created.length) {
    toast(t('convert.successBatch', { count: created.length }), 'success', 5000)
  }
  if (skipped) toast(t('convert.skipped', { count: skipped }), 'info', 5000)
}

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

// 书单
const activeBooklistId = ref('')
const showBooklistCreate = ref(false)
const showBooklistManage = ref(false)
const showBooklistPicker = ref(false)
const booklistDraft = ref('')
const pickerBookIds = ref<string[]>([])
const pickerDraft = ref('')
const booklistRenames = ref<Record<string, string>>({})
const showBooklistShare = ref(false)
const showBooklistImport = ref(false)
/** 当前书单的待找条目 (还不在藏书里的书) */
const activeWanted = computed(() =>
  activeBooklistId.value ? library.booklistWanted[activeBooklistId.value] ?? [] : [])
/** 书单只有待找条目时不显示「空书单」「无结果」 */
const showOnlyWanted = computed(() =>
  !!activeBooklist.value && !!activeWanted.value.length && !keyword.value.trim() && !tagFilter.value.length && !formatFilter.value && !languageFilter.value)
// 书源页「全部加入我的书单」→「查看」: /library?booklist=<id> (路由按 fullPath 重建视图, 不清查询参数)
watch(() => [route.query.booklist, library.loaded] as const, ([id]) => {
  if (typeof id === 'string' && id && !paperMode.value && library.booklists.some(item => item.id === id)) {
    activeBooklistId.value = id
  }
}, { immediate: true })

// 顶部「今日阅读」入口 (藏书模式), 记录变化时实时刷新
const todaySeconds = ref(0)
let stopReadingLog: (() => void) | undefined
async function refreshToday() {
  try {
    const daily = await loadDaily()
    todaySeconds.value = daily[localDay()]?.seconds ?? 0
  } catch {
    todaySeconds.value = 0
  }
}
const todayMinutes = computed(() => Math.floor(todaySeconds.value / 60))
const settings = useSettings()
const goalMinutes = computed(() => Math.max(0, Math.round(settings.dailyGoalMinutes || 0)))
const todayRatio = computed(() => (goalMinutes.value > 0 ? Math.min(1, todaySeconds.value / (goalMinutes.value * 60)) : 0))
const todayDone = computed(() => goalMinutes.value > 0 && todayRatio.value >= 1)
const TODAY_RING_C = 2 * Math.PI * 5.5

onMounted(async () => {
  const session = loadLibrarySession()
  window.addEventListener('keydown', onGlobalKeydown)
  void refreshToday()
  stopReadingLog = onReadingLogChange(() => void refreshToday())
  try {
    await library.refresh()
    if (session) {
      keyword.value = session.keyword
      sortBy.value = session.sortBy
      tagFilter.value = session.tagFilter
      tagMode.value = session.tagMode
      formatFilter.value = session.formatFilter
      languageFilter.value = session.languageFilter
      statusFilter.value = session.statusFilter
      pageSize.value = session.pageSize
      if (!paperMode.value) activeBooklistId.value = session.activeBooklistId
      orderedBookIds.value = session.orderedBookIds ?? []
      lastViewedBookId.value = session.lastViewedBookId
      page.value = session.page
    }
    await nextTick()
    restoringSession.value = false
    page.value = query.value.page
    await nextTick()
    if (session?.lastViewedBookId) document.getElementById(`book-card-${session.lastViewedBookId}`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  } catch { restoringSession.value = false; toast(t('library.loadFailed'), 'error') }
})
onBeforeRouteLeave(() => {
  if (filterDraft.value) { closeAdvancedFilter(); return false }
  saveCurrentSession()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  stopReadingLog?.()
})

/** Esc 逐层关闭: 弹窗 → 导入菜单 → 管理模式 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (filterDraft.value) { closeAdvancedFilter(); e.preventDefault(); return }
  if (showBooklistShare.value || showBooklistImport.value) {
    showBooklistShare.value = false
    showBooklistImport.value = false
    e.preventDefault()
    return
  }
  if (showTagManage.value) showTagManage.value = false
  else if (showTagModal.value) showTagModal.value = false
  else if (showBooklistManage.value) showBooklistManage.value = false
  else if (showBooklistPicker.value) showBooklistPicker.value = false
  else if (showBooklistCreate.value) showBooklistCreate.value = false
  else if (importMenu.value) importMenu.value = false
  else if (manageMode.value) toggleManage()
  else return
  e.preventDefault()
}

const totalReadingTime = computed(() => {
  const total = kindBooks.value.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  return total >= 60 ? formatReadingTime(total) : ''
})

const allTags = computed(() => {
  const tags = new Set<string>()
  for (const book of kindBooks.value) for (const t of book.tags) tags.add(t)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh'))
})

const anyConvertible = computed(() => kindBooks.value.some(book => canConvertToEpub(book.format)))
const kindBooks = computed(() =>
  library.books.filter(b => (b.kind ?? 'book') === pageKind.value))

const activeBooklist = computed(() =>
  library.booklists.find(item => item.id === activeBooklistId.value))

const scopedBooks = computed(() => {
  if (paperMode.value || !activeBooklistId.value) return kindBooks.value
  const ids = new Set(library.booklistBookIds[activeBooklistId.value] ?? [])
  return kindBooks.value.filter(book => ids.has(book.id))
})
const queryOptions = computed<LibraryQueryOptions>(() => ({
  search: keyword.value, tags: tagFilter.value, tagMode: tagMode.value,
  formats: formatFilter.value ? [formatFilter.value] : [],
  languages: languageFilter.value ? [languageFilter.value] : [],
  statuses: statusFilter.value ? [statusFilter.value] : undefined,
  sortBy: sortBy.value === 'recent' ? 'lastRead' : sortBy.value === 'added' ? 'addedAt' : sortBy.value,
  pinnedFirst: true, page: page.value, pageSize: pageSize.value,
}))
const query = computed(() => queryLibrarySession(scopedBooks.value, queryOptions.value, orderedBookIds.value))
const filtered = computed(() => query.value.items)
const formats = computed(() => [...new Set(kindBooks.value.map(book => book.format))].sort())
const languages = computed(() => [...new Set(kindBooks.value.map(book => book.language).filter((language): language is string => !!language))].sort())
watch([keyword, tagFilter, tagMode, formatFilter, languageFilter, statusFilter, sortBy, pageSize, activeBooklistId, paperMode], () => {
  if (restoringSession.value) return
  orderedBookIds.value = []
  page.value = 1
  selectedIds.value = new Set()
}, { flush: 'sync' })
watch(() => query.value.page, value => { if (!restoringSession.value) page.value = value })
watch(() => library.books.map(book => book.id), ids => {
  const existing = new Set(ids)
  selectedIds.value = new Set([...selectedIds.value].filter(id => existing.has(id)))
})
const hasActiveChips = computed(() => {
  return !!keyword.value.trim() || !!tagFilter.value.length || !!formatFilter.value || !!languageFilter.value || !!statusFilter.value
})
const lastReadingBook = computed(() => hasActiveChips.value || activeBooklistId.value ? undefined : [...kindBooks.value].filter(book => !!book.lastReadAt).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0])
const filterTags = computed(() => allTags.value.filter(tag => tag.toLowerCase().includes(filterTagQuery.value.toLowerCase())))
const visibleFilterTags = computed(() => filterTags.value.slice((filterTagPage.value - 1) * 24, filterTagPage.value * 24))
watch(filterTagQuery, () => { filterTagPage.value = 1 })
const filterPreviewCount = computed(() => {
  const draft = filterDraft.value
  return draft ? queryLibraryBooks(scopedBooks.value, { ...queryOptions.value, tags: draft.tags, tagMode: draft.tagMode, formats: draft.format ? [draft.format] : [], languages: draft.language ? [draft.language] : [], statuses: draft.status ? [draft.status] : [] }).total : query.value.total
})
async function openAdvancedFilter() {
  filterDraft.value = createFilterDraft({ tagFilter: tagFilter.value, tagMode: tagMode.value, formatFilter: formatFilter.value, languageFilter: languageFilter.value, statusFilter: statusFilter.value, sortBy: sortBy.value })
  filterTagQuery.value = ''
  filterTagPage.value = 1
  await nextTick()
  filterDialog.value?.showModal()
}
function closeAdvancedFilter() { filterDialog.value?.close(); filterDraft.value = null }
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
  if (filterDraft.value) Object.assign(filterDraft.value, { tags: [], tagMode: 'or', format: '', language: '', status: '', sortBy: 'recent' })
}
function refreshResultOrder() { orderedBookIds.value = []; page.value = 1 }
function toggleTag(tag: string) {
  tagFilter.value = tagFilter.value.includes(tag) ? tagFilter.value.filter(value => value !== tag) : [...tagFilter.value, tag]
}
function clearFilters() {
  keyword.value = ''
  tagFilter.value = []
  formatFilter.value = ''
  languageFilter.value = ''
  statusFilter.value = ''
}

// Route changes release leases, not the app pool shared with statistics.
const coverLeases = new Map<string, CoverUrlLease>()
let coversActive = true
watch(() => filtered.value.filter(book => book.hasCover).map(book => book.id), ids => {
  const visible = new Set(ids)
  for (const [id, lease] of coverLeases) {
    if (visible.has(id)) continue
    delete library.coverUrls[id]
    coverLeases.delete(id)
    lease.release()
  }
  for (const id of ids) {
    if (coverLeases.has(id)) continue
    const lease = acquireLibraryCover(id)
    coverLeases.set(id, lease)
    void lease.ready.then(url => {
      if (coversActive && coverLeases.get(id) === lease && url) library.coverUrls[id] = url
    }, () => {
      if (coversActive && coverLeases.get(id) === lease) toast(t('library.coverLoadFailed'), 'error')
    })
  }
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => { coversActive = false })
onUnmounted(() => {
  for (const [id, lease] of coverLeases) {
    delete library.coverUrls[id]
    lease.release()
  }
  coverLeases.clear()
})

async function handleFiles(files: FileList | Array<File | LazyImportFile>) {
  if (!files.length || importing.value) return
  const kind = pageKind.value
  const booklistId = kind === 'book' ? activeBooklistId.value : ''
  importing.value = true
  try {
    const results = await importFiles(files, '本地导入', (done, total, current) => {
      importState.value = { done, total, current }
    }, { kind })
    await library.refresh()
    const ids = results.filter(r => r.ok && r.bookId).map(r => r.bookId!)
    if (booklistId && ids.length) await library.addBooksToBooklist(booklistId, ids)
    if (ids.length) toast(t(kind === 'paper' ? 'library.importPapersSuccess' : 'library.importSuccess', { count: ids.length }), 'success')
    for (const f of results.filter(r => !r.ok)) toast(`${f.fileName}: ${f.error}`, 'error', 5000)
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    importing.value = false
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) handleFiles(input.files)
  input.value = ''
}

// 选择文件夹: 递归找出书, 同一本书多种格式只留最推荐的, 先确认再导入
const folderInput = ref<HTMLInputElement>()
const folderSupported = canPickFolder()
const folderPick = ref<{ scanning: boolean; scan?: FolderScan; plan?: FolderPlan<FolderFile> } | null>(null)

async function chooseFolder() {
  importMenu.value = false
  if (importing.value) return
  if (!useNativeFolderPicker()) { folderInput.value?.click(); return }
  try {
    const scan = await scanNativeFolder(name => { folderPick.value = { scanning: true, scan: { name, entries: [], truncated: false } } })
    if (scan) showFolderPlan(scan); else folderPick.value = null
  } catch (e: any) {
    folderPick.value = null
    toast(t('folder.scanFailed', { msg: e?.message ?? String(e) }), 'error', 6000)
  }
}

function onFolderPick(e: Event) {
  const input = e.target as HTMLInputElement
  const scan = input.files ? scanFromFileList(input.files) : null
  input.value = ''
  if (scan) showFolderPlan(scan)
}

function showFolderPlan(scan: FolderScan) {
  const kind = pageKind.value
  // 藏书里已有同名文件的不再导入 (导入流程本身不做内容去重)
  const existing = library.books.filter(b => (b.kind ?? 'book') === kind).map(b => b.fileName)
  folderPick.value = { scanning: false, scan, plan: planFolderPick(scan.entries, { formats: IMPORT_FORMATS, existingFileNames: existing }) }
}

function confirmFolderImport() {
  const selected = folderPick.value?.plan?.selected ?? []
  folderPick.value = null
  if (selected.length) void handleFiles(selected.map(e => e.file ?? { name: e.name, load: () => loadFolderFile(e) }))
}

function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files)
}

function saveCurrentSession(lastViewedId?: string) {
  if (restoringSession.value) return
  if (lastViewedId) {
    lastViewedBookId.value = lastViewedId
    if (!orderedBookIds.value.length) orderedBookIds.value = queryLibraryBooks(scopedBooks.value, { ...queryOptions.value, page: 1, pageSize: Number.MAX_SAFE_INTEGER }).items.map(book => book.id)
  }
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
    activeBooklistId: activeBooklistId.value,
    lastViewedBookId: lastViewedBookId.value,
    orderedBookIds: orderedBookIds.value,
  })
}

function openDetail(book: BookMeta) {
  saveCurrentSession(book.id)
  router.push(`/book/${book.id}`)
}

function openReader(book: BookMeta) {
  if (!isSupportedBookFormat(book.format)) {
    toast(t('library.retiredFormat'), 'info')
    return
  }
  saveCurrentSession(book.id)
  router.push(readerPath(book))
}

async function removeBook(book: BookMeta) {
  const confirmation = paperMode.value ? 'library.deletePaperConfirm' : 'library.deleteConfirm'
  if (!confirm(t(confirmation, { title: book.title }))) return
  try {
    await library.removeBook(book.id)
    toast(t('library.deleted'), 'success')
  } catch (error: any) {
    toast(t('library.deleteFailed', { msg: error?.message ?? error }), 'error', 6000)
  }
}

// ---- 导入菜单 ----
const importMenu = ref(false)

// ---- 批量管理 ----
function toggleManage() {
  manageMode.value = !manageMode.value
  selectedIds.value = new Set()
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

const pageSelected = computed(() => !!filtered.value.length && filtered.value.every(book => selectedIds.value.has(book.id)))
const isAllMatchingSelected = computed(() => {
  return query.value.total > 0 && selectedIds.value.size >= query.value.total
})
function selectAll() {
  const next = new Set(selectedIds.value)
  for (const book of filtered.value) {
    if (pageSelected.value) next.delete(book.id)
    else next.add(book.id)
  }
  selectedIds.value = next
}
function selectAllMatching() {
  selectedIds.value = new Set(queryLibraryBooks(scopedBooks.value, {
    ...queryOptions.value, page: 1, pageSize: Number.MAX_SAFE_INTEGER,
  }).items.map(book => book.id))
}

async function batchSetStatus(status: ReadingStatus) {
  if (!selectedIds.value.size) return
  const ids = [...selectedIds.value]
  const { succeeded, failed, failedIds } = await library.batchSetReadingStatus(ids, status)
  selectedIds.value = new Set(failedIds)
  if (failed === 0) {
    toast(t("uiV02.copy.\u5DF2\u5C06 {v0} \u672C\u4E66\u6807\u4E3A{v1}", { v0: succeeded, v1: t('uiV02.status.' + (status)) }), 'success')
  } else {
    toast(t("uiV02.copy.\u5DF2\u5C06 {v0} \u672C\u6807\u4E3A{v1}\uFF0C{v2} \u672C\u66F4\u65B0\u5931\u8D25", { v0: succeeded, v1: t('uiV02.status.' + (status)), v2: failed }), 'info')
  }
}

async function batchDelete() {
  const count = selectedIds.value.size
  const confirmation = paperMode.value ? 'library.batchDeletePapersConfirm' : 'library.batchDeleteConfirm'
  if (!count || !confirm(t(confirmation, { count }))) return
  const ids = [...selectedIds.value]
  const { succeeded, failed, failedIds } = await library.batchRemoveBooks(ids)
  selectedIds.value = new Set(failedIds)
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

async function batchMoveKind() {
  const target: 'book' | 'paper' = paperMode.value ? 'book' : 'paper'
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { kind: target })
    book.kind = target
  }
  toast(t(target === 'paper' ? 'library.movedToPapers' : 'library.movedToBooks', { count: selectedIds.value.size }), 'success')
  selectedIds.value = new Set()
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

// ---- 书单 ----
function booklistCount(id: string) {
  const ids = new Set(library.booklistBookIds[id] ?? [])
  return library.books.filter(
    book => (book.kind ?? 'book') === 'book' && ids.has(book.id)).length
}

function isBooklistNameTaken(name: string, ignoreId = '') {
  const normalized = name.trim().toLocaleLowerCase()
  return library.booklists.some(
    item => item.id !== ignoreId && item.name.trim().toLocaleLowerCase() === normalized)
}

function openCreateBooklist() {
  booklistDraft.value = ''
  showBooklistCreate.value = true
}

async function createBooklist() {
  const name = booklistDraft.value.trim()
  if (!name) return
  if (isBooklistNameTaken(name)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  const id = await library.createBooklist(name)
  activeBooklistId.value = id
  showBooklistCreate.value = false
  booklistDraft.value = ''
  toast(t('library.booklistCreated', { name }), 'success')
}

function openBooklistManage() {
  booklistRenames.value = Object.fromEntries(
    library.booklists.map(item => [item.id, item.name]))
  showBooklistManage.value = true
}

async function renameBooklist(id: string) {
  const name = booklistRenames.value[id]?.trim()
  const current = library.booklists.find(item => item.id === id)
  if (!name || !current || name === current.name) return
  if (isBooklistNameTaken(name, id)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  await library.renameBooklist(id, name)
  booklistRenames.value[id] = name
  toast(t('library.booklistRenamed'), 'success')
}

async function deleteBooklist(id: string) {
  const item = library.booklists.find(booklist => booklist.id === id)
  if (!item || !confirm(t('library.deleteBooklistConfirm', { name: item.name }))) return
  await library.deleteBooklist(id)
  if (activeBooklistId.value === id) activeBooklistId.value = ''
  delete booklistRenames.value[id]
  toast(t('library.booklistDeleted'), 'success')
}

function openBooklistPicker(ids: string[]) {
  if (!ids.length) return
  pickerBookIds.value = [...new Set(ids)]
  pickerDraft.value = ''
  showBooklistPicker.value = true
}

async function addPickerBooks(booklistId: string) {
  const item = library.booklists.find(booklist => booklist.id === booklistId)
  if (!item) return
  await library.addBooksToBooklist(booklistId, pickerBookIds.value)
  toast(t('library.addedToBooklist', {
    count: pickerBookIds.value.length,
    name: item.name,
  }), 'success')
  showBooklistPicker.value = false
}

async function createBooklistAndAdd() {
  const name = pickerDraft.value.trim()
  if (!name) return
  if (isBooklistNameTaken(name)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  const id = await library.createBooklist(name)
  await library.addBooksToBooklist(id, pickerBookIds.value)
  toast(t('library.addedToBooklist', {
    count: pickerBookIds.value.length,
    name,
  }), 'success')
  showBooklistPicker.value = false
  pickerDraft.value = ''
}

async function removeSelectedFromBooklist() {
  if (!activeBooklist.value || !selectedIds.value.size) return
  const count = selectedIds.value.size
  await library.removeBooksFromBooklist(
    activeBooklist.value.id, [...selectedIds.value])
  selectedIds.value = new Set()
  toast(t('library.removedFromBooklist', {
    count,
    name: activeBooklist.value.name,
  }), 'success')
}

// ---- 分类 (标签) 管理: 重命名 / 删除 ----
const showTagManage = ref(false)
const tagRenames = ref<Record<string, string>>({})

function openTagManage() {
  tagRenames.value = Object.fromEntries(allTags.value.map(tag => [tag, tag]))
  showTagManage.value = true
}

function tagCount(tag: string) {
  return library.books.filter(b => b.tags.includes(tag)).length
}

async function renameTag(oldName: string) {
  const newName = tagRenames.value[oldName]?.trim()
  if (!newName || newName === oldName) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of library.books) {
    if (!book.tags.includes(oldName)) continue
    const tags = [...new Set(book.tags.map(x => (x === oldName ? newName : x)))]
    await storage.updateBook(book.id, { tags })
    book.tags = tags
  }
  tagFilter.value = tagFilter.value.map(tag => tag === oldName ? newName : tag)
  delete tagRenames.value[oldName]
  tagRenames.value[newName] = newName
  toast(t('library.tagRenamed'), 'success')
}

async function deleteTag(tag: string) {
  if (!confirm(t('library.deleteTagConfirm', { tag }))) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of library.books) {
    if (!book.tags.includes(tag)) continue
    const tags = book.tags.filter(x => x !== tag)
    await storage.updateBook(book.id, { tags })
    book.tags = tags
  }
  tagFilter.value = tagFilter.value.filter(value => value !== tag)
  delete tagRenames.value[tag]
  toast(t('library.tagDeleted'), 'success')
}

async function batchClearTags() {
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
  <div
    class="library"
    :class="{ dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
    @click="importMenu = false"
  >
    <header class="toolbar">
      <div class="heading">
        <h1>{{ paperMode ? t('nav.papers') : t('library.title') }}</h1>
        <span v-if="library.loaded" class="count">
          {{ t(paperMode ? 'library.paperCount' : 'library.bookCount', { count: kindBooks.length }) }}<template v-if="totalReadingTime"> · {{ t('library.totalReading', { time: totalReadingTime }) }}</template>
        </span>
        <router-link
          v-if="!paperMode"
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
          <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 13a1.5 1.5 0 0 1 3 0v5.5a1.5 1.5 0 0 1-3 0V13zm6.5-5a1.5 1.5 0 0 1 3 0v10.5a1.5 1.5 0 0 1-3 0V8zM17 4.5a1.5 1.5 0 0 1 3 0v14a1.5 1.5 0 0 1-3 0v-14z"/></svg>
          <span>{{ goalMinutes > 0 && !todayDone ? t('stats.libraryTodayGoal', { m: todayMinutes, goal: goalMinutes }) : t('stats.libraryToday', { m: todayMinutes }) }}</span>
        </router-link>
      </div>
      <div class="spacer" />
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24a1 1 0 0 1-1.42 1.4l-4.24-4.23A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>
        <input
          v-model="keyword"
          class="input search"
          type="search"
          :placeholder="t(paperMode ? 'library.searchPapersPlaceholder' : 'library.searchPlaceholder')"
          :aria-label="t('common.search')"
          autocomplete="off"
          spellcheck="false"
        />
        <button v-if="keyword" type="button" class="search-clear" :aria-label="t('common.clear')" @click="keyword = ''">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z"/></svg>
        </button>
      </div>
      <select v-model="sortBy" class="input sort" :aria-label="t('common.sortBy')">
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="title">{{ t(paperMode ? 'library.sortPaperTitle' : 'library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
      </select>
      <button v-if="kindBooks.length" class="btn" :class="{ 'btn-primary': manageMode }" :aria-pressed="manageMode" @click="toggleManage">
        {{ manageMode ? t('common.done') : t('library.manage') }}
      </button>
      <div class="import-group">
        <button class="btn btn-primary import-main" :disabled="importing" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t(paperMode ? 'library.importPapers' : 'library.import') }}
        </button>
        <button
          class="btn btn-primary import-caret"
          :title="t('library.moreImport')"
          :aria-label="t('library.moreImport')"
          aria-haspopup="menu"
          :aria-expanded="importMenu"
          @click.stop="importMenu = !importMenu"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42z"/></svg>
        </button>
        <div v-if="importMenu" class="import-menu card" role="menu">
          <button role="menuitem" @click="importMenu = false; fileInput?.click()">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 6a3 3 0 0 1 3-3h3.6a3 3 0 0 1 2.1.9L14.4 5.6a1 1 0 0 0 .7.3H17a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6zm3-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8.9a1 1 0 0 0-1-1h-1.9a3 3 0 0 1-2.1-.9L11.3 5.3a1 1 0 0 0-.7-.3H7z"/></svg>
            {{ t('library.importLocal') }}
          </button>
          <button v-if="folderSupported" role="menuitem" class="import-folder" @click="chooseFolder()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 11h8M8 15h5"/></svg>
            {{ t('folder.choose') }}
          </button>
        </div>
      </div>
      <!-- 手机端换行点: 标题+导入 一行, 搜索+排序+管理 一行 -->
      <span class="row-break" aria-hidden="true" />
      <input ref="fileInput" type="file" multiple :accept="ACCEPT" hidden @change="onPick" />
      <!-- 选文件夹: 不带 multiple, e2e 的 input[type=file][multiple] 仍只指向上面的文件输入框 -->
      <input v-if="folderSupported" ref="folderInput" type="file" webkitdirectory hidden data-folder-input @change="onFolderPick" />
    </header>
    <p class="add-books-hint">{{ t('library.addFormatsHint') }}<span v-if="activeBooklist"> · {{ t('library.addIntoBooklist', { name: activeBooklist.name }) }}</span></p>

    <!-- 书单: 一级内容分组，可与标签和搜索组合筛选 -->
    <details v-if="!paperMode" class="booklist-section" :open="!!activeBooklistId">
      <summary>{{ t('library.booklists') }}</summary>
      <div class="booklist-heading">
        <span>{{ t('library.booklists') }}</span>
        <button class="booklist-text-action" @click="openCreateBooklist">
          <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t('library.newBooklist') }}
        </button>
        <button
          v-if="library.booklists.length"
          class="booklist-text-action"
          @click="openBooklistManage"
        >{{ t('library.manageBooklists') }}</button>
        <button v-if="activeBooklist" class="booklist-text-action" @click="showBooklistShare = true">{{ t('booklist.share') }}</button>
        <button class="booklist-text-action" @click="showBooklistImport = true">{{ t('booklist.import') }}</button>
      </div>
      <div class="booklist-row">
        <button
          class="booklist-chip"
          :class="{ active: !activeBooklistId }"
          @click="activeBooklistId = ''"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z"/></svg>
          <span>{{ t('library.allBooks') }}</span>
          <span class="booklist-count">{{ kindBooks.length }}</span>
        </button>
        <button
          v-for="item in library.booklists"
          :key="item.id"
          class="booklist-chip"
          :class="{ active: activeBooklistId === item.id }"
          @click="activeBooklistId = item.id"
        >
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v15a1 1 0 0 1-1.45.9L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm2 0v14.38l4.55-2.28a1 1 0 0 1 .9 0L17 18.38V5a1 1 0 0 0-1-1H7z"/></svg>
          <span>{{ item.name }}</span>
          <span class="booklist-count">{{ booklistCount(item.id) }}</span>
        </button>
      </div>
    </details>

    <!-- 标签筛选 -->
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
        <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16.9 3.1a2.5 2.5 0 0 1 3.54 0l.46.46a2.5 2.5 0 0 1 0 3.54L9.83 18.17a2 2 0 0 1-.9.52l-3.67 1a1 1 0 0 1-1.23-1.23l1-3.67a2 2 0 0 1 .52-.9L16.9 3.1zm2.12 1.42a.5.5 0 0 0-.7 0l-1.1 1.08 1.17 1.18 1.09-1.1a.5.5 0 0 0 0-.7l-.46-.46zM16.97 8.2 15.8 7.03 7 15.84l-.59 2.16 2.16-.59 8.4-9.2z"/></svg>
        {{ t('library.manageTags') }}
      </button>
    </div>

    <div class="advanced-filter-entry">
      <button type="button" class="btn open-filter" @click="openAdvancedFilter">{{ t('uiV02.filters') }}</button>
      <button v-if="orderedBookIds.length" type="button" class="btn" @click="refreshResultOrder">{{ t('uiV02.refreshOrder') }}</button>
    </div>
    <section v-if="lastReadingBook && !manageMode" class="resume-card">
      <div><strong>{{ lastReadingBook.title }}</strong><p>{{ t('uiV02.resumePosition') }} · {{ Math.round((lastReadingBook.progress ?? 0) * 100) }}%</p></div>
      <button type="button" class="btn btn-primary" @click="openReader(lastReadingBook)">{{ t('catalog.continueReading') }}</button>
    </section>
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
    <!-- 激活的筛选可移除胶囊 (Active removable chips) -->
    <div v-if="hasActiveChips" class="active-chips" role="region" :aria-label="t('uiV02.copy.已应用筛选条件')">
      <span v-if="keyword" class="chip">
        {{ t("uiV02.copy.搜索:") }} {{ keyword }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除搜索关键字')" @click="keyword = ''">×</button>
      </span>
      <span v-for="tag in tagFilter" :key="tag" class="chip">
        {{ t("uiV02.copy.标签:") }} {{ tag }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.\u6E05\u9664\u6807\u7B7E {v0}', { v0: tag })" @click="toggleTag(tag)">×</button>
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
        {{ t("uiV02.copy.状态:") }} {{ t('uiV02.status.' + (statusFilter)) }}
        <button type="button" class="chip-remove" :aria-label="t('uiV02.copy.清除状态筛选')" @click="statusFilter = ''">×</button>
      </span>
      <button type="button" class="btn btn-sm btn-clear-chips" @click="clearFilters">{{ t("uiV02.copy.清空全部") }}</button>
    </div>

    <div v-if="converting" class="import-bar card convert-bar" role="status">
      <div class="import-text">
        {{ converting.total > 1
          ? t('convert.progressBatch', { done: converting.done + 1, total: converting.total, name: converting.current, pct: converting.pct })
          : t('convert.progress', { name: converting.current, pct: converting.pct }) }}
      </div>
      <div class="import-track" role="progressbar" :aria-valuenow="convertPercent" aria-valuemin="0" aria-valuemax="100" :aria-label="t('book.convertToEpub')">
        <div class="import-fill" :style="{ width: `${convertPercent}%` }" />
      </div>
    </div>

    <div v-if="importing" class="import-bar card" role="status" aria-live="polite">
      <div class="import-text">
        {{ t('library.importing', { name: importState.current, done: Math.min(importState.done + 1, importState.total), total: importState.total }) }}
      </div>
      <div class="import-track">
        <div class="import-fill" :style="{ width: `${(importState.done / Math.max(importState.total, 1)) * 100}%` }" />
      </div>
    </div>

    <div v-if="!library.loaded" class="grid" aria-busy="true" :aria-label="t('library.loading')">
      <div v-for="i in 12" :key="i" class="skeleton-card">
        <div class="skeleton skeleton-cover" />
        <div class="skeleton skeleton-line" />
        <div class="skeleton skeleton-line short" />
      </div>
    </div>

    <div v-else-if="!kindBooks.length" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg v-if="paperMode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h5"/></svg>
      </div>
      <p class="empty-title">{{ t(paperMode ? 'library.papersEmptyTitle' : 'library.emptyTitle') }}</p>
      <p class="hint">
        <template v-if="paperMode">{{ t('library.papersEmptyHint') }}</template>
        <template v-else>{{ t('library.emptyHint') }}<br />{{ t('library.supportedFormats', { formats: SUPPORTED_EXTS.join(' / ') }) }}</template>
      </p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t(paperMode ? 'library.importPapers' : 'library.import') }}
        </button>
        <button v-if="folderSupported" class="btn" @click="chooseFolder()">{{ t('folder.choose') }}</button>
      </div>
    </div>

    <div
      v-else-if="activeBooklist && !query.total && !keyword.trim() && !tagFilter.length && !formatFilter && !languageFilter && !activeWanted.length"
      class="empty booklist-empty"
    >
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></svg>
      </div>
      <p class="empty-title">{{ t('library.emptyBooklist') }}</p>
      <p class="hint">{{ t('library.emptyBooklistHint') }}</p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="activeBooklistId = ''; manageMode = true">
          {{ t('library.chooseBooks') }}
        </button>
      </div>
    </div>

    <div v-else-if="!filtered.length && !showOnlyWanted" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </div>
      <p class="empty-title">{{ t('reader.noResults') }}</p>
      <div class="empty-actions">
        <button class="btn" @click="clearFilters">{{ t('common.clear') }}</button>
      </div>
    </div>

    <div v-else-if="filtered.length" class="grid">
      <BookCard
        v-for="book in filtered"
        :id="`book-card-${book.id}`"
        :key="book.id"
        :book="book"
        :cover-url="library.coverUrls[book.id]"
        :selectable="manageMode"
        :selected="selectedIds.has(book.id)"
        :show-booklists="!paperMode"
        :convertible="canConvertToEpub(book.format)"
        :converting="!!converting"
        @open="openDetail(book)"
        @read="openReader(book)"
        @remove="removeBook(book)"
        @toggle-select="toggleSelect(book.id)"
        @toggle-pin="togglePin(book)"
        @add-to-booklist="openBooklistPicker([book.id])"
        @convert="convertBooks([book.id])"
      />
    </div>

    <div v-if="library.loaded" class="pagination">
      <span role="status">{{ t('library.pageSummary', { total: query.total, page: query.page, pages: query.totalPages }) }}</span>
      <label>{{ t('library.pageSize') }}
        <select v-model.number="pageSize" class="input">
          <option :value="12">12</option><option :value="24">24</option>
        </select>
      </label>
      <button class="btn btn-sm" :disabled="query.page <= 1" @click="page--">{{ t('library.previousPage') }}</button>
      <button class="btn btn-sm" :disabled="query.page >= query.totalPages" @click="page++">{{ t('library.nextPage') }}</button>
    </div>

    <!-- 书单里还不在藏书中的书 (待找) -->
    <BooklistWantedPanel
      v-if="activeBooklist && library.loaded && !paperMode"
      :key="activeBooklist.id"
      :booklist-id="activeBooklist.id"
      :keyword="keyword"
    />

    <!-- 批量操作栏 -->
    <div v-if="manageMode" class="batch-bar card" role="toolbar" :aria-label="t('library.manage')">
      <span class="batch-count">{{ t('library.selectedCount', { count: selectedIds.size }) }}</span>
      <span v-if="selectedIds.size" class="batch-scope-badge">
        {{ pageSelected ? t("uiV02.copy.\uFF08\u5F53\u524D\u9875\u5168\u90E8\uFF09") : (isAllMatchingSelected ? t("uiV02.copy.\uFF08\u5168\u5339\u914D\u7ED3\u679C\uFF09") : '') }}
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
      <button v-if="anyConvertible" class="btn btn-sm" :disabled="!selectedIds.size || !!converting" @click="convertBooks([...selectedIds])">{{ t('book.convertToEpub') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchMoveKind">
        {{ paperMode ? t('library.moveToBooks') : t('library.moveToPapers') }}
      </button>
      <button
        v-if="!paperMode"
        class="btn btn-sm"
        :disabled="!selectedIds.size"
        @click="openBooklistPicker([...selectedIds])"
      >{{ t('library.addToBooklist') }}</button>
      <button
        v-if="activeBooklist"
        class="btn btn-sm"
        :disabled="!selectedIds.size"
        @click="removeSelectedFromBooklist"
      >{{ t('library.removeFromBooklist') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(true)">{{ t('library.pin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(false)">{{ t('library.unpin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">{{ t('library.setTags') }}</button>
      <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">{{ t('common.delete') }}</button>
      <button class="btn btn-sm" @click="toggleManage">{{ t('common.done') }}</button>
    </div>

    <BooklistShareDialog v-if="showBooklistShare && activeBooklist" :booklist-id="activeBooklist.id" @close="showBooklistShare = false" />
    <BooklistImportDialog v-if="showBooklistImport" @close="showBooklistImport = false" @imported="id => (activeBooklistId = id)" />

    <FolderPickDialog
      v-if="folderPick"
      action="import"
      :scanning="folderPick.scanning"
      :scan="folderPick.scan"
      :plan="folderPick.plan"
      @confirm="confirmFolderImport"
      @cancel="folderPick = null"
    />

    <!-- 新建书单 -->
    <div v-if="showBooklistCreate" class="modal-mask" @click.self="showBooklistCreate = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-create-title">
        <h3 id="booklist-create-title">{{ t('library.newBooklist') }}</h3>
        <p class="modal-description">{{ t('library.booklistCreateHint') }}</p>
        <input
          v-model="booklistDraft"
          class="input"
          :placeholder="t('library.booklistNamePlaceholder')"
          :aria-label="t('library.booklistNamePlaceholder')"
          maxlength="40"
          autofocus
          @keyup.enter="createBooklist"
        />
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistCreate = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!booklistDraft.trim()" @click="createBooklist">
            {{ t('library.createBooklist') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 选择书单 -->
    <div v-if="showBooklistPicker" class="modal-mask" @click.self="showBooklistPicker = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-picker-title">
        <h3 id="booklist-picker-title">{{ t('library.chooseBooklist') }}</h3>
        <p class="modal-description">
          {{ t('library.chooseBooklistHint', { count: pickerBookIds.length }) }}
        </p>
        <div v-if="library.booklists.length" class="booklist-picker-list">
          <button
            v-for="item in library.booklists"
            :key="item.id"
            class="booklist-picker-row"
            @click="addPickerBooks(item.id)"
          >
            <span class="booklist-picker-icon">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v15a1 1 0 0 1-1.45.9L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm2 0v14.38l4.55-2.28a1 1 0 0 1 .9 0L17 18.38V5a1 1 0 0 0-1-1H7z"/></svg>
            </span>
            <span class="booklist-picker-name">{{ item.name }}</span>
            <span class="booklist-picker-count">{{ t('library.booklistBooks', { count: booklistCount(item.id) }) }}</span>
            <span class="booklist-picker-add">{{ t('common.add') }}</span>
          </button>
        </div>
        <div class="booklist-create-inline">
          <div class="inline-label">{{ t('library.createNewBooklist') }}</div>
          <div class="inline-fields">
            <input
              v-model="pickerDraft"
              class="input"
              :placeholder="t('library.booklistNamePlaceholder')"
              maxlength="40"
              @keyup.enter="createBooklistAndAdd"
            />
            <button
              class="btn btn-sm btn-primary"
              :disabled="!pickerDraft.trim()"
              @click="createBooklistAndAdd"
            >{{ t('library.createAndAdd') }}</button>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistPicker = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 管理书单 -->
    <div v-if="showBooklistManage" class="modal-mask" @click.self="showBooklistManage = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-manage-title">
        <div class="modal-title-row">
          <h3 id="booklist-manage-title">{{ t('library.manageBooklists') }}</h3>
          <button class="btn btn-sm" @click="showBooklistManage = false; openCreateBooklist()">
            {{ t('library.newBooklist') }}
          </button>
        </div>
        <p class="modal-description">{{ t('library.manageBooklistsHint') }}</p>
        <div class="booklist-manage-list">
          <div v-for="item in library.booklists" :key="item.id" class="booklist-manage-row">
            <input
              v-model="booklistRenames[item.id]"
              class="input"
              maxlength="40"
              @keyup.enter="renameBooklist(item.id)"
            />
            <span class="booklist-manage-count">
              {{ t('library.booklistBooks', { count: booklistCount(item.id) }) }}
            </span>
            <button
              class="btn btn-sm"
              :disabled="!booklistRenames[item.id]?.trim() || booklistRenames[item.id].trim() === item.name"
              @click="renameBooklist(item.id)"
            >{{ t('common.save') }}</button>
            <button class="btn btn-sm btn-danger" @click="deleteBooklist(item.id)">
              {{ t('common.delete') }}
            </button>
          </div>
          <p v-if="!library.booklists.length" class="tag-manage-empty">
            {{ t('library.noBooklists') }}
          </p>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 批量标签弹窗 -->
    <div v-if="showTagModal" class="modal-mask" @click.self="showTagModal = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
        <h3 id="tag-modal-title">{{ t('library.tagModalTitle', { count: selectedIds.size }) }}</h3>
        <input v-model="tagDraft" class="input full" :placeholder="t('library.tagPlaceholder')" :aria-label="t('library.setTags')" autofocus @keyup.enter="batchTag" />
        <div class="form-actions">
          <button class="btn btn-sm" @click="batchClearTags">{{ t('library.clearTags') }}</button>
          <button class="btn btn-sm" @click="showTagModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">{{ t('common.add') }}</button>
        </div>
      </div>
    </div>

    <!-- 分类管理弹窗 -->
    <div v-if="showTagManage" class="modal-mask" @click.self="showTagManage = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-manage-title">
        <h3 id="tag-manage-title">{{ t('library.manageTags') }}</h3>
        <div class="tag-manage-list">
          <div v-for="tag in allTags" :key="tag" class="tag-manage-row">
            <input v-model="tagRenames[tag]" class="input" :aria-label="tag" @keyup.enter="renameTag(tag)" />
            <span class="tag-book-count">{{ t('library.tagBooks', { count: tagCount(tag) }) }}</span>
            <button
              class="btn btn-sm"
              :disabled="!tagRenames[tag]?.trim() || tagRenames[tag].trim() === tag"
              @click="renameTag(tag)"
            >{{ t('common.save') }}</button>
            <button class="btn btn-sm btn-danger" @click="deleteTag(tag)">{{ t('common.delete') }}</button>
          </div>
          <p v-if="!allTags.length" class="tag-manage-empty">{{ t('library.noTags') }}</p>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showTagManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <div v-if="dragging" class="drop-hint" aria-hidden="true">
      <div class="drop-hint-inner">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        <span>{{ t(paperMode ? 'library.dropHintPapers' : 'library.dropHint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-books-hint { margin: -4px 0 16px; color: var(--text-3); font-size: 12px; line-height: 1.6; }
.query-controls, .pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0; }
.query-controls .input, .pagination .input, .tag-row .input { width: auto; max-width: 100%; }
.pagination label { display: flex; align-items: center; gap: 8px; }
.library {
  min-height: 100%;
  padding: 0 28px calc(40px + var(--lr-safe-bottom));
  position: relative;
}
/* 顶栏吸顶: 长书架滚动时搜索 / 导入随手可及 */
.toolbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 -28px 18px;
  padding: 16px 28px 12px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.toolbar h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.count {
  color: var(--text-3);
  font-size: 13px;
  white-space: nowrap;
}
.today-link {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background var(--dur-fast) var(--ease);
}
.today-link.done {
  background: var(--success-soft);
  color: var(--success);
}
.today-ring {
  transform: rotate(-90deg);
}
.today-ring-track,
.today-ring-fill {
  fill: none;
  stroke-width: 2.5;
}
.today-ring-track {
  stroke: currentColor;
  opacity: 0.25;
}
.today-ring-fill {
  stroke: currentColor;
  stroke-linecap: round;
}
.today-link:hover {
  background: var(--brand-light);
  text-decoration: none;
}
.today-link.done:hover {
  background: color-mix(in srgb, var(--success) 18%, transparent);
}
.today-link:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.spacer {
  flex: 1;
}
.row-break {
  display: none;
}
.search-field {
  position: relative;
  display: flex;
  align-items: center;
  width: 260px;
  max-width: 100%;
}
.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-3);
  pointer-events: none;
}
.search {
  width: 100%;
  padding-left: 32px;
  padding-right: 30px;
}
.search-clear {
  position: absolute;
  right: 4px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  display: grid;
  place-items: center;
}
.search-clear:hover {
  background: var(--surface-2);
  color: var(--text);
}
.sort {
  width: auto;
}
.import-bar {
  padding: 12px 16px;
  margin-bottom: 16px;
}
.import-text {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.import-track {
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
}
.import-fill {
  height: 100%;
  background: var(--brand);
  transition: width 0.2s;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 22px 16px;
}
.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skeleton-cover {
  aspect-ratio: 3 / 4.2;
}
.skeleton-line {
  height: 12px;
  border-radius: 4px;
}
.skeleton-line.short {
  width: 60%;
  height: 10px;
}
.booklist-section {
  margin: -2px 0 16px;
  padding: 12px 14px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--brand-light) 55%, transparent), transparent 52%),
    var(--card);
}
.booklist-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.booklist-text-action {
  border: 0;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
.booklist-heading > span + .booklist-text-action {
  margin-left: auto;
}
.booklist-text-action:hover {
  color: var(--brand);
  background: var(--brand-soft);
}
.booklist-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: none;
}
.booklist-row::-webkit-scrollbar {
  display: none;
}
.booklist-chip {
  flex: 0 0 auto;
  min-width: 112px;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--card) 88%, transparent);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 500;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.booklist-chip:hover {
  border-color: color-mix(in srgb, var(--brand) 46%, var(--border));
  color: var(--text);
}
.booklist-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.booklist-chip.active {
  border-color: color-mix(in srgb, var(--brand) 58%, var(--border));
  background: var(--brand-light);
  color: var(--brand);
}
.booklist-count {
  min-width: 20px;
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-3) 14%, transparent);
  color: currentColor;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.booklist-empty {
  padding-top: 52px;
}
.tag-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.tag-chip {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.tag-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.tag-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.tag-chip.active {
  background: var(--brand-light);
  border-color: var(--brand);
  color: var(--brand);
}
.tag-manage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-style: dashed;
  color: var(--text-3);
}
.tag-manage:hover {
  color: var(--brand);
  border-color: var(--brand);
}
.tag-manage-list {
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.tag-manage-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tag-manage-row .input {
  flex: 1;
  min-width: 0;
  height: var(--control-h-sm);
}
.tag-book-count {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.booklist-modal {
  width: min(560px, 100%);
}
.booklist-modal > .input,
.input.full {
  width: 100%;
}
.modal-description {
  margin: -7px 0 14px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}
.form-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.modal-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}
.modal-title-row h3 {
  margin: 0;
}
.booklist-picker-list,
.booklist-manage-list {
  max-height: 300px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.booklist-picker-row {
  width: 100%;
  min-height: 44px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.booklist-picker-row:hover {
  border-color: var(--brand);
  background: var(--brand-light);
}
.booklist-picker-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.booklist-picker-icon {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--brand-light);
  color: var(--brand);
  display: grid;
  place-items: center;
}
.booklist-picker-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
}
.booklist-picker-count,
.booklist-manage-count {
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
}
.booklist-picker-add {
  color: var(--brand);
  font-size: 12px;
  font-weight: 550;
}
.booklist-create-inline {
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px solid var(--border);
}
.inline-label {
  margin-bottom: 7px;
  color: var(--text-3);
  font-size: 12px;
}
.inline-fields {
  display: flex;
  gap: 8px;
}
.inline-fields .input {
  min-width: 0;
  flex: 1;
}
.booklist-manage-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
}
.booklist-manage-row .input {
  min-width: 0;
  height: var(--control-h-sm);
}
.import-group {
  position: relative;
  display: flex;
}
.import-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.import-caret {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.35);
  padding: 0 8px;
  min-width: 0;
}
.import-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  min-width: 200px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
  animation: menu-in var(--dur) var(--ease);
}
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.import-menu button {
  height: 36px;
  border: none;
  background: none;
  border-radius: 6px;
  text-align: left;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 8px;
}
.import-menu button svg {
  color: var(--text-3);
}
.import-menu button:hover,
.import-menu button:focus-visible {
  background: var(--surface-2);
  color: var(--text);
  outline: none;
}
.tag-manage-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 16px 0;
}
.batch-bar {
  position: sticky;
  bottom: calc(16px + var(--lr-safe-bottom));
  margin-top: 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  box-shadow: var(--shadow-lg);
  z-index: 10;
  animation: menu-in var(--dur) var(--ease);
}
.batch-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  min-width: 70px;
  font-variant-numeric: tabular-nums;
}
.hint {
  font-size: 13px;
  text-align: center;
  line-height: 1.8;
  max-width: 520px;
}
.drop-hint {
  position: absolute;
  inset: 12px;
  z-index: 40;
  border: 2px dashed var(--brand);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--brand) 6%, var(--bg));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand);
  pointer-events: none;
}
.drop-hint-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 17px;
  font-weight: 600;
  padding: 24px 32px;
  border-radius: var(--radius-lg);
  background: var(--card);
  box-shadow: var(--shadow-lg);
}

@media (max-width: 720px) {
  .library {
    padding: 0 16px calc(24px + var(--lr-safe-bottom));
  }
  .toolbar {
    margin: 0 -16px 14px;
    padding: 12px 16px 10px;
    gap: 8px;
  }
  .toolbar h1 {
    font-size: 18px;
  }
  /* 手机端两行: 标题+导入 / 搜索+排序+管理 */
  .heading {
    flex: 1;
    min-width: 0;
    order: 1;
  }
  /* 手机上标题行较挤: 计数行过长时省略, 今日入口保持完整 */
  .count {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .import-group {
    order: 2;
  }
  .spacer {
    display: none;
  }
  .row-break {
    display: block;
    order: 3;
    flex-basis: 100%;
    height: 0;
  }
  .search-field {
    flex: 1;
    width: auto;
    min-width: 0;
    order: 4;
  }
  .sort {
    order: 5;
    flex: none;
    width: 104px;
    min-width: 0;
  }
  .toolbar > .btn {
    order: 6;
    padding-inline: 12px;
  }
  .import-main {
    padding-inline: 12px;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 16px 12px;
  }
  /* 书单在手机上去掉卡片外框, 只留一行可横滑的书单标签 */
  .booklist-section {
    margin: 0 0 14px;
    padding: 0;
    border: 0;
    background: none;
  }
  .booklist-heading {
    margin-bottom: 8px;
  }
  .booklist-row {
    margin-inline: -16px;
    padding-inline: 16px;
  }
  .booklist-chip {
    min-width: 0;
    height: 34px;
    border-radius: var(--radius-pill);
    padding: 0 12px;
  }
  .booklist-manage-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .booklist-manage-count {
    grid-column: 1;
    grid-row: 2;
  }
  .batch-bar {
    bottom: calc(8px + var(--lr-safe-bottom));
    padding: 8px 10px;
  }
  .drop-hint {
    inset: 8px;
  }
}

.active-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 8px 0 14px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
}
.chip-remove {
  background: transparent;
  border: none;
  color: var(--text-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chip-remove:hover {
  color: var(--danger);
}
.btn-clear-chips {
  font-size: 12px;
  padding: 2px 8px;
  height: 24px;
  line-height: 1;
}
.batch-scope-badge {
  font-size: 12px;
  color: var(--brand);
  font-weight: 600;
}
.batch-status-select {
  height: 28px;
  padding: 2px 6px;
  font-size: 12px;
}
.grid { display: flex !important; flex-direction: column; gap: 0 !important; }
.advanced-filter-entry { display: flex; gap: 12px; margin: 12px 0; }
.resume-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0; border-block: 1px solid var(--text); margin: 16px 0; }
.resume-card strong { font-size: 20px; }
.resume-card p { margin: 6px 0 0; color: var(--text-2); }
.advanced-filter-dialog { background: var(--card); color: var(--text); border: 2px solid var(--text); border-radius: 4px; padding: 24px; width: min(680px, calc(100vw - 32px)); max-height: 85dvh; overflow-y: auto; }
.advanced-filter-dialog::backdrop { background: var(--card); }
.advanced-filter-dialog header, .advanced-filter-dialog footer, .filter-topic-pages { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.advanced-filter-dialog h2 { margin: 0; }
.advanced-filter-dialog label { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; font-size: 16px; }
.advanced-filter-dialog > label { margin-top: 12px; }
.advanced-filter-dialog select, .advanced-filter-dialog > label input { max-width: 65%; min-height: 48px; }
.filter-topics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 20px; margin-block: 16px; }
.filter-topics label { justify-content: flex-start; cursor: pointer; border-bottom: 1px solid var(--border); }
.filter-topics input { width: 22px; height: 22px; accent-color: var(--text); }
.filter-topics span { margin-left: auto; }
.advanced-filter-dialog footer { margin-top: 24px; position: sticky; bottom: -24px; background: var(--card); padding-block: 16px; }
@media (max-width: 520px) { .advanced-filter-dialog { padding: 16px; } .filter-topics { grid-template-columns: 1fr; } }
</style>
