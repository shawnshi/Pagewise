import { createRouter, createWebHashHistory } from 'vue-router'
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
    { path: '/library', component: () => import('../views/LibraryView.vue') },
    { path: '/reading', component: () => import('../views/ReadingView.vue') },
    { path: '/book/:id', component: () => import('../views/BookDetailView.vue') },
    { path: '/notes', component: () => import('../views/NotesView.vue') },
    // 论文功能已退休, 旧路由重定向至藏书与通用 PDF 阅读
    { path: '/papers', redirect: '/library' },
    { path: '/read-paper/:id', redirect: to => ({ path: `/read-pdf/${encodeURIComponent(String(to.params.id))}`, query: to.query, hash: to.hash }) },
    { path: '/read-pdf/:id', component: () => import('../views/PdfReaderView.vue') },
    { path: '/read/:id', component: () => import('../views/ReaderView.vue') },
    { path: '/read-djvu/:id', redirect: '/library' },
    { path: '/catalogs', redirect: '/library' },
    { path: '/stats', component: () => import('../views/StatsView.vue') },
    { path: '/transfer', redirect: '/library' },
    { path: '/settings', component: () => import('../views/SettingsView.vue') },
    { path: '/manual', component: () => import('../views/ManualView.vue') },
  ],
})

router.afterEach((to, _from, failure) => {
  // A consumed Back or blocked leave did not commit the target route.
  if (failure) return
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
      } catch {
        // storage or book error handled by view
      }
    }
  }
})
