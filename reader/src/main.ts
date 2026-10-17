import './polyfills'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/main.css'
import { isTauri } from './storage/types'
import { installAndroidSafeArea } from './services/systemBars'

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

createApp(App).use(createPinia()).use(router).mount('#app')
