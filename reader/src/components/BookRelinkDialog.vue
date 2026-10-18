<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BookMeta } from '../storage'
import { useFolderLibrary } from '../services/folderLibrary'
import { toast } from '../services/toast'
import { t } from '../i18n'

const folderLibrary = useFolderLibrary()
const props = defineProps<{ book: BookMeta }>()
const emit = defineEmits<{ close: []; recovered: [] }>()
const dialog = ref<HTMLDialogElement>()
const candidates = ref<Awaited<ReturnType<typeof folderLibrary.relinkCandidates>>>()
const documentId = ref('')
const confirmed = ref(false)
watch(documentId, () => { confirmed.value = false }, { flush: 'sync' })
const busy = ref(true)
const saving = ref(false)
const error = ref('')
let disposed = false
onBeforeUnmount(() => { disposed = true })

onMounted(async () => {
  dialog.value?.showModal()
  try {
    const result = await folderLibrary.relinkCandidates(props.book.id)
    if (!disposed) candidates.value = result
  } catch (err) {
    if (!disposed) error.value = t('library.operationFailed', { message: err instanceof Error ? err.message : String(err) })
  } finally { if (!disposed) busy.value = false }
})

async function recover() {
  if (!candidates.value || !documentId.value || !confirmed.value || busy.value) return
  busy.value = true
  saving.value = true
  error.value = ''
  try {
    await folderLibrary.relink(props.book.id, candidates.value.folderId, documentId.value, confirmed.value)
    toast(t('library.relinkSuccess'), 'success')
    emit('recovered')
  } catch (err) {
    if (!disposed) error.value = t('library.relinkFailed', { message: err instanceof Error ? err.message : String(err) })
  } finally { if (!disposed) { busy.value = false; saving.value = false } }
}
</script>

<template>
  <dialog ref="dialog" class="relink-dialog" aria-labelledby="relink-title" @cancel.prevent="!saving && emit('close')">
    <h2 id="relink-title">{{ t('library.relinkTitle') }}</h2>
    <p class="book-title">{{ book.title }}</p>
    <p>{{ t('library.relinkWarning') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">{{ t('common.loading') }}</p>
    <template v-else-if="candidates?.files.length">
      <label for="relink-candidate">{{ t('library.chooseCandidate') }}</label>
      <select id="relink-candidate" v-model="documentId" class="input">
        <option value="">—</option>
        <option v-for="file in candidates.files" :key="file.documentId" :value="file.documentId">{{ file.relativePath || file.name }}</option>
      </select>
      <label class="confirm-edition"><input v-model="confirmed" type="checkbox">{{ t('library.confirmEdition') }}</label>
    </template>
    <p v-else-if="!error">{{ t('library.noCandidates') }}</p>
    <footer>
      <button type="button" class="btn" :disabled="saving" @click="emit('close')">{{ t('common.cancel') }}</button>
      <RouterLink v-if="!busy" class="btn" to="/settings?section=folder" @click="emit('close')">{{ t('library.folderSettings') }}</RouterLink>
      <button type="button" class="btn btn-primary" :disabled="busy || !documentId || !confirmed" @click="recover">{{ t('library.relink') }}</button>
    </footer>
  </dialog>
</template>

<style scoped>
.relink-dialog { width: min(580px, calc(100vw - 32px)); padding: 24px; border: 2px solid var(--text); border-radius: 8px; background: var(--surface); color: var(--text); }
.relink-dialog::backdrop { background: rgb(0 0 0 / 35%); }
h2 { margin: 0 0 12px; font-size: 20px; }
p { line-height: 1.65; overflow-wrap: anywhere; }
.book-title { font-weight: 700; }
select { width: 100%; margin-top: 8px; }
.confirm-edition { display: flex; align-items: center; gap: 10px; min-height: 48px; margin-top: 12px; }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.btn { min-height: 44px; }
</style>
