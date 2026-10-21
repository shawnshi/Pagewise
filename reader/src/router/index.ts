import { createRouter, createWebHashHistory } from 'vue-router'
import type { Component } from 'vue'
import { hasNativePages } from '../services/nativePages'
const managed = (load: () => Promise<{ default: Component }>) => () => hasNativePages() ? import('../views/NativePageView.vue') : load()
import { bookFileProblem } from '../services/bookAvailability'
import { saveLibrarySession } from '../services/librarySession'
import { isSupportedBookFormat } from '../services/format'
import { getStorage } from '../storage'
import { toast } from '../services/toast'
import { t } from '../i18n'
import { rememberView, restoreView } from '../services/navigationSession'

// Tauri 生产环境走 file 协议, 统一使用 hash 路由
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: () => { try { return restoreView(localStorage) } catch { return '/library' } } },
    { path: '/library', component: managed(() => import('../views/LibraryView.vue')) },
    { path: '/reading', component: managed(() => import('../views/ReadingView.vue')) },
    { path: '/book/:id', component: managed(() => import('../views/BookDetailView.vue')) },
    { path: '/notes', component: managed(() => import('../views/NotesView.vue')) },
    // 论文功能已退休, 旧路由重定向至藏书与通用 PDF 阅读
    { path: '/papers', redirect: '/library' },
    { path: '/read-paper/:id', redirect: to => ({ path: `/read-pdf/${encodeURIComponent(String(to.params.id))}`, query: to.query, hash: to.hash }) },
    { path: '/read-pdf/:id', component: () => import('../views/PdfReaderView.vue') },
    { path: '/read/:id', component: () => import('../views/ReaderView.vue') },
    { path: '/read-djvu/:id', redirect: '/library' },
    { path: '/catalogs', redirect: '/library' },
    { path: '/stats', component: managed(() => import('../views/StatsView.vue')) },
    { path: '/transfer', redirect: '/library' },
    { path: '/settings', component: managed(() => import('../views/SettingsView.vue')) },
    { path: '/manual', component: managed(() => import('../views/ManualView.vue')) },
  ],
})

router.afterEach((to, from, failure) => {
  // A consumed Back or blocked leave did not commit the target route.
  if (failure) return
  if ((from.path.startsWith('/read/') || from.path.startsWith('/read-pdf/')) && from.params.id) {
    saveLibrarySession({ returnedFromReader: true, lastViewedBookId: String(from.params.id) })
  }
  try { rememberView(to.path, localStorage) }
  catch { console.warn('Pagewise: last view could not be persisted') }
})

router.beforeEach(async (to) => {
  if (to.path.startsWith('/read-djvu/')) {
    toast(t('book.unsupportedFormat', { format: 'djvu' }), 'error')
    return '/library'
  }
  if (to.path.startsWith('/read/') || to.path.startsWith('/read-pdf/') || to.path.startsWith('/read-paper/')) {
    const id = to.params.id as string
    if (id) {
      try {
        const storage = await getStorage()
        const book = await storage.getBook(id)
        if (book && !isSupportedBookFormat(book.format)) {
          toast(t('book.unsupportedFormat', { format: book.format }), 'error')
          return '/library'
        }
        const problem = book && bookFileProblem(book)
        if (problem) return problem === 'permission-denied' ? '/settings?section=folder' : `/book/${id}?recover=1`
      } catch {
        // storage or book error handled by view
      }
    }
  }
})
