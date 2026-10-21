import './polyfills'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/main.css'
import { isTauri } from './storage/types'
import { installAndroidSafeArea } from './services/systemBars'
import { errorCode, hasNativeState, initializeNativeState } from './services/nativeState'
import { initializeNativePages } from './services/nativePages'

// index.html 的旧 WebView 检查: 模块图能执行到这里就说明环境够新
;(window as unknown as { __lightreadBoot?: boolean }).__lightreadBoot = true

// Android 包内资源不注册 Service Worker。仅清理旧 WebView 缓存，避免遗留 SW 供给旧代码。
// 这不是 PWA 注册或发行入口；不清除 IndexedDB/书库数据。
if (isTauri() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(regs => regs.forEach(r => r.unregister()))
    .catch(() => {})
  window.caches?.keys()
    .then(keys => keys.forEach(k => caches.delete(k)))
    .catch(() => {})
}

installAndroidSafeArea()

async function bootstrap() {
  const target = document.getElementById('app')
  if (hasNativeState() && target) {
    const message = document.createElement('p')
    message.textContent = '正在核对并迁移原有设置和阅读统计，请勿清除应用数据。'
    message.style.cssText = 'padding:24px;font:18px/1.6 system-ui'
    target.replaceChildren(message)
  }
  // This must settle before any Pinia store, storage factory or route can read its owner.
  await initializeNativeState()
  const pinia = createPinia()
  const app = createApp(App).use(pinia)
  await initializeNativePages(router, pinia)
  app.use(router).mount('#app')
}

void bootstrap().catch(error => {
  const target = document.getElementById('app')
  if (!target) return
  const panel = document.createElement('main')
  panel.style.cssText = 'padding:24px;font:18px/1.6 system-ui'
  const title = document.createElement('h1')
  title.textContent = '数据初始化未完成'
  const detail = document.createElement('p')
  const code = (errorCode(error) ?? 'native_initialization_failed').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  detail.textContent = `错误代码：${code}。不会回落为空设置或空统计；旧副本未删除。请核对原书库位置与权限后重新载入。`
  const retry = document.createElement('button')
  retry.textContent = '重新载入并核对'
  retry.onclick = () => window.location.reload()
  panel.append(title, detail, retry)
  target.replaceChildren(panel)
})
