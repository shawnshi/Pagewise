<script setup lang="ts">
/** 分享书单: 轻阅书单文件 (JSON, 可被「导入书单」还原) 或适合发到聊天里的纯文本清单. 只含书目, 不含文件 */
import { computed, ref } from 'vue'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { isTauri } from '../storage'
import { buildShare, shareFileName, shareToJson, shareToMarkdown, type BooklistEntry } from '../services/booklists'
import { toast } from '../services/toast'
import { t } from '../i18n'

const props = defineProps<{ booklistId: string }>()
const emit = defineEmits<{ close: [] }>()

const library = useLibrary()
const settings = useSettings()
const mode = ref<'file' | 'text'>('file')

const booklist = computed(() => library.booklists.find(item => item.id === props.booklistId))

/** 已在藏书的书 (按加入书单的顺序) + 待找条目 */
const entries = computed<BooklistEntry[]>(() => {
  const byId = new Map(library.books.map(book => [book.id, book]))
  const owned = (library.booklistBookIds[props.booklistId] ?? [])
    .map(id => byId.get(id))
    .filter(book => book && (book.kind ?? 'book') === 'book')
    .map(book => ({ title: book!.title, author: book!.author }))
  const wanted = (library.booklistWanted[props.booklistId] ?? []).map(({ id: _id, booklistId: _l, addedAt: _a, ...entry }) => entry)
  return [...owned, ...wanted]
})

const share = computed(() => buildShare(booklist.value?.name ?? '', entries.value))
const lang = computed(() => (settings.language === 'en' ? 'en' : 'zh'))
const content = computed(() => (mode.value === 'file' ? shareToJson(share.value) : shareToMarkdown(share.value, lang.value)))

async function copy() {
  try {
    await navigator.clipboard.writeText(content.value)
    toast(t('booklist.copied'), 'success')
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error')
  }
}

async function saveFile() {
  const name = shareFileName(share.value.name)
  const json = shareToJson(share.value)
  try {
    if (isTauri()) {
      const [{ save }, { writeFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ])
      const path = await save({ defaultPath: name, filters: [{ name: 'Pagewise booklist', extensions: ['json'] }] })
      if (!path) return
      await writeFile(path, new TextEncoder().encode(json))
    } else {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.hidden = true
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    toast(t('booklist.saved'), 'success')
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-share-title" @keydown.esc.stop="emit('close')">
      <h3 id="booklist-share-title">{{ t('booklist.shareTitle', { name: booklist?.name ?? '' }) }}</h3>
      <p class="share-hint">{{ t('booklist.shareHint') }}</p>
      <div class="segmented share-modes">
        <button :class="{ active: mode === 'file' }" :aria-pressed="mode === 'file'" @click="mode = 'file'">{{ t('booklist.shareFile') }}</button>
        <button :class="{ active: mode === 'text' }" :aria-pressed="mode === 'text'" @click="mode = 'text'">{{ t('booklist.shareText') }}</button>
      </div>
      <p v-if="mode === 'text'" class="share-hint sub">{{ t('booklist.shareTextHint') }}</p>
      <textarea class="input share-content" readonly rows="10" :value="content" :aria-label="mode === 'file' ? t('booklist.shareFile') : t('booklist.shareText')" @focus="($event.target as HTMLTextAreaElement).select()" />
      <div class="share-actions">
        <span class="share-count">{{ t('booklist.bookCount', { n: share.books.length }) }}</span>
        <button class="btn btn-sm" @click="emit('close')">{{ t('common.close') }}</button>
        <button v-if="mode === 'file'" class="btn btn-sm" @click="saveFile">{{ t('booklist.saveFile') }}</button>
        <button class="btn btn-sm btn-primary" @click="copy">{{ t('booklist.copy') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-modal {
  width: min(600px, 100%);
}
.share-hint {
  margin: -6px 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.share-hint.sub {
  margin: 10px 0 0;
}
.share-content {
  width: 100%;
  margin-top: 10px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  white-space: pre;
  overflow: auto;
  background: var(--surface-2);
}
.share-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.share-count {
  margin-right: auto;
  font-size: 12px;
  color: var(--text-3);
}
</style>
