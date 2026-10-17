/**
 * 匿名使用统计 (设置 → 隐私, 默认开启, 可随时关闭; 方案见 docs/usage-stats-plan.md)。
 *
 * 每天最多上报两次「心跳」到 sync.jiangshu.ai/v1/ping: 打开应用时一次, 当天第一次打开书时再一次 (reader=true)。
 * 只含: 随机安装 ID (与账号、AI 通道的设备 ID 都无关)、平台、版本号、界面语言、当天是否打开过书,
 * 以及点睛阅读的按天汇总数字 (usageCounters.ts: 各状态的阅读分钟、密度档、AI 重点词可用率)。
 * 不含书名、正文、书的 ID、具体的词、账号; IP 服务端只用于限流, 不落库。
 * 网络失败静默跳过, 不重试、不排队。
 */
import { useSettings } from '../stores/settings'
import { isTauri } from '../storage/types'

export const PING_ENDPOINT = 'https://sync.jiangshu.ai/v1/ping'
const ID_KEY = 'lightread-install-id'
const SENT_KEY = 'lightread-ping-sent'

import { beijingDay, detectPlatform, isTestEnvironment, needsPing, type PingBody } from './usageStatsCore'
import { markDjSent, pendingDj } from './usageCounters'
export { beijingDay, detectPlatform, needsPing, type PingBody, type StatsPlatform } from './usageStatsCore'

function store(): Storage | null {
  try { return localStorage } catch { return null }
}

function newId(): string {
  try { return crypto.randomUUID() } catch {
    // 旧 WebView 无 randomUUID (compat 层已补, 这里再兜底)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  }
}

export function installId(): string {
  const s = store()
  let id = s?.getItem(ID_KEY) ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    id = newId()
    s?.setItem(ID_KEY, id)
  }
  return id
}

/** 设置页「重置统计 ID」: 之后的上报与之前的记录不再关联 */
export function resetInstallId(): string {
  const s = store()
  s?.removeItem(ID_KEY)
  s?.removeItem(SENT_KEY)
  return installId()
}

/** 发送心跳 (开启统计时才发); reader=true 表示今天打开过书 */
export async function pingUsage(reader = false): Promise<void> {
  const settings = useSettings()
  if (!settings.usageStats) return
  if (isTestEnvironment(navigator, location.hostname, isTauri())) return
  const s = store()
  const day = beijingDay()
  if (!needsPing(s?.getItem(SENT_KEY) ?? null, day, reader)) return
  const body: PingBody = {
    id: installId(),
    platform: detectPlatform(navigator.userAgent, isTauri()),
    version: __APP_VERSION__,
    lang: settings.language === 'en' ? 'en' : 'zh',
    reader,
  }
  const dj = pendingDj()
  if (dj.length) body.dj = dj
  try {
    const res = await fetch(PING_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    })
    if (res.ok) {
      s?.setItem(SENT_KEY, `${day}:${reader ? 'reader' : 'app'}`)
      if (dj.length) markDjSent(dj.map(x => x.d))
    }
  } catch { /* 离线 / 被拦截: 静默跳过 */ }
}
