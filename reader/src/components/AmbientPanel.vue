<script setup lang="ts">
/**
 * 「背景音」面板: 桌面为顶栏下的浮层卡片 (与听书面板同位置同尺寸), 手机 (≤600px) 为底部抽屉;
 * 抽屉的遮罩由宿主 (ReaderView 的 sheet-scrim) 提供。
 *
 * 状态与控制全部来自 useAmbient() 单例 (services/ambient), 面板本身不持有播放状态, 关掉面板不影响播放。
 *
 * Props:
 *   ttsActive  听书正在播放 (只用于显示「听书中，已压低」; 真正的压低由宿主调用 ambient.duck())
 * Emits:
 *   close         关闭面板
 *   show-sources  点「声音来源与许可」(宿主打开 docs/ambient-sources.md 的内容或 GitHub 页面)
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import {
  SCENES,
  TIMER_CHOICES,
  currentFormat,
  findScene,
  formatBytes,
  getItem,
  itemsBytes,
  sceneItems,
  useAmbient,
  type AmbientScene,
  type NoiseColor,
} from '../services/ambient'

defineProps<{
  ttsActive?: boolean
}>()

const emit = defineEmits<{
  close: []
  'show-sources': []
}>()

const ambient = useAmbient()
const st = ambient.state

const synthScenes = SCENES.filter(s => s.source === 'synth')
const recordedScenes = SCENES.filter(s => s.source === 'recorded')
const format = currentFormat()

const current = computed(() => findScene(st.sceneId))
const mixerOpen = ref(false)
const noiseColors: { value: NoiseColor; key: string }[] = [
  { value: 'white', key: 'ambient.noise.white' },
  { value: 'pink', key: 'ambient.noise.pink' },
  { value: 'brown', key: 'ambient.noise.brown' },
]

onMounted(() => {
  void ambient.refreshDownloads()
})

function sceneBytes(scene: AmbientScene): number {
  const items = sceneItems(scene).map(id => getItem(id)).filter(i => !!i)
  return itemsBytes(items as NonNullable<ReturnType<typeof getItem>>[], format)
}

const packBytes = computed(() => recordedScenes.reduce((sum, s) => sum + sceneBytes(s), 0))

const isOn = (scene: AmbientScene) => st.sceneId === scene.id && (st.playing || st.loading)

function pick(scene: AmbientScene) {
  if (isOn(scene)) {
    void ambient.stop()
    return
  }
  // play() 必须在点击的同步调用栈里开始 (创建 AudioContext); 录音场景未下载时它会先下载
  void ambient.play(scene.id)
}

function downloadState(scene: AmbientScene) {
  return st.downloads[scene.id]?.status ?? 'none'
}

function downloadPercent(scene: AmbientScene): number {
  const d = st.downloads[scene.id]
  if (!d || !d.total) return 0
  return Math.min(100, Math.round((d.loaded / d.total) * 100))
}

function recordedMeta(scene: AmbientScene): string {
  const s = downloadState(scene)
  if (s === 'downloading') return t('ambient.downloading', { percent: downloadPercent(scene) })
  if (s === 'ready') return t('ambient.downloaded')
  if (s === 'error') return t('ambient.errorDownloadShort')
  return formatBytes(sceneBytes(scene))
}

function onVolume(e: Event) {
  ambient.setVolume(Number((e.target as HTMLInputElement).value) / 100)
}

function onLayer(id: string, e: Event) {
  ambient.setLayerVolume(id, Number((e.target as HTMLInputElement).value) / 100)
}

const percent = computed(() => Math.round(st.volume * 100))

// 每 20 s 刷新一次剩余分钟数
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | undefined
onMounted(() => { tick = setInterval(() => { now.value = Date.now() }, 20_000) })
onBeforeUnmount(() => clearInterval(tick))

const timerLeft = computed(() => {
  if (st.timerEndsAt == null) return ''
  const n = Math.max(1, Math.ceil((st.timerEndsAt - now.value) / 60_000))
  return t('ambient.timerLeft', { n })
})

const statusText = computed(() => {
  if (st.loading) return t('ambient.preparing')
  if (!st.playing) return ''
  if (st.ducked && st.duckWithVoice) return t('ambient.duckedNow')
  return t('ambient.playing')
})
</script>

<template>
  <section class="am-panel card" role="dialog" :aria-label="t('ambient.title')">
    <header class="am-head">
      <strong>{{ t('ambient.title') }}</strong>
      <span v-if="statusText" class="am-status" :class="{ live: st.playing && !st.loading }" aria-live="polite">{{ statusText }}</span>
      <span class="am-spacer" />
      <button class="am-icon-btn" type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="emit('close')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </header>

    <p v-if="st.error" class="am-error" role="alert">{{ t(st.error) }}</p>

    <!-- 本机合成: 离线可用 -->
    <div class="am-group">
      <span class="am-group-title">{{ t('ambient.synthGroup') }}</span>
      <div class="am-scenes">
        <button
          v-for="scene in synthScenes"
          :key="scene.id"
          type="button"
          class="am-scene"
          :class="{ on: isOn(scene) }"
          :aria-pressed="isOn(scene)"
          @click="pick(scene)"
        >
          <span class="am-scene-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><use :href="`#am-i-${scene.icon}`" /></svg></span>
          <span class="am-scene-text">
            <span class="am-scene-name">{{ t(scene.nameKey) }}</span>
            <span class="am-scene-desc">{{ t(scene.descKey) }}</span>
          </span>
          <span v-if="isOn(scene) && st.playing" class="am-eq" aria-hidden="true"><i /><i /><i /></span>
        </button>
      </div>
      <div v-if="current?.id === 'focus-noise'" class="am-row">
        <span class="am-label">{{ t('ambient.noiseColor') }}</span>
        <div class="segmented">
          <button
            v-for="c in noiseColors"
            :key="c.value"
            type="button"
            :class="{ active: st.noiseColor === c.value }"
            :aria-pressed="st.noiseColor === c.value"
            @click="ambient.setNoiseColor(c.value)"
          >
            {{ t(c.key) }}
          </button>
        </div>
      </div>
    </div>

    <!-- 实地录音: 按需下载 -->
    <div class="am-group">
      <span class="am-group-title">{{ t('ambient.recordedGroup', { size: formatBytes(packBytes) }) }}</span>
      <div class="am-scenes">
        <div v-for="scene in recordedScenes" :key="scene.id" class="am-scene-wrap">
          <button
            type="button"
            class="am-scene"
            :class="{ on: isOn(scene) }"
            :aria-pressed="isOn(scene)"
            @click="pick(scene)"
          >
            <span class="am-scene-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><use :href="`#am-i-${scene.icon}`" /></svg></span>
            <span class="am-scene-text">
              <span class="am-scene-name">{{ t(scene.nameKey) }}</span>
              <span class="am-scene-meta" :class="{ ready: downloadState(scene) === 'ready', error: downloadState(scene) === 'error' }">
                <svg v-if="downloadState(scene) === 'none'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
                {{ recordedMeta(scene) }}
              </span>
            </span>
            <span v-if="isOn(scene) && st.playing" class="am-eq" aria-hidden="true"><i /><i /><i /></span>
            <span
              v-if="downloadState(scene) === 'downloading'"
              class="am-progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="downloadPercent(scene)"
              :aria-label="t('ambient.downloading', { percent: downloadPercent(scene) })"
            ><span :style="{ transform: `scaleX(${downloadPercent(scene) / 100})` }" /></span>
          </button>
          <button
            v-if="downloadState(scene) === 'ready' && !isOn(scene)"
            type="button"
            class="am-remove"
            :title="t('ambient.removeDownload')"
            :aria-label="`${t('ambient.removeDownload')} · ${t(scene.nameKey)}`"
            @click="ambient.removeDownload(scene.id)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3a1 1 0 0 0-1 1v1H5a1 1 0 0 0 0 2h14a1 1 0 1 0 0-2h-3V4a1 1 0 0 0-1-1H9zm-2 6a1 1 0 0 1 1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-8a1 1 0 1 1 2 0v8a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-8a1 1 0 0 1 1-1z"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 播放 / 音量 -->
    <div class="am-row">
      <button
        type="button"
        class="am-play"
        :title="st.playing || st.loading ? t('ambient.stop') : t('ambient.play')"
        :aria-label="st.playing || st.loading ? t('ambient.stop') : t('ambient.play')"
        @click="st.playing || st.loading ? ambient.stop() : ambient.play()"
      >
        <svg v-if="st.playing || st.loading" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
      </button>
      <span class="am-label">{{ t('ambient.volume') }}</span>
      <input
        class="am-range"
        type="range"
        min="0"
        max="100"
        step="1"
        :value="percent"
        :aria-label="t('ambient.volume')"
        :aria-valuetext="`${percent}%`"
        @input="onVolume"
      />
      <span class="am-value">{{ percent }}%</span>
    </div>

    <!-- 定时 -->
    <div class="am-row am-timer">
      <span class="am-label">{{ t('ambient.timer') }}</span>
      <div class="segmented">
        <button type="button" :class="{ active: st.timerMinutes == null }" :aria-pressed="st.timerMinutes == null" @click="ambient.setTimer(null)">
          {{ t('ambient.timerOff') }}
        </button>
        <button
          v-for="m in TIMER_CHOICES"
          :key="m"
          type="button"
          :class="{ active: st.timerMinutes === m }"
          :aria-pressed="st.timerMinutes === m"
          :aria-label="t('ambient.minutes', { n: m })"
          @click="ambient.setTimer(m)"
        >
          {{ m }}
        </button>
      </div>
    </div>
    <p v-if="timerLeft && st.playing" class="am-hint am-timer-left">{{ timerLeft }}</p>

    <label class="am-toggle">
      <span>{{ t('ambient.duckWithVoice') }}</span>
      <span class="am-switch">
        <input
          type="checkbox"
          role="switch"
          :checked="st.duckWithVoice"
          :aria-checked="st.duckWithVoice"
          @change="ambient.setDuckWithVoice(($event.target as HTMLInputElement).checked)"
        />
        <span class="am-switch-track" aria-hidden="true"></span>
      </span>
    </label>

    <!-- 分层音量 -->
    <div v-if="current" class="am-mixer">
      <button type="button" class="am-mixer-toggle" :aria-expanded="mixerOpen" aria-controls="am-mixer-body" @click="mixerOpen = !mixerOpen">
        <span>{{ t('ambient.mixer') }} · {{ t(current.nameKey) }}</span>
        <svg class="am-chevron" :class="{ open: mixerOpen }" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 9.3a1 1 0 0 1 1.4 0L12 13.58l4.3-4.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.4z"/></svg>
      </button>
      <div v-show="mixerOpen" id="am-mixer-body" class="am-mixer-body">
        <div v-for="layer in current.layers" :key="layer.id" class="am-row">
          <span class="am-label am-layer-label">{{ t(layer.labelKey) }}</span>
          <input
            class="am-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="Math.round((st.layers[layer.id] ?? layer.volume) * 100)"
            :aria-label="t(layer.labelKey)"
            :aria-valuetext="`${Math.round((st.layers[layer.id] ?? layer.volume) * 100)}%`"
            @input="onLayer(layer.id, $event)"
          />
          <span class="am-value">{{ Math.round((st.layers[layer.id] ?? layer.volume) * 100) }}%</span>
        </div>
      </div>
    </div>

    <footer class="am-foot">
      <p class="am-hint">{{ t('ambient.note') }}</p>
      <button type="button" class="am-link" @click="emit('show-sources')">{{ t('ambient.sources') }}</button>
    </footer>

    <!-- 场景图标 (内联 SVG 符号, 线性 1.6px) -->
    <svg width="0" height="0" class="am-defs" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="am-i-rain" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 7.5a3.75 3.75 0 0 1 .5 7.5H7z"/><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/></g></symbol>
        <symbol id="am-i-wind" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 17h6"/></g></symbol>
        <symbol id="am-i-noise" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 12h2M6.5 8v8M10 5v14M13.5 9v6M17 7v10M20.5 11v2"/></g></symbol>
        <symbol id="am-i-moon" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></g></symbol>
        <symbol id="am-i-window" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M12 3v18M4 12h16"/><path d="M8 6.5v2M16 14.5v2M8 15v1.5"/></g></symbol>
        <symbol id="am-i-cup" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c0 1 1 1.5 1 2.5M12 3.5c0 1 1 1.5 1 2.5"/></g></symbol>
        <symbol id="am-i-fire" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c.5 3.5 5 5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 1.6 1.2 2.5 2 2.8C11 8.5 11 5.5 12 3z"/><path d="M5 21h14"/></g></symbol>
        <symbol id="am-i-bird" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c3 0 5.5-1 7-3.5 1.5 2.5 1.5 6.5-1 8.5"/><path d="M10 8.5C11.5 6 14 5 16 5l2 1.5-2 1c0 5-3 9-8 9.5"/><circle cx="15.5" cy="6.2" r=".4" fill="currentColor"/></g></symbol>
        <symbol id="am-i-wave" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 9c1.5 0 1.5-1.5 3-1.5S7.5 9 9 9s1.5-1.5 3-1.5S13.5 9 15 9s1.5-1.5 3-1.5S19.5 9 21 9"/><path d="M3 14c1.5 0 1.5-1.5 3-1.5S7.5 14 9 14s1.5-1.5 3-1.5S13.5 14 15 14s1.5-1.5 3-1.5S19.5 14 21 14"/><path d="M3 19c1.5 0 1.5-1.5 3-1.5S7.5 19 9 19s1.5-1.5 3-1.5S13.5 19 15 19s1.5-1.5 3-1.5S19.5 19 21 19"/></g></symbol>
        <symbol id="am-i-night" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4a6 6 0 1 0 6 8 5 5 0 0 1-6-8z"/><path d="M3 20c2-1.5 3-1.5 4.5-3M7.5 20c1-1.2 2-1.8 3.5-2.5"/><path d="M5 7l.5 1M3.5 11.5h1"/></g></symbol>
        <symbol id="am-i-piano" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7.5 5v8.5M12 5v8.5M16.5 5v8.5M3 13.5h18"/></g></symbol>
      </defs>
    </svg>
  </section>
</template>

<style scoped>
.am-panel {
  position: absolute;
  top: calc(52px + var(--safe-top, 0px));
  right: 12px;
  z-index: 25;
  width: min(420px, calc(100% - 24px));
  max-height: calc(100% - 72px - var(--safe-top, 0px) - var(--safe-bottom, 0px));
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
}
.am-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.am-head strong {
  font-size: 15px;
}
.am-spacer {
  flex: 1;
}
.am-status {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
}
.am-status.live {
  background: var(--brand-soft);
  color: var(--brand);
}
.am-icon-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.am-icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.am-icon-btn:focus-visible,
.am-scene:focus-visible,
.am-remove:focus-visible,
.am-play:focus-visible,
.am-mixer-toggle:focus-visible,
.am-link:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.am-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
}
.am-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.am-group-title {
  font-size: 12px;
  color: var(--text-3);
}
.am-scenes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.am-scene-wrap {
  position: relative;
  display: flex;
}
.am-scene {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 56px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  color: var(--text);
  text-align: left;
  overflow: hidden;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.am-scene.on {
  border-color: var(--brand);
  background: var(--brand-soft);
}
@media (hover: hover) {
  .am-scene:hover {
    border-color: var(--border-strong);
  }
  .am-scene.on:hover {
    border-color: var(--brand);
  }
}
.am-scene-icon {
  flex: none;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  color: var(--text-2);
}
.am-scene.on .am-scene-icon {
  color: var(--brand);
}
.am-scene-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.am-scene-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
.am-scene-desc,
.am-scene-meta {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-3);
}
.am-scene-meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-variant-numeric: tabular-nums;
}
.am-scene-meta.ready {
  color: var(--success);
}
.am-scene-meta.error {
  color: var(--danger);
}
.am-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--surface-3);
}
.am-progress span {
  display: block;
  height: 100%;
  background: var(--brand);
  transform-origin: left center;
  transition: transform var(--dur) linear;
}
.am-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.am-remove:hover {
  background: var(--surface-2);
  color: var(--danger);
}
/* 播放中的三根跳动小竖条 */
.am-eq {
  position: absolute;
  top: 9px;
  right: 9px;
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 10px;
}
.am-eq i {
  width: 2px;
  height: 100%;
  border-radius: 1px;
  background: var(--brand);
  transform-origin: bottom;
  animation: am-eq 1.4s ease-in-out infinite;
}
.am-eq i:nth-child(2) {
  animation-delay: -0.45s;
}
.am-eq i:nth-child(3) {
  animation-delay: -0.9s;
}
@keyframes am-eq {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
.am-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.am-label {
  flex: none;
  width: 56px;
  font-size: 13px;
  color: var(--text-2);
}
.am-layer-label {
  width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.am-value {
  flex: none;
  min-width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.am-play {
  flex: none;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: var(--brand);
  color: var(--on-brand);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.am-play:hover {
  background: var(--brand-hover);
}
.am-timer .segmented {
  flex: 1;
  min-width: 0;
}
.am-timer .segmented button {
  flex: 1;
}
.am-timer-left {
  margin-top: -6px !important;
  padding-left: 66px;
}
.am-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.am-switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
}
.am-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.am-switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  transition: background var(--dur) var(--ease);
  pointer-events: none;
}
.am-switch-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--card);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.am-switch input:checked + .am-switch-track {
  background: var(--brand);
}
.am-switch input:checked + .am-switch-track::after {
  transform: translateX(16px);
}
.am-switch input:focus-visible + .am-switch-track {
  box-shadow: var(--ring);
}
.am-mixer {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.am-mixer-toggle {
  width: 100%;
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
}
.am-chevron {
  transition: transform var(--dur) var(--ease);
}
.am-chevron.open {
  transform: rotate(180deg);
}
.am-mixer-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}
.am-foot {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.am-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.am-link {
  padding: 2px 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--brand);
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.am-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}
@media (max-width: 600px) {
  .am-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 82%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right, 0px)) calc(16px + var(--safe-bottom, 0px)) max(16px, var(--lr-safe-left, 0px));
    box-shadow: var(--shadow-lg);
    gap: 14px;
    animation: am-sheet-up var(--dur-slow) var(--ease);
  }
  .am-panel::before {
    content: '';
    position: absolute;
    top: 7px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .am-icon-btn,
  .am-play {
    width: 44px;
    height: 44px;
  }
  .am-remove {
    top: 0;
    right: 0;
    width: 40px;
    height: 40px;
  }
  .am-scene {
    min-height: 60px;
  }
  .am-mixer-toggle {
    min-height: 44px;
  }
  .am-link {
    min-height: 32px;
  }
  .am-timer .segmented button {
    min-height: 36px;
  }
}
@keyframes am-sheet-up {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .am-panel,
  .am-eq i,
  .am-chevron,
  .am-switch-track,
  .am-switch-track::after {
    animation: none;
    transition: none;
  }
}
</style>
