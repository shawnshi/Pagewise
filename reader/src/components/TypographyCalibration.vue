<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { calibrationStatus, measureTypographyCalibration } from '../services/readerTypographyProfiles'
import { measureTextScale } from '../services/fonts'
const settings = useSettings()
const rulerFrame = ref<HTMLIFrameElement>()
const dpr = ref(globalThis.devicePixelRatio ?? 1)
const textScale = ref<number | null>(null)
const rulerDocument = '<!doctype html><html data-pw-calibration style="font-size:18px"><body style="margin:0;background:#fff;color:#000;overflow:hidden"><div id="ruler" style="box-sizing:border-box;width:160px;max-width:100%;height:12px;border-top:2px solid #000;border-inline:2px solid #000;margin-top:8px"></div><p style="margin:12px 0 0;font-family:serif;line-height:1.5">中文阅读 · Reading Ag</p></body></html>'
function refreshFrameMetrics() {
  dpr.value = globalThis.devicePixelRatio ?? 1
  const doc = rulerFrame.value?.contentDocument
  textScale.value = doc?.documentElement?.hasAttribute('data-pw-calibration') ? measureTextScale(doc, 18) : null
}
onMounted(() => { window.addEventListener('resize', refreshFrameMetrics); refreshFrameMetrics() })
onBeforeUnmount(() => window.removeEventListener('resize', refreshFrameMetrics))
const measuredMm = ref('')
const message = ref('')
const failed = ref(false)
const saving = ref(false)
const status = computed(() => calibrationStatus(settings.typographyCalibration, dpr.value, textScale.value ?? NaN))
async function saveCalibration() {
  if (saving.value) return
  saving.value = true
  message.value = ''; failed.value = false
  try {
    refreshFrameMetrics()
    const width = rulerFrame.value?.contentDocument?.getElementById('ruler')?.getBoundingClientRect().width ?? 0
    const value = measureTypographyCalibration(width, Number(measuredMm.value), dpr.value, textScale.value ?? NaN)
    await settings.setTypographyCalibration(value)
    message.value = t('reader.calibrationSaved')
  } catch (error) {
    failed.value = true
    message.value = error instanceof Error ? error.message : t('reader.calibrationInvalid')
  } finally { saving.value = false }
}
async function clearCalibration() {
  if (saving.value) return
  saving.value = true
  message.value = ''; failed.value = false
  try { await settings.setTypographyCalibration(null); message.value = t('reader.calibrationCleared') }
  catch (error) { failed.value = true; message.value = error instanceof Error ? error.message : t('reader.calibrationInvalid') }
  finally { saving.value = false }
}
</script>

<template>
  <details class="typography-calibration">
    <summary>{{ t('reader.calibrationTitle') }}</summary>
    <p class="calibration-note">{{ t('reader.calibration.' + status) }}</p>
    <p class="calibration-note">{{ t('reader.calibrationHelp') }}</p>
    <iframe ref="rulerFrame" class="calibration-frame" sandbox="allow-same-origin" :srcdoc="rulerDocument" :title="t('reader.calibrationRuler')" @load="refreshFrameMetrics" />
    <p class="calibration-note">{{ t('reader.calibrationDeviceScope') }}</p>
    <label class="calibration-value">
      <span>{{ t('reader.calibrationMeasured') }}</span>
      <input v-model="measuredMm" class="input" type="number" min="5" max="300" step="0.1" inputmode="decimal" :aria-label="t('reader.calibrationMeasured')" />
      <span>mm</span>
    </label>
    <div class="calibration-actions">
      <button class="btn btn-sm" type="button" :disabled="saving || textScale === null" @click="saveCalibration">{{ t('reader.calibrationSave') }}</button>
      <button class="btn btn-sm" type="button" :disabled="saving || !settings.typographyCalibration" @click="clearCalibration">{{ t('reader.calibrationClear') }}</button>
    </div>
    <p v-if="message" :role="failed ? 'alert' : 'status'" class="calibration-note">{{ message }}</p>
  </details>
</template>

<style scoped>
.typography-calibration { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }
summary { cursor: pointer; font-weight: 600; line-height: 1.5; }
.calibration-note { color: var(--text-2); font-size: 13px; line-height: 1.6; margin: 10px 0; }
.calibration-frame { box-sizing: border-box; display: block; width: 100%; height: 90px; border: 0; background: #fff; margin: 12px 0; }
.calibration-value { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
.calibration-value input { width: 110px; min-height: 44px; }
.calibration-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.calibration-actions button { min-height: 44px; }
</style>
