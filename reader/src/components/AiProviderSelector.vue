<script setup lang="ts">
import { useSettings } from '../stores/settings'
import { AI_PROVIDERS } from '../services/aiProviders'
import { t } from '../i18n'

const settings = useSettings()
const emit = defineEmits<{ change: [] }>()

function selectProvider(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  settings.selectAiProvider(target.value)
  emit('change')
}
</script>

<template>
  <div class="field">
    <label class="field-label" for="ai-provider">{{ t('settings.aiProvider') }}</label>
    <select id="ai-provider" :value="settings.aiProvider" class="input ai-provider-control" @change="selectProvider">
      <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">
        {{ p.label }}{{ p.id === 'trial' ? t('settings.aiTrialTag') : p.id === 'siliconflow' || p.id === 'zhipu' ? t('settings.aiFreeTag') : '' }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.ai-provider-control {
  min-height: 48px;
}
.ai-provider-control:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
</style>
