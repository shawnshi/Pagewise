import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import ts from 'typescript'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const main = readFileSync(resolve(root, 'src/main.ts'), 'utf8')
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true)
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'renderInitializationFailure')
assert.ok(fn, 'Exercise the production early-boot recovery renderer')
const js = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const css = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8')
const out = resolve(root, '../.cache/pw17-bootstrap-fix-20261023/recovery-browser')
mkdirSync(out, { recursive: true })

test('production recovery UI: responsive targets, keyboard, diagnostics, explicit copy outcomes and bounded error text', { timeout: 45000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/') { res.writeHead(404); res.end(); return }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="app"></div><script>${js};renderInitializationFailure(document.getElementById('app'),'library_schema_mismatch')</script></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  const evidence = []
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const origin = `http://127.0.0.1:${server.address().port}`
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    for (const width of [320, 992, 1400]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(origin, { waitUntil: 'networkidle' })
      assert.equal(await page.locator('h1').textContent(), '书库尚未准备好')
      const metrics = await page.locator('button,summary').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, height: n.getBoundingClientRect().height, width: n.getBoundingClientRect().width })))
      assert.ok(metrics.every(n => n.height >= 48 && n.width >= 48), JSON.stringify(metrics))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '重新检查')
      await page.getByText('诊断信息（点击展开）', { exact: true }).click()
      await page.locator('details[open] code').waitFor({ state: 'visible' })
      assert.equal(await page.locator('details code').textContent(), 'library_schema_mismatch')
      assert.equal(await page.locator('main').innerText().then(s => s.includes('旧副本未删除')), false)
      await page.screenshot({ path: resolve(out, `width-${width}.png`), fullPage: true })
      evidence.push({ width, metrics, passed: true })
    }
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.fixtureCopied = value } } }))
    await page.getByRole('button', { name: '复制错误代码' }).click()
    await page.getByRole('status').filter({ hasText: '错误代码已复制。' }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCopied), 'library_schema_mismatch')
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('controlled clipboard denial') } } }))
    await page.getByRole('button', { name: '复制错误代码' }).click()
    await page.getByRole('status').filter({ hasText: '无法自动复制' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '复制错误代码' }).isEnabled(), true)
    await page.evaluate(() => renderInitializationFailure(document.getElementById('app'), '<img src=x onerror=alert(1)>'))
    assert.equal(await page.locator('code').textContent(), 'native_initialization_failed')
    assert.equal(await page.locator('main img').count(), 0)
    writeFileSync(resolve(out, 'result.json'), JSON.stringify({ passed: true, evidence, clipboard: 'controlled browser port; host/device clipboards not modified', invalidCodeNotRendered: true }, null, 2))
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})
