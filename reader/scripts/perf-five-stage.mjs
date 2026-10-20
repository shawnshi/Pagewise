/** Synthetic desktop acceptance probe. Never reads installed app storage or personal books.
 * node --experimental-strip-types scripts/perf-five-stage.mjs --quick
 * Full turn sampling: --samples 100 --format epub|txt|pdf (one bounded run per format).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { cpus, totalmem } from 'node:os'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function statistics(values) {
  assert.ok(values.length && values.every(v => Number.isFinite(v) && v >= 0), 'finite nonnegative samples required')
  const sorted = [...values].sort((a, b) => a - b)
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return { count: values.length, p50: at(.5), p95: at(.95), p99: at(.99), min: sorted[0], max: sorted.at(-1), tailEvidence: values.length >= 100 ? '100+ samples' : 'exploratory: fewer than 100 samples' }
}
export function assertCompletion(before, after, kind, expected) {
  assert.ok(after?.ready, `${kind}: content/bitmap not ready`)
  assert.ok(after.identity && after.identity !== before?.identity, `${kind}: unchanged position`)
  if (expected !== undefined) assert.equal(after.section, expected, `${kind}: wrong target`)
  assert.ok(Number.isFinite(after.eventAt) && Number.isFinite(after.doneAt) && after.doneAt >= after.eventAt, `${kind}: missing event/completion clock`)
  return after.doneAt - after.eventAt
}
export async function waitForCommit(read, before, { timeout = 10000, expected, kind = 'turn', interval = 5 } = {}) {
  const until = performance.now() + timeout
  do {
    const after = await read()
    if (after?.ready && after.identity !== before?.identity && (expected === undefined || after.section === expected)) {
      assertCompletion(before, after, kind, expected)
      return after
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  } while (performance.now() < until)
  throw new Error(`${kind}: unfinished action timed out after ${timeout}ms`)
}
export function syntheticFixtures() {
  const chapters = 12, paragraphs = 90
  const prose = 'SYNTHETIC_BODY. Reading performance uses generated text only. Each visible paragraph proves a real renderer document exists. 页面测量不代表电子墨水可见延迟。 '.repeat(3)
  const text = Array.from({ length: chapters }, (_, i) => `第${i + 1}章 测试章节\n\n` + Array.from({ length: paragraphs }, (_, p) => `SYNTHETIC_BODY SECTION_${i} PARA_${p}. ${prose}`).join('\n\n')).join('\n\n')
  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/package.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:pagewise:synthetic-performance</dc:identifier><dc:title>PERF_SYNTHETIC_EPUB</dc:title><dc:creator>Synthetic</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-19T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${Array.from({ length: chapters }, (_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${Array.from({ length: chapters }, (_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`),
    'OEBPS/nav.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${Array.from({ length: chapters }, (_, i) => `<li><a href="c${i}.xhtml">Chapter ${i + 1}</a></li>`).join('')}</ol></nav></body></html>`),
  }
  for (let i = 0; i < chapters; i++) files[`OEBPS/c${i}.xhtml`] = strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title></head><body><h1>Chapter ${i + 1}</h1>${Array.from({ length: paragraphs }, (_, p) => `<p>SYNTHETIC_BODY SECTION_${i} PARA_${p}. ${prose}</p>`).join('')}</body></html>`)
  // Standard uncompressed PDF with explicit xref; each page has a unique gray patch.
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (let i = 0; i < 120; i++) {
    const id = objects.length, stream = `${(.1 + i / 200).toFixed(3)} g 0 0 600 800 re f 0 g BT /F1 22 Tf 40 720 Td (SYNTHETIC PDF PAGE ${i + 1}) Tj ET`
    kids.push(`${id} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  objects[2] = `<< /Type /Pages /Count 120 /Kids [${kids.join(' ')}] >>`
  let pdf = '%PDF-1.4\n', offsets = [0]
  for (let i = 1; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return { epub: Buffer.from(zipSync(files, { mtime: new Date(2026, 0, 1) })), txt: Buffer.from(text), pdf: Buffer.from(pdf) }
}

function sourceManifest(root) {
  const files = {}
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files[relative(root, path).replaceAll('\\', '/')] = sha(readFileSync(path))
    }
  }
  walk(resolve(root, 'src')); walk(resolve(root, 'public'))
  for (const name of ['package.json', 'package-lock.json', 'vite.config.ts', 'vite.legacy.ts']) files[name] = sha(readFileSync(resolve(root, name)))
  return { sha256: sha(JSON.stringify(files)), files }
}
function option(args, name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
function inside(base, path) { const rel = relative(base, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')) }

// Executed in the page, observing the actual production renderer rather than Vue test mirrors.
export function installObserver({ settingsVersion = 16, profile = 'default' } = {}) {
  window.__perfProbe = { eventAt: null, armed: false, longTasks: [] }
  const start = () => { if (window.__perfProbe.armed && window.__perfProbe.eventAt === null) window.__perfProbe.eventAt = performance.now() }
  window.addEventListener('click', start, true)
  window.addEventListener('keydown', start, true)
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      window.__perfProbe.longTasks.push({ start: e.startTime, duration: e.duration })
      if (window.__perfProbe.longTasks.length > 20000) throw Error('Probe long-task budget exceeded')
    }
  }).observe({ type: 'longtask', buffered: true })
  window.__perfRead = format => {
    if (format === 'pdf') {
      const input = document.querySelector('.page-input'), section = Number(input?.value)
      const holder = document.querySelector(`.p-holder[data-page="${section}"]`), canvas = holder?.querySelector('.p-canvas canvas')
      let gray = -1
      if (canvas?.width && canvas?.height) gray = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[0]
      // Match the fixture's actual page raster, not just a changed page number/blank canvas.
      const expected = Math.round((.1 + (section - 1) / 200) * 255)
      const box = holder?.getBoundingClientRect()
      return { section, identity: String(section), ready: !document.querySelector('.paper-state') && !!canvas && Math.abs(gray - expected) <= 3 && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight, gray }
    }
    const v = document.querySelector('foliate-view'), loc = v?.lastLocation
    const contents = v?.renderer?.getContents?.() ?? []
    const doc = contents.find(c => c.index === loc?.section?.current)?.doc ?? contents[0]?.doc
    const range = loc?.range, box = range?.getBoundingClientRect?.()
    return { identity: loc?.cfi ?? '', section: loc?.section?.current ?? contents[0]?.index, ready: !document.querySelector('.reader > .state') && !!doc?.body?.textContent?.includes('SYNTHETIC_BODY') && !!range && !!box && (box.width > 0 || box.height > 0), bodyMarker: !!doc?.body?.textContent?.includes('SYNTHETIC_BODY') }
  }
  localStorage.setItem('lightread-settings', JSON.stringify({ version: settingsVersion, language: 'en', ttsEngine: 'system', ...(profile === 'eink' ? { readingMode: { eink: { enabled: true, prompted: true } } } : {}), pagewiseCompanion: { enabled: false }, pdf: { renderer: 'mupdf', layout: 'original', mode: 'paged', fit: 'fitP', spreadMode: 'single' }, reader: { flow: 'paginated', maxColumnCount: 1, portraitScroll: false, continuousScroll: false } }))
}
export async function browserCommit(page, before, format, timeout, expected) {
  await page.waitForFunction(({ before, format, expected }) => {
    const s = window.__perfRead(format)
    return s.ready && s.identity !== before?.identity && (expected === undefined || s.section === expected)
  }, { before, format, expected }, { timeout, polling: 'raf' })
  const after = await page.evaluate(async format => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    return { ...window.__perfRead(format), eventAt: window.__perfProbe.eventAt, doneAt: performance.now(), longTasks: window.__perfProbe.longTasks.filter(e => e.start >= window.__perfProbe.eventAt) }
  }, format)
  return { ...after, ms: assertCompletion(before, after, format, expected) }
}
async function arm(page) { await page.evaluate(() => { window.__perfProbe.eventAt = null; window.__perfProbe.armed = true }) }

async function libraryBenchmark(root, samples) {
  const { queryLibraryBooks } = await import(pathToFileURL(resolve(root, 'src/services/libraryQuery.ts')))
  const books = Object.freeze(Array.from({ length: 4000 }, (_, i) => Object.freeze({ id: String(i).padStart(4, '0'), title: `Book ${i}`, author: `Writer_${i % 20}_END`, format: i % 2 ? 'epub' : 'txt', tags: Object.freeze(['shared', `tag${i % 4}`]), addedAt: i, progress: 0, language: 'en' })))
  const before = sha(JSON.stringify(books)), results = []
  const scenarios = [
    ['sort-title', { sortBy: 'title', pageSize: 24 }, 4000],
    ['filter-author-tag', { search: 'Writer_19_END', tags: ['tag3'], sortBy: 'addedAt', direction: 'desc', pageSize: 24 }, 200],
    ['empty', { search: 'no-such-synthetic-title' }, 0],
  ]
  for (const [name, options, total] of scenarios) {
    const times = []
    for (let i = -3; i < samples; i++) {
      const start = performance.now(), result = queryLibraryBooks(books, options), ms = performance.now() - start
      assert.equal(result.total, total)
      if (name === 'filter-author-tag') assert.deepEqual(result.items.map(b => b.id), Array.from({ length: 24 }, (_, n) => String(3999 - n * 20).padStart(4, '0')))
      if (name === 'sort-title') assert.equal(result.items[0].title, 'Book 0')
      if (i >= 0) times.push(ms)
    }
    results.push({ name, stats: statistics(times), samplesMs: times })
  }
  assert.equal(sha(JSON.stringify(books)), before, 'library benchmark mutated metadata')
  return { runtime: process.version, corpus: 4000, immutable: true, warmup: 3, results }
}

export async function main(args = process.argv.slice(2)) {
  const quick = args.includes('--quick'), samples = Number(option(args, '--samples', quick ? 5 : 100)), openSamples = Number(option(args, '--open-samples', quick ? 1 : 3))
  const root = resolve(option(args, '--root', fileURLToPath(new URL('../', import.meta.url)))), workspace = resolve(root, '..')
  const port = Number(option(args, '--port', 4387)), timeout = Number(option(args, '--action-timeout', 15000)), cpu = Number(option(args, '--cpu', 1))
  const reportPath = resolve(workspace, option(args, '--report', '.cache/performance-20261019/baseline-browser.json'))
  assert.ok(inside(resolve(workspace, '.cache'), reportPath), 'report must stay in target workspace .cache')
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 1000 && Number.isInteger(openSamples) && openSamples > 0 && openSamples <= 100)
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && timeout > 0 && timeout <= 30000 && cpu >= 1 && cpu <= 6)
  const formats = option(args, '--format', 'epub,txt,pdf').split(',')
  const fault = option(args, '--fault', '')
  const profile = option(args, '--profile', 'default')
  assert.ok(['default', 'eink'].includes(profile), 'unknown benchmark profile')
  assert.ok(['', 'unfinished-turn'].includes(fault), 'unknown fault injection')
  assert.ok(formats.every(f => ['epub', 'txt', 'pdf'].includes(f)))
  assert.ok(!formats.includes('pdf') || samples <= 119, 'PDF workload has 120 pages; maximum 119 forward turns')
  const vite = await import(pathToFileURL(resolve(root, 'scripts/vite-isolated.mjs')))
  // Reuse the project's physical-path/junction guard before any report/build write.
  const outDir = resolve(dirname(reportPath), 'build')
  vite.isolatedCacheDir(reportPath, root)
  vite.isolatedCacheDir(outDir, root)
  mkdirSync(dirname(reportPath), { recursive: true })
  const report = { status: 'RUNNING', started: new Date().toISOString(), kind: 'synthetic desktop Edge; not BOOX/e-ink/device latency', options: { root, port, samples, openSamples, cpu, timeout, formats, fault, profile }, environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), viewport: { width: 992, height: 1323 }, dpr: 1.875, serviceWorkers: 'blocked' }, source: sourceManifest(root), pageErrors: [], outboundBlocked: [], browser: [], limitations: ['PDF/TXT/EPUB generated fixtures only; no physical EPD, native speech or SAF coverage', 'Fixture rows use the actual embedded-book IndexedDB schema; folder import latency is NOT measured', 'cold=open after frontend reload with HTTP cache disabled; imported synthetic IndexedDB remains', 'warm=renderer unmounted then reopened in same frontend; no fixed sleeps subtracted', 'two animation frames after committed DOM/CFI/bitmap is browser readiness, not panel scanout', 'long tasks are browser PerformanceObserver entries; desktop scheduling is uncontrolled'] }
  const apk = option(args, '--apk', null)
  if (apk) report.apk = { path: resolve(apk), sha256: sha(readFileSync(resolve(apk))), sourceEquivalence: 'unverified: supplied bytes only, no installed-app equivalence assertion' }
  const device = option(args, '--device-metadata', null)
  if (device) report.deviceReference = { path: resolve(device), sha256: sha(readFileSync(resolve(device))), metadata: JSON.parse(readFileSync(resolve(device), 'utf8')), relation: 'read-only parent metadata, not measurements from this synthetic run; source equivalence unproven' }
  report.harnessSha256 = sha(readFileSync(fileURLToPath(import.meta.url)))
  let server, browser, context, activePage
  const started = performance.now()
  // The CLI is also run under a <=180s caller timeout; this deadline preserves failure evidence.
  const deadline = setTimeout(() => { report.status = 'FAILED'; report.error = 'Run exceeded 170s safety deadline'; writeFileSync(reportPath, JSON.stringify(report, null, 2)); void browser?.close(); void server?.httpServer?.close(); process.exitCode = 1 }, 170000)
  try {
    const settingsVersion = Number(readFileSync(resolve(root, 'src/stores/settings.ts'), 'utf8').match(/const SETTINGS_VERSION = (\d+)/)?.[1])
    assert.ok(Number.isSafeInteger(settingsVersion), 'unknown settings fixture schema')
    report.settingsFixtureVersion = settingsVersion
    report.library = await libraryBenchmark(root, samples)
    if (!args.includes('--skip-build')) {
      const t = performance.now()
      await vite.build({ root, build: { outDir, emptyOutDir: true } })
      report.buildMs = performance.now() - t
      writeFileSync(resolve(outDir, 'probe-source.json'), JSON.stringify({ sha256: report.source.sha256 }))
    }
    assert.ok(existsSync(resolve(outDir, 'index.html')), 'built frontend missing')
    assert.equal(JSON.parse(readFileSync(resolve(outDir, 'probe-source.json'), 'utf8')).sha256, report.source.sha256, 'stale --skip-build source binding')
    server = await vite.preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port, strictPort: true, headers: { 'Content-Security-Policy': "default-src 'self' blob: data:; script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; worker-src 'self' blob:" } } })
    const origin = `http://127.0.0.1:${port}`
    const response = await fetch(origin)
    assert.ok(response.ok && (await response.text()).includes('<html'), 'preview HTTP app availability failed')
    report.networkPolicy = response.headers.get('content-security-policy')
    assert.match(report.networkPolicy, /connect-src 'self' blob:/, 'worker CSP must also restrict connections')
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    report.environment.browser = browser.version()
    const fixtures = syntheticFixtures()
    report.fixtures = Object.fromEntries(Object.entries(fixtures).map(([f, b]) => [f, { bytes: b.length, sha256: sha(b) }]))
    for (const format of formats) {
      const result = { format, opens: { cold: [], warm: [] }, samePage: [], chapter: [], pageTurns: [], longTasks: [] }
      report.browser.push(result)
      context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: report.environment.dpr, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
      await context.route('**/*', route => {
        const u = new URL(route.request().url())
        if (u.origin === origin || ['blob:', 'data:', 'about:'].includes(u.protocol)) return route.continue()
        report.outboundBlocked.push({ urlOrigin: u.origin, resource: route.request().resourceType() })
        return route.abort('blockedbyclient')
      })
      await context.addInitScript(installObserver, { settingsVersion, profile })
      const page = activePage = await context.newPage()
      page.setDefaultTimeout(timeout)
      page.on('pageerror', error => report.pageErrors.push({ format, message: error.message, stack: error.stack }))
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
      await page.goto(origin + '/#/library', { waitUntil: 'load' })
      result.outboundGuard = await page.evaluate(async () => {
        const src = URL.createObjectURL(new Blob([`fetch('https://pagewise-network-probe.invalid/').then(() => postMessage('ESCAPED'), () => postMessage('BLOCKED'))`], { type: 'text/javascript' }))
        const worker = new Worker(src)
        try { return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('worker network guard probe timeout')), 3000); worker.onmessage = e => { clearTimeout(timer); resolve(e.data) }; worker.onerror = e => { clearTimeout(timer); reject(Error(e.message)) } }) }
        finally { worker.terminate(); URL.revokeObjectURL(src) }
      })
      assert.equal(result.outboundGuard, 'BLOCKED', 'dedicated worker outbound guard failed')
      const t = performance.now()
      await page.locator('.empty').waitFor({ state: 'visible' })
      await page.evaluate(async ({ format, base64 }) => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
        const db = await new Promise((resolve, reject) => { const req = indexedDB.open('lightread'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction('books', 'readwrite')
            tx.objectStore('books').add({ id: 'perf-synthetic', title: `PERF_SYNTHETIC_${format.toUpperCase()}`, author: 'Synthetic', format, fileName: `synthetic.${format}`, tags: [], language: 'en', addedAt: 1, hasCover: false, file: bytes.buffer, fileAvailability: 'available' })
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? Error('fixture transaction aborted'))
          })
        } finally { db.close() }
      }, { format, base64: fixtures[format].toString('base64') })
      result.fixtureSeedMs = performance.now() - t
      await page.reload({ waitUntil: 'load' })
      const card = page.locator('.book-card').first()
      await card.waitFor({ state: 'visible' })
      await card.locator('.book-body').click()
      await page.locator('.btn-read').waitFor({ state: 'visible' })
      const detailHash = await page.evaluate(() => location.hash)
      for (let i = 0; i < openSamples; i++) {
        for (const kind of ['cold', 'warm']) {
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: kind === 'cold' })
          if (kind === 'cold') await page.reload({ waitUntil: 'load' })
          await page.locator('.btn-read').waitFor({ state: 'visible' })
          await arm(page)
          await page.locator('.btn-read').click()
          const after = await browserCommit(page, null, format, timeout)
          result.opens[kind].push(after)
          assert.match(page.url(), format === 'pdf' ? /#\/read-pdf\// : /#\/read\//, 'must open reader, not detail route')
          await page.evaluate(hash => { location.hash = hash }, detailHash)
        }
      }
      await page.locator('.btn-read').waitFor({ state: 'visible' }); await arm(page); await page.locator('.btn-read').click()
      await browserCommit(page, null, format, timeout)
      if (fault === 'unfinished-turn') await page.evaluate(() => window.addEventListener('keydown', e => { e.preventDefault(); e.stopImmediatePropagation() }, true))
      for (let i = 0; i < samples; i++) {
        const before = await page.evaluate(f => window.__perfRead(f), format)
        await arm(page)
        await page.keyboard.press(format === 'pdf' || i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft')
        const after = await browserCommit(page, before, format, timeout, format === 'pdf' ? before.section + 1 : before.section)
        result[format === 'pdf' ? 'pageTurns' : 'samePage'].push(after)
      }
      if (format !== 'pdf') for (let i = 0; i < samples; i++) {
        const before = await page.evaluate(f => window.__perfRead(f), format)
        await page.mouse.move(490, report.environment.viewport.height - 2)
        const button = page.locator('.chapter-btn').nth(i % 2 === 0 ? 1 : 0)
        await button.waitFor({ state: 'visible' }); await arm(page); await button.click()
        result.chapter.push(await browserCommit(page, before, format, timeout, before.section + (i % 2 === 0 ? 1 : -1)))
      }
      result.longTasks = await page.evaluate(() => window.__perfProbe.longTasks)
      result.summary = Object.fromEntries([['coldOpen', result.opens.cold], ['warmOpen', result.opens.warm], ['samePage', result.samePage], ['chapter', result.chapter], ['pageTurns', result.pageTurns]].filter(([, a]) => a.length).map(([key, a]) => [key, statistics(a.map(s => s.ms))]))
      assert.deepEqual(report.pageErrors.filter(e => e.format === format), [], 'unhandled page error')
      console.log('FORMAT', format, JSON.stringify(result.summary))
      await context.close(); context = null
    }
    assert.equal(sourceManifest(root).sha256, report.source.sha256, 'source changed during benchmark')
    report.status = 'PASSED'
  } catch (error) {
    report.status = 'FAILED'; report.error = error.stack ?? String(error); process.exitCode = 1
    if (activePage && !activePage.isClosed()) report.failureDOM = await activePage.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 3000), renderer: window.__perfRead?.('epub'), pdf: window.__perfRead?.('pdf') })).catch(e => ({ diagnosticError: String(e) }))
    console.error(report.error)
  } finally {
    clearTimeout(deadline)
    await context?.close(); await browser?.close()
    await new Promise((resolve, reject) => server?.httpServer ? server.httpServer.close(error => error ? reject(error) : resolve()) : resolve())
    report.elapsedMs = performance.now() - started; report.finished = new Date().toISOString()
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log('REPORT', reportPath, report.status, Math.round(report.elapsedMs), 'ms')
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
