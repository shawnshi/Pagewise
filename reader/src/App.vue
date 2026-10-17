<script setup lang="ts">
import { pingUsage } from './services/usageStats'
import { localPack, localTtsAvailable, refreshLocalPack } from './services/localTts'
import { useRoute, useRouter } from 'vue-router'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import ToastHost from './components/ToastHost.vue'
import { useSettings } from './stores/settings'
import { useAppearance } from './services/appearance'
import { t } from './i18n'
import { isTauri } from './storage'
import { startExternalOpen } from './services/externalOpen'
import { disposeLibraryCovers } from './services/libraryCovers'
import { toast } from './services/toast'

const settings = useSettings()
settings.persistOnChange()
useAppearance()
const route = useRoute()
const router = useRouter()
let stopExternalOpen: (() => void) | undefined

onMounted(async () => {
  if (isTauri()) stopExternalOpen = await startExternalOpen(router)
  // 匿名使用统计: 每天一次, 后台进行
  void pingUsage()
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
  stopExternalOpen?.()
  disposeLibraryCovers()
})
// 阅读页全屏沉浸, 隐藏侧栏
const immersive = computed(() => /^\/read(?:\/|-paper\/)/.test(route.path))

const navs = [
  {
    path: '/library',
    labelKey: 'nav.library',
    fallback: '藏书',
    icon: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z',
  },
  {
    path: '/reading',
    labelKey: 'nav.reading',
    fallback: '在读',
    icon: 'M18 2H6c-1.1 0-2 .9-2 2v16l7-3 7 3V4c0-1.1-.9-2-2-2zm0 15-5-2.18L8 17V4h10v13z',
  },
  {
    path: '/notes',
    labelKey: 'nav.notes',
    fallback: '笔记',
    icon: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  },
]

const statsNav = {
  path: '/stats',
  labelKey: 'nav.stats',
  fallback: '阅读记录',
  icon: 'M4 13a1.5 1.5 0 0 1 3 0v5.5a1.5 1.5 0 0 1-3 0V13zm6.5-5a1.5 1.5 0 0 1 3 0v10.5a1.5 1.5 0 0 1-3 0V8zM17 4.5a1.5 1.5 0 0 1 3 0v14a1.5 1.5 0 0 1-3 0v-14z',
}

// 设置固定在侧栏左下角, 保持主导航干净
const settingsNav = { path: '/settings', labelKey: 'nav.settings', fallback: '设置', icon: 'M10.83 3.28a1.5 1.5 0 0 1 2.34 0l.94 1.16c.24.3.62.45 1 .4l1.47-.2a1.5 1.5 0 0 1 1.69 1.61l-.12 1.49c-.03.38.14.75.46.97l1.23.85a1.5 1.5 0 0 1 .4 2.3l-.86 1.22c-.22.31-.26.72-.1 1.07l.6 1.36a1.5 1.5 0 0 1-1.17 2.03l-1.47.24c-.38.06-.7.32-.83.68l-.52 1.4a1.5 1.5 0 0 1-2.2.8l-1.28-.77a1.13 1.13 0 0 0-1.08 0l-1.28.76a1.5 1.5 0 0 1-2.2-.79l-.52-1.4a1.13 1.13 0 0 0-.83-.68l-1.47-.24a1.5 1.5 0 0 1-1.17-2.03l.6-1.36c.16-.35.12-.76-.1-1.07l-.87-1.22a1.5 1.5 0 0 1 .41-2.3l1.23-.85c.32-.22.49-.59.46-.97l-.12-1.5a1.5 1.5 0 0 1 1.69-1.6l1.48.2c.37.05.75-.1.99-.4l.94-1.16zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z' }

function navLabel(item: { labelKey: string; fallback?: string }): string {
  const val = t(item.labelKey)
  return val && val !== item.labelKey ? val : (item.fallback ?? item.labelKey)
}
</script>

<template>
  <div class="shell" :class="{ immersive, 'eink-shell': settings.readingMode.eink.enabled }">
    <aside v-if="!immersive" class="sidebar">
      <div class="logo" :title="t('app.fullName')">
        <img src="/pagewise-logo.png" width="30" height="30" alt="" aria-hidden="true" />
        <span class="logo-text">{{ t('app.name') }}</span>
      </div>
      <nav class="nav" :aria-label="t('nav.mainAria')">
        <router-link
          v-for="n in navs"
          :key="n.path"
          :to="n.path"
          class="nav-item"
          :title="navLabel(n)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path :d="n.icon" fill="currentColor" />
          </svg>
          <span class="nav-label">{{ navLabel(n) }}</span>
        </router-link>
      </nav>
      <div class="sidebar-secondary">
        <router-link
          :to="statsNav.path"
          class="nav-item sidebar-stats"
          :title="navLabel(statsNav)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path :d="statsNav.icon" fill="currentColor" />
          </svg>
          <span class="nav-label">{{ navLabel(statsNav) }}</span>
        </router-link>
      </div>
      <div class="sidebar-bottom">
        <router-link :to="settingsNav.path" class="nav-item sidebar-settings" :title="navLabel(settingsNav)">
          <span class="sidebar-settings-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path :d="settingsNav.icon" fill="currentColor" />
            </svg>
          </span>
          <span class="nav-label">{{ t(settingsNav.labelKey) }}</span>
        </router-link>
      </div>
    </aside>
    <main class="main">
      <router-view :key="route.fullPath" />
    </main>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}
/* 安卓 edge-to-edge / iOS 刘海屏: 网页铺到系统栏下, 普通页面让出状态栏与横屏两侧;
   阅读页 (immersive) 自行处理, 背景色可延伸到状态栏下 */
.shell:not(.immersive) {
  padding-top: var(--lr-safe-top);
  padding-left: var(--lr-safe-left);
  padding-right: var(--lr-safe-right);
}
.sidebar {
  width: 208px;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
  background: var(--card);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 18px 12px calc(16px + var(--lr-safe-bottom));
  transition: width var(--dur) var(--ease);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 8px;
  margin-bottom: 14px;
}
.logo img {
  flex-shrink: 0;
}
.logo-text {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-item:active {
  background: var(--surface-3);
}
.nav-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.nav-item.router-link-active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 600;
}
.nav-item.router-link-active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.nav-item svg {
  flex-shrink: 0;
}
.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--brand);
  color: var(--on-brand);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.sidebar-bottom {
  position: relative;
  height: 40px;
  flex: none;
}
.sidebar-secondary {
  margin-top: auto;
  margin-bottom: 4px;
}
.sidebar-settings {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding-right: 48px;
  overflow: hidden;
}
.sidebar-settings-icon {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}
/* 更新胶囊向左展开时会盖住「设置」文字的一半: 先把文字淡出 (不支持 :has 的旧内核只是被盖住) */
.sidebar-settings .nav-label {
  transition: opacity var(--dur) var(--ease);
}
.sidebar-bottom:has(.sidebar-update:hover, .sidebar-update:focus-visible, .sidebar-update.downloading) .sidebar-settings .nav-label {
  opacity: 0;
}
.sidebar-settings-badge {
  display: none;
  position: absolute;
  top: -2px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 2px var(--card);
}

/* ---- 侧栏更新按钮: 平时是一枚 32px 的淡品牌色圆钮 (在 40px 的设置行里上下居中) (带呼吸小圆点), 悬停向左展开成胶囊;
   下载中保持展开, 图标外圈显示进度环 ---- */
.sidebar-update {
  position: absolute;
  top: 4px;
  right: 4px;
  width: auto;
  max-width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--brand) 22%, transparent);
  border-radius: var(--radius-pill);
  background: linear-gradient(135deg, var(--brand-light), color-mix(in srgb, var(--brand) 14%, var(--card)));
  color: var(--brand);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--brand) 12%, transparent);
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
  transition:
    max-width var(--dur-slow) var(--ease),
    background-color var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.sidebar-update:hover,
.sidebar-update:focus-visible,
.sidebar-update.downloading {
  max-width: 148px;
  border-color: color-mix(in srgb, var(--brand) 36%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--brand) 22%, transparent);
}
.sidebar-update:active {
  background: color-mix(in srgb, var(--brand) 20%, var(--card));
}
.sidebar-update:focus-visible {
  outline: none;
  box-shadow: var(--ring), 0 4px 14px color-mix(in srgb, var(--brand) 22%, transparent);
}
.sidebar-update-icon {
  position: relative;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
}
.sidebar-update-icon > svg {
  grid-area: 1 / 1;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sidebar-update-glyph {
  stroke-width: 2;
  transition: transform var(--dur) var(--ease);
}
.sidebar-update:hover .sidebar-update-glyph {
  animation: sidebar-update-nudge 900ms var(--ease) 1;
}
/* 进度环: 平时隐藏, 下载中出现; 不确定进度时一段弧线转圈 */
.sidebar-update-ring {
  opacity: 0;
  transform: rotate(-90deg);
  stroke-width: 2.2;
  transition: opacity var(--dur) var(--ease);
}
.ring-track {
  stroke: color-mix(in srgb, var(--brand) 20%, transparent);
}
.ring-bar {
  stroke-dasharray: 100 100;
  transition: stroke-dashoffset var(--dur) linear;
}
.sidebar-update.downloading .sidebar-update-ring {
  opacity: 1;
}
.sidebar-update.downloading .sidebar-update-glyph {
  transform: scale(0.78);
}
.sidebar-update.downloading:not(.determinate) .sidebar-update-ring {
  animation: sidebar-update-spin 900ms linear infinite;
}
/* 「有新版」呼吸小圆点 */
.sidebar-update-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-light);
}
.sidebar-update-dot::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--brand);
  animation: sidebar-update-pulse 2.4s var(--ease) infinite;
}
.sidebar-update.downloading .sidebar-update-dot,
.sidebar-update.ready .sidebar-update-dot {
  display: none;
}
.sidebar-update-label {
  /* 悬停展开后总宽 ≥ 114px (e2e 要求 ≥108px) */
  min-width: 72px;
  padding: 0 12px 0 1px;
  text-align: left;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 30px;
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.sidebar-update-version {
  margin-left: 5px;
  font-size: 11px;
  font-weight: 500;
  opacity: 0.72;
}
.sidebar-update:hover .sidebar-update-label,
.sidebar-update:focus-visible .sidebar-update-label,
.sidebar-update.downloading .sidebar-update-label {
  opacity: 1;
}
.sidebar-update.downloading {
  cursor: progress;
}
:root[data-theme='dark'] .sidebar-update {
  border-color: color-mix(in srgb, var(--brand) 32%, transparent);
  background: linear-gradient(135deg, var(--brand-light), color-mix(in srgb, var(--brand) 22%, var(--card)));
  box-shadow: none;
}
:root[data-theme='dark'] .sidebar-update:hover,
:root[data-theme='dark'] .sidebar-update.downloading {
  border-color: color-mix(in srgb, var(--brand) 50%, transparent);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--brand) 18%, transparent);
}
@keyframes sidebar-update-pulse {
  0% { transform: scale(1); opacity: 0.55; }
  70%, 100% { transform: scale(2.6); opacity: 0; }
}
@keyframes sidebar-update-spin {
  to { transform: rotate(270deg); }
}
@keyframes sidebar-update-nudge {
  0%, 100% { transform: translateY(0); }
  35% { transform: translateY(2px); }
  65% { transform: translateY(-1px); }
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.immersive .main {
  overflow: hidden;
}

/* 平板 / 窄窗口: 收成图标栏, 悬停显示 title */
@media (min-width: 721px) and (max-width: 1023px) {
  .sidebar {
    width: 68px;
    padding-inline: 10px;
    align-items: stretch;
  }
  .logo {
    justify-content: center;
    padding: 0;
  }
  .logo-text,
  .nav-label {
    display: none;
  }
  .nav-badge {
    position: absolute;
    top: 4px;
    right: 6px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font-size: 10px;
    line-height: 16px;
  }
  .nav-item {
    justify-content: center;
    padding: 0;
    height: 44px;
  }
  .nav-item.router-link-active::before {
    left: -10px;
  }
  .sidebar-settings {
    padding-right: 0;
  }
  .sidebar-bottom {
    height: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* 图标栏: 更新按钮放在设置图标下方, 居中的方圆钮, 不展开 */
  .sidebar-update {
    position: relative;
    top: 0;
    right: 0;
    align-self: center;
    max-width: 32px;
    width: 32px;
    justify-content: center;
    border-radius: var(--radius-lg);
  }
  .sidebar-update:hover,
  .sidebar-update:focus-visible,
  .sidebar-update.downloading {
    max-width: 32px;
  }
  .sidebar-update-label {
    display: none;
  }
}

/* 手机: 底部标签栏, 图标在上文字在下, 预留手势区安全边距 */
@media (max-width: 720px) {
  .shell:not(.immersive) {
    flex-direction: column-reverse;
  }
  .sidebar {
    width: 100%;
    flex-direction: row;
    align-items: stretch;
    padding: 4px 6px calc(4px + var(--lr-safe-bottom));
    border-right: none;
    border-top: 1px solid var(--border);
    box-shadow: 0 -1px 0 color-mix(in srgb, var(--border) 50%, transparent);
  }
  .logo {
    display: none;
  }
  .nav-desktop-only {
    display: none;
  }
  .nav {
    flex-direction: row;
    flex: 4;
    gap: 2px;
  }
  .nav-item {
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    height: 52px;
    min-width: 0;
    padding: 0 4px;
    font-size: 11px;
    font-weight: 500;
    border-radius: var(--radius);
  }
  .nav-item svg {
    width: 22px;
    height: 22px;
  }
  .nav-item.router-link-active {
    background: transparent;
  }
  .nav-item.router-link-active::before {
    left: 50%;
    top: -4px;
    bottom: auto;
    width: 24px;
    height: 3px;
    transform: translateX(-50%);
    border-radius: 0 0 3px 3px;
  }
  .sidebar-bottom {
    flex: 1;
    height: auto;
    display: flex;
  }
  .sidebar-settings {
    width: 100%;
    height: 52px;
    padding-right: 4px;
    overflow: visible;
  }
  .sidebar-update {
    display: none;
  }
  .sidebar-settings-badge {
    display: block;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .sidebar-settings .nav-label,
  .sidebar-update,
  .sidebar-update-label,
  .sidebar-update-glyph,
  .ring-bar {
    transition: none;
  }
  .sidebar-update-dot::after,
  .sidebar-update:hover .sidebar-update-glyph {
    animation: none;
  }
  .sidebar-update-dot::after {
    display: none;
  }
  /* 不确定进度时不转圈, 停成一段静止弧线 */
  .sidebar-update.downloading:not(.determinate) .sidebar-update-ring {
    animation: none;
  }
}

.eink-shell:not(.immersive) { flex-direction: column; }
.eink-shell:not(.immersive) .main { padding-bottom: calc(76px + var(--lr-safe-bottom)); }
.eink-shell:not(.immersive) .sidebar { position: fixed; inset: auto var(--lr-safe-right) 0 var(--lr-safe-left); width: auto; height: calc(76px + var(--lr-safe-bottom)); padding: 4px 8px calc(4px + var(--lr-safe-bottom)); flex-direction: row; align-items: center; border-right: none; border-top: 2px solid var(--text); }
.eink-shell .logo { display: none; }
.eink-shell .nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: 1; margin: 0; gap: 4px; }
.eink-shell .nav-item { width: auto; min-width: 48px; height: 60px; display: flex; flex-direction: column; justify-content: center; gap: 4px; padding: 4px; }
.eink-shell .nav-label { display: block; opacity: 1; font-size: 14px; max-width: none; }
.eink-shell .sidebar-stats, .eink-shell .sidebar-bottom { flex: 0 0 64px; width: 64px; margin: 0; }
.eink-shell .sidebar-bottom { height: auto; display: flex; }
.eink-shell .sidebar-settings { width: 64px; padding: 4px; overflow: visible; }
.eink-shell .sidebar-stats .nav-label { font-size: 12px; }
.eink-shell .nav-item.router-link-active::before { left: 20%; right: 20%; top: 0; bottom: auto; width: auto; height: 3px; transform: none; border-radius: 0; }
</style>

