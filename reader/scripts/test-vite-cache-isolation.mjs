// Parent only: execute after integration and quarantine of the old shared caches.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, symlink, unlink } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, isolatedCacheDir, readerRoot, normalizePath } from './vite-isolated.mjs'

const workspace = resolve(readerRoot, '..')
const artifacts = resolve(workspace, '.cache/vite-isolation-tests', `${process.pid}-${randomUUID()}`)
const sharedModules = realpathSync(resolve(readerRoot, 'node_modules'))
const noSharedCaches = () => {
  for (const name of ['.vite', '.vite-temp']) assert.equal(existsSync(join(sharedModules, name)), false, `shared ${name} must remain absent`)
}

function scriptsIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? scriptsIn(join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [join(dir, entry.name)] : [])
}

test('startup inventory: SDK imports and raw CLI use only guarded entrypoints', () => {
  for (const file of scriptsIn(resolve(readerRoot, 'scripts'))) {
    if (['vite-isolated.mjs', 'test-vite-cache-isolation.mjs'].includes(file.split(/[\\/]/).at(-1))) continue
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /import\s*\(\s*['"]vite['"]\s*\)/, file)
    const imports = [...source.matchAll(/import\s+([^;\n]+?)\s+from\s+['"]vite['"]/g)]
    for (const match of imports) assert.equal(match[1].trim(), '{ parseAst }', file)
    for (const line of source.split('\n').filter(line => line.includes('vite/bin/vite.js'))) {
      assert.match(line, /['"]--configLoader['"],\s*['"]runner['"]/, file)
    }
  }
  let pkg
  try { pkg = JSON.parse(readFileSync(resolve(readerRoot, 'package.json'), 'utf8')) }
  catch (cause) { throw new Error('Invalid package manifest JSON', { cause }) }
  for (const name of ['dev', 'build', 'preview']) assert.match(pkg.scripts[name], /--configLoader runner/)
  for (const name of ['app', 'node']) {
    const source = readFileSync(resolve(readerRoot, `tsconfig.${name}.json`), 'utf8')
    assert.match(source, /"tsBuildInfoFile": "\.\.\/\.cache\/typescript\//)
    assert.doesNotMatch(source, /node_modules\/\.tmp/)
  }
})

test('path policy rejects dependencies and junctions before any cache creation', async () => {
  const base = resolve(artifacts, 'safe')
  const one = isolatedCacheDir(base), two = isolatedCacheDir(base)
  assert.notEqual(one, two)
  assert.equal(existsSync(base), false, 'path selection itself must not mkdir')
  assert.throws(() => isolatedCacheDir(resolve(readerRoot, 'node_modules/new-cache')), /node_modules/)
  assert.throws(() => isolatedCacheDir(base, resolve(readerRoot, 'node_modules')), /node_modules/)
  assert.throws(() => isolatedCacheDir(resolve(workspace, '../outside')), /workspace/)
  await mkdir(artifacts, { recursive: true })
  const alias = resolve(artifacts, 'dependency-alias')
  await symlink(sharedModules, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    assert.throws(() => isolatedCacheDir(resolve(alias, 'never-created')), /node_modules/)
    await assert.rejects(createServer({ root: readerRoot, configFile: false, cacheDir: resolve(alias, 'never-created') }), /node_modules/)
    await assert.rejects(createServer({ root: alias, configFile: false, cacheDir: base }), /node_modules/)
    assert.equal(existsSync(join(sharedModules, 'never-created')), false)
    assert.equal(existsSync(base), false)
  } finally {
    await unlink(alias)
  }
})

test('two simultaneous default-config servers retain root/plugins and isolate cache', { timeout: 90000 }, async () => {
  noSharedCaches()
  const servers = []
  try {
    // allSettled retains ownership even if one startup fails.
    const results = await Promise.allSettled([0, 1].map(async () => {
      const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
      servers.push(server)
      await server.listen()
      return server
    }))
    for (const result of results) if (result.status === 'rejected') throw result.reason
    assert.equal(servers.length, 2)
    assert.notEqual(servers[0].config.cacheDir, servers[1].config.cacheDir)
    for (const server of servers) {
      assert.equal(realpathSync(server.config.root), realpathSync(readerRoot))
      assert.equal(server.config.inlineConfig.configLoader, 'runner')
      assert.ok(server.config.configFile.endsWith('vite.config.ts'))
      assert.ok(server.config.plugins.some(plugin => plugin.name === 'vite:vue'))
      assert.ok(server.config.plugins.some(plugin => plugin.name === 'lightread:foliate-paginator-fork'))
      assert.ok(!relative(resolve(workspace, '.cache'), server.config.cacheDir).startsWith('..'))
      const response = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/src/App.vue`)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /render|setup/)
    }
    noSharedCaches()
  } finally { await Promise.all(servers.map(server => server.close())) }
  noSharedCaches()
})

test('configFile:false preserves Vue/plugin/define/server and real browser fixture', { timeout: 90000 }, async () => {
  noSharedCaches()
  const { default: vue } = await import('@vitejs/plugin-vue')
  const { chromium } = await import('playwright')
  let browser
  const server = await createServer({ root: readerRoot, configFile: false, configLoader: 'bundle',
    cacheDir: resolve(artifacts, 'explicit-base'), define: { __CACHE_FIXTURE__: '"caller retained"' },
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [vue(), { name: 'cache-fixture',
      resolveId(id) {
        if (id === '/__cache_fixture.vue') return normalizePath(resolve(artifacts, 'cache-fixture.vue'))
        if (id === '/__cache_entry.js') return normalizePath(resolve(artifacts, 'cache-entry.js'))
      },
      load(id) {
        if (id === normalizePath(resolve(artifacts, 'cache-fixture.vue'))) return '<script setup>const text = __CACHE_FIXTURE__</script><template><p id="result">{{ text }}</p></template>'
        if (id === normalizePath(resolve(artifacts, 'cache-entry.js'))) return 'import {createApp} from "vue"; import Fixture from "/__cache_fixture.vue"; createApp(Fixture).mount("#app")'
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== '/__cache_fixture') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><div id="app"></div><script type="module" src="/__cache_entry.js"></script>')
      }) },
    }],
  })
  try {
    await server.listen()
    assert.equal(server.config.configFile, undefined)
    assert.equal(server.config.inlineConfig.configLoader, 'runner')
    const relativeCache = relative(resolve(artifacts, 'explicit-base'), resolve(server.config.cacheDir))
    assert.ok(relativeCache.length > 0 && relativeCache !== '..' && !relativeCache.startsWith(`..${sep}`) && !isAbsolute(relativeCache), 'Vite-normalized cache must be a child of the caller base')
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const executablePath = process.env.PAGEWISE_TEST_BROWSER || [chromium.executablePath(),
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
    assert.ok(executablePath, 'Installed browser required; never download')
    browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto(origin + '/__cache_fixture')
    await page.locator('#result').waitFor()
    assert.equal(await page.locator('#result').textContent(), 'caller retained')
    await context.close()
  } finally { await browser?.close(); await server.close() }
  noSharedCaches()
})

test('official CLI build uses runner and leaves shared cache absent', { timeout: 150000 }, () => {
  noSharedCaches()
  const result = spawnSync(process.execPath, [resolve(readerRoot, 'node_modules/vite/bin/vite.js'),
    'build', '--configLoader', 'runner', '--outDir', resolve(artifacts, 'dist')],
  { cwd: readerRoot, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.ok(existsSync(resolve(artifacts, 'dist/index.html')))
  noSharedCaches()
})
