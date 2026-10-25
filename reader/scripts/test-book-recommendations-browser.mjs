import assert from 'node:assert/strict'
import {test} from 'node:test'
import {resolve} from 'node:path'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import {createServer} from './vite-isolated.mjs'
const root=resolve(import.meta.dirname,'..'),base=resolve(root,'../.cache/book-recommendations-20261024/browser-'+Date.now())
function tinyPdf(){const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 420] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',null,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 420] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];for(const [i,text] of [[3,'Synthetic PDF first page'],[5,'Synthetic PDF final page']]){const s=`BT /F1 16 Tf 20 360 Td (${text}) Tj ET`;objects[i]=`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`}let out='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${o}\nendobj\n`});const xref=Buffer.byteLength(out);out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(out).toString('base64')}
test('real Web routes, two storage-backed recommendation surfaces, reader boundary and responsive modal', {timeout:160000},async t=>{
 await mkdir(base,{recursive:true});const server=await createServer({root,logLevel:'error',cacheDir:resolve(base,'vite'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();let browser
 const errors=[],network=[]
 try{
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{}),args:['--disable-background-networking']})
  const page=await browser.newPage({viewport:{width:992,height:900},reducedMotion:'reduce'})
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:'||url.protocol==='data:')return route.continue();network.push(url.origin);return route.abort()})
  page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(40000);console.log('BROWSER_EVIDENCE_DIR',base);await page.goto(origin+'/#/library',{waitUntil:'domcontentloaded'});await page.waitForSelector('.library, .page-header, .app-shell',{timeout:30000})
  const ids=await page.evaluate(async pdf=>{
   const {getStorage}=await import('/src/storage/index.ts'),{useLibrary}=await import('/src/stores/library.ts'),{useSettings}=await import('/src/stores/settings.ts')
   const storage=await getStorage(),settings=useSettings();settings.language='zh'
   const cls=(category)=>({version:1,revision:1,category:{value:category,locked:false,source:'manual'},topics:[{value:'复杂系统',locked:false,source:'manual'}],feature:null,facets:{},legacyTags:[]})
   const rows=[['source','computing-ai','Synthetic source author'],['related-one','computing-ai','Related author one'],['related-two','computing-ai','Related author two'],['extended-science','science-mathematics','Science author'],['extended-econ','economics-finance','Economic author']]
   const ids={}
   for(const [key,category,author] of rows){const text=Array.from({length:key==='source'?90:3},(_,i)=>`Synthetic reading paragraph ${i}. Complexity, feedback, and local systems. No private source material.`).join('\n\n');ids[key]=await storage.addBook({title:'合成复杂系统 '+key,author,format:'txt',fileName:key+'.txt',tags:[],addedAt:1,classification:cls(category),description:'Synthetic metadata only',readingStatus:key==='source'?'reading':'unmarked',...(key==='source'?{lastReadAt:100}:{})},new Blob([text],{type:'text/plain'}))}
   const bytes=Uint8Array.from(atob(pdf),c=>c.charCodeAt(0));ids.pdf=await storage.addBook({title:'合成 PDF 复杂系统',author:'Synthetic PDF author',format:'pdf',fileName:'synthetic.pdf',tags:[],addedAt:2,classification:cls('computing-ai'),description:'Synthetic PDF metadata',readingStatus:'unmarked'},new Blob([bytes],{type:'application/pdf'}))
   await useLibrary().refresh();window.__recommendationFixtureIds=ids;return ids
  },tinyPdf())
  await t.test('Reading recommendation tab keeps six reading statuses; cards have grounded reasons and explicit status-only wanted action',async()=>{
   await page.goto(origin+'/#/reading');await page.locator('button').filter({hasText:/^推荐$/}).click();await page.waitForSelector('.recommendation-card')
   assert.ok(await page.locator('.recommendation-card').count()>=3);assert.equal(await page.locator('.recommendation-ai-consent').count(),0)
   const before=await page.evaluate(async()=>{const s=await(await import('/src/storage/index.ts')).getStorage();return s.listBooks()})
   const wanted=page.locator('.recommendation-card button').filter({hasText:'加入想读'}).first();await wanted.click();await page.waitForFunction(()=>!document.querySelector('.book-recommendations')?.getAttribute('aria-busy')||document.querySelector('.book-recommendations')?.getAttribute('aria-busy')==='false')
   const after=await page.evaluate(async()=>{const s=await(await import('/src/storage/index.ts')).getStorage();return s.listBooks()})
   const changed=after.filter(a=>before.find(b=>b.id===a.id)?.readingStatus!==a.readingStatus);assert.equal(changed.length,1);const original=before.find(b=>b.id===changed[0].id);assert.deepEqual(changed[0],{...original,readingStatus:'wanted'})
   await page.screenshot({path:resolve(base,'reading.png')})
  })
  await t.test('Book detail fourth tab is separate and two paths are disjoint',async()=>{
   await page.goto(origin+'/#/book/'+ids.source);await page.locator('button').filter({hasText:'相关与拓展'}).click();await page.waitForSelector('.recommendation-card')
   const text=await page.locator('.book-recommendations').innerText();assert.match(text,/相关阅读/);assert.match(text,/拓展阅读/)
   const cardIds=await page.locator('.recommendation-card').evaluateAll(nodes=>nodes.map(n=>n.textContent));assert.equal(new Set(cardIds).size,cardIds.length)
   await page.screenshot({path:resolve(base,'detail.png')})
  })
  await t.test('real Foliate pagination offers only at structural end, once, without marking Finished; narrow/large-font controls remain reachable',async()=>{
   await page.goto(origin+'/#/read/'+ids.source);await page.waitForFunction(()=>document.querySelector('foliate-view')?.renderer&&document.querySelector('foliate-view')?.lastLocation?.cfi,{timeout:30000})
   assert.equal(await page.locator('.book-end-dialog').count(),0)
   const progress=await page.evaluate(async()=>{const v=document.querySelector('foliate-view');const samples=[];for(let i=0;i<24&&!v.renderer.atEnd;i++){await v.next();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));samples.push({atEnd:v.renderer.atEnd,cfi:!!v.lastLocation?.cfi})}return samples})
   assert.ok(progress.length>0&&progress.at(-1).atEnd,'Synthetic book must actually reach renderer.atEnd')
   await page.waitForSelector('.book-end-dialog',{timeout:15000});await page.waitForFunction(()=>document.querySelector('.book-end-dialog')?.contains(document.activeElement))
   const state=await page.evaluate(async id=>{const s=await(await import('/src/storage/index.ts')).getStorage();return s.getBook(id)},ids.source);assert.notEqual(state.readingStatus,'finished')
   for(const [width,font] of [[320,1],[992,1],[320,1.8]]){
    await page.setViewportSize({width,height:900});await page.evaluate(font=>document.documentElement.style.fontSize=16*font+'px',font)
    const close=page.locator('.book-end-dialog footer button');await close.scrollIntoViewIfNeeded();const box=await close.boundingBox();assert.ok(box&&box.width>=48&&box.height>=48&&box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=901,JSON.stringify(box));await page.screenshot({path:resolve(base,`finish-${width}-${font}.png`)})
   }
   await page.keyboard.press('Escape');await page.waitForSelector('.book-end-dialog',{state:'detached'});await page.evaluate(async()=>{const v=document.querySelector('foliate-view');await v.prev();await v.next()});assert.equal(await page.locator('.book-end-dialog').count(),0)
   await page.evaluate(()=>document.documentElement.style.fontSize='16px');await page.setViewportSize({width:992,height:900})
   await writeFile(resolve(base,'foliate-end-samples.json'),JSON.stringify(progress,null,2))
  })
  await t.test('real PDF last-page paging uses geometric end and does not auto-mark Finished',async()=>{
   await page.evaluate(async()=>{const s=(await import('/src/stores/settings.ts')).useSettings();s.pdf.mode='paged';s.pdf.spreadMode='single';s.pdf.layout='original';s.reader.portraitScroll=false})
   await page.goto(origin+'/#/read-pdf/'+ids.pdf);await page.waitForSelector('.p-holder canvas',{timeout:30000});assert.equal(await page.locator('.book-end-dialog').count(),0)
   await page.evaluate(async()=>{for(let i=0;i<3;i++)await new Promise(r=>requestAnimationFrame(r))})
   const pages=await page.locator('.p-holder').count();assert.ok(pages>=1)
   await page.keyboard.press('ArrowRight');await page.waitForSelector('.book-end-dialog',{timeout:15000})
   const status=await page.evaluate(async id=>{const s=await(await import('/src/storage/index.ts')).getStorage();return (await s.getBook(id)).readingStatus},ids.pdf);assert.notEqual(status,'finished');await page.screenshot({path:resolve(base,'pdf-finish.png')})
  })
  assert.deepEqual(network,[]);assert.deepEqual(errors,[])
 }finally{await writeFile(resolve(base,'browser-errors.json'),JSON.stringify({errors,externalRequests:network},null,2));await browser?.close();await server.close()}
})
