/**
 * 网络请求抽象:
 *  - 桌面端 (Tauri) 走 Rust 原生 HTTP, 无跨域限制, 支持 http/socks5 代理 (设置页配置)
 *  - Web 端走浏览器 fetch, 目标站不支持 CORS 时可配置 CORS 代理模板
 *  - 书源可配 HTTP Basic 鉴权 (calibre-web 等需登录的源)
 */
import { isTauri } from '../storage/types'
import { useSettings } from '../stores/settings'

export interface RequestAuth {
  username?: string
  password?: string
}

export function authHeader(auth?: RequestAuth): Record<string, string> {
  if (!auth?.username) return {}
  const raw = `${auth.username}:${auth.password ?? ''}`
  // btoa 只接受 latin1, 先做 UTF-8 编码
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(raw)))
  return { authorization: `Basic ${encoded}` }
}

function applyCorsProxy(url: string): string {
  if (isTauri()) return url
  const proxy = useSettings().corsProxy.trim()
  if (!proxy) return url
  return proxy.includes('{url}')
    ? proxy.replace('{url}', encodeURIComponent(url))
    : proxy + encodeURIComponent(url)
}

export const REMOTE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 LightRead'

const STATUS_HINTS: Record<number, string> = {
  401: '请求未获授权 (401)',
  403: '访问被拒绝 (403)',
  404: '地址不存在 (404)',
  429: '请求过于频繁 (429), 请稍后再试',
}

export interface RemoteRequestInit {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  /** true 时不因非 2xx 抛错, 由调用方处理状态码 (WebDAV 探测等) */
  raw?: boolean
}

/** 设置页「网络」里配置的代理 (桌面 / 安卓应用的原生请求使用); 未配置为空串 */
export function remoteProxy(): string {
  return useSettings().httpProxy.trim()
}

export async function fetchRemote(
  url: string,
  auth?: RequestAuth,
  init: RemoteRequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/atom+xml, application/xml, text/xml, */*',
    // 部分站点 (如古登堡) 拦截非浏览器 UA; 浏览器环境此头会被忽略, 桌面端由 Rust 发送
    'user-agent': REMOTE_USER_AGENT,
    ...authHeader(auth),
    ...(init.headers ?? {}),
  }

  let res: Response
  if (isTauri()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    const proxyUrl = remoteProxy()
    res = await tauriFetch(url, {
      method: init.method ?? 'GET',
      body: init.body,
      headers,
      signal: init.signal,
      connectTimeout: 30_000,
      ...(proxyUrl ? { proxy: { all: proxyUrl } } : {}),
    } as any)
  } else {
    res = await fetch(applyCorsProxy(url), {
      method: init.method ?? 'GET',
      body: init.body,
      headers,
      signal: init.signal,
    })
  }

  if (!init.raw && !res.ok) {
    throw new Error(STATUS_HINTS[res.status] ?? `请求失败: ${res.status} ${res.statusText}`)
  }
  return res
}

export async function fetchXml(url: string, auth?: RequestAuth, init?: RemoteRequestInit): Promise<Document> {
  const res = await fetchRemote(url, auth, init)
  const text = await res.text()
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('响应不是有效的 XML / OPDS 目录')
  return doc
}

export async function fetchBlob(url: string, auth?: RequestAuth): Promise<{ blob: Blob; contentType: string }> {
  const res = await fetchRemote(url, auth)
  const blob = await res.blob()
  return { blob, contentType: res.headers.get('content-type') ?? '' }
}
