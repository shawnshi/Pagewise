<script setup lang="ts">
/**
 * 「脉络」面板 (§4.6): 章 → 要点 → 要句三级大纲, 每个节点都能跳回原文; 「本书词表」按首次出现排序。
 * 读到的章节高亮。叙述类只列到读者当前位置 (R6)。
 * 默认作为右侧面板 (手机为底部抽屉); 也可以把内容嵌进阅读器侧栏 (prop embedded)。
 */
import { computed, ref } from 'vue'
import { t } from '../i18n'
import type { Dianjing } from '../composables/useDianjing'
import type { DjPosition } from '../services/dianjing/engine'

const props = defineProps<{ dj: Dianjing; embedded?: boolean }>()
const emit = defineEmits<{ close: []; navigate: [pos: DjPosition] }>()

const tab = ref<'outline' | 'glossary'>('outline')
const data = computed(() => props.dj.outline.value)
const loading = computed(() => props.dj.outlineLoading.value)

function go(pos: DjPosition) {
  void props.dj.goTo(pos)
  emit('navigate', pos)
  if (!props.embedded && window.matchMedia?.('(max-width: 600px)').matches) close()
}
function close() {
  props.dj.outlineOpen.value = false
  emit('close')
}
const title = (s: { title: string; section: number }) => s.title || t('dianjing.untitledSection', { n: s.section + 1 })
</script>

<template>
  <section class="dj-outline" :class="{ embedded }" :aria-label="t('dianjing.outlineTitle')">
    <header class="dj-outline-head">
      <div class="segmented" role="group" :aria-label="t('dianjing.outlineTitle')">
        <button type="button" :class="{ active: tab === 'outline' }" :aria-pressed="tab === 'outline'" @click="tab = 'outline'">{{ t('dianjing.outlineTab') }}</button>
        <button type="button" :class="{ active: tab === 'glossary' }" :aria-pressed="tab === 'glossary'" @click="tab = 'glossary'">{{ t('dianjing.glossary') }}</button>
      </div>
      <button v-if="!embedded" type="button" class="btn btn-ghost btn-sm btn-icon" :aria-label="t('dianjing.close')" :title="t('dianjing.close')" @click="close">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
    </header>
    <p v-if="data?.spoilerSafe" class="dj-outline-hint">{{ t('dianjing.outlineSpoiler') }}</p>

    <div class="dj-outline-body">
      <p v-if="loading && !data" class="dj-outline-empty">{{ t('dianjing.loading') }}</p>
      <template v-else-if="tab === 'outline'">
        <p v-if="!data?.sections.length" class="dj-outline-empty">{{ t('dianjing.skimEmpty') }}</p>
        <ol v-else class="dj-tree">
          <li v-for="s in data.sections" :key="s.section" class="dj-sec" :class="{ current: s.current }">
            <button type="button" class="dj-sec-title" :aria-current="s.current ? 'location' : undefined" @click="go({ section: s.section, block: 0, sentence: 0 })">{{ title(s) }}</button>
            <p v-if="s.summary" class="dj-sec-summary">{{ s.summary }}</p>
            <ul v-if="s.gists.length" class="dj-gists">
              <li v-for="(g, gi) in s.gists" :key="'g' + gi">
                <button type="button" class="dj-node dj-gist" @click="go(g.pos)">{{ g.text }}</button>
                <ul class="dj-keys">
                  <li v-for="(k, ki) in s.keys.filter(k => k.pos.block >= g.pos.block && (gi + 1 >= s.gists.length || k.pos.block < s.gists[gi + 1].pos.block))" :key="'k' + ki">
                    <button type="button" class="dj-node dj-key" @click="go(k.pos)">{{ k.text }}</button>
                  </li>
                </ul>
              </li>
            </ul>
            <ul v-else class="dj-keys">
              <li v-for="(k, ki) in s.keys" :key="'k' + ki">
                <button type="button" class="dj-node dj-key" @click="go(k.pos)">{{ k.text }}</button>
              </li>
            </ul>
          </li>
        </ol>
      </template>
      <template v-else>
        <p v-if="!data?.glossary.length" class="dj-outline-empty">{{ t('dianjing.skimEmpty') }}</p>
        <dl v-else class="dj-glossary">
          <template v-for="g in data.glossary" :key="g.q">
            <dt><button type="button" class="dj-node dj-term" @click="go(g.pos)">{{ g.q }}</button></dt>
            <dd>{{ g.def }}</dd>
          </template>
        </dl>
      </template>
    </div>
    <p class="dj-outline-source">{{ t('dianjing.aiSource') }}</p>
  </section>
</template>

<style scoped>
.dj-outline {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(380px, 100vw);
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  z-index: 55;
  padding-top: var(--lr-safe-top);
}
.dj-outline.embedded {
  position: static;
  width: auto;
  box-shadow: none;
  border: none;
  height: 100%;
}
.dj-outline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.dj-outline-hint {
  margin: 0;
  padding: var(--space-2) var(--space-4) 0;
  font-size: 12px;
  color: var(--text-3);
}
.dj-outline-body {
  flex: 1;
  overflow: auto;
  padding: var(--space-3) var(--space-4) var(--space-4);
  overscroll-behavior: contain;
}
.dj-outline-empty {
  color: var(--text-3);
  font-size: 13px;
}
.dj-tree,
.dj-gists,
.dj-keys {
  list-style: none;
  margin: 0;
  padding: 0;
}
.dj-sec {
  padding: var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--border);
}
.dj-sec.current {
  border-left: 2px solid var(--brand);
  padding-left: var(--space-2);
  margin-left: calc(-1 * var(--space-2) - 2px);
}
.dj-sec-title {
  border: none;
  background: none;
  padding: 4px 0;
  font: inherit;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.dj-sec-summary {
  margin: 2px 0 var(--space-2);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.dj-gists > li {
  margin-top: var(--space-1);
}
.dj-keys {
  padding-left: var(--space-4);
}
.dj-node {
  display: block;
  width: 100%;
  border: none;
  background: none;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  color: var(--text);
  cursor: pointer;
}
.dj-node:hover {
  background: var(--surface-2);
}
.dj-node:focus-visible,
.dj-sec-title:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: var(--radius-sm);
}
.dj-gist {
  font-weight: 500;
}
.dj-key {
  color: var(--text-2);
  border-left: 2px solid var(--border-strong);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.dj-glossary {
  margin: 0;
}
.dj-glossary dt {
  margin-top: var(--space-2);
}
.dj-term {
  font-weight: 600;
  text-decoration: underline dotted var(--text-3);
  text-underline-offset: 3px;
}
.dj-glossary dd {
  margin: 0 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.dj-outline-source {
  margin: 0;
  padding: var(--space-2) var(--space-4) calc(var(--space-2) + var(--lr-safe-bottom));
  font-size: 11px;
  color: var(--text-3);
  border-top: 1px solid var(--border);
}
@media (max-width: 600px) {
  .dj-outline:not(.embedded) {
    top: auto;
    left: 0;
    width: 100%;
    height: 80vh;
    border-left: none;
    border-top: 1px solid var(--border);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding-top: 0;
  }
}
</style>
