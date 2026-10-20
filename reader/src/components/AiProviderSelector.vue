<script setup lang="ts">
import { useSettings } from '../stores/settings'
import { AI_PROVIDERS, isSelectableAiProvider } from '../services/aiProviders.ts'
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
    <select id="ai-provider" :value="isSelectableAiProvider(settings.aiProvider) ? settings.aiProvider : ''" class="input ai-provider-control" @change="selectProvider">
      <option v-if="!isSelectableAiProvider(settings.aiProvider)" value="" disabled>{{ t('settings.aiChooseSupported') }}</option>
      <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">
        {{ p.label }}{{ p.id === 'trial' ? t('settings.aiTrialTag') : '' }}
      </option>
    </select>
    <p v-if="!isSelectableAiProvider(settings.aiProvider)" class="provider-retired" role="status">{{ t('settings.aiRetiredProvider') }}</p>
  </div>
</template>

<style scoped>
.ai-provider-control {
  min-height: 48px;
}
.provider-retired { color: var(--text-2); font-size: 13px; }
.ai-provider-control:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
</style>
