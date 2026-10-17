<script setup lang="ts">
/** 藏书页书单里的「待找」条目: 还不在藏书里的书, 导入/下载后由 library.refresh 自动归进书单 */
import { computed, nextTick, ref } from 'vue'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { yearLabel } from '../services/booklists'
import { toast } from '../services/toast'
import { t } from '../i18n'
import type { BooklistWantedRec } from '../storage'

const props = defineProps<{ booklistId: string; keyword?: string }>()

const library = useLibrary()
const settings = useSettings()

const all = computed(() => library.booklistWanted[props.booklistId] ?? [])
const entries = computed(() => {
  const kw = (props.keyword ?? '').trim().toLowerCase()
  if (!kw) return all.value
  return all.value.filter(entry =>
    entry.title.toLowerCase().includes(kw)
    || entry.author.toLowerCase().includes(kw)
    || (entry.originalTitle ?? '').toLowerCase().includes(kw))
})

const adding = ref(false)
const titleDraft = ref('')
const authorDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

async function openAdd() {
  adding.value = true
  await nextTick()
  titleInput.value?.focus()
}

async function add() {
  const title = titleDraft.value.trim()
  if (!title) return
  const result = await library.addEntriesToBooklist(props.booklistId, [{ title, author: authorDraft.value.trim() }])
  if (result.linked) toast(t('booklist.wantedLinked', { title }), 'success', 4000)
  else if (result.wanted) toast(t('booklist.wantedAdded', { title }), 'success')
  else toast(t('booklist.wantedExists'), 'info')
  titleDraft.value = ''
  authorDraft.value = ''
  titleInput.value?.focus()
}

async function remove(entry: BooklistWantedRec) {
  await library.removeWanted([entry.id])
}

const year = (entry: BooklistWantedRec) => yearLabel(entry.year, settings.language === 'en' ? 'en' : 'zh')
</script>

<template>
  <section class="wanted-panel" :aria-label="t('booklist.wantedTitle')">
    <div v-if="all.length" class="wanted-head">
      <div class="wanted-heading">
        <h3>{{ t('booklist.wantedTitle') }} <span class="wanted-count">{{ all.length }}</span></h3>
        <p>{{ t('booklist.wantedHint') }}</p>
      </div>
      <button v-if="!adding" class="btn btn-sm" @click="openAdd">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
        {{ t('booklist.addWanted') }}
      </button>
    </div>
    <button v-else-if="!adding" class="wanted-add-row" @click="openAdd">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
      <span>{{ t('booklist.addWanted') }}</span>
      <span class="wanted-add-hint">{{ t('booklist.wantedHint') }}</span>
    </button>

    <form v-if="adding" class="wanted-form card" @submit.prevent="add">
      <input
        ref="titleInput"
        v-model="titleDraft"
        class="input"
        maxlength="200"
        :placeholder="t('booklist.wantedTitlePlaceholder')"
        :aria-label="t('booklist.wantedTitlePlaceholder')"
      />
      <input
        v-model="authorDraft"
        class="input"
        maxlength="120"
        :placeholder="t('booklist.wantedAuthorPlaceholder')"
        :aria-label="t('booklist.wantedAuthorPlaceholder')"
      />
      <button type="submit" class="btn btn-sm btn-primary" :disabled="!titleDraft.trim()">{{ t('common.add') }}</button>
      <button type="button" class="btn btn-sm" @click="adding = false">{{ t('common.cancel') }}</button>
    </form>

    <ul v-if="entries.length" class="wanted-list">
      <li v-for="entry in entries" :key="entry.id" class="wanted-card">
        <span class="wanted-spine" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 2.4"><path d="M6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3z"/></svg>
        </span>
        <div class="wanted-main">
          <span class="wanted-title">{{ entry.title }}</span>
          <span class="wanted-meta">
            <template v-if="entry.author">{{ entry.author }}</template>
            <template v-if="year(entry)"><template v-if="entry.author"> · </template>{{ year(entry) }}</template>
            <template v-if="entry.originalTitle"> · {{ entry.originalTitle }}</template>
          </span>
          <span v-if="entry.note" class="wanted-note">{{ entry.note }}</span>
        </div>
        <div class="wanted-acts">
          <button
            class="btn btn-sm btn-icon btn-ghost"
            :title="t('booklist.removeWantedNamed', { title: entry.title })"
            :aria-label="t('booklist.removeWantedNamed', { title: entry.title })"
            @click="remove(entry)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z"/></svg>
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.wanted-panel {
  margin-top: 28px;
}
.wanted-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.wanted-heading h3 {
  font-size: 15px;
  font-weight: 650;
  display: flex;
  align-items: center;
  gap: 8px;
}
.wanted-count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  display: inline-grid;
  place-items: center;
}
.wanted-heading p {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.wanted-add-row {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 12px 16px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.wanted-add-row:hover {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
}
.wanted-add-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.wanted-add-hint {
  flex-basis: 100%;
  padding-left: 26px;
  font-size: 12px;
  color: var(--text-3);
}
.wanted-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.wanted-form .input {
  flex: 1 1 200px;
  min-width: 0;
}
.wanted-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
}
.wanted-card {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 12px 12px 10px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-2);
}
.wanted-spine {
  width: 34px;
  height: 44px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  background: var(--card);
  color: var(--text-3);
}
.wanted-main {
  flex: 1 1 160px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wanted-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.wanted-meta {
  font-size: 12px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.wanted-note {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.wanted-acts {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.wanted-find {
  color: var(--brand);
}

@media (max-width: 720px) {
  .wanted-panel {
    margin-top: 20px;
  }
  .wanted-list {
    grid-template-columns: 1fr;
  }
  .wanted-acts {
    margin-left: 46px;
  }
}
</style>
