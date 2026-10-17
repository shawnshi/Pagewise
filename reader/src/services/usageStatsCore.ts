/** 匿名使用统计的纯函数 (无依赖, 可单测); 上报逻辑见 usageStats.ts */

export type StatsPlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web' | 'other'

export interface PingBody {
  id: string
  platform: StatsPlatform
  version: string
  lang: 'zh' | 'en'
  reader: boolean
  /** 点睛阅读按天汇总 (可选; 旧服务端忽略) */
  dj?: DjDay[]
}

/** 北京时间的日期 (统计按北京时间切天, 与服务端一致) */
export function beijingDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 由 UA 与运行环境判断平台; 网页版统一记为 web */
export function detectPlatform(ua: string, tauri: boolean): StatsPlatform {
  if (/Android/i.test(ua)) return tauri ? 'android' : 'web'
  if (/iPhone|iPad|iPod/i.test(ua)) return tauri ? 'ios' : 'web'
  if (!tauri) return 'web'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'other'
}

/**
 * 今天还需不需要发: 记录形如 "2026-10-05:app" / "2026-10-05:reader"。
 * 打开应用发一次; 当天第一次打开书再发一次 (服务端把 reader 按「或」合并)。
 */
export function needsPing(sent: string | null, day: string, reader: boolean): boolean {
  if (!sent || !sent.startsWith(day + ':')) return true
  return reader && !sent.endsWith(':reader')
}

/**
 * 自动化测试 (Playwright / WebDriver 会置 navigator.webdriver) 与本机开发预览 (localhost / 127.0.0.1)
 * 不上报, 免得开发期间每跑一次测试就多出一个「网页版新安装」; 桌面 / 安卓 App 的 tauri.localhost 不受影响
 */
export function isTestEnvironment(nav: { webdriver?: boolean } | undefined, hostname: string, tauri: boolean): boolean {
  if (nav?.webdriver) return true
  if (tauri) return false
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0'
}

// ---- 点睛阅读的按天汇总计数 (随心跳上报; 不含书名、正文、书的 ID 或具体的词) ----

/** 阅读时的点睛状态: 关 / 基础·词与词 / 基础·重点词 / 智能 */
export type DjState = 0 | 1 | 2 | 3
/** 重点词的密度档: 少 / 适中 / 多 */
export type DjLevelIdx = 0 | 1 | 2

/** 上报格式 (一天一条; 键名尽量短, 心跳体积有上限) */
export interface DjDay {
  /** 北京时间日期, 只能是已过完的一天 */
  d: string
  /** 读中文书的分钟数, 按点睛状态 [关, 词与词, 重点词, 智能] */
  m: [number, number, number, number]
  /** 用重点词 (基础版重点词或智能版) 时各密度档的分钟数 [少, 适中, 多] */
  lv: [number, number, number]
  /** 智能版: AI 重点词可用的块数 / 请求了重点词的块数 */
  ai: [number, number]
  /** 智能版: AI 给的重点词里正文中找不到的个数 / 总个数 */
  nf: [number, number]
}

/** 本机累计 (秒为单位, 发送时折成分钟) */
export interface DjDayAcc {
  s: [number, number, number, number]
  lv: [number, number, number]
  ai: [number, number]
  nf: [number, number]
}
export type DjStore = Record<string, DjDayAcc>

const emptyAcc = (): DjDayAcc => ({ s: [0, 0, 0, 0], lv: [0, 0, 0], ai: [0, 0], nf: [0, 0] })
const clampInt = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)))

/** 记阅读时长: state 为当时的点睛状态, level 为重点词密度档 (没用重点词时为 null) */
export function addDjReading(store: DjStore, day: string, state: DjState, level: DjLevelIdx | null, seconds: number): DjStore {
  if (!(seconds > 0)) return store
  const a = store[day] ?? emptyAcc()
  a.s[state] += seconds
  if (level !== null && (state === 2 || state === 3)) a.lv[level] += seconds
  store[day] = a
  return store
}

/** 记一块 AI 重点词的结果 */
export function addDjKeyWordChunk(store: DjStore, day: string, usable: boolean, lines: number, missing: number): DjStore {
  const a = store[day] ?? emptyAcc()
  a.ai[1] += 1
  if (usable) a.ai[0] += 1
  a.nf[1] += Math.max(0, lines)
  a.nf[0] += Math.max(0, Math.min(lines, missing))
  store[day] = a
  return store
}

/** 最多补报几天 (更早的丢弃) / 最多回看几天 */
export const DJ_MAX_DAYS = 3
export const DJ_LOOKBACK_DAYS = 7

const dayMinus = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10)

/** 待上报的日子: 今天之前、7 天以内、有数据的最近 3 天 (秒折成分钟, 每项封顶) */
export function pendingDjDays(store: DjStore, today: string): DjDay[] {
  const oldest = dayMinus(today, DJ_LOOKBACK_DAYS)
  return Object.keys(store)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today && d >= oldest)
    .sort()
    .slice(-DJ_MAX_DAYS)
    .map(d => {
      const a = store[d]
      const min = (sec: number) => clampInt(sec / 60, 1440)
      return {
        d,
        m: [min(a.s[0]), min(a.s[1]), min(a.s[2]), min(a.s[3])],
        lv: [min(a.lv[0]), min(a.lv[1]), min(a.lv[2])],
        ai: [clampInt(a.ai[0], 99999), clampInt(a.ai[1], 99999)],
        nf: [clampInt(a.nf[0], 99999), clampInt(a.nf[1], 99999)],
      } as DjDay
    })
    .filter(x => x.m.some(v => v > 0) || x.ai[1] > 0)
}

/** 上报成功后 (或过期) 清掉: 已发出的日子与 7 天以前的日子 */
export function pruneDjStore(store: DjStore, today: string, sent: readonly string[]): DjStore {
  const oldest = dayMinus(today, DJ_LOOKBACK_DAYS)
  const out: DjStore = {}
  for (const [d, v] of Object.entries(store)) {
    if (sent.includes(d) || d < oldest) continue
    out[d] = v
  }
  return out
}
