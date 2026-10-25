import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHarness} from './test-book-tag-storage.mjs'
for(const backend of ['DexieStorage','TauriStorage'])test(`${backend}: bounded recommendation projection and status-only CAS preserve metadata, files and CFI`,async()=>{
 const h=await createHarness()
 try{
  const r=await h.page.evaluate(async backend=>{
   const originalNative=window.__nativeSql;window.__nativeSql=(action,payload)=>originalNative(action==='sql.initialize'?'sql.batch':action,payload)
   const {recommendationStatusSnapshot}=await import('/src/services/bookRecommendations.ts')
   const storage=new window.modules[backend]();await storage.init()
   const add=()=>storage.addBook({title:'Synthetic only',author:'Synthetic author',format:'epub',fileName:'synthetic.epub',tags:['keep'],description:'Metadata '.repeat(800),addedAt:1,readingStatus:'unmarked',lastReadAt:7,progress:0.37,location:'synthetic-cfi-to-preserve',readingSeconds:45},new Blob(['Synthetic file body not used as recommendation evidence']),new Blob(['Synthetic cover']))
   const capture=async fn=>{try{await fn();return 'ok'}catch(e){return e.code??e.message}}
   const id=await add(),before=await storage.getBook(id),fileBefore=Array.from(new Uint8Array(await (await storage.getBookFile(id)).arrayBuffer()))
   const projected=await storage.listRecommendationBooks(),projection=projected.find(b=>b.id===id)
   const untouched=await storage.getBook(id)
   await storage.updateBookReadingStatus(id,recommendationStatusSnapshot(before),'wanted')
   const saved=await storage.getBook(id),fileAfter=Array.from(new Uint8Array(await (await storage.getBookFile(id)).arrayBuffer()))
   const conflicts=[]
   for(const field of ['readingStatus','lastReadAt','progress']){
    const bid=await add(),snapshot=recommendationStatusSnapshot(await storage.getBook(bid))
    const update=field==='readingStatus'?'finished':field==='lastReadAt'?99:0.8
    await storage.updateBook(bid,{[field]:update})
    const result=await capture(()=>storage.updateBookReadingStatus(bid,snapshot,'wanted'))
    conflicts.push({field,result,preserved:(await storage.getBook(bid))[field]===update})
   }
   const missing=await add(),missingSnap=recommendationStatusSnapshot(await storage.getBook(missing));await storage.deleteBook(missing)
   const deleted=await capture(()=>storage.updateBookReadingStatus(missing,missingSnap,'wanted'))
   const race=await add(),raceSnap=recommendationStatusSnapshot(await storage.getBook(race))
   const races=await Promise.all([capture(()=>storage.updateBookReadingStatus(race,raceSnap,'wanted')),capture(()=>storage.updateBookReadingStatus(race,raceSnap,'paused'))])
   const legacy=await add()
   if(backend==='TauriStorage')await window.__sql('execute',"UPDATE books SET reading_status='unread' WHERE id=$1",[legacy])
   else await storage.db.books.update(legacy,{readingStatus:'unread'})
   await storage.updateBookReadingStatus(legacy,recommendationStatusSnapshot(await storage.getBook(legacy)),'wanted')
   const invalid=[]
   for(const expected of [{},{readingStatus:'not-real',lastReadAt:7,progress:0.37},{readingStatus:'wanted',lastReadAt:NaN,progress:0.37}])invalid.push(await capture(()=>storage.updateBookReadingStatus(id,expected,'wanted')))
   return {id,before,untouched,projection,saved,fileBefore,fileAfter,conflicts,deleted,races,legacy:(await storage.getBook(legacy)).readingStatus,invalid}
  },backend)
  assert.deepEqual(r.untouched,r.before);assert.deepEqual(r.saved,{...r.before,readingStatus:'wanted'});assert.deepEqual(r.fileAfter,r.fileBefore)
  assert.ok(r.projection.description.length<=2048);assert.equal(r.projection.location,undefined);assert.equal(r.projection.sourceRef,undefined);assert.ok(!Object.hasOwn(r.projection,'file')&&!Object.hasOwn(r.projection,'cover'))
  for(const c of r.conflicts){assert.equal(c.result,'book_conflict');assert.equal(c.preserved,true)}
  assert.equal(r.deleted,'book_conflict');assert.deepEqual(r.races.toSorted(),['book_conflict','ok']);assert.equal(r.legacy,'wanted');assert.ok(r.invalid.every(code=>code==='invalid_payload'))
  h.reopenDatabase()
  const persisted=await h.page.evaluate(async({backend,id})=>{const s=new window.modules[backend]();await s.init();return s.getBook(id)},{backend,id:r.id})
  assert.deepEqual(persisted,r.saved)
 }finally{await h.close()}
})
