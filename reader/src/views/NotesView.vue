<script setup lang="ts">
/**
 * 全局笔记视图 (Global Notes View)
 * 路由: /notes (由 library worker 统一注册)
 * 
 * 核心契约与设计准则:
 * 1. 跨书籍聚合展示所有用户标注/划线/想法/书签, 附带所属书籍名称、作者与书源
 * 2. 仅发起 2 次全局存储调用 (listAllAnnotations + listBooks), 严禁产生 4000 次按书轮询
 * 3. 搜索与筛选: 支持按原文选区、用户想法、书名、作者即时搜索, 支持全部/想法/划线/书签筛选
 * 4. 正确的直接跳转契约: 点击跳往 `/read/:id?loc=...` 或论文阅读器 `/read-paper/:id?loc=...`
 * 5. 编辑想法集成草稿服务 (noteDrafts): 输入即存草稿, 保存失败保留文本, 保存成功移除草稿, 显式放弃
 * 6. 原书缺失保护: 书籍若被移除, 清晰呈现缺失占位并禁用跳转, 绝不抛错崩溃
 * 7. 适配黑白电子墨水屏: 高对比度令牌、清晰边框、减少非必要动画、可见焦点
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { t } from '../i18n'
import { useNativeBack } from '../composables/useNativeBack'
import { getStorage } from '../storage'
import { toast } from '../services/toast'
import {
  deleteGlobalNote,
  filterGlobalNotes,
  loadGlobalNotes,
  updateNoteThought,
  type GlobalNoteItem,
  type NoteFilterKind,
} from '../services/notes'
import {
  createDebouncedDraftSaver,
  discardNoteDraft,
  listDrafts,
  loadNoteDraft,
  type DebouncedDraftSaver,
  type NoteDraft,
} from '../services/noteDrafts'

const router = useRouter()

// ---- 状态定义 ----
const loading = ref(true)
const errorMsg = ref('')
const notes = ref<GlobalNoteItem[]>([])
const searchQuery = ref('')
const currentFilter = ref<NoteFilterKind>('all')

// 未保存草稿列表
const unsavedDrafts = ref<NoteDraft[]>([])

// 当前处于编辑状态的笔记 ID 及编辑缓存
const editingNoteId = ref<string | null>(null)
const editingText = ref('')
const editingStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const editingErrorMsg = ref('')
const isSavingNote = ref(false)
const draftReadError = ref('')
let activeSaver: DebouncedDraftSaver | null = null

// 删除确认模态框状态
const deletingNote = ref<GlobalNoteItem | null>(null)
const isDeleting = ref(false)

function tr(key: string, fallbackZh: string): string {
  const res = t(key)
  return res && res !== key ? res : fallbackZh
}

// 刷新未保存草稿列表
function refreshUnsavedDrafts(): void {
  try {
    unsavedDrafts.value = listDrafts()
    draftReadError.value = ''
  } catch (error) {
    draftReadError.value = error instanceof Error ? error.message : '本机草稿暂时无法读取'
  }
}

// 加载全局笔记
async function loadData(): Promise<void> {
  loading.value = true
  errorMsg.value = ''
  try {
    const storage = await getStorage()
    notes.value = await loadGlobalNotes(storage)
    refreshUnsavedDrafts()
  } catch (err: unknown) {
    const msg = (err as Error)?.message || ''
    if (msg === 'storage_list_all_unsupported') {
      errorMsg.value = '当前存储后端不支持全局标注聚合'
    } else {
      errorMsg.value = msg || tr('common.unknownError', '加载笔记失败，请重试')
    }
  } finally {
    loading.value = false
  }
}

function preserveEditing(): boolean {
  if (isSavingNote.value) return false
  const result = activeSaver?.flush()
  if (result && !result.success) {
    editingStatus.value = 'error'
    editingErrorMsg.value = result.message
    return false
  }
  activeSaver?.cancel()
  activeSaver = null
  return true
}

function protectUnload(event: BeforeUnloadEvent) {
  if (isSavingNote.value || !preserveEditing()) {
    event.preventDefault()
    event.returnValue = ''
  }
}

onBeforeRouteLeave(() => preserveEditing())
onMounted(() => {
  void loadData()
  window.addEventListener('beforeunload', protectUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', protectUnload)
  activeSaver?.flush()
  activeSaver?.cancel()
})

// 筛选后的笔记列表
const filteredNotes = computed(() => {
  return filterGlobalNotes(notes.value, searchQuery.value, currentFilter.value)
})

// 数量统计
const countStats = computed(() => {
  const total = notes.value.length
  const thoughts = notes.value.filter(n => n.note && n.note.trim()).length
  const highlights = notes.value.filter(n => n.kind === 'highlight').length
  const bookmarks = notes.value.filter(n => n.kind === 'bookmark').length
  return { total, thoughts, highlights, bookmarks }
})

// 返回书架
function goBack(): void {
  router.push('/library')
}

// 清除搜索
function clearSearch(): void {
  searchQuery.value = ''
}

// 跳转到书籍原文
function jumpToOriginal(note: GlobalNoteItem): void {
  if (note.sourceMissing || !note.readerJumpUrl) {
    toast(t("uiV02.copy.\u539F\u4E66\u5DF2\u4ECE\u4E66\u5E93\u4E2D\u79FB\u9664\uFF0C\u65E0\u6CD5\u8DF3\u8F6C\u5B9A\u4F4D"), 'error')
    return
  }
  void router.push(note.readerJumpUrl)
}

// 开始编辑某个想法
function startEditing(note: GlobalNoteItem): void {
  if (!preserveEditing()) return

  editingNoteId.value = note.id
  editingStatus.value = 'idle'
  editingErrorMsg.value = ''

  // 优先尝试恢复本地草稿
  const draftRes = loadNoteDraft({
    bookId: note.bookId,
    contextId: `anno:${note.id}`,
    quote: note.text,
    sourceLoc: note.cfi,
  })

  if (draftRes.success) {
    editingText.value = draftRes.draft.text
    toast(t("uiV02.copy.\u5DF2\u6062\u590D\u4E0A\u6B21\u672A\u4FDD\u5B58\u7684\u8349\u7A3F"), 'info')
  } else {
    editingText.value = note.note || ''
    if (draftRes.error !== 'not_found') {
      editingStatus.value = 'error'
      editingErrorMsg.value = draftRes.message
    }
  }

  // 绑定防抖草稿保存器
  activeSaver = createDebouncedDraftSaver(
    {
      bookId: note.bookId,
      contextId: `anno:${note.id}`,
      quote: note.text,
      sourceLoc: note.cfi,
    },
    {
      delayMs: 300,
      onSaved(res) {
        if (res.success) {
          editingStatus.value = 'saved'
          refreshUnsavedDrafts()
        } else {
          editingStatus.value = 'error'
          editingErrorMsg.value = res.message
        }
      },
    },
  )
}

// 编辑输入监听
function onEditInput(): void {
  editingStatus.value = 'saving'
  if (activeSaver) {
    activeSaver.save(editingText.value)
  }
}

// 取消编辑
function cancelEditing(_note?: GlobalNoteItem): void {
  if (!preserveEditing()) return
  editingNoteId.value = null
  editingText.value = ''
  editingStatus.value = 'idle'
  editingErrorMsg.value = ''
  refreshUnsavedDrafts()
}

// Android 返回键: 先关删除确认，再退出编辑，最后才让路由回退。
useNativeBack(() => {
  if (deletingNote.value) { deletingNote.value = null; return true }
  if (editingNoteId.value) { cancelEditing(); return true }
  return false
})

// 放弃当前笔记的草稿
function discardCurrentDraft(note: GlobalNoteItem): void {
  if (isSavingNote.value) return
  const result = discardNoteDraft({ bookId: note.bookId, contextId: `anno:${note.id}` })
  if (!result.success) {
    editingErrorMsg.value = result.message || '无法丢弃草稿'
    editingStatus.value = 'error'
    return
  }
  activeSaver?.cancel()
  activeSaver = null
  editingText.value = note.note || ''
  editingNoteId.value = null
  editingStatus.value = 'idle'
  toast(t("uiV02.copy.\u5DF2\u653E\u5F03\u672C\u5730\u8349\u7A3F"), 'info')
  refreshUnsavedDrafts()
}

// 保存正式想法
async function saveThought(note: GlobalNoteItem): Promise<void> {
  if (isSavingNote.value) return
  const submitted = editingText.value
  activeSaver?.flush()
  isSavingNote.value = true
  editingStatus.value = 'saving'
  try {
    const storage = await getStorage()
    const cleanup = await updateNoteThought(storage, note.id, note.bookId, submitted)
    note.note = submitted.trim() || undefined
    editingNoteId.value = null
    editingText.value = ''
    editingStatus.value = 'idle'
    activeSaver?.cancel()
    activeSaver = null
    toast(cleanup.success ? t("uiV02.copy.\u5DF2\u4FDD\u5B58\u7B14\u8BB0") : t("uiV02.copy.\u7B14\u8BB0\u5DF2\u4FDD\u5B58\uFF0C\u8349\u7A3F\u6E05\u7406\u5931\u8D25\uFF1A{v0}", { v0: cleanup.message ?? t('common.unknownError') }), cleanup.success ? 'success' : 'error')
    refreshUnsavedDrafts()
  } catch (error) {
    editingStatus.value = 'error'
    const msg = error instanceof Error ? error.message : '保存笔记失败，当前输入仍保留'
    editingErrorMsg.value = msg
    toast(msg, 'error')
  } finally {
    isSavingNote.value = false
  }
}

// 触发删除确认
function promptDelete(note: GlobalNoteItem): void {
  deletingNote.value = note
}

// 确认删除标注
async function confirmDelete(): Promise<void> {
  const note = deletingNote.value
  if (!note) return

  isDeleting.value = true
  try {
    const storage = await getStorage()
    const cleanup = await deleteGlobalNote(storage, note.id, note.bookId)
    if (editingNoteId.value === note.id) {
      activeSaver?.cancel()
      activeSaver = null
      editingNoteId.value = null
      editingText.value = ''
      editingStatus.value = 'idle'
      editingErrorMsg.value = ''
    }
    notes.value = notes.value.filter(n => n.id !== note.id)
    deletingNote.value = null
    toast(cleanup.success ? t("uiV02.copy.\u5DF2\u5220\u9664\u6807\u6CE8") : t('reader.noteDeletedDraftCleanupFailed', { message: cleanup.message ?? t('common.unknownError') }), cleanup.success ? 'success' : 'error')
    refreshUnsavedDrafts()
  } catch (err: unknown) {
    const msg = (err as Error)?.message || '删除失败，请重试'
    toast(msg, 'error')
  } finally {
    isDeleting.value = false
  }
}

function cancelDelete(): void {
  deletingNote.value = null
}

// 放弃未保存草稿项
function discardDraftItem(draft: NoteDraft): void {
  const result = discardNoteDraft({ bookId: draft.bookId, contextId: draft.contextId })
  if (!result.success) {
    toast(result.message || t("uiV02.copy.\u65E0\u6CD5\u4E22\u5F03\u8349\u7A3F"), 'error')
    return
  }
  toast(t("uiV02.copy.\u5DF2\u4E22\u5F03\u8349\u7A3F"), 'info')
  refreshUnsavedDrafts()
}

// 格式化时间戳
function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}
</script>

<template>
  <div class="notes-view">
    <!-- 顶部导航与操作栏 -->
    <header class="notes-header">
      <div class="header-left">
        <button
          class="btn btn-ghost btn-icon back-btn"
          :title="tr('common.back', '返回书架')"
          :aria-label="tr('common.back', '返回书架')"
          @click="goBack"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
        </button>
        <h1 class="notes-title">{{ tr('reader.annotationsBookmarks', '全部笔记') }}</h1>
        <span class="notes-count-badge" v-if="!loading">{{ notes.length }}</span>
      </div>

      <div class="header-right">
        <button
          class="btn btn-ghost btn-icon"
          :title="tr('common.refresh', '刷新')"
          :aria-label="tr('common.refresh', '刷新')"
          @click="loadData"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- 搜索与分类栏 -->
    <div class="toolbar-section">
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input
          v-model="searchQuery"
          type="search"
          class="input search-input"
          :placeholder="tr('common.search', '搜索笔记、划线原文、书名或作者…')"
          :aria-label="tr('common.search', '搜索笔记')"
        />
        <button
          v-if="searchQuery"
          class="clear-search-btn"
          :title="tr('common.clear', '清除搜索')"
          :aria-label="tr('common.clear', '清除搜索')"
          @click="clearSearch"
        >
          ✕
        </button>
      </div>

      <div class="segmented filter-segmented" role="tablist" :aria-label="tr('common.filter', '笔记分类')">
        <button
          role="tab"
          :class="{ active: currentFilter === 'all' }"
          :aria-selected="currentFilter === 'all'"
          @click="currentFilter = 'all'"
        >
          {{ tr('library.filterAll', '全部') }} ({{ countStats.total }})
        </button>
        <button
          role="tab"
          :class="{ active: currentFilter === 'thoughts' }"
          :aria-selected="currentFilter === 'thoughts'"
          @click="currentFilter = 'thoughts'"
        >
          {{ t("uiV02.copy.想法 (") }}{{ countStats.thoughts }})
        </button>
        <button
          role="tab"
          :class="{ active: currentFilter === 'highlights' }"
          :aria-selected="currentFilter === 'highlights'"
          @click="currentFilter = 'highlights'"
        >
          {{ tr('reader.highlight', '划线') }} ({{ countStats.highlights }})
        </button>
        <button
          role="tab"
          :class="{ active: currentFilter === 'bookmarks' }"
          :aria-selected="currentFilter === 'bookmarks'"
          @click="currentFilter = 'bookmarks'"
        >
          {{ tr('reader.bookmarksTab', '书签') }} ({{ countStats.bookmarks }})
        </button>
      </div>
    </div>

    <p v-if="draftReadError" class="error-text" role="alert">{{ draftReadError }}</p>
    <!-- 未保存本地草稿区域 (严格不标为正式已保存笔记) -->
    <section v-if="unsavedDrafts.length > 0" class="drafts-section" :aria-label="t('uiV02.copy.未保存草稿')">
      <div class="drafts-header">
        <span class="drafts-title">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
          </svg>
          {{ t("uiV02.copy.未保存草稿 (") }}{{ unsavedDrafts.length }})
        </span>
        <span class="drafts-notice">{{ t("uiV02.copy.本地临时草稿，尚未保存为正式笔记") }}</span>
      </div>
      <div class="drafts-list">
        <div v-for="d in unsavedDrafts" :key="d.bookId + d.contextId" class="draft-chip">
          <div class="draft-chip-content">
            <span class="draft-time">{{ formatTime(d.updatedAt) }}</span>
            <span class="draft-text">{{ d.text }}</span>
          </div>
          <button
            class="btn btn-ghost btn-sm draft-discard-btn"
            :title="t('uiV02.copy.放弃草稿')"
            :aria-label="t('uiV02.copy.放弃草稿')"
            @click="discardDraftItem(d)"
          >
            {{ t("uiV02.copy.放弃") }}
          </button>
        </div>
      </div>
    </section>

    <!-- 主列表内容 -->
    <main class="notes-content">
      <!-- 加载中态 -->
      <div v-if="loading" class="empty">
        <p class="empty-title">{{ tr('common.loading', '加载笔记中…') }}</p>
      </div>

      <!-- 错误态与重试 -->
      <div v-else-if="errorMsg" class="empty error-box">
        <p class="empty-title error-text">{{ errorMsg }}</p>
        <button class="btn btn-primary" @click="loadData">
          {{ tr('common.refresh', '重试') }}
        </button>
      </div>

      <!-- 空状态 -->
      <div v-else-if="filteredNotes.length === 0" class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="48" height="48">
            <path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
          </svg>
        </div>
        <p class="empty-title">
          {{ searchQuery ? t("uiV02.copy.\u672A\u627E\u5230\u5339\u914D\u7684\u7B14\u8BB0\u6216\u6807\u6CE8") : t("uiV02.copy.\u4E66\u67B6\u6682\u65E0\u7B14\u8BB0\u6216\u5212\u7EBF") }}
        </p>
        <p class="empty-subtitle">
          {{ searchQuery ? t("uiV02.copy.\u8BF7\u5C1D\u8BD5\u66F4\u6362\u5173\u952E\u8BCD\u6216\u5207\u6362\u5206\u7C7B\u7B5B\u9009") : t("uiV02.copy.\u5728\u9605\u8BFB\u4E66\u7C4D\u65F6\u9009\u4E2D\u6587\u672C\u5212\u7EBF\u6216\u8BB0\u5F55\u60F3\u6CD5\uFF0C\u5373\u53EF\u5728\u6B64\u6C47\u603B\u6D4F\u89C8") }}
        </p>
        <button v-if="searchQuery" class="btn btn-ghost" @click="clearSearch">
          {{ tr('common.clear', '清空搜索') }}
        </button>
      </div>

      <!-- 笔记卡片列表 -->
      <div v-else class="notes-grid">
        <article
          v-for="note in filteredNotes"
          :key="note.id"
          class="card note-card"
          :class="{ 'is-bookmark': note.kind === 'bookmark' }"
        >
          <!-- 书籍元信息与跳转头 -->
          <div class="card-book-header">
            <div class="book-identity">
              <span class="book-title" :title="note.bookTitle">{{ note.bookTitle }}</span>
              <span v-if="note.bookAuthor" class="book-author">{{ note.bookAuthor }}</span>
              <span v-if="note.bookSource" class="tag source-tag">{{ note.bookSource }}</span>
            </div>

            <div class="header-actions">
              <span
                class="tag kind-tag"
                :class="{
                  'kind-bookmark': note.kind === 'bookmark',
                  'kind-highlight': note.kind === 'highlight',
                }"
              >
                {{ note.kind === 'bookmark' ? tr('reader.bookmarksTab', '书签') : tr('reader.highlight', '划线') }}
              </span>

              <button
                v-if="!note.sourceMissing"
                class="btn btn-ghost btn-sm jump-btn"
                :title="tr('common.start', '跳转至原文定位')"
                :aria-label="tr('common.start', '跳转至原文定位')"
                @click="jumpToOriginal(note)"
              >
                {{ t("uiV02.copy.定位 ↗") }}
              </button>
              <span v-else class="tag missing-tag" :title="t('uiV02.copy.书籍已从书库移除')">{{ t("uiV02.copy.原书已移除") }}</span>
            </div>
          </div>

          <!-- 原文选区引用块 -->
          <blockquote
            v-if="note.text"
            class="quote-block"
            :style="{ borderLeftColor: note.color || 'var(--brand)' }"
          >
            <p class="quote-text">{{ note.text }}</p>
          </blockquote>

          <!-- 用户想法 / 笔记正文区域 -->
          <div class="thought-container">
            <!-- 正在编辑状态 -->
            <div v-if="editingNoteId === note.id" class="inline-editor">
              <textarea
                v-model="editingText"
                class="input note-textarea"
                rows="3"
                :placeholder="t('uiV02.copy.写下关于此处的想法…')"
                :aria-label="t('uiV02.editThought')"
                :disabled="isSavingNote"
                @input="onEditInput"
              ></textarea>

              <div class="editor-status-bar">
                <span class="status-indicator">
                  <span v-if="editingStatus === 'saving'">{{ t("uiV02.copy.草稿保存中…") }}</span>
                  <span v-else-if="editingStatus === 'saved'">{{ t("uiV02.copy.草稿已保存在本机") }}</span>
                  <span v-else-if="editingStatus === 'error'" class="error-text">
                    {{ editingErrorMsg || t("uiV02.copy.\u8349\u7A3F\u5199\u5165\u53D7\u963B") }}
                  </span>
                </span>

                <div class="editor-buttons">
                  <button
                    class="btn btn-ghost btn-sm"
                    :disabled="isSavingNote"
                    @click="discardCurrentDraft(note)"
                  >
                    {{ t("uiV02.copy.放弃草稿") }}
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    :disabled="isSavingNote"
                    @click="cancelEditing(note)"
                  >
                    {{ tr('common.cancel', '取消') }}
                  </button>
                  <button
                    class="btn btn-primary btn-sm"
                    :disabled="isSavingNote"
                    @click="saveThought(note)"
                  >
                    {{ tr('common.save', '保存') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 常规展示状态 -->
            <div v-else class="thought-display">
              <p v-if="note.note" class="thought-text">{{ note.note }}</p>
              <p v-else-if="note.kind !== 'bookmark'" class="thought-placeholder" @click="startEditing(note)">
                {{ t("uiV02.copy.+ 添加想法…") }}
              </p>
            </div>
          </div>

          <!-- 卡片底栏: 时间与操作按钮 -->
          <footer class="card-footer">
            <time class="note-time">{{ formatTime(note.createdAt) }}</time>

            <div class="card-actions">
              <button
                v-if="editingNoteId !== note.id && note.kind !== 'bookmark'"
                class="btn btn-ghost btn-sm action-btn"
                :title="t('uiV02.editThought')"
                :aria-label="t('uiV02.editThought')"
                @click="startEditing(note)"
              >
                {{ t('uiV02.editThought') }}
              </button>
              <button
                class="btn btn-ghost btn-sm action-btn delete-btn"
                :title="tr('common.delete', '删除标注')"
                :aria-label="tr('common.delete', '删除标注')"
                @click="promptDelete(note)"
              >
                {{ tr('common.delete', '删除') }}
              </button>
            </div>
          </footer>
        </article>
      </div>
    </main>

    <!-- 删除确认弹窗 -->
    <div v-if="deletingNote" class="modal-backdrop" @click="cancelDelete">
      <div class="card modal-dialog" role="dialog" aria-modal="true" @click.stop>
        <h2 class="modal-title">{{ tr('common.delete', '确认删除') }}</h2>
        <p class="modal-body">
          {{ t("uiV02.copy.确定要删除这条") }}{{ deletingNote.kind === 'bookmark' ? t("uiV02.copy.\u4E66\u7B7E") : t("uiV02.copy.\u6807\u6CE8\u4E0E\u60F3\u6CD5") }}{{ t("uiV02.copy.吗？ 删除后不可恢复。") }}
        </p>
        <div class="modal-actions">
          <button class="btn btn-ghost" :disabled="isDeleting" @click="cancelDelete">
            {{ tr('common.cancel', '取消') }}
          </button>
          <button class="btn btn-danger" :disabled="isDeleting" @click="confirmDelete">
            {{ isDeleting ? tr('common.loading', '删除中…') : tr('common.confirm', '确认删除') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notes-view {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background-color: var(--bg);
  color: var(--text);
  padding-bottom: 48px;
}

/* 顶部导航 */
.notes-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background-color: var(--card);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.back-btn {
  margin-right: 4px;
}

.notes-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.notes-count-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 12px;
  background-color: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}

/* 搜索与分类 */
.toolbar-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  background-color: var(--card);
  border-bottom: 1px solid var(--border);
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.search-icon {
  position: absolute;
  left: 12px;
  color: var(--text-3, var(--text-2));
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding-left: 36px;
  padding-right: 32px;
}

.clear-search-btn {
  position: absolute;
  right: 8px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
}

.filter-segmented {
  width: 100%;
  overflow-x: auto;
}

/* 未保存草稿区域 */
.drafts-section {
  margin: 12px 16px 0;
  padding: 10px 14px;
  background-color: var(--card);
  border: 1px dashed var(--border);
  border-radius: 6px;
}

.drafts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.drafts-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.drafts-notice {
  font-size: 11px;
  color: var(--text-2);
}

.drafts-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.draft-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background-color: var(--surface-2);
  border-radius: 4px;
  font-size: 12px;
}

.draft-chip-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin-right: 8px;
}

.draft-time {
  font-size: 10px;
  color: var(--text-2);
}

.draft-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.draft-discard-btn {
  flex-shrink: 0;
  color: var(--danger, #d32f2f);
}

/* 主内容区 */
.notes-content {
  flex: 1;
  padding: 16px;
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
}

.notes-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 笔记卡片 */
.note-card {
  padding: 14px 16px;
  border: 1px solid var(--eink-border-hairline);
  background-color: var(--eink-surface-pure);
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card-book-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.book-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.book-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.book-author {
  font-size: 12px;
  color: var(--text-2);
}

.source-tag {
  font-size: 11px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kind-tag {
  font-size: 11px;
}

.kind-bookmark {
  border-color: var(--text-2);
}

.jump-btn {
  font-weight: 500;
}

.missing-tag {
  font-size: 11px;
  color: var(--danger, #d32f2f);
  border-color: var(--danger, #d32f2f);
}

/* 选区原文引用 */
.quote-block {
  margin: 0;
  padding: 8px 12px;
  background-color: var(--eink-surface-subtle);
  border-left: 3px solid var(--eink-solid-black);
  border-radius: 0;
}

.quote-text {
  font-family: var(--font-serif);
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--eink-text-primary);
  word-break: break-word;
}

/* 想法容器 */
.thought-container {
  display: flex;
  flex-direction: column;
}

.thought-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
  white-space: pre-wrap;
}

.thought-placeholder {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  padding: 4px 0;
}

.thought-placeholder:hover {
  color: var(--brand);
}

/* 内联编辑器 */
.inline-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.note-textarea {
  width: 100%;
  resize: vertical;
  min-height: 72px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.editor-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-indicator {
  font-size: 11px;
  color: var(--text-2);
}

.editor-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 卡片底栏 */
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-2);
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.delete-btn {
  color: var(--danger, #d32f2f);
}

/* 模态弹窗 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: var(--eink-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 16px;
}

.modal-dialog {
  max-width: 400px;
  width: 100%;
  padding: 20px;
  background-color: var(--eink-surface-pure);
  border: 2px solid var(--eink-solid-black);
  border-radius: 2px;
  box-shadow: none;
}

.modal-title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 600;
}

.modal-body {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.error-text {
  color: var(--danger, #d32f2f);
}
</style>
