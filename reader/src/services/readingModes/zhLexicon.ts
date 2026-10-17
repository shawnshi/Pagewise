/**
 * 仿生阅读中文词表的懒加载 (src/data/zh-lexicon.txt, 约 230 KB gzip)。
 * 第一次在中文段落上开启仿生阅读时才下载; 加载后常驻内存 (约 5 MB)。
 * 桌面 / Android 的资源在安装包里, 等于本地读取; 网页版由 Service Worker 按 CacheFirst 缓存 (vite.config.ts
 * runtimeCaching), 下载过一次后离线也能用。下载失败时保持 ICU 回退, 一分钟后才会再试。
 */
import lexiconUrl from '../../data/zh-lexicon.txt?url'
import { parseZhLexicon, type ZhLexicon } from './zhSegment.ts'

const RETRY_MS = 60_000

let lexicon: ZhLexicon | null = null
let pending: Promise<ZhLexicon | null> | null = null
let failedAt = 0

/** 已加载的词表 (没加载完时为 null) */
export function zhLexicon(): ZhLexicon | null {
  return lexicon
}

/** 开始 (或复用) 词表下载; 结果为 null 表示这次没拿到 (离线且未缓存等) */
export function loadZhLexicon(): Promise<ZhLexicon | null> {
  if (lexicon) return Promise.resolve(lexicon)
  if (pending) return pending
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null)
  pending = fetch(lexiconUrl)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    })
    .then(text => {
      const lex = parseZhLexicon(text)
      if (lex.size < 1000) throw new Error('lexicon too small')
      lexicon = lex
      return lex
    })
    .catch(e => {
      console.warn('zh lexicon unavailable, using built-in word breaks', e)
      failedAt = Date.now()
      return null
    })
    .finally(() => { pending = null })
  return pending
}
