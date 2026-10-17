// Shared Android frontend smoke test in an isolated Chromium context; not a device test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(root, '../artifacts/android-only')
mkdirSync(artifacts, { recursive: true })
const port = 4178
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
let browser
const blocked = []
const errors = []
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Preview server exited: ${serverLog}`)
    if (!serverLog.replace(/\u001b\[[0-9;]*m/g, '').includes(base)) {
      await new Promise(done => setTimeout(done, 250))
      continue
    }
    try {
      const response = await fetch(base)
      if (response.ok) { ready = true; break }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
    await new Promise(done => setTimeout(done, 250))
  }
  assert.ok(ready, `Preview server did not become ready: ${serverLog}`)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const context = await browser.newContext({
    viewport: { width: 834, height: 1100 },
    userAgent: 'Mozilla/5.0 (Linux; Android 12; NoteX3Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
  })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) {
      blocked.push(url.origin)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await context.addInitScript(() => {
    if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ language: 'zh', usageStats: false, sync: { autoSync: false } }))
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/#/library`)
  await page.locator('input[type="file"]').first().waitFor({ state: 'attached' })
  assert.equal(await page.locator('link[rel="manifest"]').count(), 0)
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'Pagewise-Android-Preview.txt', mimeType: 'text/plain',
    buffer: Buffer.from('第一章 平台收敛\n\n' + '这是知页合成测试文本，不含私人书籍。'.repeat(200)),
  })
  const title = page.getByText('Pagewise-Android-Preview', { exact: true }).first()
  await title.waitFor({ state: 'visible', timeout: 20000 })
  await page.screenshot({ path: join(artifacts, 'preview-library.png') })
  await title.click()
  await page.locator('.book-detail .btn-read').click()
  await page.locator('foliate-view').waitFor({ state: 'attached', timeout: 20000 })
  await page.waitForFunction(() => {
    const view = document.querySelector('foliate-view')
    return view?.renderer?.getContents?.().some(({ doc }) => doc.body?.textContent?.includes('这是知页合成测试文本'))
  }, undefined, { timeout: 20000 })
  await page.screenshot({ path: join(artifacts, 'preview-reader.png') })
  await page.goto(`${base}/#/library`)
  await page.getByText('Pagewise-Android-Preview', { exact: true }).first().waitFor({ state: 'visible' })
  await page.locator('a[href$="/settings"]:visible').first().click()
  const identity = page.locator('.app-identity')
  await identity.scrollIntoViewIfNeeded()
  assert.match(await identity.locator('.app-name').textContent(), /知页阅读器\s*·\s*Pagewise/)
  assert.equal((await page.locator('.env-chip').textContent()).trim(), '开发预览')
  await page.screenshot({ path: join(artifacts, 'preview-settings.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const report = { status: 'PASSED', runtime: 'isolated Chromium Android-UA development preview', syntheticImport: true, readerOpened: true, libraryPersistedAcrossNavigation: true, versionLabel: '开发预览', pwaManifest: false, blockedExternalOrigins: [...new Set(blocked)], pageErrors: errors, nativeDeviceTested: false }
  writeFileSync(join(artifacts, 'preview-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  server.kill()
}
