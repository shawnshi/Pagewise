<script setup lang="ts">
/**
 * 首次开启点睛阅读的同意说明 (§6.7 / 计划 Q7): 说明正文会分段发给哪个服务, 结果只存在本机。
 * 两个选项: 仅本书 / 所有书。这是点睛阅读智能版的同意; 不想联网的读者可以一步「先用基础版」。
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { aiConfigured, providerById } from '../services/ai'
import type { Dianjing } from '../composables/useDianjing'

const props = defineProps<{ dj: Dianjing }>()
const settings = useSettings()
const first = ref<HTMLButtonElement | null>(null)

const own = computed(() => {
  const mode = settings.dianjing.channel
  const p = providerById(settings.aiProvider)
  const configured = p.id !== 'trial' && aiConfigured()
  return mode === 'own' || (mode === 'auto' && configured)
})
const service = computed(() => {
  if (!own.value) return t('dianjing.consentServiceBuiltin')
  const p = providerById(settings.aiProvider)
  return t('dianjing.consentServiceOwn', { name: p.label })
})
const ollama = computed(() => own.value && settings.aiProvider === 'ollama')

onMounted(() => first.value?.focus())
</script>

<template>
  <div class="modal-mask" @click.self="dj.cancelConsent()" @keydown.esc="dj.cancelConsent()">
    <div class="modal dj-consent" role="dialog" aria-modal="true" aria-labelledby="dj-consent-title">
      <h3 id="dj-consent-title">{{ t('dianjing.consentTitle') }}</h3>
      <p class="dj-consent-body">{{ t('dianjing.consentBody', { service }) }}</p>
      <p v-if="ollama" class="dj-consent-note">{{ t('dianjing.consentOllama') }}</p>
      <p class="dj-consent-note">{{ t('dianjing.consentNote') }}</p>
      <p class="dj-consent-basic">
        {{ t('dianjing.consentBasic') }}
        <button type="button" class="dj-consent-link" @click="props.dj.switchToBasic()">{{ t('dianjing.useBasic') }}</button>
      </p>
      <div class="dj-consent-actions">
        <button type="button" class="btn btn-ghost" @click="props.dj.cancelConsent()">{{ t('dianjing.consentCancel') }}</button>
        <button type="button" class="btn" @click="props.dj.consent('all')">{{ t('dianjing.consentAll') }}</button>
        <button ref="first" type="button" class="btn btn-primary" @click="props.dj.consent('book')">{{ t('dianjing.consentBook') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dj-consent-body {
  color: var(--text);
  line-height: 1.65;
  margin: 0 0 var(--space-3);
}
.dj-consent-note {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 var(--space-3);
}
.dj-consent-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}
.dj-consent-basic {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
}
.dj-consent-link {
  padding: 4px 2px;
  border: none;
  background: none;
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.dj-consent-link:hover {
  text-decoration: underline;
}
.dj-consent-link:focus-visible {
  outline: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--ring);
}
@media (max-width: 600px) {
  .dj-consent-actions {
    flex-direction: column-reverse;
  }
  .dj-consent-actions .btn {
    width: 100%;
    min-height: 44px;
  }
}
</style>
