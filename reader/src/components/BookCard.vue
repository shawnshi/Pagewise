<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { BookMeta } from '../storage'
import { FORMAT_LABELS, isSupportedBookFormat } from '../services/format'
import { formatReadingTime } from '../composables/useReadingTimer'
import { resolveReadingStatus } from '../services/readingStatus'
import { bookFileProblem, visibleBookTopics } from '../services/bookAvailability'
import AppIcon from './AppIcon.vue'
import { t } from '../i18n'

const props = defineProps<{
  book: BookMeta
  coverUrl?: string
  /** 管理模式: 点击变为选择 */
  selectable?: boolean
  selected?: boolean
}>()

const emit = defineEmits<{
  open: []
  read: []
  remove: []
  toggleSelect: []
  togglePin: []
  rescan: []
}>()

const readable = computed(() => isSupportedBookFormat(props.book.format))
const fileProblem = computed(() => bookFileProblem(props.book))
const topics = computed(() => visibleBookTopics(props.book))
const recoveryLabel = computed(() => t(fileProblem.value === 'permission-denied' ? 'library.reauthorize' : 'library.relink'))
const statusInfo = computed(() => resolveReadingStatus(props.book))
const progress = computed(() => {
  const p = props.book.progress
  if (p == null) return null
  return Math.min(100, Math.max(0, Math.round(p * 100)))
})

const tooltip = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (props.book.readingSeconds && props.book.readingSeconds >= 60) {
    parts.push(t('book.readTime', { time: formatReadingTime(props.book.readingSeconds) }))
  }
  return parts.join('\n')
})

const ariaLabel = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (progress.value != null) parts.push(`${progress.value}%`)
  if (fileProblem.value) parts.push(t(fileProblem.value === 'missing' ? 'library.fileMissing' : 'library.filePermission'))
  parts.push(t('uiV02.status.' + (statusInfo.value.effective ?? 'unmarked')))
  return parts.join(', ')
})

// 无封面时由书名生成稳定的柔和底色
const fallbackHue = computed(() => {
  let hash = 0
  for (const ch of props.book.title) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash) % 360
})

function activate() {
  if (props.selectable) emit('toggleSelect')
  else emit('open')
}

/* 触屏设备: 封面操作收进「更多」按钮, 点一下展开, 点别处收起 */
const menuOpen = ref(false)
const actionsEl = ref<HTMLElement | null>(null)
function closeMenu() {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onOutsidePointerDown, true)
}
function onOutsidePointerDown(e: PointerEvent) {
  // 按下点在菜单内部时不能收起: 收起会让按钮瞬间 pointer-events:none,
  // 随后的 click 命中测试会落到卡片上, 变成打开书籍 (触屏专属问题)
  if (actionsEl.value && e.target instanceof Node && actionsEl.value.contains(e.target)) return
  closeMenu()
}
function toggleMenu() {
  if (menuOpen.value) return closeMenu()
  openMenu()
}
function openMenu() {
  if (menuOpen.value) return
  menuOpen.value = true
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePointerDown, true))
}
function menuAction(event: 'read' | 'remove' | 'togglePin' | 'rescan') {
  closeMenu()
  if (event === 'read') emit('read')
  else if (event === 'remove') emit('remove')
  else if (event === 'togglePin') emit('togglePin')
  else if (event === 'rescan') emit('rescan')
}
/* 触屏长按封面: 与点「更多」一样展开操作 (系统的长按菜单无意义, 拦掉) */
function onContextMenu(e: Event) {
  if (props.selectable || !window.matchMedia('(hover: none)').matches) return
  e.preventDefault()
  openMenu()
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePointerDown, true))

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activate()
  }
}
</script>

<template>
  <article class="book-card" :class="{ selected: selectable && selected, selectable, 'menu-open': menuOpen }">
    <div class="book-body" :title="tooltip" :role="selectable ? 'checkbox' : 'button'"
      :aria-checked="selectable ? selected : undefined" :aria-label="ariaLabel"
      tabindex="0" @click="activate" @keydown="onKeydown" @contextmenu="onContextMenu">
      <div class="cover">
        <img v-if="coverUrl" :src="coverUrl" alt="" loading="lazy" decoding="async" />
        <div v-else class="cover-fallback" :style="{ '--h': fallbackHue }" aria-hidden="true">{{ book.title }}</div>
        <span v-if="selectable" class="select-mark" aria-hidden="true">{{ selected ? '✓' : '□' }}</span>
      </div>
      <div class="book-meta">
        <div class="book-heading">
          <h2 class="title">{{ book.title }}</h2>
          <p class="book-state">
            <strong v-if="fileProblem" class="file-problem">{{ t(fileProblem === 'missing' ? 'library.fileMissing' : 'library.filePermission') }}</strong>
            <span>{{ statusInfo.effective ? t('uiV02.status.' + statusInfo.effective) : t('uiV02.status.unmarked') }}</span>
            <span v-if="progress != null"> · {{ progress }}%</span>
          </p>
        </div>
        <p v-if="book.author" class="author">{{ book.author }}</p>
        <div class="book-tags">
          <span class="format-label">{{ FORMAT_LABELS[book.format] || book.format }}</span>
          <span v-for="tag in topics" :key="tag">{{ tag }}</span>
          <span v-if="!readable" class="format-label">{{ t('library.retiredFormat') }}</span>
        </div>
      </div>
    </div>
    <div v-if="!selectable" ref="actionsEl" class="actions">
      <button v-if="readable" type="button" class="action read-action" @click.stop="menuAction('read')">
        {{ fileProblem ? recoveryLabel : progress != null && progress > 0 ? t('catalog.continueReading') : t('settings.navReading') }}
      </button>
      <button type="button" class="action more" :aria-label="t('common.moreActions')" :aria-expanded="menuOpen" @click.stop="toggleMenu">
        <AppIcon name="more" :size="20" aria-hidden="true" />
        <span class="action-text">{{ t('common.more') }}</span>
      </button>
      <div v-if="menuOpen" class="book-menu">
        <button v-if="book.sourceRef" type="button" class="action" @click.stop="menuAction('rescan')">{{ t('folder.rescan') }}</button>
        <button type="button" class="action pin" :aria-pressed="!!book.pinnedAt" @click.stop="menuAction('togglePin')">
          <AppIcon name="pin" :size="16" aria-hidden="true" />
          <span>{{ book.pinnedAt ? t('library.unpin') : t('library.pin') }}</span>
        </button>
        <button v-if="!book.sourceRef" type="button" class="action remove" @click.stop="menuAction('remove')">
          <AppIcon name="delete" :size="16" aria-hidden="true" />
          <span>{{ t('book.removeFromLibrary') }}</span>
        </button>
        <div v-else class="action-source-notice" :title="t('book.sourceManagedHint')">
          <AppIcon name="folder" :size="16" aria-hidden="true" />
          <span>{{ t('book.sourceManaged') }}</span>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.book-card { display: flex; align-items: center; gap: 16px; position: relative; border-bottom: 1px solid var(--eink-border-hairline); background: var(--eink-surface-pure); padding: 14px 6px; color: var(--eink-text-primary); }
.book-body { display: flex; align-items: center; gap: 16px; min-width: 0; flex: 1; cursor: pointer; border-radius: 2px; padding: 4px; }
.book-body:focus-visible, .action:focus-visible { outline: 2px solid var(--eink-solid-black); outline-offset: 2px; }
.cover { position: relative; width: 58px; height: 82px; flex: 0 0 58px; overflow: hidden; border: 1px solid var(--eink-border-hairline); background: var(--eink-surface-subtle); box-sizing: border-box; padding: 1px; }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-fallback { font-family: var(--font-serif); font-size: 11px; font-weight: 600; line-height: 1.35; padding: 6px 3px; overflow: hidden; text-align: center; display: flex; align-items: center; justify-content: center; height: 100%; color: var(--eink-text-primary); }
.select-mark { position: absolute; top: 0; left: 0; background: var(--eink-surface-pure); font-size: 16px; line-height: 20px; width: 22px; height: 22px; text-align: center; border-right: 1px solid var(--eink-solid-black); border-bottom: 1px solid var(--eink-solid-black); font-weight: 700; color: var(--eink-solid-black); }
.selected { outline: 2px solid var(--eink-solid-black); outline-offset: -2px; }
.selected .cover { filter: invert(1); }
.book-meta { min-width: 0; flex: 1; }
.book-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 2px 16px; }
.book-state { flex-shrink: 0; font-family: var(--font-mono); font-feature-settings: "tnum" 1; font-size: 12px; color: var(--eink-text-secondary); font-weight: 500; }
.file-problem { display: inline-block; border: 1px solid var(--eink-solid-black); padding: 1px 5px; margin-inline-end: 8px; color: var(--eink-text-primary); font-size: 11px; font-weight: 600; }
.selected .title { font-weight: 700; }
.book-tags .format-label { border: 1px solid var(--eink-border-hairline); padding: 1px 5px; font-weight: 600; background: var(--eink-surface-subtle); }
.title { font-family: var(--font-serif); margin: 0; min-width: 0; flex: 1 1 160px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 17px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; color: var(--eink-text-primary); }
.author { margin: 3px 0; color: var(--eink-text-secondary); font-size: 13px; }
.book-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; font-size: 11px; }
.book-tags span { border: 1px solid var(--eink-border-hairline); background: var(--eink-surface-pure); padding: 1px 6px; border-radius: 2px; color: var(--eink-text-secondary); }
.actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; position: relative; }
.action { background: var(--eink-surface-pure); color: var(--eink-text-primary); border: 1px solid var(--eink-border-hairline); min-height: 38px; min-width: 38px; padding: 6px 12px; border-radius: 2px; cursor: pointer; font-size: 13px; font-weight: 500; }
.action:hover { background: var(--eink-surface-subtle); border-color: var(--eink-solid-black); }
.action:active { background: var(--eink-solid-black); color: var(--eink-surface-pure); }
.read-action { background: var(--eink-solid-black); color: var(--eink-surface-pure); border-color: var(--eink-solid-black); font-weight: 600; }
.read-action:hover { background: var(--eink-text-primary); }
.read-action:active { background: var(--eink-surface-pure); color: var(--eink-solid-black); }
.more { border-color: var(--eink-border-hairline); display: inline-flex; align-items: center; gap: 4px; }
.action-text { font-size: 13px; }
.action-source-notice { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; color: var(--eink-text-secondary); background: var(--eink-surface-subtle); border: 1px solid var(--eink-border-hairline); border-radius: 2px; }
.book-menu { z-index: 30; position: absolute; top: 100%; right: 0; width: 180px; display: grid; background: var(--eink-surface-pure); padding: 6px; border: 1.5px solid var(--eink-solid-black); gap: 4px; box-shadow: none; }
.book-menu .action { text-align: start; border-color: var(--eink-border-hairline); min-height: 36px; }
@media (max-width: 520px) { .book-card { gap: 8px; } .book-body { gap: 10px; } .actions { flex-direction: column; gap: 4px; } .action { padding: 6px 8px; } .title { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
