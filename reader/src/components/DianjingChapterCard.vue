<script setup lang="ts">
/**
 * 章首「要义」卡 (§4.5): 一段话 + 3 个可跳转的要点。放在阅读器外壳里、iframe 之外, 不重排正文。
 * 叙述类书籍显示「上一章回顾」(R6 不剧透)。可收起 (本节内不再出现)。
 */
import { computed } from 'vue'
import { t } from '../i18n'
import type { Dianjing } from '../composables/useDianjing'

const props = defineProps<{ dj: Dianjing }>()
const data = computed(() => props.dj.chapterCard.value)
const label = computed(() => t(data.value?.mode === 'recap' ? 'dianjing.chapterRecap' : 'dianjing.chapterGist'))
</script>

<template>
  <aside v-if="data" class="dj-chapter" :aria-label="label">
    <header class="dj-chapter-head">
      <span class="dj-chapter-label">{{ label }}<template v-if="data.mode === 'recap' && data.title"> · {{ data.title }}</template></span>
      <button type="button" class="btn btn-ghost btn-sm btn-icon" :aria-label="t('dianjing.collapse')" :title="t('dianjing.collapse')" @click="dj.collapseChapterCard()">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </header>
    <p class="dj-chapter-text">{{ data.summary.text }}</p>
    <ol v-if="data.summary.points.length" class="dj-chapter-points">
      <li v-for="(p, i) in data.summary.points" :key="i">
        <button type="button" class="dj-chapter-point" @click="dj.goTo({ section: data.section, block: p.block, sentence: p.sentence })">{{ p.text }}</button>
      </li>
    </ol>
    <p class="dj-chapter-source">{{ t('dianjing.aiSource') }}</p>
  </aside>
</template>

<style scoped>
.dj-chapter {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  padding: var(--space-3) var(--space-4);
  width: min(560px, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--text);
}
.dj-chapter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dj-chapter-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.dj-chapter-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.65;
}
.dj-chapter-points {
  margin: 0;
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dj-chapter-point {
  border: none;
  background: none;
  padding: 4px 0;
  text-align: left;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  cursor: pointer;
  text-decoration: underline dotted var(--border-strong);
  text-underline-offset: 3px;
}
.dj-chapter-point:hover {
  color: var(--brand);
}
.dj-chapter-point:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: var(--radius-sm);
}
.dj-chapter-source {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}
</style>
