<script setup lang="ts">
import { computed } from 'vue'
import { useSettings } from '../stores/settings'
import { AI_MODEL_CATALOG_VERIFIED_AT, aiModelOptions, isSelectableAiProvider, providerById } from '../services/aiProviders.ts'
import { t } from '../i18n'

const settings = useSettings()
const supported = computed(() => isSelectableAiProvider(settings.aiProvider))
const preset = computed(() => supported.value ? providerById(settings.aiProvider) : undefined)
const options = computed(() => aiModelOptions(settings.aiProvider, settings.aiModel))
function modelLabel(id: string, label: string): string {
  if (!preset.value?.models.some(model => model.id === id)) return t('settings.aiSavedModel', { model: label })
  return id === preset.value.defaultModel && preset.value.id !== 'trial'
    ? `${label} · ${t('settings.aiModelDefault')}` : label
}
</script>

<template>
  <div class="field">
    <label class="field-label" for="ai-model">{{ t('settings.aiModelLabel') }}</label>
    <select id="ai-model" v-model="settings.aiModel" class="input ai-model-control" :disabled="!supported">
      <option v-if="!supported" :value="settings.aiModel">{{ t('settings.aiChooseSupported') }}</option>
      <option v-for="model in options" :key="model.id" :value="model.id">{{ modelLabel(model.id, model.label) }}</option>
    </select>
    <span v-if="preset?.id !== 'trial' && supported" class="model-catalog-note">
      {{ t('settings.aiModelCatalog', { date: AI_MODEL_CATALOG_VERIFIED_AT }) }}
    </span>
  </div>
</template>

<style scoped>
.ai-model-control { min-height: 48px; min-width: 0; width: 100%; max-width: 100%; }
.ai-model-control:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.model-catalog-note { color: var(--text-2); font-size: 12px; }
</style>
