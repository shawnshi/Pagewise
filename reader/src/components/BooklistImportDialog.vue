<script setup lang="ts">
/** 导入书单: 粘贴分享文本 (轻阅书单 JSON 或「1.《书名》— 作者」清单) 或选择书单文件; 藏书里有的直接关联, 其余为待找 */
import { computed, ref, watch } from 'vue'
import { useLibrary } from '../stores/library'
import { findMatchingBook, parseShareText } from '../services/booklists'
import { toast } from '../services/toast'
import { t } from '../i18n'

const emit = defineEmits<{ close: []; imported: [id: string] }>()

const library = useLibrary()
const text = ref('')
const name = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const parsed = computed(() => parseShareText(text.value))
const ownedCount = computed(() =>
  parsed.value?.books.filter(book => findMatchingBook({ ...book, originalTitle: book.original?.title, originalAuthor: book.original?.author }, library.books)).length ?? 0)

// 识别出书单时预填书单名 (用户改过就不再覆盖)
let autoName = ''
watch(parsed, share => {
  if (share && (!name.value.trim() || name.value === autoName)) {
    name.value = share.name
    autoName = share.name
  }
})

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 2 * 1024 * 1024) {
    toast(t('booklist.importInvalid'), 'error')
    return
  }
  text.value = await file.text()
}

async function doImport() {
  const share = parsed.value
  if (!share || busy.value) return
  busy.value = true
  try {
    const entries = share.books.map(({ original, ...book }) => ({
      ...book,
      originalTitle: original?.title,
      originalAuthor: original?.author,
    }))
    const result = await library.saveEntriesAsBooklist(name.value.trim() || share.name, entries, { uniqueName: true })
    toast(t('booklist.imported', { name: result.name, linked: result.linked, wanted: result.wanted }), 'success', 5000)
    emit('imported', result.id)
    emit('close')
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-import-title" @keydown.esc.stop="emit('close')">
      <h3 id="booklist-import-title">{{ t('booklist.import') }}</h3>
      <p class="import-hint">{{ t('booklist.importHint') }}</p>
      <textarea
        v-model="text"
        class="input import-text"
        rows="8"
        :placeholder="t('booklist.importPlaceholder')"
        :aria-label="t('booklist.importPlaceholder')"
      />
      <div class="import-file-row">
        <button class="btn btn-sm" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>
          {{ t('booklist.chooseFile') }}
        </button>
        <input ref="fileInput" type="file" accept=".json,.txt,.md,application/json,text/plain,text/markdown" hidden @change="onFile" />
        <span v-if="parsed" class="import-preview" role="status">{{ t('booklist.importPreview', { n: parsed.books.length, owned: ownedCount }) }}</span>
        <span v-else-if="text.trim()" class="import-preview invalid" role="status">{{ t('booklist.importInvalid') }}</span>
      </div>
      <label v-if="parsed" class="import-name">
        <span>{{ t('booklist.importName') }}</span>
        <input v-model="name" class="input" maxlength="40" />
      </label>
      <div class="import-actions">
        <button class="btn btn-sm" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-sm btn-primary" :disabled="!parsed || busy" @click="doImport">{{ t('booklist.import') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-modal {
  width: min(560px, 100%);
}
.import-hint {
  margin: -6px 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.import-text {
  width: 100%;
  font-size: 13px;
}
.import-file-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-top: 10px;
}
.import-preview {
  font-size: 12px;
  color: var(--success);
}
.import-preview.invalid {
  color: var(--danger);
}
.import-name {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-3);
}
.import-name .input {
  width: 100%;
}
.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
