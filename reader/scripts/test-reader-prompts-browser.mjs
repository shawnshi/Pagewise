import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'

const root = resolve(readerRoot, '..')
const artifacts = resolve(root, process.env.PAGEWISE_PROMPTS_QA_DIR || '.cache/reader-prompts-qa')
mkdirSync(artifacts, { recursive: true })
const staleOnly = process.argv.includes('--stale-only')
const results = { started: new Date().toISOString(), cases: [], external: [], pageErrors: [], evidence: [] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const snapshot = process.env.PAGEWISE_PROMPTS_SNAPSHOT
  ? JSON.parse(readFileSync(process.env.PAGEWISE_PROMPTS_SNAPSHOT, 'utf8'))
  : { files: Object.fromEntries(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(p => p && existsSync(resolve(root, p))).map(p => [p, hash(readFileSync(resolve(root, p)))])) }
function reconcile() {
  const mismatches = Object.entries(snapshot.files).filter(([p, sha]) => !existsSync(resolve(root, p)) || hash(readFileSync(resolve(root, p))) !== sha).map(([p]) => p)
  return { count: Object.keys(snapshot.files).length, mismatches }
}
results.baseline = reconcile()
results.initialStatus = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
const cases = ['engine-invalid-completion', 'engine-valid-gists-summary', 'engine-summary-references', 'summary-budget-cache-version', 'six-tabs', 'pdf-popup-caller', 'reader-visible-scope', 'reader-replies-history', 'selection-expansion', 'translation-card', 'reader-stale-page-close-back']
let server, browser, context, page, origin
async function run(name, fn) {
  console.log('CASE', name)
  const start = Date.now()
  try { const details = await fn(); results.cases.push({ name, status: 'PASS', ms: Date.now() - start, details }); console.log('PASS', name, JSON.stringify(details)) }
  catch (error) { results.cases.push({ name, status: 'BLOCKED', ms: Date.now() - start, error: String(error.stack ?? error) }); throw error }
}
async function fresh() {
  await context?.close()
  context = await browser.newContext({ viewport: { width: 992, height: 1000 }, serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const u = new URL(route.request().url())
    if (u.origin === origin || !['http:', 'https:'].includes(u.protocol)) return route.continue()
    results.external.push({ origin: u.origin, blocked: true }); return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.on('pageerror', e => results.pageErrors.push(e.message))
  await page.goto(origin + '/#/library', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.locator('.library').waitFor({ timeout: 45000 })
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/stores/settings.ts')
    const s = useSettings()
    s.language = 'en'; s.aiProvider = 'openai'; s.aiBaseUrl = location.origin + '/qa-model/v1'; s.aiModel = 'synthetic-only'; s.aiApiKey = 'synthetic-local-only'
    s.corsProxy = ''; s.httpProxy = ''; s.pagewiseCompanion.channel = 'own'; s.pagewiseCompanion.enabled = false
    const original = window.fetch.bind(window)
    window.__qa = { calls: [], plans: [], frame: text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` }
    window.fetch = async (url, init) => {
      if (!String(url).startsWith(location.origin + '/qa-model/')) return original(url, init)
      const q = window.__qa; const body = JSON.parse(init.body); q.calls.push(body)
      if (!q.plans.length) throw Error('FIXTURE: unexpected synthetic model call')
      const plan = q.plans.shift()
      const data = q.frame(plan.text ?? '')
      if (plan.hold) return new Response(new ReadableStream({ start(controller) { q.held = controller; controller.enqueue(new TextEncoder().encode(data)) } }), { headers: { 'content-type': 'text/event-stream' } })
      const ending = plan.end === 'eof' ? '' : plan.end === 'length' ? 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n' : 'data: [DONE]\n\n'
      return new Response(data + ending, { headers: { 'content-type': 'text/event-stream' } })
    }
  })
}
async function plan(text, end = 'done', hold = false) { await page.evaluate(p => window.__qa.plans.push(p), { text, end, hold }) }
async function send(question) {
  await page.locator('.ai-input-row input').fill(question)
  await page.locator('.ai-input-row button').click()
  await page.waitForFunction(() => !document.querySelector('.reader').__vueParentComponent.setupState.aiStreaming)
}
async function engineScenario(kind, summaryKind = 'sum') {
  return page.evaluate(async ({ kind, summaryKind }) => {
    const check = (yes, message) => { if (!yes) throw Error('PRODUCTION: ' + message) }
    const { PagewiseCompanion } = await import('/src/services/PagewiseCompanion/engine.ts')
    const { createMemoryCache } = await import('/src/services/PagewiseCompanion/cache.ts')
    const cache = createMemoryCache(), id = crypto.randomUUID(), captures = []
    const doc = new DOMParser().parseFromString('<html lang="en"><body>' + Array.from({ length: 4 }, (_, i) => `<p>SYNTHETIC_PARAGRAPH_${i}. Evidence belongs only to this paragraph and no unseen chapter.</p>`).join('') + '</body></html>', 'text/html')
    const host = { bookId: id, book: () => ({ title: 'TITLE_IGNORE_POLICY', author: 'AUTHOR_ATTACK', language: 'en' }), uiLang: () => 'en', chapterTitle: () => 'CHAPTER_ATTACK', sectionCount: () => 1, sectionLinear: () => true, sectionDoc: async () => null,
      channel: () => ({ kind: 'own', baseUrl: location.origin + '/qa-model/v1', model: 'synthetic-only' }), density: () => 'normal', kinds: () => ({ key: true, term: true, note: true }), fictionOverride: () => null, colors: () => ({}), getOverlayer: () => null, concurrency: () => 1, batchPaint: () => true, onChange() {} }
    const original = window.fetch
    window.fetch = async (url, init) => {
      if (!String(url).startsWith(location.origin + '/qa-model/')) return original(url, init)
      const body = JSON.parse(init.body), data = JSON.parse(body.messages.at(-1).content)
      captures.push(body)
      check(!body.messages[0].content.includes('TITLE_IGNORE_POLICY') && !body.messages[0].content.includes('CHAPTER_ATTACK'), 'metadata in engine system policy')
      let rows
      if (!Array.isArray(data.gistParagraphs)) {
        rows = [{ t: 'sum', text: 'Synthetic summary' }]
        if (summaryKind === 'invalid') rows.push({ t: 'pt', s: 'abc', text: 'Wrong' })
        if (summaryKind === 'nonexistent') rows.push({ t: 'pt', s: '99', text: 'Wrong' })
        if (summaryKind === 'duplicate') rows.push({ t: 'pt', s: '1', text: 'First' }, { t: 'pt', s: '1', text: 'Duplicate' })
        if (summaryKind === 'over3') rows.push(...[1, 2, 3, 4].map(s => ({ t: 'pt', s: String(s), text: 'Point ' + s })))
      } else {
        check(/spoiler/i.test(body.messages[0].content), 'unknown genre first call must be spoiler-protected')
        rows = [{ t: 'meta', fiction: false }, ...data.gistParagraphs.map(p => ({ t: 'gist', p, text: 'Paragraph gist ' + p }))]
        if (kind === 'meta') rows = rows.slice(0, 1)
        if (kind === 'missing') rows.pop()
        if (kind === 'bad-id') rows = [{ t: 'meta', fiction: false }, { t: 'gist', p: 999, text: 'Wrong source' }]
        if (summaryKind !== 'sum') rows.push(...[1, 2, 3, 4].map(p => ({ t: 'key', s: `${p}.1`, r: 3, why: 'Core evidence' })))
      }
      let text = rows.map(x => JSON.stringify(x)).join('\n') + '\n'
      if (kind === 'ndjson') text += '{broken}\n'
      const end = kind === 'eof' ? '' : kind === 'length' ? 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n' : 'data: [DONE]\n\n'
      return new Response(window.__qa.frame(text) + end, { headers: { 'content-type': 'text/event-stream' } })
    }
    const engine = new PagewiseCompanion(host, cache)
    try {
      engine.attach(0, doc); engine.start()
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const s = engine.sections.get(0), c = s?.chunks[0]
        if (c?.status === 'error' || (c?.status === 'done' && !s.summaryLoading && (s.summary || engine.error))) break
        await new Promise(r => setTimeout(r, 10))
      }
      const chunks = await cache.listBook('chunks', id), sections = await cache.listBook('sections', id)
      const state = engine.sections.get(0)
      if (kind !== 'valid') {
        check(chunks.length === 0, `${kind} created complete cache`)
        check(state.chunks[0].status === 'error', `${kind} did not expose error`)
        check(engine.fictionSource === 'default' && localStorage.getItem('lightread-dj-genre:' + id) === null, 'failed output committed model genre')
      } else {
        check(chunks.length === 1 && chunks[0].complete, 'valid required gists did not complete')
        check(state.model.blockCount === 4, 'real DOM SectionTextModel fixture changed')
        if (summaryKind === 'sum') check(sections.length === 1 && sections[0].points.length === 0, 'zero-key sum-only summary failed')
        else check(sections.length === 0 && !state.summary && engine.error, `${summaryKind} cached misleading summary`)
      }
      return { kind, summaryKind, logicalCalls: captures.length, chunks: chunks.length, sections: sections.length, blockCount: state.model.blockCount, fictionSource: engine.fictionSource, error: engine.error?.message }
    } finally { engine.dispose(); window.fetch = original }
  }, { kind, summaryKind })
}

try {
  assert.deepEqual(results.baseline.mismatches, [], 'Frozen snapshot must match before test')
  server = await createServer({ root: readerRoot, cacheDir: resolve(artifacts, 'vite'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'pinia', 'dexie', 'fflate', 'marked', 'yaml'] }, server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`
  const executablePath = [process.env.PAGEWISE_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p))
  assert.ok(executablePath, 'Installed browser required; no download')
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] })
  results.browser = await browser.version()
  if (!staleOnly) {
  await fresh()
  await run('engine-invalid-completion', async () => {
    const details = []
    for (const kind of ['meta', 'missing', 'bad-id', 'ndjson', 'eof', 'length']) details.push(await engineScenario(kind))
    return details
  })
  await run('engine-valid-gists-summary', () => engineScenario('valid'))
  await run('engine-summary-references', async () => {
    const details = []
    for (const kind of ['invalid', 'nonexistent', 'duplicate', 'over3']) details.push(await engineScenario('valid', kind))
    return details
  })
  await run('summary-budget-cache-version', async () => page.evaluate(async () => {
    const check = (v, m) => { if (!v) throw Error('PRODUCTION: ' + m) }
    const { buildSummarySource, PROMPT_VERSION } = await import('/src/services/PagewiseCompanion/prompt.ts')
    const { createMemoryCache, sectionKey } = await import('/src/services/PagewiseCompanion/cache.ts')
    const { PagewiseCompanion } = await import('/src/services/PagewiseCompanion/engine.ts')
    const gists = Array.from({ length: 100 }, (_, i) => 'GIST_' + i + '_' + 'G'.repeat(60)), keys = Array.from({ length: 100 }, (_, i) => 'KEY_' + i + '_' + 'K'.repeat(250))
    const source = buildSummarySource(gists, keys), data = JSON.parse(source.text)
    check(source.text.length <= 3000 && source.text.includes('GIST_99_') && source.text.includes('KEY_99_'), 'summary budget or late samples missing')
    check(data.keys.every((k, i) => k.id === i + 1 && k.text.startsWith('KEY_' + source.keyIndices[i] + '_')), 'summary ID mapping wrong')
    const cache = createMemoryCache(), id = crypto.randomUUID()
    for (const version of ['dj1', 'dj2', PROMPT_VERSION]) {
      await cache.put('chunks', { key: `${id}:${version}`, bookId: id, promptVersion: version, items: [] })
      await cache.put('sections', { key: sectionKey(id, 0, version), bookId: id, section: 0, text: version })
    }
    const engine = new PagewiseCompanion({ bookId: id, book: () => ({}), fictionOverride: () => null,
      uiLang: () => 'en', chapterTitle: () => '', sectionCount: () => 0, sectionLinear: () => false,
      sectionDoc: async () => null, channel: () => null, density: () => 'normal',
      kinds: () => ({ key: true, term: true, note: true }), colors: () => ({}),
      getOverlayer: () => null, concurrency: () => 1, batchPaint: () => true, onChange() {} }, cache)
    try { const found = await engine.bookRecords(); check(found.chunks.length === 1 && found.chunks[0].promptVersion === PROMPT_VERSION && found.sections.length === 1 && found.sections[0].text === PROMPT_VERSION, 'old bookRecords caches reappeared'); return { chars: source.text.length, sampledKeys: data.keys.length, currentChunks: found.chunks.length, currentSections: found.sections.length } } finally { engine.dispose() }
  }))
  await run('six-tabs', async () => {
    await page.goto(origin + '/#/reading')
    await page.evaluate(async () => { (await import('/src/stores/settings.ts')).useSettings().language = 'zh' })
    await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 6)
    const labels = (await page.getByRole('tab').allTextContents()).map(t => t.trim().replace(/\s*\(\d+\)$/, '').trim())
    assert.deepEqual(labels, ['在读', '最近阅读', '想读', '暂缓', '已读', '弃读'])
    await page.screenshot({ path: resolve(artifacts, 'six-tabs.png') }); results.evidence.push('six-tabs.png')
    return labels
  })
  await run('pdf-popup-caller', async () => {
    const src = readFileSync(resolve(readerRoot, 'src/views/PdfReaderView.vue'), 'utf8')
    assert.match(src, /const messages = buildPdfAssistantMessages\(\{\s*title: meta\.value\?\.title \?\? '', author: meta\.value\?\.author, page: s\.page,\s*text: s\.text, question: explainPrompt\(lang\), language: lang,/)
    const data = await page.evaluate(async () => {
      const { buildPdfAssistantMessages } = await import('/src/services/pdfReadingAssistant.ts')
      const messages = buildPdfAssistantMessages({ title: 'PDF_TITLE_ATTACK', author: 'PDF_AUTHOR_ATTACK', page: 7, text: 'PDF_SELECTION_ATTACK', question: 'Explain selection', language: 'en' })
      if (messages[0].content.includes('PDF_TITLE_ATTACK') || messages[0].content.includes('PDF_SELECTION_ATTACK')) throw Error('PRODUCTION: PDF data in policy')
      return JSON.parse(messages.at(-1).content)
    })
    assert.equal(data.document.page, 7); assert.equal(data.excerpt, 'PDF_SELECTION_ATTACK')
    return { selectedPage: data.document.page, scope: 'exact current caller static assertion + real builder browser oracle; actual PDF rendering not exercised' }
  })
  }
  await fresh()
  const bookId = await page.evaluate(async () => {
    const s = (await import('/src/stores/settings.ts')).useSettings()
    s.reader.flow = 'paginated'; s.reader.portraitScroll = false; s.reader.continuousScroll = false
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    const text = Array.from({ length: 180 }, (_, i) => `SYNTHETIC_PARA_${i}. ` + 'SOURCE_IGNORE_POLICY This is synthetic evidence only. '.repeat(18)).join('\n\n') + '\n\nUNSEEN_TAIL_CANARY'
    return storage.addBook({ title: 'TITLE_IGNORE_POLICY', author: 'AUTHOR_ATTACK', fileName: 'synthetic.txt', format: 'txt', tags: [], addedAt: 1 }, new Blob([text], { type: 'text/plain' }))
  })
  await page.goto(`${origin}/#/read/${bookId}`)
  await page.waitForFunction(() => { const v = document.querySelector('.reader')?.__vueParentComponent?.setupState; return v && !v.loading && v.view?.lastLocation?.cfi && v.view?.lastLocation?.range }, undefined, { timeout: 25000 })
  if (!staleOnly) {
  await run('reader-visible-scope', async () => {
    const visible = await page.evaluate(async bookId => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState, range = v.view.lastLocation.range
      const storage = await (await import('/src/storage/index.ts')).getStorage()
      await storage.addAnnotation({ bookId, type: 'highlight', cfi: v.view.lastLocation.cfi, text: range.toString().slice(0, 30), note: 'PRIVATE_NOTE_CANARY_INDEPENDENT', color: 'yellow', createdAt: 1, updatedAt: 1 })
      const stored = await storage.listAnnotations(bookId)
      if (!stored.some(a => a.note === 'PRIVATE_NOTE_CANARY_INDEPENDENT')) throw Error('FIXTURE: note not persisted')
      v.showBars(); v.panel = 'ai'; v.aiInputOpen = true
      return { text: range.toString().trim().slice(0, 6000), cfi: v.view.lastLocation.cfi }
    }, bookId)
    await plan('COMPLETE_REPLY'); await send('What does this visible passage say?')
    const request = await page.evaluate(() => window.__qa.calls.at(-1))
    const data = JSON.parse(request.messages.at(-1).content)
    assert.equal(data.context.kind, 'visible_page'); assert.ok(data.context.text.length > 0 && data.context.text.length <= 6000)
    assert.equal(data.context.text, visible.text)
    for (const canary of ['TITLE_IGNORE_POLICY', 'AUTHOR_ATTACK', 'SOURCE_IGNORE_POLICY']) assert.ok(!request.messages[0].content.includes(canary))
    assert.ok(data.context.text.includes('SOURCE_IGNORE_POLICY'))
    assert.ok(!JSON.stringify(request).includes('UNSEEN_TAIL_CANARY')); assert.ok(!JSON.stringify(request).includes('PRIVATE_NOTE_CANARY_INDEPENDENT'))
    const { complete, draft } = await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState; return { complete: v.aiMessages.at(-1).complete, draft: v.aiInput } })
    assert.equal(complete, true); assert.equal(draft, '')
    await page.screenshot({ path: resolve(artifacts, 'reader-visible.png') }); results.evidence.push('reader-visible.png')
    return { boundedCharacters: data.context.text.length, cfi: visible.cfi, separatelyStoredNote: true, logicalRequests: 1 }
  })
  await run('reader-replies-history', async () => {
    const details = []
    for (const end of ['eof', 'length']) {
      await plan('PARTIAL_' + end, end); await send('Draft_' + end)
      const state = await page.evaluate(() => { const v = document.querySelector('.reader').__vueParentComponent.setupState; return { complete: v.aiMessages.at(-1).complete, text: v.aiMessages.at(-1).content, draft: v.aiInput } })
      assert.equal(state.complete, false); assert.equal(state.text, 'PARTIAL_' + end); assert.equal(state.draft, 'Draft_' + end)
      assert.ok(await page.locator('.ai-msg.assistant .analysis-scope').count())
      await plan('FOLLOWUP_REPLY'); await send('Follow up after ' + end)
      const call = await page.evaluate(() => window.__qa.calls.at(-1))
      assert.ok(call.messages.some(m => m.content === 'COMPLETE_REPLY'))
      assert.ok(!JSON.stringify(call.messages).includes('PARTIAL_' + end)); assert.ok(!JSON.stringify(call.messages).includes('Draft_' + end))
      details.push(state)
    }
    const blank = await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState, loc = v.view.lastLocation, range = loc.range
      loc.range = undefined; window.__qa.plans.push({ text: 'UNAVAILABLE_ACK' })
      await v.sendAi('Missing visible range')
      const call = window.__qa.calls.at(-1); loc.range = range
      return JSON.parse(call.messages.at(-1).content).context
    })
    assert.equal(blank.kind, 'unavailable'); assert.ok(!blank.text)
    return { replies: details, missingContext: blank }
  })
  await run('selection-expansion', async () => {
    const selection = await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      const range = v.view.lastLocation.range.cloneRange(), text = range.toString().slice(0, 60)
      v.selection = { text, range, index: 0, rect: { left: 50, right: 150, top: 100, bottom: 120 } }
      window.__qa.plans.push({ text: 'SELECTION_EXPLANATION' }); v.aiExplainSelection()
      return text
    })
    await page.waitForFunction(() => !document.querySelector('.reader').__vueParentComponent.setupState.aiStreaming)
    let request = await page.evaluate(() => window.__qa.calls.at(-1)), data = JSON.parse(request.messages.at(-1).content)
    assert.equal(data.context.kind, 'selection'); assert.equal(data.context.text, selection)
    assert.ok(!request.messages[0].content.includes('TITLE_IGNORE_POLICY'))
    const expanded = await page.evaluate(() => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState, dj = v.dj
      const section = dj.engine.sections.values().next().value
      if (!section) throw Error('FIXTURE: mounted PagewiseCompanion missing section')
      const block = section.model.sectionBlocks().find(b => b.sentences.some(s => s.includes('SOURCE_IGNORE_POLICY')))?.block
      if (block === undefined) throw Error('FIXTURE: source paragraph missing')
      const sentence = section.model.sentenceTexts(block).findIndex(s => s.includes('SOURCE_IGNORE_POLICY'))
      const start = section.model.sentenceTexts(block)[sentence].indexOf('SOURCE_IGNORE_POLICY')
      const item = { t: 'term', id: 'qa-term', block, sentence, start, end: start + 20, q: 'SOURCE_IGNORE_POLICY', def: 'DEFINITION_ATTACK', r: 2 }
      const range = section.model.sentenceRange(block, sentence)
      dj.card.value = { target: { kind: 'term', section: section.index, item, range, text: 'SOURCE_IGNORE_POLICY' }, rect: { left: 50, right: 150, top: 100, bottom: 120 } }
      window.__qa.plans.push({ text: 'EXPANSION_EXPLANATION' }); dj.expand()
      return section.model.sentenceTexts(block).join('').slice(0, 600)
    })
    await page.waitForFunction(() => !document.querySelector('.reader').__vueParentComponent.setupState.aiStreaming)
    request = await page.evaluate(() => window.__qa.calls.at(-1)); data = JSON.parse(request.messages.at(-1).content)
    assert.equal(data.context.kind, 'paragraph'); assert.equal(data.context.text, expanded)
    assert.equal(data.context.focus.term, 'SOURCE_IGNORE_POLICY'); assert.equal(data.context.focus.explanation, 'DEFINITION_ATTACK')
    assert.ok(!request.messages[0].content.includes('DEFINITION_ATTACK'))
    return { selectionCharacters: selection.length, paragraphCharacters: expanded.length, actualMountedComposable: true }
  })
  await run('translation-card', async () => {
    await page.evaluate(async bookId => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState, dj = v.dj, s = dj.engine.sections.values().next().value
      const settings = (await import('/src/stores/settings.ts')).useSettings()
      // Opt in only this synthetic book; isolate background I/O, not the translation guard.
      window.__qa.backgroundChannel = dj.engine.host.channel
      dj.engine.host.channel = () => null
      settings.pagewiseCompanion.level = 'smart'
      settings.pagewiseCompanion.perBook[bookId] = true
      await Promise.resolve()
      if (!dj.active.value) throw Error('FIXTURE: synthetic Companion consent must be active ' + JSON.stringify({
        level: settings.pagewiseCompanion.level, perBook: settings.pagewiseCompanion.perBook, bookId,
        supported: dj.supported.value, publicationBaseline: v.publicationBaseline, route: location.hash,
      }))
      v.panel = 'none'
      const block = s.model.sectionBlocks().find(b => b.sentences.some(text => text.includes('SOURCE_IGNORE_POLICY')))?.block
      if (block === undefined) throw Error('FIXTURE: translation source paragraph missing')
      const sentence = s.model.sentenceTexts(block).findIndex(text => text.includes('SOURCE_IGNORE_POLICY'))
      const start = s.model.sentenceTexts(block)[sentence].indexOf('SOURCE_IGNORE_POLICY')
      dj.card.value = { target: { kind: 'term', section: s.index, item: { t: 'term', id: 'qa-tr', block, sentence, start, end: start + 20, q: 'SOURCE_IGNORE_POLICY', def: 'DEFINITION_ATTACK', r: 2 }, range: s.model.sentenceRange(block, sentence), text: 'SOURCE_IGNORE_POLICY' }, rect: { left: 100, right: 200, top: 100, bottom: 120 } }
      window.__qa.plans.push({ text: '{"t":"tr","s":"1.1","text":"PARTIAL_TRANSLATION"}\n', end: 'eof' })
    }, bookId)
    const button = page.locator('.dj-card').getByRole('button', { name: 'Translate', exact: true })
    await button.click()
    await page.waitForFunction(() => document.querySelector('.reader').__vueParentComponent.setupState.dj.card.value?.translateError)
    assert.equal(await page.locator('.dj-card-tr').textContent(), 'PARTIAL_TRANSLATION'); assert.equal(await button.isEnabled(), true)
    const failure = await page.locator('.dj-card-muted').textContent(); assert.match(failure, /incomplete|fail/i)
    const call = await page.evaluate(() => window.__qa.calls.at(-1)); assert.ok(!call.messages[0].content.includes('SOURCE_IGNORE_POLICY'))
    assert.ok(JSON.parse(call.messages.at(-1).content).text.includes('SOURCE_IGNORE_POLICY'))
    await page.screenshot({ path: resolve(artifacts, 'translation-incomplete.png') }); results.evidence.push('translation-incomplete.png')
    await plan('{"t":"tr","s":"1.1","text":"SUCCESS_TRANSLATION"}\n'); await button.click()
    await page.waitForFunction(() => document.querySelector('.reader').__vueParentComponent.setupState.dj.card.value?.translation === 'SUCCESS_TRANSLATION')
    assert.equal(await page.evaluate(() => document.querySelector('.reader').__vueParentComponent.setupState.dj.card.value.translateError), false)
    const stale = await page.evaluate(async () => {
      const dj = document.querySelector('.reader').__vueParentComponent.setupState.dj, old = dj.card.value
      dj.card.value = { ...old, translation: undefined }
      window.__qa.plans.push({ text: '{"t":"tr","s":"1.1","text":"STALE_TRANSLATION"}\n', hold: true })
      const pending = dj.translate(); await new Promise(r => setTimeout(r, 20))
      const target = { ...old.target, text: 'NEW_TARGET' }; dj.card.value = { ...old, target, translation: 'NEW_TARGET_TRANSLATION' }
      window.__qa.held.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); window.__qa.held.close(); await pending
      return { text: dj.card.value.target.text, translation: dj.card.value.translation }
    })
    assert.deepEqual(stale, { text: 'NEW_TARGET', translation: 'NEW_TARGET_TRANSLATION' })
    await page.evaluate(async bookId => {
      const dj = document.querySelector('.reader').__vueParentComponent.setupState.dj
      dj.closeCard()
      const settings = (await import('/src/stores/settings.ts')).useSettings()
      settings.pagewiseCompanion.perBook[bookId] = false
      await Promise.resolve()
      dj.engine.host.channel = window.__qa.backgroundChannel
      delete window.__qa.backgroundChannel
    }, bookId)
    return { partialRetained: true, incompleteText: failure, retryEnabled: true, successfulRetryClearsError: true, stale }
  })
  }
  await run('reader-stale-page-close-back', async () => {
    const observed = await page.evaluate(async () => {
      const v = document.querySelector('.reader').__vueParentComponent.setupState
      const snapshot = async () => {
        const text = v.view.lastLocation.range.toString()
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
        return { cfi: v.view.lastLocation.cfi, rangeLength: text.length, rangeSha256: sha, excerpt: text.slice(0, 110) }
      }
      v.panel = 'ai'; v.aiInputOpen = true; v.aiInput = 'STALE_DRAFT_page'
      window.__qa.plans.push({ text: 'BEFORE_page', hold: true })
      const pending = v.sendAi()
      const limit = Date.now() + 5000
      while (!v.aiMessages.at(-1).content && Date.now() < limit) await new Promise(r => setTimeout(r, 10))
      const before = v.aiMessages.at(-1).content, initial = await snapshot()
      document.querySelector('.nav.next').click()
      await new Promise(r => setTimeout(r, 150))
      const openPanelNav = await snapshot()
      document.querySelector('.bar.top [aria-expanded="true"][title="Reading assistant"]').click()
      document.querySelector('.nav.next').click()
      let moved = null, last = '', stable = 0
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
        const at = await snapshot()
        if (at.cfi !== initial.cfi && at.rangeSha256 !== initial.rangeSha256) {
          stable = at.cfi === last ? stable + 1 : 0
          if (stable >= 2) { moved = at; break }
        }
        last = at.cfi
      }
      const preTail = { content: v.aiMessages.at(-1).content, complete: v.aiMessages.at(-1).complete, draft: v.aiInput, panel: v.panel }
      let tailRejectedByCancel = ''
      try { window.__qa.held.enqueue(new TextEncoder().encode(window.__qa.frame('AFTER_page') + 'data: [DONE]\n\n')); window.__qa.held.close() }
      catch (error) { tailRejectedByCancel = String(error) }
      await pending
      const pageResult = { initial, openPanelNav, moved, settled: !!moved, wrapperEntry: 'actual .nav.next DOM click -> ReaderView.turnPage; close via actual toolbar button', preTail, before, after: v.aiMessages.at(-1).content, complete: v.aiMessages.at(-1).complete, draft: v.aiInput, panel: v.panel, tailRejectedByCancel }
      const interruptions = []
      for (const action of ['close', 'back']) {
        v.panel = 'ai'; v.aiInput = `STALE_DRAFT_${action}`
        window.__qa.plans.push({ text: `BEFORE_${action}`, hold: true })
        const request = v.sendAi(), until = Date.now() + 5000
        while (!v.aiMessages.at(-1).content && Date.now() < until) await new Promise(r => setTimeout(r, 10))
        if (action === 'close') document.querySelector('.bar.top [aria-expanded="true"][title="Reading assistant"]').click()
        else { window.__pagewiseReaderBack(); await new Promise(r => setTimeout(r, 50)) }
        let rejected = ''
        try { window.__qa.held.enqueue(new TextEncoder().encode(window.__qa.frame(`AFTER_${action}`) + 'data: [DONE]\n\n')); window.__qa.held.close() }
        catch (error) { rejected = String(error) }
        await request
        interruptions.push({ action, reply: v.aiMessages.at(-1).content, complete: v.aiMessages.at(-1).complete, draft: v.aiInput, panel: v.panel, rejected })
      }
      return { ...pageResult, interruptions, logicalCalls: window.__qa.calls.length }
    })
    writeFileSync(resolve(artifacts, 'stale-confirmed-observed.json'), JSON.stringify(observed, null, 2))
    await page.screenshot({ path: resolve(artifacts, 'stale-confirmation.png') }); results.evidence.push('stale-confirmation.png')
    assert.ok(observed.settled, 'QA-STALE-01 evidence insufficient: real CFI and visible range must change and settle before tail delivery')
    assert.equal(observed.openPanelNav.cfi, observed.initial.cfi, 'ReaderView nav must remain blocked while assistant panel is open')
    assert.equal(observed.after, observed.before, 'PRODUCTION QA-STALE-01: actual toolbar close plus settled actual page turn must prevent stale update')
    assert.equal(observed.complete, false)
    assert.equal(observed.draft, 'STALE_DRAFT_page')
    if (observed.tailRejectedByCancel) assert.match(observed.tailRejectedByCancel, /closed|cancel/i)
    for (const interruption of observed.interruptions) {
      assert.equal(interruption.reply, `BEFORE_${interruption.action}`)
      assert.equal(interruption.complete, false)
      assert.equal(interruption.draft, `STALE_DRAFT_${interruption.action}`)
      assert.equal(interruption.panel, 'none')
      if (interruption.rejected) assert.match(interruption.rejected, /closed|cancel/i)
    }
    return observed
  })
} catch (error) {
  results.error = String(error.stack ?? error); console.error(results.error); process.exitCode = 1
} finally {
  for (const name of (staleOnly ? ['reader-stale-page-close-back'] : cases)) if (!results.cases.some(c => c.name === name)) results.cases.push({ name, status: 'BLOCKED', reason: 'Not executed after earlier blocker; production frozen' })
  await context?.close(); await browser?.close(); await server?.close()
  results.finalSnapshot = reconcile(); results.testSha256 = hash(readFileSync(new URL(import.meta.url)))
  results.stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim()
  results.finished = new Date().toISOString(); results.exitCode = process.exitCode ?? 0
  writeFileSync(resolve(artifacts, staleOnly ? 'stale-confirmation.json' : 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ exitCode: results.exitCode, cases: results.cases.map(({ name, status }) => ({ name, status })), externalCount: results.external.length, finalSnapshot: results.finalSnapshot, staged: results.stagedFiles }))
}
