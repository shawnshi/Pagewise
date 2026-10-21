<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { hideNativePage, showNativePage } from '../services/nativePages'
const route = useRoute()
const error = ref('')
const owner = crypto.randomUUID()
let mounted = false
let epoch = 0
async function update() {
  const current = ++epoch
  const page = route.path.startsWith('/book/') ? 'book' : route.path === '/notes' ? 'annotations' : route.path.slice(1)
  const params = { ...route.query, ...route.params }
  try { await showNativePage(page, params, owner); if (current === epoch) error.value = '' }
  catch {
    if (current !== epoch) return
    error.value = '原生页面未能打开。不会回落到旧网页管理界面；请重新载入并核对初始化状态。'
    // Never issue an unowned/automatic hide on show failure: an earlier native editor may still hold input.
  }
}
async function leave() {
  try { await hideNativePage(owner); return true }
  catch {
    error.value = '页面尚不能离开：草稿或提交结果未确认。当前输入保持原位，请核对后重试。'
    return false
  }
}
onBeforeRouteLeave(leave)
onBeforeRouteUpdate(leave)
onMounted(() => { mounted = true; void update() })
watch(() => route.fullPath, () => { if (mounted) void update() })
// Normal transitions have an awaited router barrier. Host teardown owns unavoidable Activity disposal.
// An old component unmount must never send a late hide over a newer component's show.
onBeforeUnmount(() => { mounted = false; epoch++ })
</script>

<template>
  <!-- Actual content is an opaque Android native View overlay, not an HTML/iframe management page. -->
  <section class="native-page-status" aria-live="polite">
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" @click="update">重新打开原生页面</button>
  </section>
</template>

<style scoped>
.native-page-status { min-height: 100%; padding: 24px; }
</style>
