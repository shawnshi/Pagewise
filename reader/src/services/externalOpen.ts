import type { Router } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { importFile } from './importer'
import { detectFormat } from './format'
import { onyxNativeAccelerator } from './onyxNativeAccelerator'
import { useLibrary } from '../stores/library'
import { toast } from './toast'

let draining = false
let rerun = false

/** 导入并打开由操作系统交给 LightRead 的电子书文件。 */
async function drainOpenFiles(router: Router) {
  if (draining) {
    rerun = true
    return
  }
  draining = true
  try {
    do {
      rerun = false
      const paths = await invoke<string[]>('take_open_files')
      const nativeStaged = onyxNativeAccelerator.drainExternalOpenQueue()
      let lastBookId: string | undefined
      let lastFormat: ReturnType<typeof detectFormat> = null
      for (const staged of nativeStaged) {
        const name = staged.fileName || 'document'
        try {
          const relTarget = `books/.staged-open-${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
          if (!onyxNativeAccelerator.commitStagedExternalFile(staged.stagedPath, relTarget)) {
            throw new Error('Failed to stage external document')
          }
          const { readFile, remove, BaseDirectory } = await import('@tauri-apps/plugin-fs')
          try {
            const bytes = await readFile(relTarget, { baseDir: BaseDirectory.AppLocalData })
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
            const result = await importFile(new File([buffer], name), '系统打开')
            if (!result.ok) throw new Error(result.error)
            lastBookId = result.bookId
            lastFormat = detectFormat(name)
          } finally {
            await remove(relTarget, { baseDir: BaseDirectory.AppLocalData }).catch(() => {})
          }
        } catch (error: any) {
          toast(`${name}: ${error?.message ?? error}`, 'error', 6000)
        }
      }
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() || 'document'
        try {
          // 由 Rust 读取系统交付的路径，避免外置磁盘等位置被前端 fs scope 拦截。
          const bytes = await invoke<ArrayBuffer>('read_open_file', { path })
          const result = await importFile(
            new File([bytes], name),
            '系统打开',
          )
          if (!result.ok) throw new Error(result.error)
          lastBookId = result.bookId
          lastFormat = detectFormat(name)
        } catch (error: any) {
          toast(`${name}: ${error?.message ?? error}`, 'error', 6000)
        }
      }
      if (lastBookId) {
        await useLibrary().refresh()
        // 同一路由组件的 :id 变化不会自动重建 setup；先离开阅读页再打开新文件。
        if (router.currentRoute.value.path.startsWith('/read')) {
          await router.replace('/library')
        }
        const target = lastFormat === 'pdf'
          ? `/read-paper/${lastBookId}`
          : lastFormat === 'djvu'
            ? `/read-djvu/${lastBookId}`
            : `/read/${lastBookId}`
        await router.push(target)
      }
    } while (rerun)
  } finally {
    draining = false
  }
}

/** 同时覆盖冷启动和应用已运行时的系统文件打开事件。 */
export async function startExternalOpen(router: Router): Promise<UnlistenFn> {
  const unlisten = await listen('open-files', () => drainOpenFiles(router))
  const unlistenNative = onyxNativeAccelerator.onNativeExternalOpen(() => {
    void drainOpenFiles(router)
  })
  await drainOpenFiles(router)
  return () => {
    unlisten()
    unlistenNative()
  }
}
