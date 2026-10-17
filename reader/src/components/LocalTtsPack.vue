<script setup lang="ts">
/**
 * 离线语音包: 下载 (后台进行, 可续传) / 设备评估 / 闪退后的恢复。
 * 状态全局共享 (services/localTts.ts 的 localPack), 阅读器与论文阅读器共用。
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { localPack, localTtsClearCrash, localTtsDeviceCheck, refreshLocalPack, startLocalDownload, type DeviceCheck } from '../services/localTts'
import { resetEdgeFailure } from '../services/tts'
import { toast } from '../services/toast'

const settings = useSettings()
const device = ref<DeviceCheck | null>(null)

onMounted(async () => {
  await refreshLocalPack()
  if (!localPack.installed) device.value = await localTtsDeviceCheck()
})

const mb = (n: number) => Math.round(n / 1048576)
const percent = computed(() => localPack.total ? Math.min(100, Math.floor(localPack.downloaded / localPack.total * 100)) : 0)
const label = computed(() => {
  if (localPack.running) {
    if (localPack.phase === 'extracting' || localPack.phase === 'done') return t('reader.extracting')
    if (localPack.phase === 'connecting' && !localPack.downloaded) return t('common.connecting')
    return t('tts.localProgress', { pct: percent.value, done: mb(localPack.downloaded), total: mb(localPack.total) })
  }
  return localPack.downloaded > 0
    ? t('tts.resumeLocal', { done: mb(localPack.downloaded), total: mb(localPack.total) })
    : t('tts.downloadLocal')
})
const blocked = computed(() => device.value?.ok === false)

async function retry() {
  try {
    await localTtsClearCrash()
    resetEdgeFailure()
    toast(t('tts.localRetryArmed'), 'info', 5000)
  } catch (e: any) {
    toast(e?.message ?? String(e), 'error')
  }
}
</script>

<template>
  <div class="local-pack">
    <template v-if="localPack.crashed">
      <p class="local-pack-note danger">{{ t('tts.localCrashedNotice') }}</p>
      <div class="local-pack-actions">
        <button class="btn btn-sm btn-primary" @click="settings.ttsEngine = 'edge'">{{ t('tts.useOnline') }}</button>
        <button class="btn btn-sm" @click="retry">{{ t('tts.localRetry') }}</button>
      </div>
    </template>
    <template v-else-if="!localPack.installed">
      <p v-if="blocked" class="local-pack-note danger">
        {{ t('tts.deviceNotRecommended', { reasons: device!.reasons.join('; ') }) }}
      </p>
      <button class="btn btn-sm btn-primary local-pack-btn" :disabled="localPack.running || blocked" @click="startLocalDownload">
        {{ label }}
      </button>
      <span
        v-if="localPack.running && localPack.phase === 'downloading'"
        class="local-pack-bar"
        role="progressbar"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      ><i :style="{ width: percent + '%' }" /></span>
      <button v-if="blocked" class="btn btn-sm" @click="settings.ttsEngine = 'edge'">{{ t('tts.useOnline') }}</button>
    </template>
  </div>
</template>

<style scoped>
.local-pack {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.local-pack-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  flex-basis: 100%;
}
.local-pack-note.danger {
  color: var(--danger);
}
.local-pack-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.local-pack-btn {
  font-variant-numeric: tabular-nums;
}
.local-pack-btn:disabled {
  opacity: 0.85;
}
.local-pack-bar {
  flex-basis: 100%;
  height: 3px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}
.local-pack-bar i {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width 0.3s ease;
}
</style>
