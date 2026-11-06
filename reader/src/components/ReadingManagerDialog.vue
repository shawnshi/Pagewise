<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
import { getStorage, type BookMeta } from '../storage'
import { useLibrary } from '../stores/library'
import {
  generateCrossBookMatrixWithAi,
  buildCrossBookMatrixMarkdown,
  generateReadingPathWithAi,
  ReadingManagerAiError,
  type CrossBookMatrixResult,
  type ReadingPathResult,
} from '../services/readingManagerAi'
import { toast } from '../services/toast'
import { t } from '../i18n'

const props = defineProps<{
  modelValue: boolean
  initialTab?: 'matrix' | 'path'
  defaultBookId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const router = useRouter()
const library = useLibrary()
const dialog = ref<HTMLDialogElement | null>(null)

const activeTab = ref<'matrix' | 'path'>(props.initialTab || 'matrix')

// 跨书观点矩阵状态 (P2-A)
const selectedBookIds = ref<string[]>([])
const matrixTopic = ref('')
const matrixLoading = ref(false)
const matrixResult = ref<CrossBookMatrixResult | null>(null)
const matrixError = ref('')

// 主题阅读路径规划状态 (P2-B)
const pathGoal = ref('')
const pathLoading = ref(false)
const pathSavingList = ref(false)
const pathResult = ref<ReadingPathResult | null>(null)
const pathError = ref('')

let activeController: AbortController | null = null
let alive = true

const availableBooks = computed<BookMeta[]>(() => {
  return [...library.books].sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0))
})

const SELECTOR_PAGE_SIZE = 6
const bookSelectorPage = ref(1)
const selectorTotalPages = computed(() => Math.max(1, Math.ceil(availableBooks.value.length / SELECTOR_PAGE_SIZE)))
const pagedAvailableBooks = computed<BookMeta[]>(() => {
  const start = (bookSelectorPage.value - 1) * SELECTOR_PAGE_SIZE
  return availableBooks.value.slice(start, start + SELECTOR_PAGE_SIZE)
})

const isBusy = computed(() => matrixLoading.value || pathLoading.value || pathSavingList.value)

function cancelOngoing() {
  if (activeController) {
    activeController.abort()
    activeController = null
  }
  matrixLoading.value = false
  pathLoading.value = false
}

function initDialogState() {
  activeTab.value = props.initialTab || 'matrix'
  matrixError.value = ''
  pathError.value = ''
  bookSelectorPage.value = 1
  if (selectedBookIds.value.length === 0 && availableBooks.value.length > 0) {
    const defaults: string[] = []
    if (props.defaultBookId && availableBooks.value.some(b => b.id === props.defaultBookId)) {
      defaults.push(props.defaultBookId)
    }
    for (const b of availableBooks.value) {
      if (defaults.length >= 2) break
      if (!defaults.includes(b.id)) defaults.push(b.id)
    }
    selectedBookIds.value = defaults
  }
}

function requestClose() {
  if (pathSavingList.value) return
  cancelOngoing()
  dialog.value?.close()
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  async open => {
    if (!open) {
      if (pathSavingList.value) {
        emit('update:modelValue', true)
        return
      }
      cancelOngoing()
      dialog.value?.close()
      return
    }
    if (!library.loaded) {
      await library.refresh().catch(() => {})
    }
    initDialogState()
    await nextTick()
    if (alive && props.modelValue && !dialog.value?.open) {
      dialog.value?.showModal()
    }
  },
  { immediate: true },
)

function beforeNavigate() {
  if (pathSavingList.value) return false
  if (props.modelValue) requestClose()
  return true
}
onBeforeRouteLeave(beforeNavigate)
onBeforeRouteUpdate(beforeNavigate)

onBeforeUnmount(() => {
  alive = false
  cancelOngoing()
})

function toggleBookSelection(bookId: string) {
  if (isBusy.value) return
  const idx = selectedBookIds.value.indexOf(bookId)
  if (idx >= 0) {
    selectedBookIds.value.splice(idx, 1)
  } else {
    if (selectedBookIds.value.length >= 4) {
      toast(t('readingManager.matrixSelectHint'), 'info', 2000)
      return
    }
    selectedBookIds.value.push(bookId)
  }
}

function formatError(err: unknown): string {
  if (err instanceof ReadingManagerAiError) {
    if (err.code === 'unconfigured') return t('bookIntroduction.error.unconfigured')
    return err.message
  }
  return (err as Error)?.message || t('bookMetadata.error')
}

/** P2-A: 执行跨书观点对比矩阵 */
async function runCrossBookMatrix() {
  if (isBusy.value) return
  if (selectedBookIds.value.length < 2 || selectedBookIds.value.length > 4) {
    matrixError.value = t('readingManager.matrixSelectHint')
    return
  }

  cancelOngoing()
  matrixError.value = ''
  matrixLoading.value = true
  const controller = new AbortController()
  activeController = controller

  try {
    const storage = await getStorage()
    const entries = []
    for (const id of selectedBookIds.value) {
      const book = availableBooks.value.find(b => b.id === id) || (await storage.getBook(id))
      if (!book) continue
      const annotations = await storage.listAnnotations(id).catch(() => [])
      entries.push({ book, annotations })
    }

    const res = await generateCrossBookMatrixWithAi({
      topic: matrixTopic.value,
      entries,
      signal: controller.signal,
    })
    if (!alive || controller.signal.aborted) return
    matrixResult.value = res
  } catch (err) {
    if (controller.signal.aborted) return
    matrixError.value = formatError(err)
  } finally {
    if (activeController === controller) {
      matrixLoading.value = false
      activeController = null
    }
  }
}

async function copyMatrixMarkdown() {
  if (!matrixResult.value) return
  const md = buildCrossBookMatrixMarkdown(matrixResult.value)
  try {
    await navigator.clipboard.writeText(md)
    toast(t('readingManager.copiedSuccess'), 'success', 2000)
  } catch {
    toast(t('bookMetadata.error'), 'error')
  }
}

function exportMatrixMarkdown() {
  if (!matrixResult.value) return
  const md = buildCrossBookMatrixMarkdown(matrixResult.value)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `跨书观点矩阵-${matrixResult.value.topic.slice(0, 24)}.md`
  a.click()
  URL.revokeObjectURL(url)
  toast(t('readingManager.exportedSuccess'), 'success', 2000)
}

/** P2-B: 生成主题阅读路径 */
async function runReadingPath() {
  if (isBusy.value) return
  if (!pathGoal.value.trim()) {
    pathError.value = '请输入研究课题或阅读目标'
    return
  }

  cancelOngoing()
  pathError.value = ''
  pathLoading.value = true
  const controller = new AbortController()
  activeController = controller

  try {
    const res = await generateReadingPathWithAi({
      goal: pathGoal.value,
      books: availableBooks.value,
      signal: controller.signal,
    })
    if (!alive || controller.signal.aborted) return
    pathResult.value = res
  } catch (err) {
    if (controller.signal.aborted) return
    pathError.value = formatError(err)
  } finally {
    if (activeController === controller) {
      pathLoading.value = false
      activeController = null
    }
  }
}

/** 一键将规划好的阅读路径保存为本地书单 */
async function savePathAsBooklist() {
  if (!pathResult.value || pathResult.value.stages.length === 0 || pathSavingList.value) return
  pathSavingList.value = true
  pathError.value = ''
  try {
    const storage = await getStorage()
    const listName = `主题路径：${pathResult.value.goal.slice(0, 32)}`
    const listId = await storage.createBooklist(listName)
    const bookIds = pathResult.value.stages.map(s => s.bookId)
    await storage.addBooksToBooklist(listId, bookIds)
    toast(t('readingManager.pathSavedToast'), 'success', 2500)
  } catch (err: any) {
    pathError.value = err?.message || t('bookMetadata.error')
  } finally {
    pathSavingList.value = false
  }
}

function jumpToBook(bookId: string) {
  requestClose()
  router.push(`/book/${encodeURIComponent(bookId)}`)
}
</script>

<template>
  <dialog
    ref="dialog"
    class="reading-manager-dialog"
    aria-labelledby="reading-manager-title"
    @cancel.prevent="requestClose"
  >
    <header class="dialog-header">
      <h2 id="reading-manager-title">{{ t('readingManager.hubTitle') }}</h2>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="pathSavingList" @click="requestClose">
        ✕
      </button>
    </header>

    <nav class="manager-tabs" role="tablist">
      <button
        type="button"
        class="tab-pill"
        :class="{ active: activeTab === 'matrix' }"
        role="tab"
        :aria-selected="activeTab === 'matrix'"
        @click="activeTab = 'matrix'"
      >
        {{ t('readingManager.tabMatrix') }}
      </button>
      <button
        type="button"
        class="tab-pill"
        :class="{ active: activeTab === 'path' }"
        role="tab"
        :aria-selected="activeTab === 'path'"
        @click="activeTab = 'path'"
      >
        {{ t('readingManager.tabPath') }}
      </button>
    </nav>

    <!-- Tab 1: 跨书观点对比矩阵 (P2-A) -->
    <section v-if="activeTab === 'matrix'" class="tab-body" role="tabpanel">
      <div class="field-group">
        <label for="matrix-topic-input" class="field-label">{{ t('readingManager.matrixTopicLabel') }}</label>
        <input
          id="matrix-topic-input"
          v-model="matrixTopic"
          type="text"
          class="input"
          maxlength="160"
          :placeholder="t('readingManager.matrixTopicPlaceholder')"
          :disabled="isBusy"
        />
      </div>

      <div class="field-group">
        <div class="selector-header-row">
          <span class="field-label">
            {{ t('readingManager.matrixSelectHint') }} ({{ selectedBookIds.length }} / 4)
          </span>
          <div v-if="selectorTotalPages > 1" class="step-pager">
            <button
              type="button"
              class="btn btn-sm"
              :disabled="isBusy || bookSelectorPage <= 1"
              @click="bookSelectorPage--"
            >
              ‹
            </button>
            <span class="pager-status">{{ bookSelectorPage }} / {{ selectorTotalPages }}</span>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="isBusy || bookSelectorPage >= selectorTotalPages"
              @click="bookSelectorPage++"
            >
              ›
            </button>
          </div>
        </div>
        <div class="book-selector-grid">
          <button
            v-for="b in pagedAvailableBooks"
            :key="b.id"
            type="button"
            class="book-pick-chip"
            :class="{ selected: selectedBookIds.includes(b.id) }"
            :disabled="isBusy"
            @click="toggleBookSelection(b.id)"
          >
            <span class="check-indicator">{{ selectedBookIds.includes(b.id) ? '■' : '□' }}</span>
            <span class="chip-title">{{ b.title }}</span>
            <span v-if="b.author" class="chip-author">{{ b.author }}</span>
          </button>
        </div>
      </div>

      <div class="action-bar">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="isBusy || selectedBookIds.length < 2"
          @click="runCrossBookMatrix"
        >
          {{ matrixLoading ? t('readingManager.matrixGenerating') : t('readingManager.matrixGenerateBtn') }}
        </button>
        <template v-if="matrixResult">
          <button type="button" class="btn btn-sm" :disabled="isBusy" @click="copyMatrixMarkdown">
            {{ t('readingManager.copyMarkdownBtn') }}
          </button>
          <button type="button" class="btn btn-sm" :disabled="isBusy" @click="exportMatrixMarkdown">
            {{ t('readingManager.exportMarkdownBtn') }}
          </button>
        </template>
      </div>

      <div v-if="matrixError" class="error-banner" role="alert">{{ matrixError }}</div>

      <div v-if="matrixResult" class="result-box">
        <h3 class="result-heading">{{ matrixResult.topic }}</h3>

        <div v-if="matrixResult.consensus.length" class="matrix-block">
          <h4>{{ t('readingManager.matrixConsensus') }}</h4>
          <ul>
            <li v-for="(c, idx) in matrixResult.consensus" :key="idx">{{ c }}</li>
          </ul>
        </div>

        <div v-if="matrixResult.divergences.length" class="matrix-block">
          <h4>{{ t('readingManager.matrixDivergences') }}</h4>
          <ul>
            <li v-for="(d, idx) in matrixResult.divergences" :key="idx">{{ d }}</li>
          </ul>
        </div>

        <div class="matrix-block">
          <h4>{{ t('readingManager.matrixPerspectives') }}</h4>
          <div class="perspectives-cards">
            <article v-for="p in matrixResult.perspectives" :key="p.bookId" class="perspective-card">
              <header class="perspective-head">
                <button type="button" class="book-link-btn" @click="jumpToBook(p.bookId)">
                  《{{ p.bookTitle }}》
                </button>
              </header>
              <p class="p-row"><strong>核心立场：</strong>{{ p.coreStance }}</p>
              <p class="p-row"><strong>承重证据：</strong>{{ p.keyEvidence }}</p>
              <p class="p-row"><strong>适用边界：</strong>{{ p.boundary }}</p>
            </article>
          </div>
        </div>
      </div>
    </section>

    <!-- Tab 2: 主题阅读路径规划 (P2-B) -->
    <section v-else class="tab-body" role="tabpanel">
      <div class="field-group">
        <label for="path-goal-input" class="field-label">{{ t('readingManager.pathGoalLabel') }}</label>
        <input
          id="path-goal-input"
          v-model="pathGoal"
          type="text"
          class="input"
          maxlength="200"
          :placeholder="t('readingManager.pathGoalPlaceholder')"
          :disabled="isBusy"
          @keydown.enter.prevent="runReadingPath"
        />
      </div>

      <div class="action-bar">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="isBusy || !pathGoal.trim() || availableBooks.length === 0"
          @click="runReadingPath"
        >
          {{ pathLoading ? t('readingManager.pathGenerating') : t('readingManager.pathGenerateBtn') }}
        </button>
        <button
          v-if="pathResult && pathResult.stages.length > 0"
          type="button"
          class="btn btn-sm"
          :disabled="isBusy"
          @click="savePathAsBooklist"
        >
          {{ t('readingManager.pathSaveBooklistBtn') }}
        </button>
      </div>

      <div v-if="pathError" class="error-banner" role="alert">{{ pathError }}</div>

      <div v-if="pathResult" class="result-box">
        <h3 class="result-heading">{{ pathResult.goal }}</h3>
        <p class="path-overview">{{ pathResult.overview }}</p>

        <ol class="stages-list">
          <li v-for="stage in pathResult.stages" :key="stage.bookId" class="stage-card">
            <div class="stage-top">
              <span class="stage-badge">{{ stage.order }}. {{ stage.stageName }}</span>
              <button type="button" class="book-link-btn" @click="jumpToBook(stage.bookId)">
                《{{ stage.bookTitle }}》 · {{ stage.bookAuthor }}
              </button>
            </div>
            <p class="stage-rationale">{{ stage.rationale }}</p>
            <p class="stage-focus">
              <strong>{{ t('readingManager.focusArea') }}</strong>{{ stage.focusArea }}
            </p>
          </li>
        </ol>
      </div>
    </section>

    <footer class="dialog-footer">
      <button type="button" class="btn btn-ghost" :disabled="pathSavingList" @click="requestClose">
        {{ t('bookMetadata.close') }}
      </button>
    </footer>
  </dialog>
</template>

<style scoped>
.reading-manager-dialog {
  width: min(820px, calc(100vw - 28px));
  max-height: 90vh;
  padding: 24px;
  border: 2px solid var(--eink-solid-black, #000000);
  border-radius: var(--radius, 2px);
  background: var(--eink-surface-pure, #ffffff);
  color: var(--eink-text-primary, #000000);
  overflow-y: auto;
  box-sizing: border-box;
}
.reading-manager-dialog::backdrop {
  background: rgba(0, 0, 0, 0.35);
}
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.dialog-header h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
}
.manager-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--eink-border-hairline, #bbbbbb);
  padding-bottom: 12px;
  margin-bottom: 18px;
}
.tab-pill {
  padding: 8px 14px;
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius, 2px);
  background: var(--eink-surface-pure, #ffffff);
  color: inherit;
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
}
.tab-pill.active {
  background: var(--eink-solid-black, #000000);
  color: var(--eink-surface-pure, #ffffff);
  border-color: var(--eink-solid-black, #000000);
}
.tab-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.selector-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.step-pager {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pager-status {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.field-label {
  font-size: 13px;
  font-weight: 700;
}
.book-selector-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius, 2px);
}
.book-pick-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius-sm, 0px);
  background: var(--eink-surface-pure, #ffffff);
  color: inherit;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}
.book-pick-chip.selected {
  border: 2px solid var(--eink-solid-black, #000000);
  font-weight: 700;
}
.check-indicator {
  font-family: monospace;
  font-size: 14px;
}
.chip-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-author {
  font-size: 11px;
  color: var(--eink-text-secondary, #444444);
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.action-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.error-banner {
  padding: 10px 12px;
  border: 1px solid var(--eink-solid-black, #000000);
  border-inline-start: 4px solid var(--eink-solid-black, #000000);
  background: var(--eink-surface-card, #eeeeee);
  font-size: 13px;
  font-weight: 600;
}
.result-box {
  border-top: 1px solid var(--eink-border-hairline, #bbbbbb);
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.result-heading {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.matrix-block h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.matrix-block ul {
  margin: 0;
  padding-inline-start: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}
.perspectives-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.perspective-card {
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius, 2px);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.perspective-head {
  margin-bottom: 4px;
}
.book-link-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
  color: inherit;
  text-align: left;
}
.p-row {
  margin: 0;
  line-height: 1.5;
}
.path-overview {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--eink-text-secondary, #444444);
}
.stages-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stage-card {
  border: 1px solid var(--eink-border-hairline, #bbbbbb);
  border-radius: var(--radius, 2px);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stage-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.stage-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border: 1px solid var(--eink-solid-black, #000000);
  border-radius: var(--radius-sm, 0px);
}
.stage-rationale,
.stage-focus {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
.dialog-footer {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
}
</style>
