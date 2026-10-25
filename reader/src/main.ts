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

function renderInitializationFailure(target: HTMLElement, rawCode: string) {
  const code = /^[a-zA-Z0-9_-]{1,80}$/.test(rawCode) ? rawCode : 'native_initialization_failed'
  const panel = document.createElement('main')
  panel.style.cssText = 'box-sizing:border-box;max-width:720px;margin:0 auto;padding:calc(var(--lr-safe-top,0px) + 24px) 24px calc(var(--lr-safe-bottom,0px) + 24px);font:18px/1.6 system-ui;overflow-wrap:anywhere'
  const title = document.createElement('h1')
  title.id = 'initialization-failure-title'
  title.textContent = '书库尚未准备好'
  title.tabIndex = -1
  title.style.cssText = 'font-size:24px;line-height:1.4;margin:0 0 16px'
  panel.setAttribute('aria-labelledby', title.id)
  const detail = document.createElement('p')
  detail.textContent = code === 'library_schema_mismatch'
    ? '书库结构检查未通过，已停止继续初始化。该错误不等于数据库损坏，也不能据此判断书籍是否丢失。'
    : '初始化遇到错误，已停止进入书库。不会回落为空设置或空统计。'
  const advice = document.createElement('p')
  advice.textContent = '请勿清除应用数据或删除书库文件。可展开诊断信息并提供错误代码；需要退出时可使用系统返回键。'
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;margin-top:24px'
  function button(label: string) {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    node.style.cssText = 'box-sizing:border-box;min-height:48px;min-width:160px;flex:1 1 180px;padding:10px 16px;font:inherit;color:inherit;background:white;border:1px solid currentColor;border-radius:6px'
    actions.append(node)
    return node
  }
  const retry = button('重新检查')
  retry.onclick = () => window.location.reload()
  const copy = button('复制错误代码')
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  copy.onclick = async () => {
    copy.disabled = true
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable')
      await navigator.clipboard.writeText(code)
      status.textContent = '错误代码已复制。'
    } catch {
      status.textContent = '无法自动复制。请展开诊断信息，长按错误代码手动复制。'
    } finally {
      copy.disabled = false
    }
  }
  const diagnostics = document.createElement('details')
  diagnostics.style.marginTop = '24px'
  const summary = document.createElement('summary')
  summary.textContent = '诊断信息（点击展开）'
  summary.style.cssText = 'box-sizing:border-box;min-height:48px;padding:10px 0;cursor:pointer'
  const diagnosticCode = document.createElement('code')
  diagnosticCode.textContent = code
  diagnosticCode.style.cssText = 'display:block;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text'
  diagnostics.append(summary, diagnosticCode)
  panel.append(title, detail, advice, actions, status, diagnostics)
  target.replaceChildren(panel)
  title.focus()
}

void bootstrap().catch(error => {
  const target = document.getElementById('app')
  if (target) renderInitializationFailure(target, errorCode(error) ?? 'native_initialization_failed')
})
