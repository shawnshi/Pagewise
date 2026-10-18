<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { BookMeta } from '../storage'
import { getStorage } from '../storage'
import {
  BOOK_CATEGORIES,
  createClassification,
  parseClassification,
  classificationTags,
  normalizeTagName,
  type BookClassification,
} from '../services/bookClassification'
import { saveBookClassification } from '../services/bookTagActions'
import { generateBookClassification, BookTaggingError } from '../services/bookTagging'
import { aiConfigured } from '../services/ai'
import { toast } from '../services/toast'
import { t } from '../i18n'

interface Props {
  book: BookMeta
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'updated', classification: BookClassification): void
}>()

const router = useRouter()

const original = ref<BookMeta>({ ...props.book })
function initDraft(): BookClassification {
  return props.book.classification === undefined
    ? createClassification(props.book.tags)
    : parseClassification(props.book.classification)
}
function validatedDraft(): BookClassification {
  const facets = { ...draft.value.facets }
  for (const key of ['audience', 'workCountry', 'workPeriod'] as const) {
    if (!facets[key]?.trim()) delete facets[key]
  }
  return parseClassification({ ...draft.value, facets })
}

const draft = ref<BookClassification>(initDraft())

watch(() => props.book.id, () => {
  cancelGeneration()
  onPointerUpOrCancel()
  original.value = { ...props.book }
  draft.value = initDraft()
})

const isComplete = computed(() => draft.value.category !== null && draft.value.topics.length >= 2)
const isEmpty = computed(() => !draft.value.category && draft.value.topics.length === 0)
const isConfigured = computed(() => aiConfigured())

// AI 生成与补全
const generating = ref(false)
const saving = ref(false)
const busy = computed(() => generating.value || saving.value)
const generationError = ref('')
const showDisclosure = ref(false)
let currentAbortController: AbortController | null = null
let disposed = false

function onGenerateClick() {
  if (busy.value || editingTag.value) return
  if (!isConfigured.value) {
    toast(t('classification.unconfigured'), 'info')
    router.push('/settings')
    return
  }
  if (isComplete.value) return
  generationError.value = ''
  showDisclosure.value = true
}

async function executeGeneration() {
  if (busy.value || editingTag.value) return
  showDisclosure.value = false
  generating.value = true
  generationError.value = ''
  const controller = new AbortController()
  currentAbortController = controller

  try {
    const updated = await generateBookClassification({ ...original.value, classification: validatedDraft() }, { signal: controller.signal })
    if (controller.signal.aborted || currentAbortController !== controller) return
    draft.value = parseClassification(updated)
    toast(t('common.done'), 'success', 2000)
  } catch (err: any) {
    if (err instanceof BookTaggingError && err.code === 'cancelled') {
      return
    }
    generationError.value = err?.message || '生成分类失败'
    toast(generationError.value, 'error')
  } finally {
    if (currentAbortController === controller) {
      generating.value = false
      currentAbortController = null
    }
  }
}

function cancelGeneration() {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  generating.value = false
}

watch(busy, value => {
  if (value) {
    editingTag.value = null
    confirmDeleteLocked.value = false
    onPointerUpOrCancel()
  }
}, { flush: 'sync' })

onBeforeUnmount(() => {
  disposed = true
  cancelGeneration()
  onPointerUpOrCancel()
})

// 类别编辑
function onCategoryChange(categoryId: string) {
  if (busy.value) return
  if (draft.value.category?.locked) return
  if (!categoryId) {
    draft.value.category = null
  } else {
    const existing = draft.value.category
    draft.value.category = {
      value: categoryId,
      locked: existing?.locked ?? false,
      source: 'manual',
    }
  }
}

// 主题编辑
const newTopicInput = ref('')

function addTopic() {
  if (busy.value) return
  const raw = newTopicInput.value
  if (!raw.trim()) return
  try {
    const val = normalizeTagName(raw)
    if (!val) return
    if (draft.value.topics.length >= 3) {
      toast(t('classification.topicsLimit'), 'info')
      return
    }
    if (draft.value.topics.some(t => normalizeTagName(t.value) === val)) {
      toast('主题标签已存在', 'info')
      return
    }
    const next = validatedDraft()
    next.topics.push({ value: val, locked: false, source: 'manual' })
    draft.value = parseClassification(next)
    newTopicInput.value = ''
  } catch (err: any) {
    toast(err?.message || '无效标签', 'error')
  }
}

// 特色标签
const newFeatureInput = ref('')

function addFeature() {
  if (busy.value) return
  const raw = newFeatureInput.value
  if (!raw.trim()) return
  try {
    const val = normalizeTagName(raw)
    if (!val) return
    if (draft.value.topics.some(t => normalizeTagName(t.value) === val)) {
      toast('特色标签不能与核心主题重复', 'info')
      return
    }
    const next = validatedDraft()
    next.feature = { value: val, locked: false, source: 'manual' }
    draft.value = parseClassification(next)
    newFeatureInput.value = ''
  } catch (err: any) {
    toast(err?.message || '无效特色标签', 'error')
  }
}

// 标签菜单 / 编辑
interface EditingTagState {
  role: 'category' | 'topic' | 'feature' | 'legacy'
  index?: number
  value: string
  locked: boolean
  source?: string
}

const editingTag = ref<EditingTagState | null>(null)
const confirmDeleteLocked = ref(false)

function openTagMenu(role: 'category' | 'topic' | 'feature' | 'legacy', index?: number) {
  if (busy.value || showDisclosure.value) return
  if (role === 'category') {
    if (!draft.value.category) return
    editingTag.value = {
      role: 'category',
      value: draft.value.category.value,
      locked: draft.value.category.locked,
      source: draft.value.category.source,
    }
  } else if (role === 'topic' && index !== undefined) {
    const item = draft.value.topics[index]
    if (!item) return
    editingTag.value = {
      role: 'topic',
      index,
      value: item.value,
      locked: item.locked,
      source: item.source,
    }
  } else if (role === 'feature') {
    if (!draft.value.feature) return
    editingTag.value = {
      role: 'feature',
      value: draft.value.feature.value,
      locked: draft.value.feature.locked,
      source: draft.value.feature.source,
    }
  } else if (role === 'legacy' && index !== undefined) {
    const val = draft.value.legacyTags[index]
    if (val === undefined) return
    editingTag.value = {
      role: 'legacy',
      index,
      value: val,
      locked: false,
      source: 'manual',
    }
  }
  confirmDeleteLocked.value = false
}

const panel = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
watch(() => Boolean(editingTag.value || showDisclosure.value), async opened => {
  if (opened) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    panel.value?.querySelector<HTMLElement>('[role="dialog"] input:not(:disabled), [role="dialog"] button')?.focus()
  } else returnFocus?.focus()
})
function onDialogKey(event: KeyboardEvent) {
  const dialog = panel.value?.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) return
  if (event.key === 'Escape') {
    event.preventDefault()
    editingTag.value = null
    showDisclosure.value = false
  } else if (event.key === 'Tab') {
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function saveTagEdit() {
  if (busy.value) return
  if (!editingTag.value) return
  const { role, index, value, locked } = editingTag.value
  try {
    const normalized = normalizeTagName(value)
    if (!normalized && role !== 'legacy') return

    const next = validatedDraft()
    if (role === 'category' && next.category) {
      next.category.locked = locked
    } else if (role === 'topic' && index !== undefined && next.topics[index]) {
      if (next.topics[index].locked && locked && normalized !== next.topics[index].value) throw new Error('请先解锁标签')
      next.topics[index] = {
        ...next.topics[index],
        value: normalized,
        locked,
        source: 'manual',
      }
    } else if (role === 'feature' && next.feature) {
      if (next.feature.locked && locked && normalized !== next.feature.value) throw new Error('请先解锁标签')
      next.feature = {
        ...next.feature,
        value: normalized,
        locked,
        source: 'manual',
      }
    } else if (role === 'legacy' && index !== undefined) {
      next.legacyTags[index] = value.trim()
    }
    draft.value = parseClassification(next)
    editingTag.value = null
  } catch (err: any) {
    toast(err?.message || '保存失败', 'error')
  }
}

function deleteCurrentTag() {
  if (busy.value) return
  if (!editingTag.value) return
  const { role, index } = editingTag.value
  const locked = role === 'category' ? draft.value.category?.locked
    : role === 'feature' ? draft.value.feature?.locked
    : role === 'topic' && index !== undefined ? draft.value.topics[index]?.locked : false
  if (locked && !confirmDeleteLocked.value) {
    confirmDeleteLocked.value = true
    return
  }
  if (role === 'category') {
    draft.value.category = null
  } else if (role === 'topic' && index !== undefined) {
    draft.value.topics.splice(index, 1)
  } else if (role === 'feature') {
    draft.value.feature = null
  } else if (role === 'legacy' && index !== undefined) {
    draft.value.legacyTags.splice(index, 1)
  }
  editingTag.value = null
  confirmDeleteLocked.value = false
}

// 长按支持 (触摸 / 墨水屏长按手势)
let longPressTimer: ReturnType<typeof setTimeout> | null = null

function onPointerDown(role: 'category' | 'topic' | 'feature' | 'legacy', index?: number) {
  if (busy.value) return
  if (longPressTimer) clearTimeout(longPressTimer)
  longPressTimer = setTimeout(() => {
    openTagMenu(role, index)
    longPressTimer = null
  }, 500)
}

function onPointerUpOrCancel() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

// 属性字段绑定
const textbookSelection = computed({
  get(): string {
    const val = draft.value.facets.textbook
    if (val === true) return 'true'
    if (val === false) return 'false'
    return 'unknown'
  },
  set(val: string) {
    if (val === 'true') draft.value.facets.textbook = true
    else if (val === 'false') draft.value.facets.textbook = false
    else delete draft.value.facets.textbook
  },
})

const ancientTextSelection = computed({
  get(): string {
    const val = draft.value.facets.ancientText
    if (val === true) return 'true'
    if (val === false) return 'false'
    return 'unknown'
  },
  set(val: string) {
    if (val === 'true') draft.value.facets.ancientText = true
    else if (val === 'false') draft.value.facets.ancientText = false
    else delete draft.value.facets.ancientText
  },
})

// 保存提交
async function saveClassification() {
  if (busy.value || editingTag.value || showDisclosure.value) return
  const bookId = original.value.id
  saving.value = true
  try {
    // Navigation can replace props while storage initializes; bind this write to the original book.
    const snapshot = { ...original.value, tags: [...original.value.tags],
      classification: original.value.classification === undefined ? undefined : parseClassification(original.value.classification) }
    const next = validatedDraft()
    const storage = await getStorage()
    const saved = await saveBookClassification(storage, snapshot, next)
    if (disposed || props.book.id !== bookId) return
    draft.value = parseClassification(saved)
    original.value = { ...snapshot, classification: saved, tags: classificationTags(saved) }
    toast(t('classification.saved'), 'success')
    emit('updated', saved)
  } catch (err: any) {
    if (!disposed && props.book.id === bookId) toast(t('classification.saveFailed', { msg: err?.message || err }), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section ref="panel" class="card classification-panel" data-testid="classification-panel" :aria-busy="busy" @keydown="onDialogKey">
    <header class="panel-header">
      <div class="header-left">
        <h2 class="panel-title">{{ t('classification.title') }}</h2>
        <span
          class="badge"
          :class="{ complete: isComplete, incomplete: !isComplete && !isEmpty, unclassified: isEmpty }"
          data-testid="classification-status"
        >
          {{ isComplete ? t('classification.statusComplete') : (isEmpty ? t('classification.statusUnclassified') : t('classification.statusIncomplete')) }}
        </span>
      </div>

      <div class="header-actions">
        <button
          v-if="!isConfigured"
          type="button"
          class="btn btn-sm btn-ghost"
          data-testid="ai-unconfigured-notice"
          @click="router.push('/settings')"
        >
          {{ t('classification.goToSettings') }}
        </button>

        <template v-else>
          <button
            v-if="generating"
            type="button"
            class="btn btn-sm btn-danger"
            data-testid="btn-cancel-generation"
            @click="cancelGeneration"
          >
            {{ t('classification.cancel') }}
          </button>
          <button
            v-else
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="isComplete || busy || !!editingTag || showDisclosure"
            data-testid="btn-generate-classification"
            @click="onGenerateClick"
          >
            {{ isComplete ? t('classification.statusComplete') : (isEmpty ? t('classification.generate') : t('classification.complete')) }}
          </button>
        </template>

        <button
          type="button"
          class="btn btn-sm btn-save"
          :disabled="busy || !!editingTag || showDisclosure"
          data-testid="btn-save-classification"
          @click="saveClassification"
        >
          {{ saving ? t('common.saving') : t('classification.save') }}
        </button>
      </div>
    </header>

    <!-- 错误横幅 (原标签保持不变) -->
    <div v-if="generationError" class="alert alert-error" data-testid="classification-error" role="alert">
      <span>{{ generationError }}</span>
      <button type="button" class="btn-close" aria-label="关闭提示" @click="generationError = ''">×</button>
    </div>

    <!-- 分类主体表单 -->
    <fieldset class="classification-body" :disabled="busy" style="border: 0; padding: 0; margin: 0; min-width: 0">
      <!-- 类别选择器 (固定 16 项词表) -->
      <div class="field-row">
        <label for="classification-category-select" class="field-label">
          <strong>{{ t('classification.category') }}</strong>
          <span class="required-mark" aria-hidden="true">*</span>
        </label>
        <div class="field-control">
          <select
            id="classification-category-select"
            class="input category-select"
            :value="draft.category?.value || ''"
            data-testid="select-category"
            :disabled="draft.category?.locked"
            :aria-label="t('classification.category')"
            @change="onCategoryChange(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('classification.categoryEmpty') }}</option>
            <option v-for="cat in BOOK_CATEGORIES" :key="cat.id" :value="cat.id">
              {{ cat.label }}
            </option>
          </select>
          <button v-if="draft.category" type="button" class="btn btn-sm" data-testid="btn-edit-category" @click="openTagMenu('category')">{{ t('classification.editTag') }}</button>
          <span v-if="draft.category?.locked" class="badge-lock" aria-label="类别已锁定">[已锁定]</span>
        </div>
      </div>

      <!-- 核心主题 (2-3 个) -->
      <div class="field-row">
        <label class="field-label">
          <strong>{{ t('classification.topics') }}</strong>
          <span class="field-hint">({{ draft.topics.length }}/3)</span>
          <span class="required-mark" aria-hidden="true">*</span>
        </label>
        <div class="field-control tags-control">
          <div class="chips-container" data-testid="topics-list">
            <div
              v-for="(topic, idx) in draft.topics"
              :key="idx"
              class="tag-chip eink-chip"
              data-testid="topic-chip"
              :tabindex="busy ? -1 : 0"
              :aria-disabled="busy"
              role="button"
              :aria-label="`${topic.value}，角色：核心主题${topic.locked ? '，已锁定' : ''}`"
              @contextmenu.prevent="openTagMenu('topic', idx)"
              @pointerdown="onPointerDown('topic', idx)"
              @pointerup="onPointerUpOrCancel"
              @pointercancel="onPointerUpOrCancel"
              @keydown.enter.space.prevent="openTagMenu('topic', idx)"
            >
              <span class="chip-text">{{ topic.value }}</span>
              <span v-if="topic.source === 'ai'" class="chip-provenance">[AI]</span>
              <span v-if="topic.locked" class="chip-lock" aria-label="已锁定">[锁]</span>
              <button
                type="button"
                class="chip-action-btn"
                :aria-label="`编辑主题 ${topic.value}`"
                data-testid="btn-edit-topic"
                @click.stop="openTagMenu('topic', idx)"
              >
                ✎
              </button>
            </div>
            <span v-if="!draft.topics.length" class="empty-hint">{{ t('classification.topicsEmpty') }}</span>
          </div>

          <div v-if="draft.topics.length < 3" class="add-tag-inline">
            <input
              v-model="newTopicInput"
              class="input input-sm input-new-tag"
              :placeholder="t('classification.addTopic')"
              data-testid="input-new-topic"
              :aria-label="t('classification.addTopic')"
              @keyup.enter="addTopic"
            />
            <button
              type="button"
              class="btn btn-sm"
              data-testid="btn-add-topic"
              :disabled="!newTopicInput.trim()"
              @click="addTopic"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <!-- 特色标签 (可选 0-1 个) -->
      <div class="field-row">
        <label class="field-label">
          <strong>{{ t('classification.feature') }}</strong>
          <span class="field-hint">({{ t('classification.featureOptional') }})</span>
        </label>
        <div class="field-control tags-control">
          <div v-if="draft.feature" class="chips-container">
            <div
              class="tag-chip eink-chip"
              data-testid="feature-chip"
              :tabindex="busy ? -1 : 0"
              :aria-disabled="busy"
              role="button"
              :aria-label="`${draft.feature.value}，角色：特色标签${draft.feature.locked ? '，已锁定' : ''}`"
              @contextmenu.prevent="openTagMenu('feature')"
              @pointerdown="onPointerDown('feature')"
              @pointerup="onPointerUpOrCancel"
              @pointercancel="onPointerUpOrCancel"
              @keydown.enter.space.prevent="openTagMenu('feature')"
            >
              <span class="chip-text">{{ draft.feature.value }}</span>
              <span v-if="draft.feature.source === 'ai'" class="chip-provenance">[AI]</span>
              <span v-if="draft.feature.locked" class="chip-lock" aria-label="已锁定">[锁]</span>
              <button
                type="button"
                class="chip-action-btn"
                :aria-label="`编辑特色标签 ${draft.feature.value}`"
                data-testid="btn-edit-feature"
                @click.stop="openTagMenu('feature')"
              >
                ✎
              </button>
            </div>
          </div>
          <div v-else class="add-tag-inline">
            <input
              v-model="newFeatureInput"
              class="input input-sm input-new-tag"
              :placeholder="t('classification.addFeature')"
              data-testid="input-new-feature"
              :aria-label="t('classification.addFeature')"
              @keyup.enter="addFeature"
            />
            <button
              type="button"
              class="btn btn-sm"
              data-testid="btn-add-feature"
              :disabled="!newFeatureInput.trim()"
              @click="addFeature"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <!-- 独立属性 (Facets, 独立于标签数量) -->
      <div class="facets-block card" data-testid="facets-section">
        <h3 class="facets-title">{{ t('classification.facets') }}</h3>
        <div class="facets-grid">
          <div class="facet-item">
            <label for="facet-audience" class="facet-label">{{ t('classification.audience') }}</label>
            <input
              id="facet-audience"
              v-model="draft.facets.audience"
              class="input input-sm"
              :placeholder="t('classification.audiencePlaceholder')"
              data-testid="input-facet-audience"
            />
          </div>

          <div class="facet-item">
            <label for="facet-textbook" class="facet-label">{{ t('classification.textbook') }}</label>
            <select
              id="facet-textbook"
              v-model="textbookSelection"
              class="input input-sm"
              data-testid="select-facet-textbook"
            >
              <option value="unknown">{{ t('classification.facetUnknown') }}</option>
              <option value="true">{{ t('classification.textbookYes') }}</option>
              <option value="false">{{ t('classification.textbookNo') }}</option>
            </select>
          </div>

          <div class="facet-item">
            <label for="facet-ancient" class="facet-label">{{ t('classification.ancientText') }}</label>
            <select
              id="facet-ancient"
              v-model="ancientTextSelection"
              class="input input-sm"
              data-testid="select-facet-ancient"
            >
              <option value="unknown">{{ t('classification.facetUnknown') }}</option>
              <option value="true">{{ t('classification.ancientYes') }}</option>
              <option value="false">{{ t('classification.ancientNo') }}</option>
            </select>
          </div>

          <div class="facet-item">
            <label for="facet-country" class="facet-label">{{ t('classification.workCountry') }}</label>
            <input
              id="facet-country"
              v-model="draft.facets.workCountry"
              class="input input-sm"
              :placeholder="t('classification.countryPlaceholder')"
              data-testid="input-facet-country"
            />
          </div>

          <div class="facet-item">
            <label for="facet-period" class="facet-label">{{ t('classification.workPeriod') }}</label>
            <input
              id="facet-period"
              v-model="draft.facets.workPeriod"
              class="input input-sm"
              :placeholder="t('classification.periodPlaceholder')"
              data-testid="input-facet-period"
            />
          </div>
        </div>
      </div>

      <!-- 折叠历史旧标签 (保留原始历史，不猜测角色) -->
      <details v-if="draft.legacyTags.length" class="legacy-details" data-testid="legacy-tags-section">
        <summary class="legacy-summary">
          <span>{{ t('classification.legacyTags') }} ({{ draft.legacyTags.length }})</span>
        </summary>
        <div class="chips-container legacy-chips">
          <span
            v-for="(lt, idx) in draft.legacyTags"
            :key="idx"
            class="tag-chip legacy-chip"
          >
            {{ lt }}
            <button
              type="button"
              class="chip-action-btn"
              :aria-label="`删除历史标签 ${lt}`"
              @click="draft.legacyTags.splice(idx, 1)"
            >
              ×
            </button>
          </span>
        </div>
      </details>
    </fieldset>

    <!-- AI 生成须知与数据范围确认弹窗 -->
    <div v-if="showDisclosure" class="modal-mask" data-testid="ai-disclosure-modal" @click.self="showDisclosure = false">
      <div class="modal eink-modal" role="dialog" aria-modal="true" aria-labelledby="disclosure-title">
        <h3 id="disclosure-title">{{ t('classification.disclosureTitle') }}</h3>
        <p class="disclosure-body">
          {{ t('classification.disclosureText') }}
        </p>
        <ul class="disclosure-list">
          <li><strong>包含数据：</strong>书名、作者、出版社、出版日期、书籍简介及已有分类标签（不含历史标签）。</li>
          <li><strong>绝不包含：</strong>书籍正文、目录、笔记标注、阅读进度、用户个人隐私。</li>
        </ul>
        <div class="form-actions">
          <button type="button" class="btn btn-sm" data-testid="btn-disclosure-cancel" @click="showDisclosure = false">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn-sm btn-primary" data-testid="btn-disclosure-confirm" @click="executeGeneration">
            {{ t('classification.disclosureConsent') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 单标签编辑与操作弹窗 -->
    <div v-if="editingTag" class="modal-mask" data-testid="tag-edit-dialog" @click.self="editingTag = null">
      <div class="modal eink-modal" role="dialog" aria-modal="true" aria-labelledby="tag-menu-title">
        <h3 id="tag-menu-title">{{ t('classification.editTag') }}</h3>
        <div class="tag-menu-form">
          <label>
            <span>标签名称</span>
            <input
              v-model="editingTag.value"
              class="input"
              :disabled="busy || editingTag.role === 'category'"
              autofocus
            />
          </label>

          <label v-if="editingTag.role !== 'legacy'" class="checkbox-label">
            <input
              v-model="editingTag.locked"
              type="checkbox"
              data-testid="checkbox-tag-lock"
              :disabled="busy"
            />
            <span>{{ t('classification.locked') }} ({{ t('classification.lockHint') }})</span>
          </label>

          <div v-if="confirmDeleteLocked" class="alert alert-warning" role="alert">
            {{ t('classification.deleteLockedConfirm', { tag: editingTag.value }) }}
          </div>
        </div>

        <div class="form-actions">
          <button
            type="button"
            class="btn btn-sm btn-danger"
            data-testid="btn-delete-tag"
            :disabled="busy"
            @click="deleteCurrentTag"
          >
            {{ confirmDeleteLocked ? t('common.confirm') + ' ' + t('common.delete') : t('common.delete') }}
          </button>
          <button type="button" class="btn btn-sm" @click="editingTag = null">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="busy" @click="saveTagEdit">
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.classification-panel {
  margin-top: 20px;
  padding: 16px 20px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.badge.complete {
  background: var(--surface-2);
  color: var(--text);
  font-weight: 600;
}
.badge.incomplete {
  background: var(--surface-2);
  color: var(--text-2);
  border-style: dashed;
}
.badge.unclassified {
  background: var(--surface-3);
  color: var(--text-3);
}

.classification-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}

.field-hint {
  font-size: 12px;
  color: var(--text-2);
}

.required-mark {
  color: var(--text-3);
  font-weight: bold;
}

.field-control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.category-select {
  min-width: 200px;
  max-width: 320px;
}

.chips-container {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* 墨水屏静态可读标签 */
.tag-chip.eink-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--text);
  background: var(--card);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.tag-chip.eink-chip:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.chip-lock {
  font-size: 11px;
  font-weight: bold;
}

.chip-provenance {
  font-size: 11px;
  color: var(--text-2);
}

.chip-action-btn {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
}

.add-tag-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.input-new-tag {
  width: 140px;
}

/* 属性板块 */
.facets-block {
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.facets-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 10px 0;
}

.facets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.facet-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.facet-label {
  font-size: 12px;
  color: var(--text-2);
}

/* 历史标签折叠 */
.legacy-details {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.legacy-summary {
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  margin-bottom: 8px;
}

.legacy-chips {
  margin-top: 8px;
}

.legacy-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-2);
}

/* 弹窗与须知 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.eink-modal {
  background: var(--card);
  border: 2px solid var(--text);
  border-radius: var(--radius);
  padding: 20px 24px;
  max-width: 480px;
  width: 90%;
  color: var(--text);
}

.disclosure-body {
  font-size: 14px;
  line-height: 1.6;
  margin: 12px 0;
}

.disclosure-list {
  font-size: 13px;
  line-height: 1.6;
  margin: 8px 0 16px 20px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.tag-menu-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 16px 0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.alert-error {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--danger, #b00);
  background: var(--surface-2);
  color: var(--text);
  font-size: 13px;
}

.btn-close {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
}
</style>
