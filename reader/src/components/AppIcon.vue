<script setup lang="ts">
import { computed } from 'vue'
import { iconMarkup, markedBookmarkMarkup, type PagewiseIconName } from './menuIcons'

const props = withDefaults(defineProps<{
  name: string
  size?: number | string
  ariaHidden?: boolean | 'true' | 'false'
  emphasis?: boolean
  marked?: boolean
}>(), { ariaHidden: true, emphasis: false, marked: false })

const MENU_ICONS: Record<string, PagewiseIconName> = {
  library: 'library',
  reading: 'currently-reading',
  notes: 'notes',
  annotations: 'annotations',
  history: 'reading-history',
  stats: 'reading-history',
  settings: 'settings',
  toc: 'table-of-contents',
  typography: 'typography',
  search: 'search-library',
  searchInBook: 'search-in-book',
  ai: 'reading-assistant',
  audio: 'read-aloud',
  readingModes: 'reading-modes',
  bookmarks: 'bookmarks',
  bookmark: 'bookmarks',
  bookmarkBorder: 'bookmarks',
}

const ICONS: Record<string, string> = {
  // PDF page-layout controls are not navigation destinations.
  singlePage: 'M18 2H6c-1.1 0-2 .9-2 2v16l7-3 7 3V4c0-1.1-.9-2-2-2zm0 15-5-2.18L8 17V4h10v13z',
  facingPages: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM9 7h7M9 11h5',
  // 监测文件夹 / Folder
  folder:
    'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  // 刷新 / Refresh
  refresh:
    'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  // 信息 / Info
  info:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm-1-7h2v6h-2zm0-4h2v2h-2z',
  // 返回 / Back
  back:
    'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  // 全屏 / Fullscreen
  fullscreen:
    'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fullscreenExit:
    'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  // 更多 / More
  more:
    'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  next: 'M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4z',
  thumbnails: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z',
  zoomIn: 'M15.5 14h-.79l-.28-.27A6.5 6.5 0 1 0 13.73 14l.27.28v.79L20 21l1-1-5.5-6zM9.5 14a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10 7H9v2H7v1h2v2h1v-2h2V9h-2z',
  zoomOut: 'M15.5 14h-.79l-.28-.27A6.5 6.5 0 1 0 13.73 14l.27.28v.79L20 21l1-1-5.5-6zM9.5 14a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM7 9v1h5V9z',
  print: 'M18 3H6v4h12zM6 19h12v-6H6zm14-11H4a2 2 0 0 0-2 2v7h3v4h14v-4h3v-7a2 2 0 0 0-2-2zm-1 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2z',
  slideshow: 'M3 3h18v14h-8v3h4v2H7v-2h4v-3H3zm2 2v10h14V5zm5 2 6 3-6 3z',
  // 关闭 / Close
  close:
    'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z',
  // 删除 / Delete
  delete:
    'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  // 置顶 / Pin
  pin:
    'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z',
}

const menuIcon = computed(() => {
  if (Object.hasOwn(MENU_ICONS, props.name)) return MENU_ICONS[props.name]
  return Object.hasOwn(iconMarkup, props.name) ? props.name as PagewiseIconName : undefined
})
const iconSize = computed(() => {
  const size = props.size ?? (menuIcon.value ? 28 : 24)
  return typeof size === 'number' ? `${size}px` : size
})
const menuMarkup = computed(() => {
  if (!menuIcon.value) return ''
  return menuIcon.value === 'bookmarks' && (props.marked || props.name === 'bookmark')
    ? markedBookmarkMarkup
    : iconMarkup[menuIcon.value]
})
const menuStyle = computed(() => menuIcon.value ? {
  width: iconSize.value,
  height: iconSize.value,
  strokeWidth: props.emphasis ? 2.25 : 2,
} : undefined)
const pathData = computed(() => Object.hasOwn(ICONS, props.name) ? ICONS[props.name] : ICONS.info)
</script>

<template>
  <svg
    class="app-icon"
    :class="[`app-icon--${name}`, { 'app-icon--menu': menuIcon }]"
    :data-icon="menuIcon"
    :width="iconSize"
    :height="iconSize"
    viewBox="0 0 24 24"
    fill="none"
    :stroke="menuIcon ? 'currentColor' : undefined"
    :stroke-width="emphasis ? 2.25 : 2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :style="menuStyle"
    :aria-hidden="ariaHidden === true || ariaHidden === 'true' ? 'true' : undefined"
    focusable="false"
  >
    <g v-if="menuIcon" v-html="menuMarkup" />
    <path v-else fill="currentColor" :d="pathData" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}
</style>
