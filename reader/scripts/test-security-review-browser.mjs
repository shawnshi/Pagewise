import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright'
import {zipSync,strToU8} from 'fflate'
import {createServer,readerRoot} from './vite-isolated.mjs'

const evidence = new URL('../../.cache/audit-stage1/',import.meta.url)
let frozen
try { frozen=JSON.parse(readFileSync(new URL('svg-repair-baseline.json',evidence),'utf8')) }
catch(error){throw new Error('Cannot load actual frozen Foliate baseline',{cause:error})}
for(const name of ['view.js','epubcfi.js','epub.js','fixed-layout.js']){
  const bytes=readFileSync(new URL(`../node_modules/foliate-js/${name}`,import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'),frozen.hashes[`reader/node_modules/foliate-js/${name}`])
}
const book = zipSync({
  mimetype:[strToU8('application/epub+zip'),{level:0}],
  'META-INF/container.xml':strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'book.opf':strToU8('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">review-p1</dc:identifier><dc:title>P1 synthetic fixture</dc:title><dc:language>en</dc:language><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta></metadata><manifest><item id="svg" href="a.svg" media-type="image/svg+xml"/><item id="html" href="a.html" media-type="text/html"/></manifest><spine><itemref id="spine,[]^()" idref="svg"/><itemref idref="html"/></spine></package>'),
  'a.svg':strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 400"><text id="text,[]^()" x="20" y="40">Target text offsets must stay exact.</text><text x="20" y="80">Second SVG text.</text></svg>'),
  'a.html':strToU8('<!doctype html><html><head><title>Metadata</title><meta name="viewport" content="width=700,height=400"><meta name="author" content="benign author"><meta name="description" content="benign description"><script>/* inert legacy fixture */</script><base><link rel="prefetch"><template><p>inert rejected head content</p></template></head><body><p>Hello numeric body anchors.</p><p>Second paragraph.</p></body></html>'),
})
function api({View,opener,CFI}){
  const exact=range=>({text:range.toString(),start:range.startOffset,end:range.endOffset,container:range.startContainer.nodeValue})
  const open=async bytes=>{
    const book=await opener(new File([new Uint8Array(bytes)],'review.epub')),view=new View(),docs=new Map()
    view.addEventListener('load',e=>docs.set(e.detail.index,e.detail.doc));document.body.append(view);await view.open(book)
    await view.renderer.goTo({index:0});await view.renderer.goTo({index:1})
    return{book,view,docs,close(){view.close();view.remove();book.destroy()}}
  }
  const range=(doc,svg,point=false)=>{const node=svg?doc.getElementById('text,[]^()').firstChild:doc.body.querySelector('p').firstChild;const r=doc.createRange();r.setStart(node,svg?3:1);if(point)r.collapse(true);else r.setEnd(node,svg?7:9);return r}
  const withoutIds=cfi=>{let result='',bracket=false,escaped=false;for(const c of cfi){if(bracket){if(escaped)escaped=false;else if(c==='^')escaped=true;else if(c===']')bracket=false}else if(c==='[')bracket=true;else result+=c}return result}
  const detail=r=>({text:r.toString(),collapsed:r.collapsed,start:{type:r.startContainer.nodeType,name:r.startContainer.nodeName,id:r.startContainer.id??null,offset:r.startOffset},end:{type:r.endContainer.nodeType,name:r.endContainer.nodeName,id:r.endContainer.id??null,offset:r.endOffset}})
  const boundaries=(doc,svg)=>{
    const elements=svg?doc.querySelectorAll('text'):doc.body.querySelectorAll('p'),first=elements[0],text=first.firstChild,second=elements[1]
    const make=(a,x,b,y)=>{const r=doc.createRange();r.setStart(a,x);r.setEnd(b,y);return r}
    return [{kind:'empty-start-element-to-text',range:make(first,0,text,5)},{kind:'text-to-next-element',range:make(text,3,second,0)},{kind:'empty-end-upstream-element-offset',range:make(text,3,first,1)}]
  }
  const importedEmptyEnd=(owner,index)=>{
    const doc=owner.docs.get(index),element=index===0?doc.querySelector('text'):doc.body.querySelector('p')
    const a=doc.createRange(),b=doc.createRange();a.setStart(element.firstChild,3);a.collapse(true);b.setStart(element,0);b.collapse(true)
    const local=r=>{const cfi=owner.view.getCFI(index,r);return '/2'+cfi.slice(cfi.indexOf('!')+1,-1)}
    return CFI.fromCalibreHighlight({spine_index:index,start_cfi:local(a),end_cfi:local(b)})
  }
  window.oldAnchors=async bytes=>{
    const owner=await open(bytes),result={base:owner.book.sections[0].cfi,boundaries:[]}
    for(const[k,index,point]of[['point',0,true],['range',0,false],['html',1,false]]){const r=range(owner.docs.get(index),index===0,point),cfi=owner.view.getCFI(index,r);result[k]={cfi,expected:exact(owner.view.resolveCFI(cfi).anchor(owner.docs.get(index)))}}
    for(const index of [0,1])for(const entry of boundaries(owner.docs.get(index),index===0)){const cfi=owner.view.getCFI(index,entry.range);result.boundaries.push({index,kind:entry.kind,cfi,source:detail(entry.range),expected:detail(owner.view.resolveCFI(cfi).anchor(owner.docs.get(index)))})}
    for(const index of [0,1]){const cfi=importedEmptyEnd(owner,index);result.boundaries.push({index,kind:'empty-end-real-upstream-buildRange',cfi,source:'actual fromCalibreHighlight -> private buildRange using real View-generated endpoint CFIs',expected:detail(owner.view.resolveCFI(cfi).anchor(owner.docs.get(index)))})}
    owner.close();return result
  }
  window.reviewCases=async({bytes,old})=>{
    const owner=await open(bytes),html=owner.docs.get(1),r=range(html,false),generated=owner.view.getCFI(1,r)
    html.getSelection().removeAllRanges();html.getSelection().addRange(r)
    let restored,htmlError
    try{restored=exact(owner.view.resolveCFI(old.html.cfi).anchor(html))}catch(error){htmlError=error.message}
    const p1a={generated,old:old.html.cfi,restored,expected:old.html.expected,selection:html.getSelection().toString(),bodyTags:Array.from(html.body.children,n=>n.localName),htmlError,htmlDocument:html.contentType}
    const point=old.point.cfi,prefix=old.base.slice(0,-1),noSpine=point.replace(prefix,'epubcfi(/6/2')
    const malformed=[point.replace('!/2[','!/2[overwritten-id]['),point.replace(':3)',':3:7)'),point.replace(':3)',':3junk)'),point.replace(prefix,'epubcfi(/6/2[nonexistent]'),old.range.cfi.replace(prefix,'epubcfi(/6/2[nonexistent]'),old.base.replace(prefix,'epubcfi(/6/2[nonexistent]')]
    const invalid=[]
    for(const cfi of malformed){let rejected=false,target,error;try{target=exact(owner.view.resolveCFI(cfi).anchor(owner.docs.get(0)))}catch(e){rejected=true;error=e.message}invalid.push({input:cfi,rejected,target,error})}
    const valid=[point,noSpine,withoutIds(point),point.replace(':3)',':3[before,after;s=b])'),point.replace(':3)',':3~1.5@2:3)'),old.range.cfi]
    const validResults=valid.map(cfi=>{const target=exact(owner.view.resolveCFI(cfi).anchor(owner.docs.get(0)));return{input:cfi,target,expected:cfi===old.range.cfi?old.range.expected:old.point.expected}})
    const unchanged={point:owner.view.getCFI(0,range(owner.docs.get(0),true,true)),range:owner.view.getCFI(0,range(owner.docs.get(0),true))}
    const numeric=withoutIds(point),matrix=[]
    for(const value of [0,1,999])for(const [kind,input]of [['spine-root',numeric.replace('/6/','/6:'+value+'/')],['spine-item',numeric.replace('/2!','/2:'+value+'!')],['local-even-nonterminal',numeric.replace('!/2/','!/2:'+value+'/')],['local-even-terminal',numeric.replace('!/2/1:3)','!/2:'+value+')')]])matrix.push({kind,input})
    for(const [kind,input]of [['spine-temporal',numeric.replace('/2!','/2~0!')],['local-temporal-nonterminal',numeric.replace('!/2/','!/2~1/')],['local-spatial-nonterminal',numeric.replace('!/2/','!/2@2:3/')],['local-side-nonterminal',numeric.replace('!/2/','!/2[;s=b]/')],['text-step-nonterminal',numeric.replace('/1:3)','/1:0/2)')],['qualified-range-parent','epubcfi(/6/2!/2/1:0,,/1:5)']])matrix.push({kind,input})
    for(const item of matrix){try{item.target=detail(owner.view.resolveCFI(item.input).anchor(owner.docs.get(0)));item.rawRejected=false}catch(error){item.error=error.message;item.rawRejected=error.message==='Invalid raw CFI syntax'}}
    const boundaryResults=[]
    for(const oldBoundary of old.boundaries){const entry=boundaries(owner.docs.get(oldBoundary.index),oldBoundary.index===0).find(x=>x.kind===oldBoundary.kind);let actual,error;try{actual=detail(owner.view.resolveCFI(oldBoundary.cfi).anchor(owner.docs.get(oldBoundary.index)))}catch(e){error=e.message}boundaryResults.push({...oldBoundary,canonical:entry?owner.view.getCFI(oldBoundary.index,entry.range):importedEmptyEnd(owner,oldBoundary.index),actual,error})}
    owner.close();return{p1a,invalid,validResults,unchanged,matrix,boundaryResults}
  }
  window.ready=true
}
test('P1 head reparse preserves old numeric HTML CFIs; raw malformed SVG/spine input rejects', {timeout:90000}, async()=>{
  let server,browser
  try{
    const plugin={name:'review-p1-production-oracle',resolveId(id){if(id==='/p1-old.js'||id==='/p1-new.js')return'\0'+id},load(id){if(!['\0/p1-old.js','\0/p1-new.js'].includes(id))return;const secure=id.includes('new');return`import{View,makeBook}from'foliate-js/view.js';import*as CFI from'foliate-js/epubcfi.js';${secure?"import{makeFoliateBook}from'/src/services/foliateBook.ts';":''}(${api.toString()})({View,CFI,opener:${secure?'makeFoliateBook':'makeBook'}});`}}
    server=await createServer({root:readerRoot,cacheDir:'../.cache/audit-stage1/final-cfi-repair/vite',plugins:[plugin],logLevel:'error',server:{host:'127.0.0.1',port:4423,strictPort:true}});await server.listen()
    browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({serviceWorkers:'block',viewport:{width:930,height:1240}}),remote=[],errors=[]
    await context.route('**/*',route=>{const u=new URL(route.request().url());if(/^https?:$/.test(u.protocol)&&u.origin!=='http://127.0.0.1:4423'){remote.push(u.href);return route.abort()}return route.continue()})
    const page=async mode=>{const p=await context.newPage();p.on('pageerror',e=>errors.push(e.stack??e.message));await p.route(`**/${mode}.html`,route=>route.fulfill({contentType:'text/html',body:`<style>foliate-view{display:block;width:930px;height:1240px}</style><script type="module" src="/p1-${mode}.js"></script>`}));await p.goto(`http://127.0.0.1:4423/${mode}.html`);await p.waitForFunction(()=>window.ready);return p}
    const oldPage=await page('old'),old=await oldPage.evaluate(bytes=>oldAnchors(bytes),Array.from(book)),newPage=await page('new'),result=await newPage.evaluate(input=>reviewCases(input),{bytes:Array.from(book),old})
    console.log(JSON.stringify({old,result,remote,errors},null,2))
    assert.equal(result.matrix.every(x=>x.rawRejected),true,'mutation matrix must reject before normalization')
    for(const entry of result.boundaryResults){assert.equal(entry.canonical,entry.cfi);assert.deepEqual(entry.actual,entry.expected)}
    assert.equal(result.p1a.htmlDocument,'text/html');assert.equal(result.p1a.generated,old.html.cfi);assert.deepEqual(result.p1a.restored,old.html.expected);assert.equal(result.p1a.selection,old.html.expected.text);assert.deepEqual(result.p1a.bodyTags,['p','p'])
    assert.equal(result.invalid.every(x=>x.rejected),true,'raw malformed offsets and asserted spine mismatches must reject')
    for(const item of result.validResults)assert.deepEqual(item.target,item.expected)
    assert.deepEqual(result.unchanged,{point:old.point.cfi,range:old.range.cfi});assert.deepEqual(remote,[]);assert.deepEqual(errors,[])
  }finally{await browser?.close();await server?.close()}
})
