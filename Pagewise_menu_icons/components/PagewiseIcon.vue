<script setup lang="ts">
import { computed } from 'vue'
import { iconMarkup, type PagewiseIconName } from './iconMarkup'

const props = withDefaults(defineProps<{
  name: PagewiseIconName
  size?: number
  emphasis?: boolean
  label?: string
  marked?: boolean
}>(), { size: 28, emphasis: false, marked: false })

// 只使用随包提供的静态图形字符串，不接收远程或用户提供的SVG。
const markup = computed(() => props.marked && props.name === 'bookmarks'
  ? iconMarkup.bookmarks.replace('/>', ' fill="currentColor"/>')
  : iconMarkup[props.name])
</script>

<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
    :width="size" :height="size" fill="none" stroke="currentColor"
    :stroke-width="emphasis ? 2.25 : 2" stroke-linecap="round" stroke-linejoin="round"
    :role="label ? 'img' : undefined" :aria-label="label"
    :aria-hidden="label ? undefined : true" focusable="false" v-html="markup" />
</template>

<style scoped>
svg { display: block; flex: none; }
</style>
