<script setup lang="ts">
import { localPack, localTtsAvailable, refreshLocalPack } from './services/localTts'
import { useRoute, useRouter } from 'vue-router'
import { computed, onBeforeUnmount, onMounted, provide, watch } from 'vue'
import ToastHost from './components/ToastHost.vue'
import AppIcon from './components/AppIcon.vue'
import { useSettings } from './stores/settings'
import { useLibrary } from './stores/library'
import { useAppearance } from './services/appearance'
import { useFolderLibrary } from './services/folderLibrary'
import { createReaderActivity, readerActivityKey } from './services/readerActivity'
import { t } from './i18n'
import { isTauri } from './storage'
import { startExternalOpen } from './services/externalOpen'
import { disposeLibraryCovers } from './services/libraryCovers'
import { toast } from './services/toast'
import { initSystemTts } from './services/systemTts'

const settings = useSettings()
const library = useLibrary()
const stopSettingsPersistence = settings.persistOnChange(() => {
  toast(settings.language === 'en'
    ? 'Settings were not confirmed saved. Keep this app open and reconcile before retrying.'
    : '设置尚未确认保存，请保持应用开启并核对，避免重复提交。', 'error', 12000)
})
useAppearance()
const route = useRoute()
const router = useRouter()
let stopExternalOpen: (() => void) | undefined
let stopFolderLibrary: (() => void) | undefined
let stopPerformanceProbe: (() => void) | undefined
const folderLibrary = useFolderLibrary()
const readerActivity = createReaderActivity(active => folderLibrary.setReadingActive(active))
provide(readerActivityKey, () => readerActivity.captureFailure())
const stopReaderActivity = watch(() => route.fullPath, key => readerActivity.commit(key, route.path), { immediate: true, flush: 'sync' })
let disposed = false
let refreshing = false
let refreshedGeneration = folderLibrary.status.value.generation
watch(() => folderLibrary.status.value.generation, async () => {
  if (refreshing || disposed) return
  refreshing = true
  try {
    // A scan can commit again while listBooks is pending; drain the newest generation.
    while (!disposed && refreshedGeneration < folderLibrary.status.value.generation) {
      const generation = folderLibrary.status.value.generation
      await library.refresh()
      refreshedGeneration = generation
    }
  } catch (error) {
    console.warn('Pagewise: library refresh after scan failed', error)
  } finally {
    refreshing = false
  }
})

async function startPerformanceProbe() {
  try {
    const bridge = (window as Window & {
      LightReadInsets?: {
        performanceProbeEnabled?: () => boolean
        recordPerformance: (action: number, engine: number, elapsedMs: number, completed: boolean) => boolean
      }
    }).LightReadInsets
    if (bridge?.performanceProbeEnabled?.() !== true) return
    const { installDevicePerformance } = await import('./services/devicePerformance')
    if (!disposed) stopPerformanceProbe = installDevicePerformance(bridge, () =>
      route.path.startsWith('/read-pdf/') ? 2 : route.path.startsWith('/read/') ? 1 : undefined)
  } catch {
    // Optional measurement must not break startup; absent ready records mean the probe is unavailable.
  }
}

onMounted(async () => {
  void startPerformanceProbe()
  void initSystemTts()
  stopFolderLibrary = folderLibrary.start()
  if (isTauri()) stopExternalOpen = await startExternalOpen(router)
  void recoverFromLocalTtsCrash()

})

/** 上次加载离线语音时闪退: 本次启动自动改用在线朗读 (Rust 侧也会拒绝再加载), 并告诉用户 */
async function recoverFromLocalTtsCrash() {
  if (!localTtsAvailable()) return
  await refreshLocalPack()
  if (!localPack.crashed) return
  if (settings.ttsEngine === 'local') settings.ttsEngine = 'edge'
  toast(t('tts.localCrashedRecovered'), 'error', 12000)
}
onBeforeUnmount(() => {
  disposed = true
  stopPerformanceProbe?.()
  stopSettingsPersistence()
  stopReaderActivity()
  readerActivity.dispose()
  stopExternalOpen?.()
  disposeLibraryCovers()
  stopFolderLibrary?.()
})
// 阅读页全屏沉浸, 隐藏侧栏 (包含图书阅读与通用 PDF 阅读)
const immersive = computed(() => /^\/read(?:\/|-(?:paper|pdf)\/)/.test(route.path))

const navs = [
  {
    path: '/library',
    labelKey: 'nav.library',
    fallback: '书库',
    icon: 'library',
  },
  {
    path: '/reading',
    labelKey: 'nav.reading',
    fallback: '在读',
    icon: 'reading',
  },
  {
    path: '/notes',
    labelKey: 'nav.notes',
    fallback: '笔记',
    icon: 'notes',
  },
]

const statsNav = {
  path: '/stats',
  labelKey: 'nav.stats',
  fallback: '阅读记录',
  icon: 'stats',
}

// 设置固定在侧栏左下角, 保持主导航干净
const settingsNav = { path: '/settings', labelKey: 'nav.settings', fallback: '设置', icon: 'settings' }

function navLabel(item: { labelKey: string; fallback?: string }): string {
  const val = t(item.labelKey)
  return val && val !== item.labelKey ? val : (item.fallback ?? item.labelKey)
}
</script>

<template>
  <div class="shell" :class="{ immersive, 'eink-shell': settings.readingMode.eink.enabled }">
    <main class="main">
      <router-view :key="route.fullPath" />
    </main>
    <nav v-if="!immersive" class="sidebar" :aria-label="t('nav.mainAria')">
      <div class="nav">
        <router-link
          v-for="n in navs"
          :key="n.path"
          :to="n.path"
          class="nav-item"
          :title="navLabel(n)"
        >
          <AppIcon :name="n.icon" :size="28" :emphasis="route.path === n.path" aria-hidden="true" />
          <span class="nav-label">{{ navLabel(n) }}</span>
        </router-link>
      </div>
      <div class="sidebar-secondary">
        <router-link
          :to="statsNav.path"
          class="nav-item sidebar-stats"
          :title="navLabel(statsNav)"
        >
          <AppIcon :name="statsNav.icon" :size="28" :emphasis="route.path === statsNav.path" aria-hidden="true" />
          <span class="nav-label">{{ navLabel(statsNav) }}</span>
        </router-link>
      </div>
      <div class="sidebar-bottom">
        <router-link :to="settingsNav.path" class="nav-item sidebar-settings" :title="navLabel(settingsNav)">
          <span class="sidebar-settings-icon">
            <AppIcon :name="settingsNav.icon" :size="28" :emphasis="route.path === settingsNav.path" aria-hidden="true" />
          </span>
          <span class="nav-label">{{ t(settingsNav.labelKey) }}</span>
        </router-link>
      </div>
    </nav>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.shell:not(.immersive) {
  padding-top: var(--lr-safe-top);
  padding-left: var(--lr-safe-left);
  padding-right: var(--lr-safe-right);
}
.main {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.immersive .main {
  overflow: hidden;
}
/* 导航参与布局而非覆盖内容，长页面和动态安全区都不依赖猜测底部高度。 */
.sidebar {
  flex: none;
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  align-items: stretch;
  padding: 4px 8px calc(4px + var(--lr-safe-bottom));
  background: var(--card);
  border-top: 1px solid var(--border);
}
.nav,
.sidebar-secondary,
.sidebar-bottom {
  display: contents;
}
.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 48px;
  min-height: 64px;
  width: 100%;
  padding: 6px 4px;
  border-radius: var(--radius);
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  text-decoration: none;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
}
.nav-item:active {
  background: var(--surface-3);
}
.nav-item:focus-visible {
  outline: 2px solid var(--text);
  box-shadow: none;
}
.nav-item.router-link-active {
  background: var(--surface-2);
  color: var(--text);
  font-weight: 700;
}
.nav-item.router-link-active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 24px;
  height: 3px;
  transform: translateX(-50%);
  border-radius: 0 0 3px 3px;
  background: var(--text);
}
.nav-item svg,
.sidebar-settings-icon {
  flex-shrink: 0;
}
.sidebar-settings-icon {
  display: inline-flex;
}
.nav-label {
  max-width: 100%;
  line-height: 1.35;
  white-space: normal;
  overflow-wrap: anywhere;
}
.eink-shell .sidebar {
  border-top: 2px solid var(--text);
}
.eink-shell .nav-item {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .nav-item {
    transition: none;
  }
}
</style>

