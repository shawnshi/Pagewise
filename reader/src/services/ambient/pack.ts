/**
 * 录音包 (阶段 3): 清单格式、格式选择、按需下载与本地缓存。
 *
 * - 素材不进仓库, 托管在 PACK_BASE_URL (R2); 清单内置一份 (BUILTIN_MANIFEST, 离线时也能显示大小),
 *   refreshManifest() 可拉取远端新版。远端需要 CORS: Access-Control-Allow-Origin: *。
 * - 缓存: 优先 Cache Storage, 不可用时回退 IndexedDB; 只用 fetch + Cache/IDB, 三端 (网页 / Tauri 桌面 / Android WebView) 同一条路径。
 * - 格式: 支持 `audio/ogg; codecs=opus` 用 Opus, 否则 AAC .m4a (Safari < 18.4 / 旧 macOS WKWebView)。
 *   Opus 解码失败时由调用方 markFormatBroken('opus') 后改用 m4a。
 * 来源与许可见 docs/ambient-sources.md。
 */
import { BUILTIN_MANIFEST as BUILTIN } from './manifest.ts'

export type PackFormat = 'opus' | 'm4a'

export interface PackFile {
  /** 相对 baseUrl 的路径, 或绝对 URL */
  url: string
  bytes: number
  sha256?: string
}

export interface PackItem {
  id: string
  /** 所属场景 id (scenes.ts) */
  scene: string
  kind: 'loop' | 'track'
  title: string
  author: string
  license: string
  licenseUrl: string
  sourceUrl: string
  durationSec: number
  /** 后期处理后的响度 */
  loudness: { integratedLufs: number; truePeakDb: number }
  files: Record<PackFormat, PackFile>
}

export interface PackManifest {
  version: 1
  baseUrl: string
  items: PackItem[]
}

export const PACK_BASE_URL = 'https://lightread-assets.jiangshu.ai/ambient/v1/'
const CACHE_NAME = 'lightread-ambient-v1'
const IDB_NAME = 'lightread-ambient'
const IDB_STORE = 'files'

// ---------------------------------------------------------------------------
// 纯函数: 清单校验 / 格式选择 / URL 解析
// ---------------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 只接受可自由再分发的许可 (CC0 / 公有领域 / CC BY); NC、ND、SA 和其他许可一律拒绝 */
export const ALLOWED_LICENSES = ['CC0-1.0', 'PD', 'CC-BY-4.0'] as const

export function validateManifest(json: unknown): { ok: true; manifest: PackManifest } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const m = json as Partial<PackManifest> | null
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest 不是对象'] }
  if (m.version !== 1) errors.push(`不支持的 version: ${String(m.version)}`)
  if (!isStr(m.baseUrl) || !/^https:\/\//.test(m.baseUrl) || !m.baseUrl.endsWith('/')) errors.push('baseUrl 必须是以 / 结尾的 https 地址')
  if (!Array.isArray(m.items) || m.items.length === 0) errors.push('items 为空')
  const seen = new Set<string>()
  for (const [i, it] of (Array.isArray(m.items) ? m.items : []).entries()) {
    const at = `items[${i}]`
    if (!it || typeof it !== 'object') { errors.push(`${at} 不是对象`); continue }
    if (!isStr(it.id) || !/^[a-z0-9-]+$/.test(it.id)) errors.push(`${at}.id 非法`)
    else if (seen.has(it.id)) errors.push(`${at}.id 重复: ${it.id}`)
    else seen.add(it.id)
    if (!isStr(it.scene)) errors.push(`${at}.scene 缺失`)
    if (it.kind !== 'loop' && it.kind !== 'track') errors.push(`${at}.kind 必须是 loop / track`)
    for (const k of ['title', 'author', 'licenseUrl', 'sourceUrl'] as const) if (!isStr(it[k])) errors.push(`${at}.${k} 缺失`)
    if (!(ALLOWED_LICENSES as readonly string[]).includes(it.license)) errors.push(`${at}.license 不允许: ${String(it.license)}`)
    if (!isNum(it.durationSec) || it.durationSec <= 0) errors.push(`${at}.durationSec 非法`)
    if (it.kind === 'loop' && isNum(it.durationSec) && (it.durationSec < 20 || it.durationSec > 120)) errors.push(`${at} 循环素材时长应在 20–120 秒`)
    if (!it.loudness || !isNum(it.loudness.integratedLufs) || !isNum(it.loudness.truePeakDb)) errors.push(`${at}.loudness 缺失`)
    else if (it.loudness.truePeakDb > -1) errors.push(`${at}.loudness.truePeakDb 过高`)
    for (const f of ['opus', 'm4a'] as const) {
      const file = it.files?.[f]
      if (!file || !isStr(file.url) || !isNum(file.bytes) || file.bytes <= 0) errors.push(`${at}.files.${f} 缺失或非法`)
      else if (file.sha256 != null && !/^[0-9a-f]{64}$/.test(file.sha256)) errors.push(`${at}.files.${f}.sha256 非法`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m as PackManifest }
}

/**
 * 选格式: canPlayType 给出 'probably' / 'maybe' 即可用 Opus; broken 记录本机试解码失败过的格式。
 * 两个都不支持时仍返回 m4a (AAC 覆盖面最广)。
 */
export function pickFormat(canPlayType: (mime: string) => string, broken: ReadonlySet<PackFormat> = new Set()): PackFormat {
  if (!broken.has('opus')) {
    const ogg = canPlayType('audio/ogg; codecs=opus')
    if (ogg === 'probably' || ogg === 'maybe') return 'opus'
  }
  return 'm4a'
}

export function resolveFileUrl(manifest: Pick<PackManifest, 'baseUrl'>, file: PackFile): string {
  return /^https?:\/\//.test(file.url) ? file.url : manifest.baseUrl + file.url.replace(/^\/+/, '')
}

/** 一组素材按选定格式的下载体积 */
export function itemsBytes(items: PackItem[], format: PackFormat): number {
  return items.reduce((sum, it) => sum + (it.files[format]?.bytes ?? 0), 0)
}

// ---------------------------------------------------------------------------
// 运行时: 清单 / 格式 / 缓存 / 下载
// ---------------------------------------------------------------------------

let manifest: PackManifest = (() => {
  const r = validateManifest(BUILTIN)
  if (!r.ok) console.warn('[ambient] 内置清单无效', r.errors)
  return BUILTIN as PackManifest
})()

export function getManifest(): PackManifest {
  return manifest
}

export function getItem(id: string): PackItem | undefined {
  return manifest.items.find(i => i.id === id)
}

/** 拉取远端清单 (可选): 校验通过才替换; 失败保持内置清单 */
export async function refreshManifest(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(manifest.baseUrl + 'manifest.json', { signal, cache: 'no-cache' })
    if (!res.ok) return false
    const r = validateManifest(await res.json())
    if (!r.ok) {
      console.warn('[ambient] 远端清单无效', r.errors)
      return false
    }
    manifest = r.manifest
    return true
  } catch {
    return false
  }
}

const brokenFormats = new Set<PackFormat>()

export function markFormatBroken(format: PackFormat): void {
  brokenFormats.add(format)
}

export function currentFormat(): PackFormat {
  if (typeof document === 'undefined') return 'm4a'
  const probe = document.createElement('audio')
  return pickFormat(m => probe.canPlayType(m), brokenFormats)
}

// ---- 存储: Cache Storage 优先, 回退 IndexedDB ----

interface BlobStore {
  get(key: string): Promise<Blob | null>
  put(key: string, blob: Blob): Promise<void>
  delete(key: string): Promise<void>
}

function cacheStore(): BlobStore | null {
  if (typeof caches === 'undefined') return null
  return {
    async get(key) {
      const c = await caches.open(CACHE_NAME)
      const res = await c.match(key)
      return res ? res.blob() : null
    },
    async put(key, blob) {
      const c = await caches.open(CACHE_NAME)
      await c.put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream', 'Content-Length': String(blob.size) } }))
    },
    async delete(key) {
      const c = await caches.open(CACHE_NAME)
      await c.delete(key)
    },
  }
}

function idbStore(): BlobStore | null {
  if (typeof indexedDB === 'undefined') return null
  let dbp: Promise<IDBDatabase> | null = null
  const open = () => (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> =>
    open().then(db => new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    }))
  return {
    async get(key) { return (await run<Blob | undefined>('readonly', s => s.get(key))) ?? null },
    async put(key, blob) { await run('readwrite', s => s.put(blob, key)) },
    async delete(key) { await run('readwrite', s => s.delete(key)) },
  }
}

let store: BlobStore | null | undefined
function getStore(): BlobStore | null {
  if (store === undefined) {
    try {
      store = cacheStore() ?? idbStore()
    } catch {
      store = idbStore()
    }
  }
  return store
}

function storeKey(item: PackItem, format: PackFormat): string {
  return resolveFileUrl(manifest, item.files[format])
}

export async function getCachedBlob(item: PackItem, format: PackFormat): Promise<Blob | null> {
  try {
    return (await getStore()?.get(storeKey(item, format))) ?? null
  } catch {
    return null
  }
}

export async function isItemCached(item: PackItem, format: PackFormat): Promise<boolean> {
  return (await getCachedBlob(item, format)) != null
}

export async function removeItem(item: PackItem): Promise<void> {
  const s = getStore()
  if (!s) return
  for (const f of ['opus', 'm4a'] as const) {
    try { await s.delete(storeKey(item, f)) } catch { /* 不存在 */ }
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

export interface DownloadProgress {
  loaded: number
  total: number
}

/**
 * 下载一个素材到本地缓存 (已缓存则直接返回)。onProgress 按字节回调; 校验 sha256 (清单提供时)。
 * 返回缓存里的 Blob。
 */
export async function downloadItem(
  item: PackItem,
  format: PackFormat,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const cached = await getCachedBlob(item, format)
  const file = item.files[format]
  if (cached) {
    onProgress?.({ loaded: file.bytes, total: file.bytes })
    return cached
  }
  const url = resolveFileUrl(manifest, file)
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('Content-Length')) || file.bytes
  let buf: ArrayBuffer
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.({ loaded, total })
    }
    const out = new Uint8Array(loaded)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    buf = out.buffer
  } else {
    buf = await res.arrayBuffer()
    onProgress?.({ loaded: buf.byteLength, total })
  }
  if (file.sha256) {
    const got = await sha256Hex(buf)
    if (got && got !== file.sha256) throw new Error('校验失败 (sha256 不一致)')
  }
  const blob = new Blob([buf], { type: format === 'opus' ? 'audio/ogg' : 'audio/mp4' })
  try {
    await getStore()?.put(storeKey(item, format), blob)
  } catch (e) {
    // 存储满 / 无痕模式: 本次仍可播放, 只是下次需要重新下载
    console.warn('[ambient] 缓存写入失败', e)
  }
  return blob
}
