import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness } from './test-book-tag-storage.mjs'

for (const backend of ['DexieStorage', 'TauriStorage']) test(`${backend}: real atomic description CAS, concurrent writers, deletion and rollback`, async () => {
  const h = await createHarness()
  try {
    const result = await h.page.evaluate(async backend => {
      // The older shared harness predates explicit empty-library initialization.
      // Adapt only this task-owned synthetic transport; production still uses sql.initialize.
      const originalNative = window.__nativeSql
      window.__nativeSql = (action,payload) => originalNative(action === 'sql.initialize' ? 'sql.batch' : action,payload)
      const {bookDescriptionSnapshot} = await import('/src/services/bookDescription.ts')
      const storage = new window.modules[backend](); await storage.init()
      const add = async description => storage.addBook({title:'Synthetic title', author:'Synthetic author', publisher:'Synthetic press', publicationDate:'2001-02-03',
        format:'txt', fileName:'synthetic.txt', addedAt:1, tags:['keep'], description, progress:0.37, location:'synthetic-location', readingStatus:'wanted', readingSeconds:120}, new Blob(['Synthetic only']))
      const capture = async fn => {try {await fn();return 'ok'} catch(e) {return e.code??e.message}}
      const id = await add('Original'), original = await storage.getBook(id)
      await storage.updateBookDescription(id, bookDescriptionSnapshot(original), 'Replaced')
      const saved = await storage.getBook(id)
      const conflicts=[]
      for(const key of ['title','author','publisher','publicationDate','description']) {
        const id=await add('Original'), before=await storage.getBook(id)
        await storage.updateBook(id,{[key]:'Concurrent change'})
        const code=await capture(()=>storage.updateBookDescription(id,bookDescriptionSnapshot(before),'Must not overwrite'))
        const after=await storage.getBook(id)
        conflicts.push({key,code,preserved:after[key]==='Concurrent change',description:after.description})
      }
      const raceId=await add('Race source'), snap=bookDescriptionSnapshot(await storage.getBook(raceId))
      const race=await Promise.all([capture(()=>storage.updateBookDescription(raceId,snap,'Race one')),capture(()=>storage.updateBookDescription(raceId,snap,'Race two'))])
      const deleted=await add('Deleted source'), deletedSnapshot=bookDescriptionSnapshot(await storage.getBook(deleted));await storage.deleteBook(deleted)
      const deletion=await capture(()=>storage.updateBookDescription(deleted,deletedSnapshot,'Do not resurrect'))
      const rollbackId=await add('Rollback original'), rollbackSnapshot=bookDescriptionSnapshot(await storage.getBook(rollbackId))
      let rollback
      if(backend==='DexieStorage') {
        const hook=()=>{throw Error('Synthetic transaction failure')};storage.db.books.hook('updating',hook)
        rollback=await capture(()=>storage.updateBookDescription(rollbackId,rollbackSnapshot,'Should roll back'))
        storage.db.books.hook('updating').unsubscribe(hook)
      } else {
        await window.__sql('execute',`CREATE TRIGGER introduction_rollback BEFORE UPDATE OF description ON books BEGIN SELECT RAISE(ABORT,'Synthetic transaction failure'); END`,[])
        rollback=await capture(()=>storage.updateBookDescription(rollbackId,rollbackSnapshot,'Should roll back'))
        await window.__sql('execute','DROP TRIGGER introduction_rollback',[])
      }
      const rollbackDescription=(await storage.getBook(rollbackId)).description
      const invalid=[]
      for(const value of ['', '  ', 'bad\0value', 'x'.repeat(16001)]) invalid.push(await capture(()=>storage.updateBookDescription(id,bookDescriptionSnapshot(saved),value)))
      const missingId=await add(undefined), missing=await storage.getBook(missingId)
      await storage.updateBookDescription(missingId,bookDescriptionSnapshot(missing),'Previously empty')
      return {id,original,saved,conflicts,race,deletion,deletedStillMissing:!(await storage.getBook(deleted)),rollback,rollbackDescription,invalid,missing:(await storage.getBook(missingId)).description}
    }, backend)
    assert.deepEqual(result.saved,{...result.original,description:'Replaced'})
    for(const r of result.conflicts) {assert.equal(r.code,'source_changed');assert.equal(r.preserved,true);assert.equal(r.description,r.key==='description'?'Concurrent change':'Original')}
    assert.deepEqual(result.race.toSorted(),['ok','source_changed']);assert.equal(result.deletion,'source_changed');assert.equal(result.deletedStillMissing,true)
    assert.ok(result.rollback.includes('Synthetic transaction failure'));assert.equal(result.rollbackDescription,'Rollback original')
    assert.ok(result.invalid.every(v=>v!=='ok'));assert.equal(result.missing,'Previously empty')
    h.reopenDatabase()
    const persisted=await h.page.evaluate(async ({backend,id})=>{const s=new window.modules[backend]();await s.init();return s.getBook(id)},{backend,id:result.id})
    assert.deepEqual(persisted,result.saved)
  } finally {await h.close()}
})
