/**
 * 「选择文件夹」的平台适配: 桌面 (Tauri) 走系统目录对话框 + plugin-fs 递归读取,
 * 网页走 <input type="file" webkitdirectory>。挑书规则见 folderPick.ts。
 * Android / iOS 的 WebView 与 Tauri 移动端拿不到可遍历的目录, 不提供入口。
 */
import { isTauri } from '../storage/types.ts'
import { detectFormat } from './format.ts'
import { isIgnoredEntry, type FolderEntry } from './folderPick.ts'

/** 一次最多扫描的文件数 / 目录深度 */
export const FOLDER_MAX_FILES = 5000
export const FOLDER_MAX_DEPTH = 8

export interface FolderFile extends FolderEntry {
  /** 网页: 浏览器给的 File */
  file?: File
  /** 桌面: 绝对路径, 导入 / 上传时再读 */
  absPath?: string
  lastModified?: number
}
export interface FolderScan {
  /** 所选文件夹的名字 */
  name: string
  entries: FolderFile[]
  /** 文件太多, 只扫描了前 FOLDER_MAX_FILES 个 */
  truncated: boolean
}

const isMobile = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** 当前环境能否选择文件夹 */
export function canPickFolder(): boolean {
  if (typeof window === 'undefined' || isMobile()) return false
  // iPadOS 13+ 的 Safari 伪装成 Mac, 但也选不了文件夹
  if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return false
  if (isTauri()) return true
  return typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype
}

/** 桌面端是否走原生目录对话框 (网页走 webkitdirectory 输入框) */
export const useNativeFolderPicker = () => isTauri()

/** 网页: webkitdirectory 输入框选中的文件 → 条目 (路径去掉最外层的文件夹名) */
export function scanFromFileList(files: FileList | File[]): FolderScan | null {
  const list = Array.from(files)
  if (!list.length) return null
  const rel = (file: File) => (file.webkitRelativePath || file.name).replace(/\\/g, '/')
  const name = rel(list[0]).split('/')[0] || ''
  const entries = list.slice(0, FOLDER_MAX_FILES).map(file => {
    const parts = rel(file).split('/')
    return { path: (parts.length > 1 ? parts.slice(1) : parts).join('/'), name: file.name, size: file.size, file, lastModified: file.lastModified }
  })
  return { name, entries, truncated: list.length > FOLDER_MAX_FILES }
}

/** 桌面: 弹出目录对话框并递归扫描; 取消返回 null。onPicked: 选好目录、开始扫描时回调 (界面显示「正在扫描」) */
export async function scanNativeFolder(onPicked?: (name: string) => void): Promise<FolderScan | null> {
  const [{ open }, fs] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')])
  // recursive: 让对话框把子目录也加入 fs 权限范围
  const picked = await open({ directory: true, recursive: true, multiple: false })
  const root = Array.isArray(picked) ? picked[0] : picked
  if (!root) return null
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '') || root
  const name = trimmed.split(/[\\/]/).pop() || trimmed
  onPicked?.(name)
  const entries: FolderFile[] = []
  let seen = 0, truncated = false
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let items: Awaited<ReturnType<typeof fs.readDir>>
    try { items = await fs.readDir(dir) } catch { return } // 无权限的子目录跳过
    for (const item of items) {
      if (truncated) return
      // 符号链接不跟随, 避免环
      if (item.isSymlink) continue
      const path = rel ? `${rel}/${item.name}` : item.name
      const abs = `${dir}${dir.endsWith(sep) ? '' : sep}${item.name}`
      if (item.isDirectory) {
        // 子目录是否忽略交给 isIgnoredEntry 同一套规则判断 (以虚拟文件试探)
        if (depth < FOLDER_MAX_DEPTH && !isIgnoredEntry({ path: `${path}/x.epub`, name: 'x.epub', size: 1 })) await walk(abs, path, depth + 1)
        continue
      }
      if (!item.isFile) continue
      if (++seen > FOLDER_MAX_FILES) { truncated = true; return }
      entries.push({ path, name: item.name, size: 0, absPath: abs })
    }
  }
  await walk(trimmed, '', 1)
  // 只给可能是书的文件取大小 (每个 stat 一次 IPC); 其余只用来计数「不支持」
  const needSize = entries.filter(e => detectFormat(e.name) && !isIgnoredEntry({ ...e, size: 1 }))
  for (let i = 0; i < needSize.length; i += 16) {
    await Promise.all(needSize.slice(i, i + 16).map(async e => {
      try {
        const info = await fs.stat(e.absPath!)
        e.size = info.size
        e.lastModified = info.mtime?.getTime()
      } catch { e.size = 0 } // 读不到按空文件忽略
    }))
  }
  return { name, entries, truncated }
}

/** 取得条目的 File (桌面端此时才从磁盘读出) */
export async function loadFolderFile(entry: FolderFile): Promise<File> {
  if (entry.file) return entry.file
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(entry.absPath!)
  return new File([bytes as Uint8Array<ArrayBuffer>], entry.name, { lastModified: entry.lastModified })
}
