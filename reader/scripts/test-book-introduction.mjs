import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
const forbid = () => { throw Error('No outbound networking permitted in introduction tests') }
globalThis.fetch = forbid
http.request = http.get = https.request = https.get = net.connect = net.createConnection = forbid
registerHooks({ resolve(source, context, next) {
  if (source === './ai.ts' && context.parentURL?.endsWith('/bookIntroduction.ts')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export const aiConfigured=()=>false; export async function* chatStream(){throw Error("Unexpected transport")}') }
  if (source.startsWith('.') && context.parentURL?.startsWith('file:') && !extname(source)) {
    const p = fileURLToPath(new URL(source + '.ts', context.parentURL)); if (existsSync(p)) return next(pathToFileURL(p).href, context)
  }
  return next(source, context)
} })
const { BOOK_INTRODUCTION_PROMPT, buildBookIntroductionPrompt, generateBookIntroduction } = await import('../src/services/bookIntroduction.ts')
const { BookDescriptionConflictError, bookDescriptionMatches } = await import('../src/services/bookDescription.ts')
const { createBookIntroductionActions } = await import('../src/services/bookIntroductionActions.ts')
const book = () => ({ id: 'fixture-a', title: '合成书名 {authors}', author: 'Fixture author', publisher: 'Fixture publisher', publicationDate: '2001-02-03', description: 'ORIGINAL_DESCRIPTION_NOT_FOR_MODEL', format: 'epub', fileName: 'fixture.epub', tags: ['retained'], addedAt: 1, progress: 0.37, location: 'fixture-location' })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return { promise, resolve, reject } }
function fixture(overrides = {}) {
  let current = book(), now = 1, counter = 0, writes = 0, attempts = 0, aiCalls = 0
  const storage = { async getBook(id) { return id === current?.id ? structuredClone(current) : undefined }, async updateBookDescription(id, expected, value) {
    attempts++; if (!current || !bookDescriptionMatches(current, expected)) throw new BookDescriptionConflictError()
    writes++; current.description = value
  } }
  const deps = { storage: async () => storage, ready: async () => undefined,
    generate: async () => { aiCalls++; return 'Generated synthetic introduction' }, now: () => now, token: () => 'nonce-' + ++counter, ...overrides }
  return { actions: createBookIntroductionActions(deps), storage, current: () => current, set: v => { current = v }, now: v => {now=v}, counts: () => ({writes, attempts, aiCalls}) }
}
const generate = (a, extra={}) => a.bookIntroductionGenerate({bookId:'fixture-a',requestId:'request-a',...extra})
const save = (a, preview, extra={}) => a.bookIntroductionSave({bookId:'fixture-a',token:preview.token,text:'Edited introduction',confirmReplace:true,...extra})

test('user prompt retains exact framework, 500–800 words, title language, and one-pass metadata substitution', () => {
  const p = buildBookIntroductionPrompt(book(), 'Fixture series')
  assert.ok(p.startsWith('you are a senior literary critic, book publisher, and cultural scholar.'))
  for (const title of ['1. Opening: Era Background & Core Thesis','2. Core Insights: Deep Thought Analysis','3. Author\'s Style & Unique Value','4. Social Impact & Reading Significance','Word count: 500-800 words.','Output language: Please write in the same language as the book title.']) assert.ok(p.includes(title), title)
  assert.ok(p.includes('Title: 合成书名 {authors}\nAuthors: Fixture author'))
  assert.ok(p.includes('Series: Fixture series'))
  assert.ok(buildBookIntroductionPrompt({title:'Title',author:''}).includes('Series: [not provided]'))
  assert.equal(BOOK_INTRODUCTION_PROMPT.match(/\{(?:title|authors|publisher|pubdate|series)\}/g).length, 5)
})
test('invalid bibliographic data is rejected without truncation or invented metadata', () => {
  for (const patch of [{title:''},{title:'a'.repeat(1025)},{author:4},{publisher:'bad\0field'},{publicationDate:'x'.repeat(129)}]) assert.throws(()=>buildBookIntroductionPrompt({...book(),...patch}), e=>e.code==='invalid_metadata')
  assert.throws(()=>buildBookIntroductionPrompt(book(),'a'.repeat(1025)), e=>e.code==='invalid_metadata')
})
test('stream uses existing transport contract, bibliographic fields only, and no automatic persistence', async () => {
  let captured
  const value = await generateBookIntroduction(book(), {series:'Series'}, {configured:()=>true, stream:async function*(messages,signal){ captured=messages;assert.ok(signal instanceof AbortSignal); yield '  First '; yield 'second  ' }})
  assert.equal(value,'First second'); const raw=JSON.stringify(captured)
  for (const secret of [book().description,book().location,book().fileName]) assert.ok(!raw.includes(secret))
  assert.ok(raw.includes('untrusted bibliographic data'));assert.equal(captured.length,2)
})
test('missing configuration and pre-cancellation cause zero transport calls', async () => {
  let calls=0; const deps={configured:()=>false,stream:async function*(){calls++;yield 'bad'}}
  await assert.rejects(generateBookIntroduction(book(),{},deps),e=>e.code==='unconfigured')
  await assert.rejects(generateBookIntroduction(book(),{signal:AbortSignal.abort()},deps),e=>e.code==='cancelled')
  assert.equal(calls,0)
})
test('empty, excessive and provider-error output is bounded and errors are sanitized', async () => {
  for (const [value,code] of [['  ','empty_output'],['x'.repeat(16001),'output_too_long']]) await assert.rejects(generateBookIntroduction(book(),{},{configured:()=>true,stream:async function*(){yield value}}),e=>e.code===code)
  await assert.rejects(generateBookIntroduction(book(),{},{configured:()=>true,stream:async function*(){throw Error('PRIVATE endpoint credential body')}}),e=>e.code==='generation_failed'&&!e.message.includes('PRIVATE'))
})
test('timeout and external abort settle even if a transport ignores AbortSignal', async () => {
  const never={configured:()=>true,stream:async function*(){await new Promise(()=>{});yield 'late'}}
  const result=await Promise.race([generateBookIntroduction(book(),{}, {...never,timeoutMs:5}).then(()=> 'wrong',e=>e.code),new Promise(r=>setTimeout(()=>r('hung'),100))])
  assert.equal(result,'timeout')
  const c=new AbortController();const pending=generateBookIntroduction(book(),{signal:c.signal},never);c.abort()
  assert.equal(await Promise.race([pending.then(()=> 'wrong',e=>e.code),new Promise(r=>setTimeout(()=>r('hung'),100))]),'cancelled')
})
test('generation is preview-only; explicit confirmation is required; only description changes', async () => {
  const f=fixture(), before=structuredClone(f.current()), p=await generate(f.actions)
  assert.equal(p.ok,true);assert.equal(f.counts().writes,0)
  assert.equal((await save(f.actions,p,{confirmReplace:false})).code,'invalid_payload')
  assert.equal((await save(f.actions,p)).saved,true)
  assert.deepEqual(f.current(),{...before,description:'Edited introduction'});assert.equal(f.counts().writes,1)
  assert.equal((await save(f.actions,p)).code,'stale_preview');assert.equal(f.counts().attempts,1)
})
test('preview is book-bound, expires, rejects invalid text, and never falls back to unsafe updateBook', async () => {
  const f=fixture(), p=await generate(f.actions)
  assert.equal((await save(f.actions,p,{bookId:'other'})).code,'stale_preview')
  for (const text of ['', '  ', 'x'.repeat(16001), 'bad\0value']) assert.equal((await save(f.actions,p,{text})).code,'invalid_payload')
  f.now(15*60_000+2);assert.equal((await save(f.actions,p)).code,'stale_preview');assert.equal(f.counts().writes,0)
  const g=fixture({storage:async()=>({getBook:async()=>book(),updateBook:async()=>{throw Error('Unsafe fallback')}})})
  assert.equal((await generate(g.actions)).code,'unsupported_storage')
})
test('cancel during settings readiness or model work discards late output and never saves', async () => {
  for(const stage of ['settings','model']) {
    const gate=deferred(); let calls=0
    const f=fixture(stage==='settings'?{ready:()=>gate.promise,generate:async()=>{calls++;return 'late'}}:{generate:async()=>{calls++;return gate.promise}})
    const p=generate(f.actions);await new Promise(r=>setImmediate(r))
    assert.equal((await f.actions.bookIntroductionCancel({bookId:'fixture-a',requestId:'request-a'})).ok,true)
    gate.resolve(stage==='settings'?undefined:'late')
    assert.equal((await p).code,'cancelled');assert.equal(f.counts().writes,0);assert.equal(calls,stage==='settings'?0:1)
  }
})
test('metadata or description changes after preview cause atomic conflict without overwrite', async () => {
  for (const key of ['title','author','publisher','publicationDate','description']) {
    const f=fixture(), p=await generate(f.actions); f.current()[key]='Concurrent change'
    assert.equal((await save(f.actions,p)).code,'source_changed');assert.equal(f.current()[key],'Concurrent change');assert.equal(f.counts().writes,0)
  }
})
test('unknown commit may have applied once; same proposal cannot be replayed or cancelled as an undo', async () => {
  const f=fixture();f.storage.updateBookDescription=async()=>{f.current().description='Applied before lost ACK';throw Error('PRIVATE failure')}
  const p=await generate(f.actions), r=await save(f.actions,p);assert.equal(r.code,'commit_outcome_unknown');assert.ok(!JSON.stringify(r).includes('PRIVATE'))
  assert.equal((await save(f.actions,p)).code,'commit_outcome_unknown')
  await f.actions.bookIntroductionCancel({bookId:'fixture-a',requestId:'request-a',token:p.token});assert.equal((await save(f.actions,p)).code,'commit_outcome_unknown')
  assert.equal(f.current().description,'Applied before lost ACK')
})
test('one active generation, one save per token and settings commit barrier remain enforced', async () => {
  const gate=deferred(), f=fixture({generate:()=>gate.promise}), pending=generate(f.actions)
  assert.equal((await generate(f.actions,{requestId:'request-b'})).code,'busy');gate.resolve('text');const p=await pending
  const saveGate=deferred();let calls=0;f.storage.updateBookDescription=async()=>{calls++;await saveGate.promise}
  const writing=save(f.actions,p);await new Promise(r=>setImmediate(r));assert.equal((await save(f.actions,p)).code,'busy')
  saveGate.resolve();assert.equal((await writing).saved,true);assert.equal(calls,1)
  for(const ready of [async()=>({ok:false,code:'settings_recovery_required'}),async()=>{throw Error('Private settings failure')}]) {
    const g=fixture({ready});assert.equal((await generate(g.actions)).ok,false);assert.equal(g.counts().aiCalls,0)
  }
})
