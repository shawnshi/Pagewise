/**
 * 书库包保存。
 *
 * Android WebView 不支持 `<a download>` 的 blob 下载: 点击不会产生文件, 旧实现仍然
 * 提示“已导出”。这里改用系统保存对话框 (ACTION_CREATE_DOCUMENT) 选择目标。
 *
 * 设备上优先使用 `exportLibraryArchiveToDevice`: 先选目标, 再边构建 zip 边把输出
 * 以 2 MB 块写入应用 cache, 最后原生流式复制到 content URI。这样数百 MB 书库也不会
 * 同时在 JS 中保留全部书字节和完整 zip。浏览器预览保留原来的下载链接。
 */
import { isTauri } from '../storage/types'
import { retryWhileBusy } from '../storage/sourceFile'
import { toBase64Chunk } from './base64'

export type ArchiveSaveResult = 'saved' | 'cancelled'

const NATIVE_TEMP = /^cache\/export-[A-Za-z0-9-]{1,64}\.zip$/
const CHUNK_BYTES = 2 * 1024 * 1024

async function chooseArchiveTarget(fileName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  try {
    return await save({ defaultPath: fileName, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
  } catch (error) {
    // 对话框取消在 Android 插件侧是 reject; 不应当成导出失败。
    if (/cancel/i.test(error instanceof Error ? error.message : String(error))) return null
    throw error
  }
}

function nativeTempPath(): string {
  const relative = `cache/export-${crypto.randomUUID()}.zip`
  if (!NATIVE_TEMP.test(relative)) throw new Error('Invalid export path')
  return relative
}

/** 浏览器分支: 直接下载已生成的 Blob。 */
export function downloadArchiveBlob(blob: Blob, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob)
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

/** 兼容入口: 已有完整 Blob 时仍可分块写入设备。 */
export async function saveLibraryArchive(blob: Blob, fileName: string): Promise<ArchiveSaveResult> {
  if (!isTauri()) {
    downloadArchiveBlob(blob, fileName)
    return 'saved'
  }
  const target = await chooseArchiveTarget(fileName)
  if (!target) return 'cancelled'
  const { invoke } = await import('@tauri-apps/api/core')
  const relative = nativeTempPath()
  await retryWhileBusy(() => invoke('begin_export', { path: relative }))
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, Math.min(offset + CHUNK_BYTES, blob.size)).arrayBuffer())
      await retryWhileBusy(() => invoke('append_export', { path: relative, data: toBase64Chunk(bytes) }))
    }
    await retryWhileBusy(() => invoke('write_export', { path: relative, uri: target }))
  } finally {
    await invoke('delete_export', { path: relative }).catch(() => { /* 原生也会清理过期文件 */ })
  }
  return 'saved'
}

/**
 * 设备导出: 先生成档案到指定 zip sink, 不在内存中收集完整包。
 * `build` 通常为 backup.ts 的 exportBackupToSink。
 */
export async function exportLibraryArchiveToDevice(
  fileName: string,
  build: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<ArchiveSaveResult> {
  if (!isTauri()) return 'cancelled'
  const target = await chooseArchiveTarget(fileName)
  if (!target) return 'cancelled'
  const { invoke } = await import('@tauri-apps/api/core')
  const relative = nativeTempPath()
  await retryWhileBusy(() => invoke('begin_export', { path: relative }))

  const pending: Uint8Array[] = []
  let pendingBytes = 0
  const append = async (bytes: Uint8Array) => {
    await retryWhileBusy(() => invoke('append_export', { path: relative, data: toBase64Chunk(bytes) }))
  }
  const flush = async () => {
    while (pending.length) {
      let chunk = pending.shift()!
      while (chunk.byteLength > CHUNK_BYTES) {
        await append(chunk.subarray(0, CHUNK_BYTES))
        chunk = chunk.subarray(CHUNK_BYTES)
      }
      if (chunk.byteLength) await append(chunk)
    }
    pendingBytes = 0
  }
  try {
    await build(async chunk => {
      pending.push(chunk)
      pendingBytes += chunk.byteLength
      if (pendingBytes >= CHUNK_BYTES) await flush()
    })
    await flush()
    await retryWhileBusy(() => invoke('write_export', { path: relative, uri: target }))
  } finally {
    await invoke('delete_export', { path: relative }).catch(() => { /* 原生也会清理过期文件 */ })
  }
  return 'saved'
}
