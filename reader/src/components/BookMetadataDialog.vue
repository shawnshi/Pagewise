<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import type { BookMeta } from '../storage'
import { useLibrary } from '../stores/library'
import {
  bookMetadataSnapshot,
  diffMetadataField,
  mergeMetadata,
  validateBookMetadataUpdate,
  BookMetadataConflictError,
  METADATA_LIMITS,
  type BookMetadataFields,
  type BookMetadataSnapshot,
  type MetadataMergeMode,
  type MetadataFieldDiffStatus,
} from '../services/bookMetadata'
import { searchOpenBookMetadata, type BookMetadataCandidate } from '../services/openBookSearch'
import { inferBookMetadataWithAi, AiMetadataError } from '../services/aiBookMetadata'
import { toast } from '../services/toast'
import { t } from '../i18n'

const props = defineProps<{
  modelValue: boolean
  bookId: string
  book: BookMeta | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [bookId: string, metadata: BookMetadataFields]
}>()

const library = useLibrary()
const dialog = ref<HTMLDialogElement | null>(null)

// 初始快照 (CAS 防脏写守卫)
const initialSnapshot = ref<BookMetadataSnapshot | null>(null)

// 手动精修表单状态
const form = ref<Record<keyof BookMetadataFields, string>>({
  author: '',
  publisher: '',
  publicationDate: '',
  language: '',
})

// 合并模式：'fill-empty' (仅补全空白字段) | 'overwrite' (覆盖已有字段)
const mergeMode = ref<MetadataMergeMode>('fill-empty')

// 最近一次由检索或 AI 产出的原始建议
const rawSuggested = ref<BookMetadataFields | null>(null)

// 候选列表
const candidates = ref<BookMetadataCandidate[]>([])
const selectedCandidateIndex = ref<number>(-1)

// 执行状态
const searchingOpen = ref(false)
const inferringAi = ref(false)
const saving = ref(false)
const errorMessage = ref('')

let openSearchController: AbortController | null = null
let aiInferController: AbortController | null = null
let alive = true

function resetDialogState() {
  if (!props.book) return
  initialSnapshot.value = bookMetadataSnapshot(props.book)
  form.value = {
    author: props.book.author || '',
    publisher: props.book.publisher || '',
    publicationDate: props.book.publicationDate || '',
    language: props.book.language || '',
  }
  rawSuggested.value = null
  candidates.value = []
  selectedCandidateIndex.value = -1
  searchingOpen.value = false
  inferringAi.value = false
  saving.value = false
  errorMessage.value = ''
}

function cancelOngoingRequests() {
  if (openSearchController) {
    openSearchController.abort()
    openSearchController = null
  }
  if (aiInferController) {
    aiInferController.abort()
    aiInferController = null
  }
  searchingOpen.value = false
  inferringAi.value = false
}

function requestClose() {
  if (saving.value) return
  cancelOngoingRequests()
  dialog.value?.close()
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  async open => {
    if (!open) {
      if (saving.value) {
        emit('update:modelValue', true)
        return
      }
      cancelOngoingRequests()
      dialog.value?.close()
      return
    }
    resetDialogState()
    await nextTick()
    if (alive && props.modelValue && !dialog.value?.open) {
      dialog.value?.showModal()
    }
  },
  { immediate: true },
)

watch(
  () => props.bookId,
  () => {
    if (props.modelValue && !saving.value) {
      requestClose()
    }
  },
)

// 路由离开保护
function beforeNavigate() {
  if (saving.value) return false
  if (props.modelValue) requestClose()
  return true
}
onBeforeRouteLeave(beforeNavigate)
onBeforeRouteUpdate(beforeNavigate)

onBeforeUnmount(() => {
  alive = false
  cancelOngoingRequests()
})

/** 当合并模式切换或有新的建议值时，重新应用合并规则 */
function applySuggestion(suggested: BookMetadataFields) {
  rawSuggested.value = { ...suggested }
  if (!initialSnapshot.value) return
  const merged = mergeMetadata(initialSnapshot.value, suggested, mergeMode.value)
  form.value = {
    author: merged.author || '',
    publisher: merged.publisher || '',
    publicationDate: merged.publicationDate || '',
    language: merged.language || '',
  }
}

/** 切换合并模式 */
function setMergeMode(mode: MetadataMergeMode) {
  mergeMode.value = mode
  if (rawSuggested.value) {
    applySuggestion(rawSuggested.value)
  }
}

/** 第一级：开放图书元数据检索 */
async function startOpenSearch() {
  if (!props.book || searchingOpen.value || saving.value) return
  cancelOngoingRequests()
  errorMessage.value = ''
  searchingOpen.value = true

  const controller = new AbortController()
  openSearchController = controller

  try {
    const result = await searchOpenBookMetadata({
      title: props.book.title,
      author: props.book.author,
      signal: controller.signal,
    })

    if (!alive || !props.modelValue || controller.signal.aborted) return

    candidates.value = result.candidates
    if (result.bestMatch && Object.values(result.bestMatch).some(Boolean)) {
      selectedCandidateIndex.value = 0
      applySuggestion(result.bestMatch)
      toast(t('bookMetadata.candidates') + `: ${result.candidates.length}`, 'info', 2000)
    } else {
      selectedCandidateIndex.value = -1
      errorMessage.value = t('bookMetadata.noCandidates')
    }
  } catch (err: any) {
    if (controller.signal.aborted) return
    errorMessage.value = err?.message || t('bookMetadata.error')
  } finally {
    if (openSearchController === controller) {
      searchingOpen.value = false
      openSearchController = null
    }
  }
}

/** 采纳某个候选 */
function pickCandidate(index: number) {
  const candidate = candidates.value[index]
  if (!candidate) return
  selectedCandidateIndex.value = index
  applySuggestion({
    author: candidate.author,
    publisher: candidate.publisher,
    publicationDate: candidate.publicationDate,
    language: candidate.language,
  })
}

/** 第二级：AI 著录推理补全 */
async function startAiInference() {
  if (!props.book || inferringAi.value || saving.value) return
  cancelOngoingRequests()
  errorMessage.value = ''
  inferringAi.value = true

  const controller = new AbortController()
  aiInferController = controller

  try {
    const aiResult = await inferBookMetadataWithAi({
      title: props.book.title,
      fileName: props.book.fileName,
      current: {
        author: form.value.author,
        publisher: form.value.publisher,
        publicationDate: form.value.publicationDate,
        language: form.value.language,
      },
      signal: controller.signal,
    })

    if (!alive || !props.modelValue || controller.signal.aborted) return

    applySuggestion(aiResult)
    toast(t('bookMetadata.tier2Badge'), 'info', 2000)
  } catch (err: any) {
    if (controller.signal.aborted) return
    if (err instanceof AiMetadataError && err.code === 'unconfigured') {
      errorMessage.value = t('bookIntroduction.error.unconfigured')
    } else {
      errorMessage.value = err?.message || t('bookMetadata.error')
    }
  } finally {
    if (aiInferController === controller) {
      inferringAi.value = false
      aiInferController = null
    }
  }
}

/** 计算各字段相对于初始快照的差异状态 */
function fieldDiff(field: keyof BookMetadataFields): {
  status: MetadataFieldDiffStatus
  label: string
} {
  const orig = initialSnapshot.value ? initialSnapshot.value[field] : ''
  const current = form.value[field]
  const status = diffMetadataField(orig, current)
  const labels: Record<MetadataFieldDiffStatus, string> = {
    added: t('bookMetadata.diffAdded'),
    modified: t('bookMetadata.diffModified'),
    unchanged: t('bookMetadata.diffUnchanged'),
    empty: t('bookMetadata.diffEmpty'),
  }
  return { status, label: labels[status] }
}

/** 提交保存并校验 CAS 快照 */
async function saveMetadata() {
  if (!props.book || !initialSnapshot.value || saving.value) return
  errorMessage.value = ''

  const patch: BookMetadataFields = {
    author: form.value.author.trim() || undefined,
    publisher: form.value.publisher.trim() || undefined,
    publicationDate: form.value.publicationDate.trim() || undefined,
    language: form.value.language.trim() || undefined,
  }

  try {
    validateBookMetadataUpdate(props.bookId, initialSnapshot.value, patch)
  } catch (err: any) {
    errorMessage.value = err?.message || 'Invalid metadata input'
    return
  }

  saving.value = true
  try {
    await library.updateBookMetadata(props.bookId, initialSnapshot.value, patch)
    toast(t('bookMetadata.success'), 'success', 2000)
    emit('saved', props.bookId, patch)
    requestClose()
  } catch (err: any) {
    if (err instanceof BookMetadataConflictError || err?.code === 'source_changed') {
      errorMessage.value = t('bookMetadata.conflict')
    } else {
      errorMessage.value = err?.message || t('bookMetadata.error')
    }
  } finally {
    saving.value = false
  }
}

const isBusy = computed(() => searchingOpen.value || inferringAi.value || saving.value)
</script>

<template>
  <dialog
    ref="dialog"
    class="book-metadata-dialog"
    aria-labelledby="book-metadata-title"
    @cancel.prevent="requestClose"
  >
    <header class="dialog-header">
      <div class="header-titles">
        <h2 id="book-metadata-title">{{ t('bookMetadata.title') }}</h2>
        <p v-if="book" class="book-name">{{ book.title }}</p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm close-corner-btn" :disabled="saving" @click="requestClose">
        ✕
      </button>
    </header>

    <p class="dialog-hint">{{ t('bookMetadata.hint') }}</p>

    <!-- 渐进补全触发栏 (第一级 & 第二级) -->
    <section class="action-tiers">
      <div class="tier-card">
        <div class="tier-info">
          <span class="badge tier-badge">{{ t('bookMetadata.tier1Badge') }}</span>
          <span class="tier-desc">OpenLibrary / Google Books / 豆瓣</span>
        </div>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isBusy"
          @click="startOpenSearch"
        >
          <span v-if="searchingOpen" class="spinner" aria-hidden="true" />
          <span>{{ searchingOpen ? t('bookMetadata.searchingOpen') : t('bookMetadata.openSearch') }}</span>
        </button>
      </div>

      <div class="tier-card">
        <div class="tier-info">
          <span class="badge tier-badge tier2">{{ t('bookMetadata.tier2Badge') }}</span>
          <span class="tier-desc">结合书名与线索大模型推理</span>
        </div>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isBusy"
          @click="startAiInference"
        >
          <span v-if="inferringAi" class="spinner" aria-hidden="true" />
          <span>{{ inferringAi ? t('bookMetadata.inferringAi') : t('bookMetadata.aiInfer') }}</span>
        </button>
      </div>
    </section>

    <!-- 候选列表 (若有) -->
    <section v-if="candidates.length > 0" class="candidates-section">
      <h3 class="section-title">{{ t('bookMetadata.candidates') }} ({{ candidates.length }})</h3>
      <div class="candidate-pills">
        <button
          v-for="(cand, idx) in candidates.slice(0, 5)"
          :key="idx"
          type="button"
          class="candidate-pill"
          :class="{ selected: selectedCandidateIndex === idx }"
          :disabled="isBusy"
          @click="pickCandidate(idx)"
        >
          <span class="cand-src">{{ cand.sourceLabel }}</span>
          <span class="cand-text">
            {{ [cand.author, cand.publisher, cand.publicationDate].filter(Boolean).join(' · ') || cand.title }}
          </span>
        </button>
      </div>
    </section>

    <!-- 合并模式控制 -->
    <section class="merge-mode-section">
      <span class="mode-label">{{ t('bookMetadata.mergeMode') }}：</span>
      <div class="mode-switch">
        <button
          type="button"
          class="btn btn-sm mode-btn"
          :class="{ active: mergeMode === 'fill-empty' }"
          :disabled="isBusy"
          @click="setMergeMode('fill-empty')"
        >
          {{ t('bookMetadata.modeFillEmpty') }}
        </button>
        <button
          type="button"
          class="btn btn-sm mode-btn"
          :class="{ active: mergeMode === 'overwrite' }"
          :disabled="isBusy"
          @click="setMergeMode('overwrite')"
        >
          {{ t('bookMetadata.modeOverwrite') }}
        </button>
      </div>
    </section>

    <!-- 字段精修与对比表单 -->
    <section class="fields-grid">
      <!-- 作者 -->
      <div class="field-row">
        <div class="field-meta">
          <label for="meta-field-author" class="field-name">{{ t('bookMetadata.fieldAuthor') }}</label>
          <span class="diff-badge" :class="fieldDiff('author').status">
            {{ fieldDiff('author').label }}
          </span>
          <span class="orig-preview">
            {{ t('bookMetadata.original') }}: {{ initialSnapshot?.author || t('bookMetadata.emptyValue') }}
          </span>
        </div>
        <input
          id="meta-field-author"
          v-model="form.author"
          type="text"
          class="input field-input"
          :maxlength="METADATA_LIMITS.author"
          :disabled="saving"
          autocomplete="off"
        />
      </div>

      <!-- 出版社 -->
      <div class="field-row">
        <div class="field-meta">
          <label for="meta-field-publisher" class="field-name">{{ t('bookMetadata.fieldPublisher') }}</label>
          <span class="diff-badge" :class="fieldDiff('publisher').status">
            {{ fieldDiff('publisher').label }}
          </span>
          <span class="orig-preview">
            {{ t('bookMetadata.original') }}: {{ initialSnapshot?.publisher || t('bookMetadata.emptyValue') }}
          </span>
        </div>
        <input
          id="meta-field-publisher"
          v-model="form.publisher"
          type="text"
          class="input field-input"
          :maxlength="METADATA_LIMITS.publisher"
          :disabled="saving"
          autocomplete="off"
        />
      </div>

      <!-- 出版时间 -->
      <div class="field-row">
        <div class="field-meta">
          <label for="meta-field-pubdate" class="field-name">{{ t('bookMetadata.fieldPublicationDate') }}</label>
          <span class="diff-badge" :class="fieldDiff('publicationDate').status">
            {{ fieldDiff('publicationDate').label }}
          </span>
          <span class="orig-preview">
            {{ t('bookMetadata.original') }}: {{ initialSnapshot?.publicationDate || t('bookMetadata.emptyValue') }}
          </span>
        </div>
        <input
          id="meta-field-pubdate"
          v-model="form.publicationDate"
          type="text"
          class="input field-input"
          :maxlength="METADATA_LIMITS.publicationDate"
          :disabled="saving"
          placeholder="YYYY 或 YYYY-MM"
          autocomplete="off"
        />
      </div>

      <!-- 语种 -->
      <div class="field-row">
        <div class="field-meta">
          <label for="meta-field-lang" class="field-name">{{ t('bookMetadata.fieldLanguage') }}</label>
          <span class="diff-badge" :class="fieldDiff('language').status">
            {{ fieldDiff('language').label }}
          </span>
          <span class="orig-preview">
            {{ t('bookMetadata.original') }}: {{ initialSnapshot?.language || t('bookMetadata.emptyValue') }}
          </span>
        </div>
        <input
          id="meta-field-lang"
          v-model="form.language"
          type="text"
          class="input field-input"
          :maxlength="METADATA_LIMITS.language"
          :disabled="saving"
          placeholder="zh, en, ja..."
          autocomplete="off"
        />
      </div>
    </section>

    <!-- 错误反馈 -->
    <div v-if="errorMessage" class="dialog-error-banner" role="alert">
      {{ errorMessage }}
    </div>

    <!-- 底部操作按钮 -->
    <footer class="dialog-footer">
      <button
        type="button"
        class="btn btn-ghost"
        :disabled="saving"
        @click="requestClose"
      >
        {{ t('bookMetadata.close') }}
      </button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="saving"
        @click="saveMetadata"
      >
        <span v-if="saving" class="spinner" aria-hidden="true" />
        <span>{{ saving ? t('bookMetadata.saving') : t('bookMetadata.save') }}</span>
      </button>
    </footer>
  </dialog>
</template>

<style scoped>
.book-metadata-dialog {
  width: min(720px, calc(100vw - 32px));
  max-height: 90vh;
  padding: 24px;
  border: 2px solid var(--eink-solid-black, #000000);
  border-radius: var(--radius, 2px);
  background: var(--eink-surface-pure, #ffffff);
  color: var(--eink-text-primary, #000000);
  overflow-y: auto;
  box-sizing: border-box;
}

.book-metadata-dialog::backdrop {
  background: rgba(0, 0, 0, 0.35);
}

.dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.header-titles h2 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
}

.book-name {
  margin: 0;
  font-size: 14px;
  color: var(--eink-text-secondary, #444444);
  word-break: break-all;
}

.close-corner-btn {
  font-size: 16px;
  padding: 4px 10px;
  line-height: 1;
}

.dialog-hint {
  font-size: 13px;
  line-height: 1.5;
  color: var(--eink-text-secondary, #444444);
  margin: 0 0 16px;
}

/* 渐进触发卡片 (16级灰阶零噪点) */
.action-tiers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.tier-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius, 2px);
  background: var(--eink-surface-pure, #ffffff);
}

.tier-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tier-badge {
  align-self: flex-start;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid var(--eink-solid-black, #000000);
  background: var(--eink-surface-pure, #ffffff);
  color: var(--eink-text-primary, #000000);
}

.tier-badge.tier2 {
  background: var(--eink-solid-black, #000000);
  color: var(--eink-surface-pure, #ffffff);
}

.tier-desc {
  font-size: 12px;
  color: var(--eink-text-secondary, #444444);
}

/* 候选卡片 */
.candidates-section {
  margin-bottom: 18px;
  padding: 10px 14px;
  border-radius: var(--radius, 2px);
  background: var(--eink-surface-card, #eeeeee);
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
}

.section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
}

.candidate-pills {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.candidate-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  text-align: left;
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius-sm, 0px);
  background: var(--eink-surface-pure, #ffffff);
  color: var(--eink-text-primary, #000000);
  cursor: pointer;
  font-size: 13px;
}

.candidate-pill:hover {
  border-color: var(--eink-solid-black, #000000);
}

.candidate-pill.selected {
  border: 2px solid var(--eink-solid-black, #000000);
  background: var(--eink-surface-pure, #ffffff);
  font-weight: 700;
}

.cand-src {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--radius-sm, 0px);
  border: 1px solid var(--eink-solid-black, #000000);
  background: var(--eink-surface-card, #eeeeee);
  white-space: nowrap;
}

.cand-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 合并模式切换 */
.merge-mode-section {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  font-size: 13px;
}

.mode-label {
  font-weight: 600;
}

.mode-switch {
  display: inline-flex;
  gap: 6px;
}

.mode-btn {
  font-size: 12px;
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  background: var(--eink-surface-pure, #ffffff);
}

.mode-btn.active {
  background: var(--eink-solid-black, #000000);
  color: var(--eink-surface-pure, #ffffff);
  border-color: var(--eink-solid-black, #000000);
}

/* 字段表单区 */
.fields-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 20px;
}

.field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.field-name {
  font-weight: 700;
}

/* 墨水屏纯黑白线型与反色徽章编码 (零彩色逃逸) */
.diff-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-sm, 0px);
  font-weight: 700;
  text-transform: uppercase;
}

.diff-badge.added {
  background: var(--eink-solid-black, #000000);
  color: var(--eink-surface-pure, #ffffff);
  border: 1px solid var(--eink-solid-black, #000000);
}

.diff-badge.modified {
  background: var(--eink-surface-pure, #ffffff);
  color: var(--eink-text-primary, #000000);
  border: 2px solid var(--eink-solid-black, #000000);
}

.diff-badge.unchanged {
  background: var(--eink-surface-card, #eeeeee);
  color: var(--eink-text-secondary, #444444);
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
}

.diff-badge.empty {
  background: transparent;
  color: var(--eink-text-muted, #666666);
  border: 1px dashed var(--eink-border-hairline, #bbbbbb);
}

.orig-preview {
  margin-left: auto;
  font-size: 12px;
  color: var(--eink-text-muted, #666666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 45%;
}

.field-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  border: 1px solid var(--eink-solid-black, #000000);
  border-radius: var(--radius, 2px);
  padding: 8px 10px;
  color: inherit;
  background: var(--eink-surface-pure, #ffffff);
  font: inherit;
}

.field-input:focus-visible {
  outline: 2px solid var(--eink-solid-black, #000000);
  outline-offset: 2px;
}

/* 错误提示 (纯黑白高对比度边栏) */
.dialog-error-banner {
  padding: 8px 12px;
  border: 1px solid var(--eink-solid-black, #000000);
  border-inline-start: 4px solid var(--eink-solid-black, #000000);
  background: var(--eink-surface-card, #eeeeee);
  color: var(--eink-text-primary, #000000);
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 16px;
}

/* 底部操作 */
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 10px;
}

/* 墨水屏禁用连续旋转动画，采用静态高对比方块指示 */
.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  background: currentColor;
}

@media (max-width: 540px) {
  .book-metadata-dialog {
    padding: 16px;
    width: calc(100vw - 16px);
  }
  .dialog-footer {
    flex-direction: column;
  }
  .dialog-footer button {
    width: 100%;
  }
}
</style>
