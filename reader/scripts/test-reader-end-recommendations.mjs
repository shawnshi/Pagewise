import assert from 'node:assert/strict'
import {test} from 'node:test'
import {registerHooks} from 'node:module'
const stub=code=>({shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(code)})
registerHooks({resolve(source,context,next){
 if(context.parentURL?.endsWith('/useReadingTimer.ts')){
  if(source==='vue')return stub('export const onMounted=f=>globalThis.__timerHarness.mounted.push(f);export const onBeforeUnmount=f=>globalThis.__timerHarness.unmounted.push(f)')
  if(source==='../stores/library')return stub('export const useLibrary=()=>({addReadingTime:(...args)=>globalThis.__timerHarness.credits.push(args)})')
  if(source==='../i18n')return stub('export const t=x=>x')
  if(source==='../services/readingLog.ts')return stub('export const localDay=at=>Math.floor(at/86400000)')
 }
 return next(source,context)
}})
const {createReaderEndRecommendationGate:gate,isPdfDocumentEnd:pdfEnd}=await import('../src/services/readerEndRecommendations.ts')
const {useReadingTimer}=await import('../src/composables/useReadingTimer.ts')
const v=(extra={})=>({bookId:'source',atEnd:false,primary:true,loading:false,unstable:false,navigating:false,inspecting:false,blocked:false,reason:'page',...extra})
test('first position or restored last page is never completion; progress is not an oracle',()=>{
 for(const reason of ['page','scroll','snap','anchor',null]){const g=gate('source');assert.equal(g.observe(v({atEnd:true,reason})),false);assert.equal(g.consume('source',true,false),false)}
 const g=gate('source');assert.equal(g.observe(v({fraction:1,atEnd:false})),false);assert.equal(g.consume('source',false,false),false)
})
test('natural structural arrival offers once; overlays defer, leaving the edge invalidates, dispose and owner fence late results',()=>{
 const g=gate('source');g.observe(v());assert.equal(g.observe(v({atEnd:true,blocked:true})),false);assert.equal(g.pending,true);assert.equal(g.consume('source',true,true),false);assert.equal(g.consume('source',true,false),true);assert.equal(g.observe(v({atEnd:true})),false)
 for(const change of [{atEnd:false},{atEnd:true,navigating:true},{atEnd:true,inspecting:true},{atEnd:true,unstable:true},{atEnd:true,loading:true},{atEnd:true,bookId:'other'}]){const a=gate('source');a.observe(v());a.observe(v({atEnd:true,blocked:true}));a.observe(v(change));assert.equal(a.consume('source',true,false),false,JSON.stringify(change))}
 const a=gate('source');a.observe(v());a.observe(v({atEnd:true,blocked:true}));a.cancelPending();assert.equal(a.consume('source',true,false),false);a.dispose();assert.equal(a.observe(v({atEnd:true})),false)
})
test('restoration, reflow, programmatic jumps, inspection and nonprimary relocation cannot arm an offer',()=>{
 for(const invalid of [{loading:true},{unstable:true},{navigating:true},{inspecting:true},{primary:false}]){const g=gate('source');g.observe(v(invalid));assert.equal(g.observe(v({atEnd:true})),false)}
 for(const reason of ['anchor','navigation','restore','resize',null,undefined]){const g=gate('source');g.observe(v());assert.equal(g.observe(v({atEnd:true,reason})),false)}
 for(const reason of ['page','scroll','snap']){const g=gate('source');g.observe(v());assert.equal(g.observe(v({atEnd:true,reason})),true)}
})
test('PDF boundary requires actual last represented page, rendered canvas and both viewport edges; no fraction shortcut',()=>{
 const viewport={scrollTop:700,clientHeight:300,scrollHeight:1000,scrollLeft:0,clientWidth:600,scrollWidth:600},base={pageCount:10,lastPage:10,rendered:true,viewport}
 assert.equal(pdfEnd(base),true);assert.equal(pdfEnd({...base,lastPage:9}),false);assert.equal(pdfEnd({...base,rendered:false}),false);assert.equal(pdfEnd({...base,viewport:null}),false)
 for(const patch of [{scrollTop:600},{scrollLeft:0,scrollWidth:900},{clientHeight:0},{scrollHeight:Infinity},{clientWidth:NaN}])assert.equal(pdfEnd({...base,viewport:{...viewport,...patch}}),false)
 assert.equal(pdfEnd({...base,viewport:{...viewport,scrollTop:698}}),true);assert.equal(pdfEnd({...base,pageCount:0,lastPage:0}),false)
})
test('real reading clock through composable: recommendation interactions and ticks credit zero, existing credited seconds survive',async()=>{
 const old={window:globalThis.window,document:globalThis.document,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,now:Date.now}
 const h=globalThis.__timerHarness={mounted:[],unmounted:[],credits:[]};let now=1000,active=true,tick
 globalThis.window=new EventTarget();globalThis.document=Object.assign(new EventTarget(),{hidden:false,visibilityState:'visible'})
 globalThis.setInterval=callback=>{tick=callback;return 1};globalThis.clearInterval=()=>{};Date.now=()=>now
 try{
  const timer=useReadingTimer('synthetic-book',{enabled:()=>active});h.mounted.forEach(f=>f());now+=15000;tick()
  active=false
  for(let i=0;i<24;i++){now+=15000;window.dispatchEvent(new Event('pointerdown'));timer.ping();timer.pingAuto();tick()}
  document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'))
  assert.deepEqual(h.credits,[['synthetic-book',15,16000]])
  active=true;document.visibilityState='visible';now+=15000;tick();assert.equal(h.credits.length,1)
  timer.ping();now+=15000;tick();h.unmounted.forEach(f=>f());assert.deepEqual(h.credits.map(row=>row[1]),[15,15])
 }finally{Object.assign(globalThis,{window:old.window,document:old.document,setInterval:old.setInterval,clearInterval:old.clearInterval});Date.now=old.now;delete globalThis.__timerHarness}
})
