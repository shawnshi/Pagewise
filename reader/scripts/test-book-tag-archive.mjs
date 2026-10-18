import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate'
import { parse, stringify } from 'yaml'
import { createHarness } from './test-book-tag-storage.mjs'

function document(bytes) {
  const text = strFromU8(bytes).replace(/\r\n/g,'\n')
  const end = text.indexOf('\n---\n',4)
  return {meta:parse(text.slice(4,end)),body:text.slice(end+5)}
}
const archive = entries => Array.from(zipSync(entries))

test('manifest and OKF preserve old/new classifications; invalid data rejects before writes; duplicates skip', async () => {
  const h = await createHarness()
  try {
    const bytes = await h.page.evaluate(async () => {
      const {getStorage}=await import('/src/storage/index.ts')
      const {exportBackup}=await import('/src/services/backup.ts')
      const storage=await getStorage()
      const meta={title:'Synthetic class',author:'A',format:'txt',fileName:'a.txt',addedAt:1,tags:['legacy'],publisher:'P',publicationDate:'1900',description:'Synthetic description'}
      const id=await storage.addBook(meta,new Blob(['synthetic content']))
      const draft=window.modules.createClassification(['legacy'])
      draft.category={value:'medicine-health',locked:true,source:'manual'}
      draft.topics=[{value:'中医',locked:true,source:'manual'},{value:'养生',locked:false,source:'ai'}]
      draft.facets={ancientText:true,textbook:false,workCountry:'中国',workPeriod:'古代',audience:'成人'}
      await window.modules.saveBookClassification(storage,await storage.getBook(id),draft)
      await storage.addBook({...meta,title:'Legacy only',fileName:'b.txt'},new Blob(['old content']))
      return Array.from(new Uint8Array(await (await exportBackup()).arrayBuffer()))
    })
    const entries=unzipSync(Uint8Array.from(bytes))
    const manifest=JSON.parse(strFromU8(entries['manifest.json']))
    assert.equal(manifest.version,3)
    const structured=manifest.books.find(book=>book.classification)
    const conceptPath=Object.keys(entries).find(path=>/^books\/[^/]+\.md$/.test(path)&&path!=='books/index.md'&&document(entries[path]).meta.classification)
    assert.ok(conceptPath)
    assert.deepEqual(document(entries[conceptPath]).meta.classification,structured.classification)
    const runImport=async (input,clear=true) => h.page.evaluate(async ({bytes,clear})=>{
      const {getStorage}=await import('/src/storage/index.ts')
      const {importBackup}=await import('/src/services/backup.ts')
      const storage=await getStorage()
      if(clear) for(const book of await storage.listBooks()) await storage.deleteBook(book.id)
      let error
      let result
      try {result=await importBackup(new File([Uint8Array.from(bytes)],'test.zip'))}catch(e){error=String(e)}
      return {result,error,books:await storage.listBooks()}
    },{bytes:input,clear})
    for(const route of ['okf','manifest']) {
      const input={...entries}
      if(route==='manifest') delete input['index.md']
      const restored=await runImport(archive(input))
      assert.equal(restored.error,undefined)
      assert.equal(restored.books.length,2)
      assert.deepEqual(restored.books.find(book=>book.classification).classification,structured.classification)
      assert.deepEqual(restored.books.find(book=>!book.classification).tags,['legacy'])
      const duplicate=await runImport(archive(input),false)
      assert.equal(duplicate.result.books,0)
      assert.equal(duplicate.books.length,2)
      assert.deepEqual(duplicate.books.find(book=>book.classification).classification,structured.classification)
      const bad={...input}
      if(route==='manifest') {
        const value=structuredClone(manifest)
        value.books.find(book=>book.classification).classification.version=99
        bad['manifest.json']=strToU8(JSON.stringify(value))
      } else {
        const doc=document(bad[conceptPath]);doc.meta.classification.category.value='unknown'
        bad[conceptPath]=strToU8(`---\n${stringify(doc.meta)}---\n${doc.body}`)
      }
      const rejected=await runImport(archive(bad))
      assert.ok(rejected.error)
      assert.equal(rejected.books.length,0)
    }
    const oldManifest=structuredClone(manifest)
    oldManifest.version=2
    for(const book of oldManifest.books) delete book.classification
    const oldEntries={...entries,'manifest.json':strToU8(JSON.stringify(oldManifest))}
    delete oldEntries['index.md']
    const old=await runImport(archive(oldEntries))
    assert.equal(old.error,undefined)
    assert.equal(old.books.length,2)
  } finally {await h.close()}
})
