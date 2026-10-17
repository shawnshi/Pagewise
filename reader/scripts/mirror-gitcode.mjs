#!/usr/bin/env node
/**
 * 把已公开的 GitHub Release 镜像到 GitCode (国内下载源)。设置与用法见 docs/gitcode-mirror.md。
 *
 *   node scripts/mirror-gitcode.mjs release --repo yzfly/LightRead --tag v1.8.0 --dir release-assets \
 *     --title "LightRead 轻阅 v1.8.0" --notes-file notes.md --commit <sha> [--latest] [--dry-run]
 *   node scripts/mirror-gitcode.mjs --self-test
 *
 * 环境变量: GITCODE_TOKEN (个人访问令牌, dry-run 可不填), GITCODE_USER (git 推送用户名, 默认取仓库 owner),
 * GITCODE_API / GITCODE_WEB / GITCODE_GIT_URL (默认官方地址, 自测时指向本地假服务),
 * MIRROR_BACKOFF_MS (重试退避基数, 默认 5000), MIRROR_TAG_WAIT_MS (等待 pull 镜像同步 tag, 默认 10 分钟)。
 *
 * 流程: 本地按 SHA256SUMS 校验全部文件 → 确保 GitCode 上有同一提交的 tag (已有 / HTTPS 推送 / 等待 pull 镜像)
 * → 幂等创建或更新 Release → 上传缺少的文件 (每次重试都重新获取 upload_url) → 逐个从公开地址 GET 回来比对
 * SHA-256, 不一致则删除重传 → 最后上传并校验 SHA256SUMS。应用内更新器只认带 SHA256SUMS 的镜像版本,
 * 因此 SHA256SUMS 出现即表示其余文件都已校验通过。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const SUMS = 'SHA256SUMS'
const SIZES_MARKER = 'lightread-mirror-sizes'
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- 纯函数 ----

export function parseSums(text) {
  const sums = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = line.match(/^([a-fA-F0-9]{64}) [ *](.+)$/)
    if (!m) throw new Error(`SHA256SUMS 行格式无效: ${line}`)
    const name = m[2].trim().replace(/^\.\//, '')
    if (name.includes('/')) throw new Error(`SHA256SUMS 只能列出同目录文件: ${name}`)
    sums.set(name, m[1].toLowerCase())
  }
  return sums
}

/** 小文件先传; SHA256SUMS 不在其中 (所有文件校验通过后最后上传) */
export function uploadOrder(sizes) {
  return [...sizes.entries()]
    .filter(([name]) => name !== SUMS)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
}

export function publicUrl(web, repo, tag, name) {
  return `${web}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

/** GitCode 不返回附件大小; 写进说明末尾的 HTML 注释 (网页不显示), 供应用内更新器展示 */
export function releaseBody(notes, sizes, fallback) {
  const text = String(notes ?? '').replace(new RegExp(`<!--\\s*${SIZES_MARKER}[\\s\\S]*?-->`, 'g'), '').trim() || fallback
  const record = Object.fromEntries([...sizes.entries()].filter(([name]) => name !== SUMS).sort())
  return `${text}\n\n<!-- ${SIZES_MARKER} ${JSON.stringify(record)} -->`
}

export function backoffDelays(base, attempts) {
  return Array.from({ length: attempts - 1 }, (_, i) => base * [1, 3, 9, 18, 27][Math.min(i, 4)])
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 本地文件必须与 SHA256SUMS 一一对应且哈希一致, 否则不做任何远端写入 */
export async function verifyLocal(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name)
  assert.ok(entries.includes(SUMS), `${dir} 缺少 ${SUMS}`)
  const sums = parseSums(await readFile(join(dir, SUMS), 'utf8'))
  assert.ok(sums.size > 0, `${SUMS} 为空`)
  const sizes = new Map()
  for (const name of entries) {
    sizes.set(name, (await stat(join(dir, name))).size)
    if (name === SUMS) continue
    assert.ok(sums.has(name), `${name} 不在 ${SUMS} 中`)
  }
  for (const [name, expected] of sums) {
    assert.ok(entries.includes(name), `${SUMS} 列出的 ${name} 不存在`)
    assert.equal(await sha256File(join(dir, name)), expected, `${name} 与 ${SUMS} 不一致`)
  }
  return { sums, sizes, sumsHash: await sha256File(join(dir, SUMS)) }
}

// ---- GitCode API ----

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status }
}
const retriable = e => !(e instanceof HttpError) || e.status === 429 || e.status >= 500 || e.status === 408

async function withRetry(label, fn, { attempts = 5, base = 5000, log = console.log } = {}) {
  const delays = backoffDelays(base, attempts)
  for (let i = 0; ; i++) {
    try {
      return await fn(i)
    } catch (e) {
      if (i >= delays.length || !retriable(e)) throw e
      log(`  ${label} 失败 (${e.message}), ${delays[i]}ms 后第 ${i + 2}/${attempts} 次重试`)
      await sleep(delays[i])
    }
  }
}

export class GitCode {
  constructor({ api, web, repo, token, backoffMs = 5000, log = console.log }) {
    Object.assign(this, { api, web, repo, token, backoffMs, log })
  }

  async request(method, path, { query, json, allow404 = false, timeout = 120_000 } = {}) {
    const url = new URL(`${this.api}/repos/${this.repo}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    return withRetry(`${method} ${path}`, async () => {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(json ? { 'content-type': 'application/json; charset=utf-8' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(timeout),
      })
      const text = await res.text()
      if (res.status === 404 && allow404) return null
      if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status)
      return text ? JSON.parse(text) : {}
    }, { base: this.backoffMs, log: this.log })
  }

  getRelease(tag) {
    return this.request('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
  }

  createRelease(payload) {
    return this.request('POST', '/releases', { json: payload })
  }

  updateRelease(tag, payload) {
    return this.request('PATCH', `/releases/${encodeURIComponent(tag)}`, { json: payload })
  }

  deleteAsset(tag, id) {
    return this.request('DELETE', `/releases/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(id)}`, { allow404: true })
  }

  /** 每次尝试都重新获取签名上传地址 (签名地址可能一次性或已过期) */
  async uploadAsset(tag, name, path) {
    const data = await readFile(path)
    await withRetry(`上传 ${name}`, async () => {
      const target = await this.request('GET', `/releases/${encodeURIComponent(tag)}/upload_url`, { query: { file_name: name } })
      if (!target?.url) throw new HttpError(`upload_url 响应缺少 url: ${JSON.stringify(target).slice(0, 200)}`, 502)
      const res = await fetch(target.url, {
        method: 'PUT',
        headers: Object.fromEntries(Object.entries(target.headers ?? {}).map(([k, v]) => [k, String(v)])),
        body: data,
        signal: AbortSignal.timeout(45 * 60_000),
      })
      const text = await res.text()
      if (!res.ok) throw new HttpError(`PUT HTTP ${res.status}: ${text.slice(0, 300)}`, res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 500 : res.status)
    }, { base: this.backoffMs, log: this.log })
  }

  /** 匿名 GET 公开下载地址 (HEAD 会返回 401), 计算 SHA-256 */
  async downloadHash(tag, name) {
    const res = await fetch(publicUrl(this.web, this.repo, tag, name), { signal: AbortSignal.timeout(45 * 60_000) })
    if (!res.ok) throw new HttpError(`下载 ${name} HTTP ${res.status}`, res.status === 404 ? 503 : res.status)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of res.body) { hash.update(chunk); size += chunk.length }
    return { sha256: hash.digest('hex'), size }
  }
}

const attachments = release => new Map((release?.assets ?? [])
  .filter(a => a && a.type !== 'source' && typeof a.name === 'string')
  .map(a => [a.name, a.id]))

// ---- tag ----

function gitEnv(token, user) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    // 经环境变量注入认证头, 令牌不出现在命令行参数或远端 URL 中
    const basic = Buffer.from(`${user}:${token}`).toString('base64')
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` })
  }
  return env
}

/** 远端 tag 指向的提交 (附注 tag 取解引用后的提交); 不存在返回 null */
export function remoteTagCommit(gitUrl, tag, env = process.env) {
  const out = execFileSync('git', ['ls-remote', gitUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { env, encoding: 'utf8' })
  const refs = new Map(out.trim().split('\n').filter(Boolean).map(line => line.split('\t').reverse()))
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null
}

/**
 * 确保 GitCode 上有指向同一提交的 tag: 已存在则核对; 否则用令牌 HTTPS 推送;
 * 推送被拒 (仓库设为从 GitHub pull 镜像) 时轮询等待镜像同步。提交不一致一律失败。
 */
export async function ensureTag({ gitUrl, tag, commit, token, user, waitMs, pollMs = 15_000, cwd = process.cwd(), log = console.log }) {
  const env = gitEnv(token, user)
  const check = () => {
    let found
    try {
      found = remoteTagCommit(gitUrl, tag, env)
    } catch {
      // 公开仓库匿名可读; 认证头格式不被接受时不应影响读取
      found = remoteTagCommit(gitUrl, tag, gitEnv('', ''))
    }
    if (found && found !== commit) throw new Error(`GitCode 上的 ${tag} 指向 ${found}, 与 GitHub 的 ${commit} 不一致, 停止镜像`)
    return Boolean(found)
  }
  if (check()) { log(`GitCode 已有 tag ${tag} (${commit.slice(0, 12)})`); return 'present' }
  const push = spawnSync('git', ['push', gitUrl, `refs/tags/${tag}:refs/tags/${tag}`], { cwd, env, encoding: 'utf8' })
  if (push.status === 0 && check()) { log(`已推送 tag ${tag} 到 GitCode`); return 'pushed' }
  log(`推送 tag 未成功 (${(push.stderr || '').trim().split('\n').pop() || `exit ${push.status}`}); 按 pull 镜像处理, 最多等待 ${Math.round(waitMs / 1000)}s`)
  for (const started = Date.now(); Date.now() - started < waitMs;) {
    await sleep(Math.min(pollMs, waitMs))
    if (check()) { log(`pull 镜像已同步 tag ${tag}`); return 'mirrored' }
  }
  throw new Error(`GitCode 上始终没有 tag ${tag}: 请确认令牌有仓库写权限, 或在 GitCode 仓库镜像设置里立即同步`)
}

// ---- 主流程 ----

export async function mirrorRelease(opts) {
  const {
    repo, tag, dir, title, notes = '', commit, latest = false, dryRun = false,
    api, web, gitUrl, token, user, backoffMs = 5000, tagWaitMs = 600_000, tagPollMs = 15_000, cwd,
    log = console.log, summary,
  } = opts
  assert.match(repo, REPO_PATTERN, 'GitCode 仓库应为 owner/repo')
  assert.ok(tag && !/[\s/]/.test(tag), 'tag 无效')
  if (!dryRun) assert.ok(token, '缺少 GITCODE_TOKEN')

  const { sums, sizes, sumsHash } = await verifyLocal(dir)
  log(`本地 ${sums.size} 个文件已按 ${SUMS} 校验`)
  const gc = new GitCode({ api, web, repo, token, backoffMs, log })
  const body = releaseBody(notes, sizes, title)
  const order = uploadOrder(sizes)

  if (dryRun) {
    let found = null
    try {
      if (commit) found = remoteTagCommit(gitUrl, tag, { ...gitEnv(token, user || repo.split('/')[0]), GIT_ASKPASS: 'true' })
    } catch {
      log('[dry-run] 无法读取 GitCode 仓库 (尚未创建或未公开)')
    }
    const existing = await gc.getRelease(tag)
    const remote = attachments(existing)
    log(`[dry-run] tag: ${commit ? (found ? (found === commit ? '已存在且一致' : `已存在但指向 ${found}`) : '缺失, 将推送或等待镜像') : '由创建 Release 时在默认分支生成'}`)
    log(`[dry-run] Release: ${existing ? '已存在' : '将创建'} "${title}"${latest ? ' (latest)' : ''}`)
    for (const name of [...order, SUMS]) log(`[dry-run] ${remote.has(name) ? '已存在, 将回下载校验' : '将上传'}: ${name} (${sizes.get(name)} B)`)
    return { dryRun: true, uploads: order.filter(n => !remote.has(n)).concat(remote.has(SUMS) ? [] : [SUMS]) }
  }

  const tagState = commit
    ? await ensureTag({ gitUrl, tag, commit, token, user: user || repo.split('/')[0], waitMs: tagWaitMs, pollMs: tagPollMs, cwd, log })
    : 'by-release'

  const status = latest ? { release_status: 'latest' } : {}
  let release = await gc.getRelease(tag)
  if (!release) {
    log(`创建 GitCode Release ${tag}`)
    try {
      release = await gc.createRelease({ tag_name: tag, name: title, body, ...status })
    } catch (e) {
      // 并发或上次创建成功但响应丢失
      release = await gc.getRelease(tag)
      if (!release) throw e
    }
  } else if (release.name !== title || String(release.body ?? '').trim() !== body.trim() || (latest && release.release_status !== 'latest')) {
    log(`更新 GitCode Release ${tag} 的标题/说明`)
    await gc.updateRelease(tag, { name: title, body, ...status })
  }
  let remote = attachments(await gc.getRelease(tag))

  // 远端清单与本次不同 (例如 Android 修补后重新生成) 时先删掉, 使「有 SHA256SUMS」始终代表镜像完整
  if (remote.has(SUMS)) {
    const current = await gc.downloadHash(tag, SUMS).catch(() => null)
    if (current?.sha256 !== sumsHash) {
      log(`远端 ${SUMS} 已过期, 先删除`)
      await gc.deleteAsset(tag, remote.get(SUMS))
      remote.delete(SUMS)
    }
  }

  const uploaded = []
  const upload = async name => {
    log(`上传 ${name} (${sizes.get(name)} B)`)
    await gc.uploadAsset(tag, name, join(dir, name))
    uploaded.push(name)
  }
  for (const name of order) if (!remote.has(name)) await upload(name)

  const verify = async name => {
    const expected = name === SUMS ? sumsHash : sums.get(name)
    try {
      return await withRetry(`回下载 ${name}`, async () => {
        const got = await gc.downloadHash(tag, name)
        // 刚上传时 CDN 可能尚未就绪, 不一致也按可重试处理
        if (got.sha256 !== expected) throw new HttpError(`${name} SHA-256 ${got.sha256} ≠ ${expected}`, 503)
        return true
      }, { attempts: 4, base: backoffMs, log })
    } catch (e) {
      log(`  ${e.message}`)
      return false
    }
  }
  const repaired = []
  for (const name of order) {
    if (await verify(name)) continue
    log(`${name} 校验失败, 删除后重传`)
    remote = attachments(await gc.getRelease(tag))
    if (remote.has(name)) await gc.deleteAsset(tag, remote.get(name))
    await upload(name)
    repaired.push(name)
    if (!await verify(name)) throw new Error(`${name} 重传后仍未通过回下载校验`)
  }

  remote = attachments(await gc.getRelease(tag))
  if (!remote.has(SUMS)) await upload(SUMS)
  if (!await verify(SUMS)) throw new Error(`${SUMS} 未通过回下载校验`)

  const final = await withRetry('核对附件列表', async () => {
    const names = attachments(await gc.getRelease(tag))
    const missing = [...sizes.keys()].filter(n => !names.has(n))
    if (missing.length) throw new HttpError(`GitCode Release 缺少: ${missing.join(', ')}`, 503)
    return names
  }, { attempts: 4, base: backoffMs, log })
  const extra = [...final.keys()].filter(n => !sizes.has(n))
  if (extra.length) log(`注意: GitCode Release 另有本次未包含的附件: ${extra.join(', ')}`)

  if (summary) {
    const rows = [...order, SUMS].map(name => `| [${name}](${publicUrl(web, repo, tag, name)}) | ${sizes.get(name)} | ${uploaded.includes(name) ? (repaired.includes(name) ? '重传' : '上传') : '已存在'} · 已校验 |`)
    await appendFile(summary, [
      `### GitCode 镜像 ${tag}: 完成`,
      '',
      `Release 页: ${web}/${repo}/releases · tag: ${tagState}`,
      '',
      '| 文件 | 字节 | 状态 |',
      '| --- | ---: | --- |',
      ...rows,
      '',
    ].join('\n'))
  }
  log(`GitCode 镜像完成: ${uploaded.length} 个文件上传, ${sizes.size} 个文件全部回下载校验通过`)
  return { tagState, uploaded, repaired }
}

// ---- 自测: 本地假 GitCode 服务 + 本地 bare 仓库 ----

async function fakeGitCode() {
  const state = { releases: new Map(), files: new Map(), nextId: 1, log: [], fail: { uploadUrl: 0, put: new Map() }, tokens: new Set(), usedTokens: new Set() }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data))
    }
    state.log.push(`${req.method} ${url.pathname}`)
    const api = url.pathname.match(/^\/api\/v5\/repos\/o\/r(\/.*)$/)
    if (api) {
      if (req.headers.authorization !== 'Bearer tok' && req.method !== 'GET') return send(401, { error_message: 'unauthorized' })
      const path = api[1]
      let m
      if (req.method === 'GET' && (m = path.match(/^\/releases\/tags\/([^/]+)$/))) {
        const r = state.releases.get(decodeURIComponent(m[1]))
        return r ? send(200, r) : send(404, { error_message: '404 Release Not Found' })
      }
      if (req.method === 'POST' && path === '/releases') {
        const p = JSON.parse(body)
        if (state.releases.has(p.tag_name)) return send(400, { error_message: 'exists' })
        const r = { tag_name: p.tag_name, name: p.name, body: p.body, release_status: p.release_status ?? 'none', created_with_target: 'target_commitish' in p, assets: [{ name: `${p.tag_name}.zip`, type: 'source' }] }
        state.releases.set(p.tag_name, r)
        return send(200, r)
      }
      if (req.method === 'PATCH' && (m = path.match(/^\/releases\/([^/]+)$/))) {
        const r = state.releases.get(decodeURIComponent(m[1]))
        const p = JSON.parse(body)
        Object.assign(r, { name: p.name, body: p.body }, p.release_status ? { release_status: p.release_status } : {})
        return send(200, r)
      }
      if (req.method === 'GET' && (m = path.match(/^\/releases\/([^/]+)\/upload_url$/))) {
        if (state.fail.uploadUrl > 0) { state.fail.uploadUrl--; return send(500, { error_message: 'boom' }) }
        const token = `t${state.nextId++}`
        state.tokens.add(token)
        return send(200, { url: `http://127.0.0.1:${server.address().port}/obs/${token}?tag=${m[1]}&name=${encodeURIComponent(url.searchParams.get('file_name'))}`, headers: { 'x-obs-acl': 'public-read', 'x-obs-callback': 'cb', 'Content-Type': 'application/octet-stream' } })
      }
      if (req.method === 'DELETE' && (m = path.match(/^\/releases\/([^/]+)\/attach_files\/(\d+)$/))) {
        const r = state.releases.get(decodeURIComponent(m[1]))
        const before = r.assets.length
        r.assets = r.assets.filter(a => String(a.id) !== m[2])
        return before === r.assets.length ? send(404, {}) : send(204, '')
      }
      return send(404, { error_message: 'no route' })
    }
    let m
    if (req.method === 'PUT' && (m = url.pathname.match(/^\/obs\/(t\d+)$/))) {
      const token = m[1]
      if (!state.tokens.has(token) || state.usedTokens.has(token)) return send(403, 'signature reused')
      state.usedTokens.add(token)
      if (req.headers['x-obs-callback'] !== 'cb') return send(400, 'missing signed headers')
      const tag = url.searchParams.get('tag')
      const name = url.searchParams.get('name')
      const failures = state.fail.put.get(name) ?? 0
      if (failures > 0) { state.fail.put.set(name, failures - 1); return send(503, 'obs busy') }
      const r = state.releases.get(tag)
      const id = state.nextId++
      r.assets = r.assets.filter(a => a.name !== name).concat({ name, type: 'attach', id, browser_download_url: `x/${name}` })
      state.files.set(`${tag}/${name}`, body)
      state.log.push(`STORED ${name}`)
      return send(200, '')
    }
    if ((m = url.pathname.match(/^\/o\/r\/releases\/download\/([^/]+)\/([^/]+)$/))) {
      if (req.method === 'HEAD') return send(401, '')
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
      const listed = state.releases.get(decodeURIComponent(m[1]))?.assets.some(a => a.name === decodeURIComponent(m[2]))
      return state.files.has(key) && listed ? send(302, '', { location: `/cdn/${encodeURIComponent(key)}` }) : send(404, 'not found')
    }
    if ((m = url.pathname.match(/^\/cdn\/(.+)$/))) return send(200, state.files.get(decodeURIComponent(m[1])), { 'content-type': 'application/octet-stream' })
    send(404, 'no route')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { state, server, base: `http://127.0.0.1:${server.address().port}` }
}

async function writeAssets(dir, files) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const lines = []
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
    lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`)
  }
  await writeFile(join(dir, SUMS), lines.sort().join('\n') + '\n')
}

async function selfTest() {
  // 纯函数
  assert.deepEqual([...parseSums(`${'A'.repeat(64)}  a.apk\n${'b'.repeat(64)} *./b.dmg\n`)], [['a.apk', 'a'.repeat(64)], ['b.dmg', 'b'.repeat(64)]])
  assert.throws(() => parseSums('nope  x'), /格式无效/)
  assert.throws(() => parseSums(`${'a'.repeat(64)}  sub/x`), /同目录/)
  assert.deepEqual(uploadOrder(new Map([[SUMS, 1], ['big.AppImage', 900], ['a.json', 5], ['b.apk', 500]])), ['a.json', 'b.apk', 'big.AppImage'])
  assert.equal(publicUrl('https://gitcode.com', 'yzfly/LightRead', 'v1.8.0', 'a b.deb'), 'https://gitcode.com/yzfly/LightRead/releases/download/v1.8.0/a%20b.deb')
  assert.deepEqual(backoffDelays(5000, 5), [5000, 15000, 45000, 90000])
  const body = releaseBody(`notes\n\n<!-- ${SIZES_MARKER} {"old":1} -->`, new Map([['x.apk', 3], [SUMS, 9]]), 'title')
  assert.equal(body, `notes\n\n<!-- ${SIZES_MARKER} {"x.apk":3} -->`)
  assert.equal(releaseBody('', new Map(), 'title'), `title\n\n<!-- ${SIZES_MARKER} {} -->`)

  const root = await mkdtemp(join(tmpdir(), 'mirror-gitcode-'))
  const { state, server, base } = await fakeGitCode()
  const logs = []
  const log = line => logs.push(line)
  try {
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()
    const src = join(root, 'src')
    await mkdir(src)
    git(src, 'init', '-q')
    await writeFile(join(src, 'f'), '1')
    git(src, 'add', 'f')
    git(src, 'commit', '-qm', 'one')
    git(src, 'tag', '-a', 'v9.9.9', '-m', 'v9.9.9')
    const commit = git(src, 'rev-parse', 'v9.9.9^{commit}')
    const bare = join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', bare)
    const gitUrl = `file://${bare}`

    const assets = join(root, 'assets')
    const files = { 'LightRead_9.9.9_amd64.AppImage': 'A'.repeat(4000), 'LightRead_v9.9.9_android_arm64.apk': 'apk-v1', 'LightRead_v9.9.9_android_arm64.apk.json': '{}' }
    await writeAssets(assets, files)
    const summary = join(root, 'summary.md')
    const common = { repo: 'o/r', tag: 'v9.9.9', dir: assets, title: 'LightRead 轻阅 v9.9.9', notes: 'Release notes', commit, latest: true, api: `${base}/api/v5`, web: base, gitUrl, token: 'tok', backoffMs: 1, tagWaitMs: 2000, tagPollMs: 20, cwd: src, log, summary }

    // 1. dry-run 不产生任何写请求
    const dry = await mirrorRelease({ ...common, dryRun: true, token: '' })
    assert.equal(dry.uploads.at(-1), SUMS)
    assert.ok(state.log.every(l => l.startsWith('GET ')), `dry-run 只能读: ${state.log}`)
    assert.equal(remoteTagCommit(gitUrl, 'v9.9.9'), null)

    // 2. 首次镜像: 推送 tag、创建 Release、带重试上传 (每次重试重新取 upload_url)、SHA256SUMS 最后
    state.fail.uploadUrl = 1
    state.fail.put.set('LightRead_v9.9.9_android_arm64.apk', 2)
    const first = await mirrorRelease(common)
    assert.equal(first.tagState, 'pushed')
    assert.equal(remoteTagCommit(gitUrl, 'v9.9.9'), commit)
    const stored = state.log.filter(l => l.startsWith('STORED ')).map(l => l.slice(7))
    assert.deepEqual(stored, ['LightRead_v9.9.9_android_arm64.apk.json', 'LightRead_v9.9.9_android_arm64.apk', 'LightRead_9.9.9_amd64.AppImage', SUMS])
    const release = state.releases.get('v9.9.9')
    assert.equal(release.release_status, 'latest')
    assert.equal(release.created_with_target, false)
    assert.match(release.body, /^Release notes\n\n<!-- lightread-mirror-sizes \{"LightRead_9\.9\.9_amd64\.AppImage":4000,/)
    // 每次 PUT 都用新取的签名地址 (假服务拒绝重复使用)
    assert.equal(state.usedTokens.size, state.log.filter(l => l.startsWith('PUT ')).length)
    assert.equal(state.log.filter(l => l.startsWith('PUT ')).length, 4 + 2)
    assert.match(await readFile(summary, 'utf8'), /GitCode 镜像 v9\.9\.9: 完成/)

    // 3. 重跑幂等: 不创建、不更新、不上传
    state.log.length = 0
    const again = await mirrorRelease(common)
    assert.deepEqual(again.uploaded, [])
    assert.equal(again.tagState, 'present')
    assert.ok(!state.log.some(l => /^(POST|PATCH|PUT|DELETE) /.test(l)), `重跑不应写入: ${state.log}`)

    // 4. Android 修补: 本地 APK 与清单变化 → 先删旧清单, 删除并重传 APK, 再传新清单
    await writeAssets(assets, { ...files, 'LightRead_v9.9.9_android_arm64.apk': 'apk-v2' })
    state.log.length = 0
    const repair = await mirrorRelease(common)
    assert.deepEqual(repair.repaired, ['LightRead_v9.9.9_android_arm64.apk'])
    assert.deepEqual(state.log.filter(l => l.startsWith('STORED ') || l.startsWith('DELETE ')).map(l => l.split(' ')[0]), ['DELETE', 'DELETE', 'STORED', 'STORED'])
    assert.equal(state.files.get('v9.9.9/LightRead_v9.9.9_android_arm64.apk').toString(), 'apk-v2')

    // 5. 本地文件与清单不符时不做任何远端写入
    await writeFile(join(assets, 'stray.bin'), 'x')
    state.log.length = 0
    await assert.rejects(mirrorRelease(common), /stray\.bin 不在 SHA256SUMS/)
    assert.equal(state.log.length, 0)
    await rm(join(assets, 'stray.bin'))
    await writeFile(join(assets, 'LightRead_v9.9.9_android_arm64.apk.json'), 'tampered')
    await assert.rejects(mirrorRelease(common), /与 SHA256SUMS 不一致/)
    await writeAssets(assets, files)

    // 6. GitCode 上同名 tag 指向其他提交时拒绝镜像
    await writeFile(join(src, 'f'), '2')
    git(src, 'commit', '-qam', 'two')
    const other = git(src, 'rev-parse', 'HEAD')
    git(src, 'tag', 'v9.9.8', other)
    git(src, 'push', '-q', gitUrl, `${other}:refs/tags/v9.9.8`)
    await assert.rejects(mirrorRelease({ ...common, tag: 'v9.9.8', commit }), /不一致, 停止镜像/)

    // 7. pull 镜像: 推送被拒时等待镜像同步出 tag
    const hook = join(bare, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\necho "mirror repository is read-only" >&2\nexit 1\n', { mode: 0o755 })
    git(src, 'tag', 'v9.9.7', commit)
    const sync = setTimeout(() => git(bare, 'update-ref', 'refs/tags/v9.9.7', commit), 100)
    const mirrored = await mirrorRelease({ ...common, tag: 'v9.9.7', latest: false })
    clearTimeout(sync)
    assert.equal(mirrored.tagState, 'mirrored')
    assert.equal(state.releases.get('v9.9.7').release_status, 'none')
    await assert.rejects(mirrorRelease({ ...common, tag: 'v9.9.6', tagWaitMs: 100 }), /始终没有 tag v9\.9\.6/)

    // 8. 无 commit (tts-models): 不碰 git, 由创建 Release 生成 tag
    const tts = join(root, 'tts')
    await writeAssets(tts, { 'kokoro.tar.bz2': 'model' })
    const model = await mirrorRelease({ ...common, tag: 'tts-models', dir: tts, commit: undefined, latest: false, title: 'Kokoro TTS models' })
    assert.equal(model.tagState, 'by-release')
    assert.equal(remoteTagCommit(gitUrl, 'tts-models'), null)

    // 9. 缺令牌时拒绝写入
    await assert.rejects(mirrorRelease({ ...common, token: '' }), /缺少 GITCODE_TOKEN/)
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
  console.log('mirror-gitcode self-test passed')
}

// ---- CLI ----

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'self-test': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      latest: { type: 'boolean' },
      repo: { type: 'string' },
      tag: { type: 'string' },
      dir: { type: 'string' },
      title: { type: 'string' },
      'notes-file': { type: 'string' },
      commit: { type: 'string' },
    },
  })
  if (values['self-test']) return selfTest()
  if (positionals[0] !== 'release') {
    console.error('用法: mirror-gitcode.mjs release --repo owner/repo --tag TAG --dir DIR --title T [--notes-file F] [--commit SHA] [--latest] [--dry-run] | --self-test')
    process.exit(2)
  }
  const env = process.env
  const web = (env.GITCODE_WEB || 'https://gitcode.com').replace(/\/$/, '')
  await mirrorRelease({
    repo: values.repo,
    tag: values.tag,
    dir: values.dir,
    title: values.title || values.tag,
    notes: values['notes-file'] ? await readFile(values['notes-file'], 'utf8') : '',
    commit: values.commit || undefined,
    latest: Boolean(values.latest),
    dryRun: Boolean(values['dry-run']),
    api: (env.GITCODE_API || 'https://api.gitcode.com/api/v5').replace(/\/$/, ''),
    web,
    gitUrl: env.GITCODE_GIT_URL || `${web}/${values.repo}.git`,
    token: env.GITCODE_TOKEN || '',
    user: env.GITCODE_USER || '',
    backoffMs: Number(env.MIRROR_BACKOFF_MS) || 5000,
    tagWaitMs: Number(env.MIRROR_TAG_WAIT_MS) || 600_000,
    summary: env.GITHUB_STEP_SUMMARY,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(`::error::GitCode 镜像失败: ${e.message}`)
    process.exit(1)
  })
}
