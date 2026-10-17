#!/usr/bin/env node
// 轻阅匿名使用统计 (终端版): npm run stats [-- --days 90] [-- --json]
// 令牌: ~/.config/lightread/stats-admin-token (或环境变量 LIGHTREAD_STATS_TOKEN)
// 接口: GET <api>/v1/admin/stats?days=N, api 默认 https://sync.jiangshu.ai (LIGHTREAD_STATS_API 可覆盖)
// 网页版统计页: https://sync.jiangshu.ai/admin
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN_FILE = join(homedir(), '.config/lightread/stats-admin-token')
const API = (process.env.LIGHTREAD_STATS_API || 'https://sync.jiangshu.ai').replace(/\/+$/, '')

function parseArgs(argv) {
  const out = { days: 30, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--days' || a.startsWith('--days=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i]
      out.days = Number(v)
      if (!Number.isInteger(out.days) || out.days < 1 || out.days > 365) fatal('--days 需要 1–365 的整数')
    } else if (a === '-h' || a === '--help') {
      console.log('用法: npm run stats [-- --days 90] [-- --json]')
      process.exit(0)
    } else fatal(`未知参数: ${a}`)
  }
  return out
}

function fatal(msg) {
  console.error(msg)
  process.exit(1)
}

async function readToken() {
  if (process.env.LIGHTREAD_STATS_TOKEN) return process.env.LIGHTREAD_STATS_TOKEN.trim()
  try {
    return (await readFile(TOKEN_FILE, 'utf8')).trim()
  } catch {
    fatal(`读不到管理员令牌: ${TOKEN_FILE}`)
  }
}

// ---- 排版 (中文按两格宽对齐) ----

const width = s => [...String(s)].reduce((w, c) => w + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0)
const padEnd = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))
const padStart = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s)
const num = n => Number(n || 0).toLocaleString('en-US')
const pct = (r, digits = 1) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(digits)}%`)
const dim = s => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const bold = s => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)

/** 迷你趋势图; 超过 60 个点时按组取平均, 保持一行宽度 */
function sparkline(values) {
  if (values.length > 60) {
    const k = Math.ceil(values.length / 60)
    const grouped = []
    for (let i = 0; i < values.length; i += k) {
      const g = values.slice(i, i + k)
      grouped.push(g.reduce((x, y) => x + y, 0) / g.length)
    }
    values = grouped
  }
  const blocks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 0)
  if (max === 0) return '▁'.repeat(values.length)
  return values.map(v => blocks[Math.min(7, Math.round((v / max) * 7))]).join('')
}

function table(headers, rows, align) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map(r => width(r[i]))))
  const line = cells =>
    cells.map((c, i) => (align[i] === 'r' ? padStart(c, widths[i]) : padEnd(c, widths[i]))).join('  ')
  return [dim(line(headers)), ...rows.map(line)].join('\n')
}

const PLATFORM = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', web: '网页版', other: '其他' }

function split(list, label) {
  const total = list.reduce((s, x) => s + x.installs, 0)
  if (!total) return dim('暂无数据')
  return list.map(x => `${label(x.name)} ${num(x.installs)} ${dim(`(${pct(x.installs / total, 0)})`)}`).join('  ')
}

function print(s) {
  const { totals: t, active: a, retention: r } = s
  const out = []
  out.push(bold(`轻阅使用统计 · 截至 ${s.today}（北京时间）`))
  out.push('')
  out.push(
    table(
      ['累计装机', '今日新增', '近 7 天新增', '近 30 天新增', '日活(今天)', '昨日日活', '周活', '月活', '黏性'],
      [[num(t.installs), num(t.newToday), num(t.new7d), num(t.new30d), num(a.dau), num(a.dauYesterday), num(a.wau), num(a.mau), pct(a.stickiness, 0)]],
      Array(9).fill('r'),
    ),
  )
  out.push('')
  const daily = s.daily
  out.push(`近 ${s.days} 天趋势  ${dim(`${daily[0].day} → ${daily.at(-1).day}`)}`)
  out.push(`  日活        ${sparkline(daily.map(d => d.actives))}  峰值 ${num(Math.max(...daily.map(d => d.actives)))}`)
  out.push(`  打开阅读器  ${sparkline(daily.map(d => d.readers))}`)
  out.push(`  新增        ${sparkline(daily.map(d => d.newInstalls))}  合计 ${num(daily.reduce((x, d) => x + d.newInstalls, 0))}`)
  out.push('')
  const recent = daily.slice(-14).reverse()
  out.push(
    table(
      ['日期', '日活', '打开阅读器', '新增'],
      recent.map(d => [d.day, num(d.actives), num(d.readers), num(d.newInstalls)]),
      ['l', 'r', 'r', 'r'],
    ),
  )
  out.push('')
  out.push(`平台（月活）  ${split(s.platforms, n => PLATFORM[n] || n)}`)
  out.push(`版本（近 7 天）${split(s.versions.slice(0, 8), n => 'v' + n)}`)
  out.push(`语言（月活）  ${split(s.langs, n => (n === 'zh' ? '中文' : n === 'en' ? 'English' : n))}`)
  out.push('')
  const ret = x => (x.cohortSize ? `${pct(x.rate)} ${dim(`(${num(x.cohortSize)} 个安装)`)}` : dim('数据不足'))
  out.push(`留存  次日 ${ret(r.d1)}   7 日 ${ret(r.d7)}   30 日 ${ret(r.d30)}`)
  const cohorts = r.cohorts.slice(0, 10)
  if (cohorts.length) {
    const cell = (rate, n) => (rate === null ? '—' : `${pct(rate, 0)} (${n})`)
    out.push(
      table(
        ['首日', '新增', '次日', '7 日', '30 日'],
        cohorts.map(c => [c.day, num(c.size), cell(c.d1, c.d1n), cell(c.d7, c.d7n), cell(c.d30, c.d30n)]),
        ['l', 'r', 'r', 'r', 'r'],
      ),
    )
  }
  out.push('')
  out.push(dim(s.note))
  out.push(dim(`完整统计页: ${API}/admin`))
  console.log(out.join('\n'))
}

const args = parseArgs(process.argv.slice(2))
const token = await readToken()
let res
try {
  res = await fetch(`${API}/v1/admin/stats?days=${args.days}`, { headers: { authorization: `Bearer ${token}` } })
} catch (e) {
  fatal(`请求失败: ${e.message}`)
}
if (res.status === 401) fatal(`令牌无效 (401)。检查 ${TOKEN_FILE}`)
if (!res.ok) fatal(`请求失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
const stats = await res.json()
if (args.json) console.log(JSON.stringify(stats, null, 2))
else print(stats)
