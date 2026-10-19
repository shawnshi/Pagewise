import { defineStore } from 'pinia'
import type { BookMeta, ReadingStatus } from '../storage'
import { getStorage } from '../storage'
import { recordReading } from '../services/readingLog.ts'

export const useLibrary = defineStore('library', {
  state: () => ({
    books: [] as BookMeta[],
    loaded: false,
  }),
  actions: {
    async refresh() {
      const storage = await getStorage()
      this.books = await storage.listBooks()
      this.loaded = true
    },
    async removeBook(id: string) {
      const storage = await getStorage()
      const book = await storage.getBook(id)
      // Rescans rediscover source files; deleting only their index would discard notes/history.
      if (book && 'sourceRef' in book && book.sourceRef) {
        throw new Error('Source-linked books cannot be removed. Manage the monitored folder instead.')
      }
      await storage.deleteBook(id)
      this.books = this.books.filter(b => b.id !== id)
    },
    async saveProgress(id: string, location: string, progress: number) {
      const storage = await getStorage()
      const patch = { location, progress, lastReadAt: Date.now() }
      await storage.updateBook(id, patch)
      const book = this.books.find(b => b.id === id)
      if (book) Object.assign(book, patch)
    },
    /** 累加阅读时长 (秒), 同时记入每日阅读记录 (at: 归到哪一天, 缺省为现在) */
    async addReadingTime(id: string, seconds: number, at?: number) {
      const delta = Math.round(seconds)
      if (!Number.isFinite(delta) || delta <= 0) return
      const storage = await getStorage()
      const meta = await storage.getBook(id)
      if (!meta) return
      // 支持的后端用单条原子累加; 旧后端回退到读-改-写, 仍然保留真实累计值。
      const readingSeconds = storage.incrementReadingSeconds
        ? await storage.incrementReadingSeconds(id, delta)
        : (meta.readingSeconds ?? 0) + delta
      if (!storage.incrementReadingSeconds) await storage.updateBook(id, { readingSeconds })
      const book = this.books.find(b => b.id === id)
      if (book) book.readingSeconds = readingSeconds
      // 每日记录是附加统计: 失败不影响书的累计时长
      try {
        await recordReading({ id, title: meta.title, kind: meta.kind }, delta, at)
      } catch (err) {
        console.warn('[readingLog] record failed', err)
      }
    },
    /** 设置单本书籍的阅读状态 */
    async setReadingStatus(id: string, readingStatus: ReadingStatus | undefined) {
      const storage = await getStorage()
      await storage.updateBook(id, { readingStatus })
      const book = this.books.find(b => b.id === id)
      if (book) book.readingStatus = readingStatus
    },
    /** 批量更新阅读状态, 精确统计成功与失败, 避免全量历史覆写 */
    async batchSetReadingStatus(ids: string[], readingStatus: ReadingStatus) {
      const storage = await getStorage()
      const targetIds = [...new Set(ids)]
      const results = await Promise.allSettled(
        targetIds.map(id => storage.updateBook(id, { readingStatus }))
      )
      let succeeded = 0
      const failedIds: string[] = []
      results.forEach((res, index) => {
        const id = targetIds[index]
        if (res.status === 'fulfilled') {
          succeeded++
          const book = this.books.find(b => b.id === id)
          if (book) book.readingStatus = readingStatus
        } else {
          failedIds.push(id)
        }
      })
      return { succeeded, failed: failedIds.length, failedIds }
    },
    /** 批量永久删除书籍, 返回真实结果, 不伪造回收站 */
    async batchRemoveBooks(ids: string[]) {
      const targetIds = [...new Set(ids)]
      const results = await Promise.allSettled(
        targetIds.map(id => this.removeBook(id))
      )
      const succeededIds = new Set<string>()
      const failedIds: string[] = []
      results.forEach((res, index) => {
        const id = targetIds[index]
        if (res.status === 'fulfilled') {
          succeededIds.add(id)
        } else {
          failedIds.push(id)
        }
      })
      return { succeeded: succeededIds.size, failed: failedIds.length, failedIds }
    },
  },
})
