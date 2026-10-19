import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from './vite-isolated.mjs'
import ts from 'typescript'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '../..'), reader = resolve(root, 'reader')
const cache = resolve(root, '.cache/performance-20261019')
test('VAL-LIFECYCLE-001: actual setStyles delayed callbacks ignore destroyed and replaced views', async () => {
  const source = await readFile(resolve(reader, 'src/vendor/foliate/paginator.js'), 'utf8')
  const method = source.slice(source.indexOf('    setStyles(styles) {'), source.indexOf('    focusView()', source.indexOf('    setStyles(styles) {')))
  const frames = [], callbacks = []
  const Paginator = vm.runInNewContext(`(class { #styles; #mode='page'; #view; #styleMap=new Map(); calls=0; columnCount=1;
    #contSetStyles(){} #replaceBackground(){this.calls++}
    constructor(){ this.install() } install(){ this.#view={docBackground:'x',document:{fonts:{ready:{then: cb=>callbacks.push(cb)}}},expand:()=>this.calls++}; this.#styleMap.set(this.#view.document,[{},{}]) }
    destroy(){this.#view=null} ${method} })`, { requestAnimationFrame: cb => frames.push(cb), callbacks })
  for (const replace of [false, true]) {
    const p = new Paginator(); p.setStyles('body{}'); p.destroy(); if (replace) p.install()
    for (const callback of frames.splice(0)) callback()
    for (const callback of callbacks.splice(0)) callback()
    assert.equal(p.calls, 0)
  }
  const p = new Paginator(); p.setStyles('body{}'); frames.shift()(); callbacks.shift()(); assert.equal(p.calls, 2)
})

test('real text Worker preserves EPUB content, isolates UI, bounds reuse and cancels', { timeout: 90000 }, async () => {
  await mkdir(cache, { recursive: true })
  const frozen = resolve('C:/Users/shich/projects/Pagewise/.cache/performance-20261019/baseline/reader/src/services/textToEpub.ts')
  let baseline = ts.transpileModule(await readFile(frozen, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  baseline = baseline.replace(/^import .*;?\r?\n/gm, '').replace(/export /g, '')
  const harness = `<script type="module">
import { convertToEpub, convertToEpubLocal, readTextTitle } from '/reader/src/services/textToEpub.ts';
import { layoutWitness, sameLayoutWitness } from '/reader/src/services/performanceLayout.ts';
import { looksLikeEinkDevice } from '/reader/src/services/readingModes/presets.ts';
import { zipSync, strToU8, unzipSync, strFromU8 } from '/reader/node_modules/fflate/esm/browser.js';
import { marked } from '/reader/node_modules/marked/lib/marked.esm.js'; import { CHAPTER_RE } from '/reader/src/services/smartToc.ts';
import { looksHardWrapped, packSections, toParagraphs } from '/reader/src/services/txtParagraphs.ts';
const baselineConvert=(()=>{${baseline};return convertToEpub})();
window.textHarness={convertToEpub,convertToEpubLocal,readTextTitle,baselineConvert,unzipSync,strFromU8,layoutWitness,sameLayoutWitness,looksLikeEinkDevice};
</script>`
  await writeFile(resolve(cache, 'text-harness.html'), harness)
  let server, browser
  try {
    server = await createServer({ root, configFile: resolve(reader, 'vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 41876, strictPort: true, fs: { allow: [root, realpathSync(resolve(reader, 'node_modules'))] } } })
    await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => { const u = new URL(route.request().url()); return /^https?:$/.test(u.protocol) && u.origin !== 'http://127.0.0.1:41876' ? route.abort() : route.continue() })
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('http://127.0.0.1:41876/.cache/performance-20261019/text-harness.html')
    await page.waitForFunction(() => window.textHarness)
    const receipt = await page.evaluate(async () => {
      const h = window.textHarness, check = (v, m) => { if (!v) throw Error(m) }
      const unpack = async blob => Object.fromEntries(Object.entries(h.unzipSync(new Uint8Array(await blob.arrayBuffer()))).map(([k,v]) => [k,h.strFromU8(v)]))
      const noRead = new Blob(['do not read']); noRead.arrayBuffer = () => { throw Error('metadata read file') }
      check(await h.readTextTitle(noRead, 'Safe.txt', 'txt') === 'Safe', 'TXT title must not read/ZIP')
      const NativeWorker = Worker; let started = 0
      window.Worker = class extends NativeWorker { constructor(...args) { super(...args); started++ } }
      const samples = [], fixtures = ['', '第一章 开始\n中文 & <xml>\n\n第二章 结束\nfinish', Array.from({length:20000},(_,i)=>'paragraph '+i+' '+'word '.repeat(30)).join('\n\n')]
      for (const text of fixtures) {
        const blob = new Blob([text]); const start = performance.now(); const old = await h.baselineConvert(blob,'synthetic.txt','txt'); const oldMs = performance.now()-start
        let beats=0; const timer=setInterval(()=>beats++,2); const now=performance.now(); let next
        try { next=await h.convertToEpub(blob,'synthetic.txt','txt') } finally { clearInterval(timer) }
        const workerMs=performance.now()-now
        check(JSON.stringify(await unpack(old.epub))===JSON.stringify(await unpack(next.epub)), 'EPUB payload changed')
        const count=started; check((await h.convertToEpub(blob,'synthetic.txt','txt')).epub===next.epub,'same Blob not reused'); check(started===count,'cache started worker')
        const fresh=await h.convertToEpub(new Blob([text]),'synthetic.txt','txt'); check(fresh.epub!==next.epub,'new source identity stale reuse')
        if(blob.size>=256*1024) check(started===count+1,'large conversion not off-thread')
        samples.push({bytes:blob.size,oldMs,workerMs,beats})
      }
      const changed = new Blob(['one']); const one=await h.convertToEpub(changed,'one.txt','txt')
      const two=await h.convertToEpub(changed,'two.txt','txt'); check(one.epub!==two.epub && two.title==='two','filename key stale')
      const abort=new AbortController(); const pending=h.convertToEpub(new Blob([fixtures[2]]),'cancel.txt','txt',abort.signal)
      let busy=false; try { await h.convertToEpub(new Blob(['busy']),'busy.txt','txt') } catch(e) { busy=/busy/.test(e.message) }; check(busy,'active worker accepted unbounded concurrency'); abort.abort()
      let cancelled=false; try { await pending } catch(e) { cancelled=e.name==='AbortError' }; check(cancelled,'cancel did not reject')
      window.Worker=class { constructor(){throw Error('synthetic CSP denial')} }; let failed=false
      try { await h.convertToEpub(new Blob([fixtures[2]]),'fail.txt','txt') } catch(e) { failed=/CSP/.test(e.message) }; check(failed,'worker failure silently fell back'); window.Worker=NativeWorker
      for(const md of ['# Heading\n\ntext','preface\n\n# Later','']) {
        const blob=new Blob([md]); const old=await h.baselineConvert(blob,'file.md','md'); check(await h.readTextTitle(blob,'file.md','md')===old.title,'Markdown metadata changed')
        const next=await h.convertToEpub(blob,'file.md','md'); check(JSON.stringify(await unpack(old.epub))===JSON.stringify(await unpack(next.epub)),'Markdown payload changed')
      }
      check(h.looksLikeEinkDevice('Mozilla/5.0 (Linux; Android 12; NoteX3Pro Build/SKQ1)'),'NoteX3Pro missed')
      check(h.looksLikeEinkDevice('Note X3'),'Note X3 missed'); check(!h.looksLikeEinkDevice('Samsung Galaxy Note 3'),'unrelated phone matched')
      const doc=document; const view={lastLocation:{cfi:'a'},renderer:{getContents:()=>[{doc}]}}
      await doc.fonts.ready; const a=h.layoutWitness(view,'r1'); check(h.sameLayoutWitness(a,h.layoutWitness(view,'r1')),'unchanged layout missed')
      check(!h.sameLayoutWitness(a,h.layoutWitness(view,'r2')),'revision reused'); view.lastLocation.cfi='b'; check(!h.sameLayoutWitness(a,h.layoutWitness(view,'r1')),'anchor reused')
      return {samples,negativeAssertions:'source/name/cancel/CSP/anchor/revision passed',metadata:'TXT no-read; Markdown baseline equivalent'}
    })
    assert.deepEqual(errors, []); assert.ok(receipt.samples[2].beats > 0, 'large conversion never yielded UI')
    await writeFile(resolve(cache, 'text-performance.json'), JSON.stringify(receipt,null,2)); console.log(JSON.stringify(receipt))
  } finally { await browser?.close(); await server?.close() }
})
