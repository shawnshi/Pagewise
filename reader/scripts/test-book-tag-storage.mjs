import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from './vite-isolated.mjs'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
export async function createHarness() {
  const domain = process.env.BOOK_CLASSIFICATION_MODULE && resolve(process.env.BOOK_CLASSIFICATION_MODULE)
  await access(domain || resolve(root, 'src/services/bookClassification.ts'))
  const temp = await mkdtemp(join(tmpdir(), 'pagewise-tags-'))
  let db = new DatabaseSync(join(temp, 'test.sqlite'))
  const server = await createServer({ root, configFile: false, logLevel: 'error',
    cacheDir: resolve(root, '../.cache/book-tags-vite', crypto.randomUUID()), define: { __APP_VERSION__: '"test"' },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'dexie', 'fflate', 'yaml'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, ...(domain ? [resolve(domain, '..')] : [])] } },
    plugins: [vue(), { name: 'book-tags-test', enforce: 'pre',
      resolveId(source) {
        if (domain && /(?:^|\/)bookClassification(?:\.ts)?$/.test(source)) return domain
        if (source === '@tauri-apps/plugin-sql') return '\0tags-sql'
        if (source === '@tauri-apps/plugin-fs') return '\0tags-fs'
      },
      load(id) {
        if (id === '\0tags-sql') return `export default {load:async()=>({execute:(s,v)=>window.__sql('execute',s,v||[]),select:(s,v)=>window.__sql('select',s,v||[])})}`
        if (id === '\0tags-fs') return `export const BaseDirectory={AppData:1}; export const exists=async()=>true;export const mkdir=async()=>{};export const writeFile=async()=>{};export const readFile=async()=>new Uint8Array([1]);export const remove=async()=>{};`
      },
      configureServer(vite) { vite.middlewares.use((req,res,next) => {
        if (req.url === '/__tags') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>tags</title>') } else next()
      }) },
    }],
  })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({headless:true, ...(process.platform === 'win32' ? {channel:'msedge'} : {}), args:['--disable-background-networking']})
    const context = await browser.newContext({serviceWorkers:'block'})
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    await context.exposeFunction('__sql', (operation, sql, values) => {
      const statement = db.prepare(sql)
      const bindings = Object.fromEntries(values.map((v,i)=>[`$${i+1}`,v]))
      if (operation === 'select') return values.length ? statement.all(bindings) : statement.all()
      if (!values.length) { db.exec(sql); return {rowsAffected:0} }
      return {rowsAffected:Number(statement.run(bindings).changes)}
    })
    const page = await context.newPage()
    await page.goto(`${base}/__tags`)
    await page.evaluate(async () => {
      window.__APP_VERSION__ = 'test'
      window.modules = {...await import('/src/storage/dexie.ts'), ...await import('/src/storage/tauri.ts'),
        ...await import('/src/services/bookTagActions.ts'), ...await import('/src/services/bookClassification.ts')}
    })
    return {page, db, reopenDatabase:()=>{db.close();db=new DatabaseSync(join(temp,'test.sqlite'))}, close:async()=>{await browser.close();await server.close();db.close();await rm(temp,{recursive:true,force:true})}}
  } catch(error) { await browser?.close(); await server.close(); db.close(); await rm(temp,{recursive:true,force:true}); throw error }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  test('actual SQLite JSON1 change-set: revision/metadata gates and statement rollback', async () => {
    const source = await readFile(resolve(root,'src/storage/tauri.ts'),'utf8')
    const sql = source.match(/const result = await this\.db\.execute\(`(\s+WITH changes AS MATERIALIZED[\s\S]*?)`, \[JSON\.stringify\(prepared\)\]\)/)?.[1]
    assert.ok(sql, 'Production atomic statement must be tested')
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT,author TEXT,publisher TEXT,publication_date TEXT,description TEXT,classification TEXT,tags TEXT);
        INSERT INTO books VALUES('a','A','B',NULL,NULL,NULL,NULL,'["old"]'),('b','A','B',NULL,NULL,NULL,NULL,'["old"]');`)
      const classification = {version:1,revision:1,category:null,topics:[],feature:null,facets:{},legacyTags:['old']}
      const make = id => ({id,expectedRevision:0,expectedMetadata:{title:'A',author:'B'},classification,tags:[]})
      const run = changes => db.prepare(sql).run({$1:JSON.stringify(changes)}).changes
      assert.equal(run([make('a'),{...make('b'),expectedRevision:8}]),0)
      assert.equal(run([make('a'),{...make('b'),expectedMetadata:{title:'changed',author:'B'}}]),0)
      assert.equal(run([make('a'),make('missing')]),0)
      assert.ok(db.prepare('SELECT * FROM books').all().every(row=>row.classification===null))
      db.exec("CREATE TRIGGER fail_batch BEFORE UPDATE ON books WHEN new.id='b' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END")
      assert.throws(()=>run([make('a'),make('b')]),/synthetic rollback/)
      assert.ok(db.prepare('SELECT * FROM books').all().every(row=>row.classification===null))
      db.exec('DROP TRIGGER fail_batch')
      assert.equal(run([make('a'),make('b')]),2)
      assert.equal(run([make('a'),make('b')]),0)
    } finally {db.close()}
  })

  for (const backend of ['DexieStorage','TauriStorage']) test(`${backend}: legacy operations retain plain tags`, async () => {
    const h = await createHarness()
    try {
      const result = await h.page.evaluate(async backend => {
        const m = window.modules, storage = new m[backend]()
        await storage.init()
        const id = await storage.addBook({title:'Plain fixture',author:'',format:'txt',fileName:'plain.txt',tags:['old','keep'],addedAt:1},new Blob(['synthetic']))
        await m.mergeLibraryTags(storage,'legacy','old','new')
        return storage.getBook(id)
      }, backend)
      assert.equal(result.classification,undefined)
      assert.deepEqual(result.tags,['new','keep'])
    } finally { await h.close() }
  })

  for (const backend of ['DexieStorage','TauriStorage']) test(`${backend}: first classification save respects deleted legacy tags after reopen and retains CAS`, async () => {
    const h = await createHarness()
    try {
      const result = await h.page.evaluate(async backend => {
        const m = window.modules, storage = new m[backend]()
        await storage.init()
        const id = await storage.addBook({ title:'Legacy deletion', author:'Manual author', format:'txt', fileName:'legacy.txt',
          tags:['Keep legacy','Remove legacy'], progress:0.36, location:'saved-location', addedAt:1 }, new Blob(['Synthetic text']))
        const original = await storage.getBook(id)
        const draft = m.createClassification(original.tags)
        draft.legacyTags = draft.legacyTags.filter(tag => tag !== 'Remove legacy')
        await m.saveBookClassification(storage, original, draft)
        let conflict = false
        try { await m.saveBookClassification(storage, original, draft) } catch { conflict = true }
        return { id, original, conflict }
      }, backend)
      h.reopenDatabase()
      const persisted = await h.page.evaluate(async ({ backend, id }) => {
        const storage = new window.modules[backend](); await storage.init(); return storage.getBook(id)
      }, { backend, id: result.id })
      assert.deepEqual(persisted.classification.legacyTags, ['Keep legacy'])
      assert.deepEqual(result.original.tags, ['Keep legacy','Remove legacy'])
      assert.equal(result.conflict, true)
      assert.equal(persisted.progress, 0.36)
      assert.equal(persisted.location, 'saved-location')
      assert.equal(persisted.classification.revision, 1)
    } finally { await h.close() }
  })

  for (const backend of ['DexieStorage','TauriStorage']) test(`${backend}: mixed atomic changes and plain-to-structured CAS`, async () => {
    const h = await createHarness()
    try {
      const result = await h.page.evaluate(async backend => {
        const m=window.modules, s=new m[backend]();await s.init()
        const meta={title:'Mixed fixture',author:'',format:'txt',fileName:'mixed.txt',tags:['old','keep'],addedAt:1}
        const a=await s.addBook(meta,new Blob(['synthetic'])),b=await s.addBook(meta,new Blob(['synthetic']))
        const draft=m.createClassification(['old','keep']);draft.topics=[{value:'代数',locked:true,source:'manual'}]
        await m.saveBookClassification(s,await s.getBook(a),draft)
        const snapshot=await s.getBook(b), first=await s.getBook(a)
        const next={...first.classification,revision:2}
        const structured=[{id:a,expectedRevision:1,classification:next}]
        let rejected=0
        const reject=async fn=>{try{await fn()}catch{rejected++;return}throw Error('Expected rejection')}
        await reject(()=>s.updateBookClassifications(structured,[{id:b,expectedTags:['wrong'],tags:['new']}]))
        if((await s.getBook(a)).classification.revision!==1)throw Error('Partial mixed write')
        await reject(()=>s.updateBookClassifications(structured,[{id:a,expectedTags:first.tags,tags:['new']}]))
        await s.updateBookClassifications(structured,[{id:b,expectedTags:snapshot.tags,tags:['new','keep']}])
        await reject(()=>m.saveBookClassification(s,snapshot,draft))
        await reject(()=>s.updateBookClassifications([],[{id:a,expectedTags:first.tags,tags:[]}]))
        const merged=await m.mergeLibraryTags(s,'legacy','keep','retained')
        const repeated=await m.mergeLibraryTags(s,'legacy','keep','retained')
        await m.removeLibraryTag(s,'legacy','new')
        return {a:await s.getBook(a),b:await s.getBook(b),rejected,merged,repeated,id:a}
      },backend)
      assert.equal(result.rejected,4);assert.equal(result.merged,2);assert.equal(result.repeated,0)
      assert.deepEqual(result.b.tags,['retained']);assert.equal(result.b.classification,undefined)
      assert.deepEqual(result.a.classification.legacyTags,['old','retained'])
      h.reopenDatabase()
      const reopened=await h.page.evaluate(async ({backend,id})=>{const s=new window.modules[backend]();await s.init();return s.getBook(id)}, {backend,id:result.id})
      assert.deepEqual(reopened,result.a)
    } finally {await h.close()}
  })

  for (const backend of ['DexieStorage','TauriStorage']) test(`${backend}: real commit, rollback, reopen, guarded updates and actions`, async () => {
    const h = await createHarness()
    try {
      const result = await h.page.evaluate(async backend => {
        const m = window.modules
        const storage = new m[backend](); await storage.init()
        const meta = {title:'Synthetic',author:'Author',format:'txt',fileName:'test.txt',addedAt:1,tags:['old'],description:'Evidence',publisher:'P',publicationDate:'2000'}
        const a = await storage.addBook(meta,new Blob(['test']))
        const b = await storage.addBook({...meta,title:'Second'},new Blob(['test']))
        const draft = m.createClassification(meta.tags)
        draft.category = {value:'science-mathematics',locked:true,source:'manual'}
        draft.topics = [{value:'数学',locked:true,source:'manual'},{value:'代数',locked:false,source:'ai'}]
        draft.facets = {audience:'children',textbook:true,ancientText:false,workCountry:'中国',workPeriod:'古代'}
        const original = await storage.getBook(a)
        await m.saveBookClassification(storage,original,draft)
        let rejected=0
        const reject=async fn=>{try{await fn()}catch{rejected++;return}throw Error('Expected rejection')}
        await reject(()=>storage.updateBook(a,{tags:['bypass']}))
        await reject(()=>storage.updateBook(a,{classification:draft}))
        await reject(()=>storage.updateBook(a,{'classification.revision':99}))
        await reject(()=>storage.updateBook(a,{'tags.0':'bypass'}))
        await reject(()=>m.saveBookClassification(storage,original,draft))
        const first=await storage.getBook(a)
        const next={...first.classification,revision:2}
        await reject(()=>storage.updateBookClassifications([{id:a,expectedRevision:1,classification:{...next,revision:5}}]))
        await reject(()=>storage.updateBookClassifications([{id:a,expectedRevision:1,classification:{...next,version:99}}]))
        await reject(()=>storage.updateBookClassifications([{id:a,expectedRevision:1,classification:next},{id:b,expectedRevision:9,classification:{...draft,revision:10}}]))
        if ((await storage.getBook(a)).classification.revision!==1) throw Error('Partial commit')
        await reject(()=>storage.updateBookClassifications([{id:a,expectedRevision:1,expectedMetadata:{title:'raced',author:'Author'},classification:next}]))
        await reject(()=>storage.updateBookClassifications([{id:a,expectedRevision:1,classification:next},{id:a,expectedRevision:1,classification:next}]))
        await storage.updateBook(a,{description:'scanned metadata',progress:0.4})
        const reopened=new m[backend](); await reopened.init()
        const persisted=await reopened.getBook(a)
        await m.mergeLibraryTags(storage,'topic','代数','数学')
        const merged=await storage.getBook(a)
        const repeated=await m.mergeLibraryTags(storage,'topic','代数','数学')
        await m.removeLibraryTag(storage,'topic','数学')
        const removed=await storage.getBook(a)
        await m.clearBookClassifications(storage,[a])
        return {rejected,persisted,merged,repeated,removed,cleared:await storage.getBook(a),second:await storage.getBook(b)}
      }, backend)
      assert.equal(result.rejected,10)
      assert.equal(result.persisted.classification.revision,1)
      assert.equal(result.persisted.classification.facets.textbook,true)
      assert.equal(result.persisted.progress,0.4)
      assert.deepEqual(result.persisted.tags,['自然科学与数学','数学','代数'])
      assert.equal(result.merged.classification.topics.length,1)
      assert.equal(result.merged.classification.topics[0].locked,true)
      assert.equal(result.repeated,0)
      assert.equal(result.removed.classification.topics.length,0)
      assert.deepEqual(result.cleared.classification.legacyTags,['old'])
      assert.deepEqual(result.second.tags,['old'])
    } finally {await h.close()}
  })
}
