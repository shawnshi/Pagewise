<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { acquireLibraryCover } from '../../services/libraryCovers'
import { t } from '../../i18n'
import type { BookMeta } from '../../storage'
import { titleHue } from './format'

/** Only visible statistics thumbnails borrow from the same bounded pool as the library. */
const props = withDefaults(defineProps<{
  book?: BookMeta
  title: string
  kind?: 'book' | 'paper'
  size?: 'sm' | 'md' | 'lg'
}>(), { size: 'sm', kind: 'book', book: undefined })

const element = ref<HTMLElement | null>(null)
const visible = ref(false)
const coverUrl = ref<string>()
const coverError = shallowRef<Error>()
let observer: IntersectionObserver | undefined
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { visible.value = true; return }
  observer = new IntersectionObserver(entries => {
    const entry = entries.find(item => item.target === element.value)
    if (entry) visible.value = entry.isIntersecting
  })
  if (element.value) observer.observe(element.value)
})
onBeforeUnmount(() => observer?.disconnect())
watch([() => props.book?.id, () => props.book?.hasCover, visible], ([id, hasCover, shown], _previous, onCleanup) => {
  coverUrl.value = undefined
  coverError.value = undefined
  if (!id || !shown || !hasCover) return
  const lease = acquireLibraryCover(id)
  let active = true
  onCleanup(() => { active = false; lease.release() })
  void lease.ready.then(url => {
    if (active) coverUrl.value = url
  }, error => {
    if (active) coverError.value = error instanceof Error ? error : new Error(String(error))
  })
}, { immediate: true })
const hue = computed(() => titleHue(props.title || '?'))
const initial = computed(() => [...(props.title || '?').trim()][0] ?? '?')
</script>

<template>
  <span ref="element" class="thumb" :class="[size, { missing: !book, 'cover-error': !!coverError }]" :title="coverError ? t('library.coverLoadFailed') : undefined" aria-hidden="true">
    <img v-if="coverUrl" :src="coverUrl" alt="" loading="lazy" decoding="async" />
    <span v-else-if="book" class="fallback" :style="{ '--h': hue }">{{ initial }}</span>
    <span v-else class="placeholder">
      <svg v-if="kind === 'paper'" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 2h9a1 1 0 0 1 .7.3l4 4a1 1 0 0 1 .3.7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 2H6v16h12V8h-3a1 1 0 0 1-1-1V4zM8 11a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1z" /></svg>
      <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z" /></svg>
    </span>
  </span>
</template>

<style scoped>
.thumb {
  position: relative;
  flex-shrink: 0;
  display: block;
  width: 32px;
  aspect-ratio: 5 / 7;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-2);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent), var(--shadow-sm);
}
.thumb.md {
  width: 44px;
  border-radius: 5px;
}
.thumb.lg {
  width: 56px;
  border-radius: 6px;
}
.thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.fallback {
  --h: 210;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  font-weight: 650;
  color: hsl(var(--h) 40% 26%);
  background: linear-gradient(160deg, hsl(var(--h) 55% 90%) 0%, hsl(var(--h) 45% 80%) 100%);
}
.md .fallback {
  font-size: 17px;
}
.lg .fallback {
  font-size: 21px;
}
:root[data-theme='dark'] .fallback {
  color: hsl(var(--h) 60% 88%);
  background: linear-gradient(160deg, hsl(var(--h) 26% 32%) 0%, hsl(var(--h) 24% 22%) 100%);
}
.thumb.cover-error {
  outline: 1px dashed var(--border-strong);
}
.thumb.missing {
  background: transparent;
  box-shadow: none;
  border: 1px dashed var(--border-strong);
}
.placeholder {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: var(--text-3);
}
</style>
