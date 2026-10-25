import assert from 'node:assert/strict'
import {test} from 'node:test'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import {extname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {cpus} from 'node:os'
registerHooks({resolve(source,context,next){
 if(source==='./ai.ts'&&context.parentURL?.endsWith('/bookRecommendationAi.ts'))return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export const aiConfigured=()=>false;export async function* chatStream(){throw Error("No real AI permitted")}')}
 if(source.startsWith('.')&&context.parentURL?.startsWith('file:')&&!extname(source)){const p=fileURLToPath(new URL(source+'.ts',context.parentURL));if(existsSync(p))return next(pathToFileURL(p).href,context)}return next(source,context)
}})
globalThis.fetch=()=>{throw Error('No external network in recommendation tests')}
const m=await import('../src/services/bookRecommendations.ts')
const {createRecommendationFeedbackStore}=await import('../src/services/bookRecommendationFeedback.ts')
const ai=await import('../src/services/bookRecommendationAi.ts')
const {createBookRecommendationActions}=await import('../src/services/bookRecommendationActions.ts')
const classification=(category,topics)=>({version:1,revision:1,category:category?{value:category,locked:false,source:'manual'}:null,topics:topics.map(value=>({value,locked:false,source:'manual'})),feature:null,facets:{},legacyTags:[]})
const book=(id,category='computing-ai',topics=['复杂系统'],extra={})=>({id,title:'合成 '+id,author:'Author '+id,format:'epub',fileName:id+'.epub',tags:[],addedAt:1,readingStatus:'unmarked',classification:classification(category,topics),description:'Synthetic metadata',...extra})
const catalogue=()=>[book('source','computing-ai',['复杂系统'],{author:'Same author',lastReadAt:100,readingStatus:'reading'}),book('related','computing-ai',['复杂系统']),book('same-author','history-archaeology',['合成考古'],{author:'Same author'}),book('extended-science','science-mathematics',['复杂系统']),book('extended-econ','economics-finance',['复杂系统']),book('extended-psy','psychology-cognition',['复杂系统']),book('unrelated','arts-design',['绘画技法']),book('unknown',null,[])]
const opts={language:'zh',onlyNotStarted:false,relatedLimit:6,extendedLimit:6,feedback:[]}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
class MemoryStorage {
 map=new Map();get length(){return this.map.size}key(i){return [...this.map.keys()][i]??null}getItem(k){return this.map.get(k)??null}setItem(k,v){this.map.set(k,v)}removeItem(k){this.map.delete(k)}
}
function fixture(extra={}){
 const rows=new Map(catalogue().map(b=>[b.id,structuredClone(b)]));let nonce=0,writes=0,feedbackWrites=0
 const storage={listRecommendationBooks:async()=>structuredClone([...rows.values()]),getBook:async id=>rows.has(id)?structuredClone(rows.get(id)):undefined,updateBookReadingStatus:async(id,expected,status)=>{const current=rows.get(id);if(!current||current.readingStatus!==expected.readingStatus||(current.lastReadAt??null)!==expected.lastReadAt||(current.progress??null)!==expected.progress)throw new m.RecommendationStatusConflictError();writes++;current.readingStatus=status}}
 const records=[];const feedback={read:async()=>structuredClone(records),put:async record=>{feedbackWrites++;records.push(record)},clear:async()=>{records.splice(0)}}
 const deps={storage:async()=>storage,feedback,ready:async()=>undefined,now:()=>1000,token:()=>`context-${++nonce}`,ai:async pairs=>pairs.map(p=>({candidateId:p.target.id,sourceId:p.source.id,reason:'Synthetic verified-pair draft',sourceAnchor:p.source.title,targetAnchor:p.target.title})),...extra}
 return {actions:createBookRecommendationActions(deps),rows,storage,feedback,counts:()=>({writes,feedbackWrites})}
}
const get=(a,extra={})=>a.recommendationsGet({mode:'detail',referenceId:'source',language:'zh',requestId:crypto.randomUUID(),...extra})
const target=reply=>reply.result.related[0].book.id

test('local sparse vectors are bounded nonnegative and lanes have actual evidence, no source/self/unknown-category crossovers',async()=>{
 const books=catalogue(),index=await m.buildRecommendationIndex(books,async()=>{}),result=m.rankBookRecommendations(index,[books[0]],opts)
 assert.ok(index.records.every(r=>r.vector.size<=160&&[...r.vector.values()].every(v=>v>=0&&Number.isFinite(v))))
 assert.ok(result.related.some(c=>c.book.id==='same-author'));assert.ok(result.related.some(c=>c.book.id==='related'))
 assert.ok(result.extended.some(c=>c.book.id==='extended-science'));assert.ok(![...result.related,...result.extended].some(c=>['source','unrelated','unknown'].includes(c.book.id)))
 assert.equal(new Set([...result.related,...result.extended].map(c=>c.book.id)).size,result.related.length+result.extended.length)
 for(const c of result.extended){assert.notEqual(c.evidence.sourceCategory,c.evidence.targetCategory);assert.ok(c.evidence.shared.length);assert.notEqual(c.book.author,books[0].author)}
})
test('empty/small/weak libraries do not fabricate minimum counts or label unknown status as unread',async()=>{
 const empty=await m.buildRecommendationIndex([],async()=>{});assert.deepEqual(m.rankBookRecommendations(empty,[],opts),{related:[],extended:[],filteredCount:0})
 const one=book('source',null,[],{author:'Unknown'});const index=await m.buildRecommendationIndex([one],async()=>{});assert.equal(m.rankBookRecommendations(index,[one],opts).related.length,0)
 assert.equal(m.recommendationNotStarted(book('x',null,[],{readingStatus:undefined,progress:0})),false)
 assert.equal(m.recommendationNotStarted(book('x',null,[],{readingStatus:'wanted',progress:0.1})),false)
 assert.equal(m.recommendationNotStarted(book('x',null,[],{readingStatus:'wanted',lastReadAt:1})),false)
 assert.equal(m.recommendationNotStarted(book('x',null,[],{readingStatus:'wanted'})),true)
 await assert.rejects(m.buildRecommendationIndex([one,one]),e=>e.code==='invalid_library')
 await assert.rejects(m.buildRecommendationIndex(Array(10001).fill(one)),e=>e.code==='library_limit')
})
test('two lanes are mutually exclusive, author-capped, grouped conservatively, and category-diverse',async()=>{
 const books=[...catalogue(),...Array.from({length:8},(_,i)=>book('same-'+i,'computing-ai',['复杂系统'],{author:'Same author'})),book('volume-1','computing-ai',['复杂系统'],{title:'合成明确系列（第1册）',author:'Volume author',publisher:'P'}),book('volume-2','computing-ai',['复杂系统'],{title:'合成明确系列（第2册）',author:'Volume author',publisher:'P'})]
 const index=await m.buildRecommendationIndex(books,async()=>{}),r=m.rankBookRecommendations(index,[books[0]],opts)
 assert.ok(r.related.filter(c=>c.book.author==='Same author').length<=2)
 assert.equal(r.related.filter(c=>c.book.author==='Volume author').length,1);assert.equal(r.related.find(c=>c.book.author==='Volume author').recordCount,2)
 assert.equal(new Set(r.extended.map(c=>c.evidence.targetCategory)).size,3)
 assert.equal(new Set(r.extended.map(c=>c.book.author)).size,r.extended.length)
})
test('global dislike and pair-only unrelated feedback have distinct scope; metadata and state invalidate keys',async()=>{
 const books=catalogue(),index=await m.buildRecommendationIndex(books,async()=>{})
 const r=m.rankBookRecommendations(index,[books[0]],{...opts,feedback:[{kind:'not-interested',candidateId:'related',sourceId:'other',at:1},{kind:'unrelated',candidateId:'extended-econ',sourceId:'source',at:1}]})
 assert.ok(!r.related.some(c=>c.book.id==='related'));assert.ok(!r.extended.some(c=>c.book.id==='extended-econ'))
 const before=m.recommendationCorpusKey(books);books[1].readingStatus='finished';assert.notEqual(m.recommendationCorpusKey(books),before)
 const k=m.recommendationMetadataKey(books[1]);books[1].description='Changed metadata';assert.notEqual(m.recommendationMetadataKey(books[1]),k)
 const reversed=await m.buildRecommendationIndex([...books].reverse(),async()=>{});assert.equal(m.recommendationSeeds(reversed,'reading',null).kind,'recent-reading')
})
test('feedback browser namespace is isolated, durable across instances, explicit-clear only, and corrupt reads are errors',async()=>{
 const storage=new MemoryStorage();storage.setItem('unrelated-settings','preserve')
 const feedback=createRecommendationFeedbackStore({isNative:()=>false,web:()=>storage})
 await feedback.put({candidateId:'b',sourceId:'a',kind:'not-interested',at:1});await feedback.put({candidateId:'c',sourceId:'a',kind:'unrelated',at:2})
 assert.equal((await createRecommendationFeedbackStore({isNative:()=>false,web:()=>storage}).read()).length,2)
 const own=[...storage.map.keys()].find(k=>k.startsWith('pagewise.book-recommendation.'));storage.setItem(own,'{corrupt')
 await assert.rejects(feedback.read(),e=>e.code==='feedback_corrupt');assert.equal(storage.getItem('unrelated-settings'),'preserve')
 await feedback.clear();assert.equal(storage.length,1);assert.equal(storage.getItem('unrelated-settings'),'preserve')
})
test('native feedback updates only its JSON namespace using whole-value CAS, and preserves other settings',async()=>{
 let raw={other:'preserved'},lastPatch
 const client={refreshSettings:async()=>{},settings:()=>structuredClone(raw),patchSettings:async patches=>{lastPatch=patches[0];const p=lastPatch,key=p.path[0],present=Object.hasOwn(raw,key);if(p.before.present!==present||present&&JSON.stringify(raw[key])!==JSON.stringify(p.before.value))throw Object.assign(Error('Conflict'),{code:'settings_conflict'});if(p.after.present)raw[key]=structuredClone(p.after.value);else delete raw[key]}}
 const feedback=createRecommendationFeedbackStore({isNative:()=>true,native:()=>client})
 await feedback.put({candidateId:'b',sourceId:'a',kind:'unrelated',at:1});assert.deepEqual(lastPatch.path,['bookRecommendationFeedbackV1']);assert.equal(raw.other,'preserved');assert.equal((await feedback.read()).length,1)
 raw.bookRecommendationFeedbackV1='corrupt';await assert.rejects(feedback.read(),e=>e.code==='feedback_corrupt');await feedback.clear();assert.deepEqual(raw,{other:'preserved'})
})
test('plain Get uses no AI/write; candidates and source context are book-bound; stale metadata refuses writes',async()=>{
 let aiCalls=0;const f=fixture({ai:async()=>{aiCalls++;throw Error('Forbidden')}}),r=await get(f.actions);assert.equal(r.ok,true);assert.equal(aiCalls,0);assert.deepEqual(f.counts(),{writes:0,feedbackWrites:0})
 assert.equal((await f.actions.recommendationsWanted({token:r.result.token,candidateId:'forged'})).code,'invalid_recommendations')
 f.rows.get(target(r)).title='Concurrent edit';assert.equal((await f.actions.recommendationsWanted({token:r.result.token,candidateId:target(r)})).code,'stale_recommendations');assert.equal(f.counts().writes,0)
})
test('Wanted changes only status, conflicts zero-write, and unknown result cannot replay the same context',async()=>{
 const f=fixture(),r=await get(f.actions),id=target(r),before=structuredClone(f.rows.get(id))
 assert.equal((await f.actions.recommendationsWanted({token:r.result.token,candidateId:id})).ok,true);assert.deepEqual(f.rows.get(id),{...before,readingStatus:'wanted'})
 const g=fixture(),q=await get(g.actions),gid=target(q);g.rows.get(gid).progress=0.5
 assert.equal((await g.actions.recommendationsWanted({token:q.result.token,candidateId:gid})).code,'book_conflict');assert.equal(g.counts().writes,0)
 const h=fixture(),s=await get(h.actions),hid=target(s);let attempts=0;h.storage.updateBookReadingStatus=async()=>{attempts++;throw Error('Lost ACK')}
 assert.equal((await h.actions.recommendationsWanted({token:s.result.token,candidateId:hid})).code,'commit_outcome_unknown');assert.equal((await h.actions.recommendationsWanted({token:s.result.token,candidateId:hid})).code,'commit_outcome_unknown');assert.equal(attempts,1)
})
test('busy calls do not unlock another writer; cancelled Get and AI cannot publish late output',async()=>{
 const f=fixture(),r=await get(f.actions),id=target(r),gate=deferred();let attempts=0;f.storage.updateBookReadingStatus=async()=>{attempts++;await gate.promise}
 const first=f.actions.recommendationsWanted({token:r.result.token,candidateId:id});await new Promise(r=>setImmediate(r))
 assert.equal((await f.actions.recommendationsWanted({token:r.result.token,candidateId:id})).code,'busy');assert.equal((await f.actions.recommendationsWanted({token:r.result.token,candidateId:id})).code,'busy');assert.equal(attempts,1);gate.resolve();assert.equal((await first).ok,true)
 const ready=deferred(),g=fixture({ready:()=>ready.promise}),pending=get(g.actions,{requestId:'cancel-me'})
 await g.actions.recommendationsCancel({requestId:'cancel-me',discardContext:true});ready.resolve();assert.equal((await pending).code,'cancelled')
 const aiGate=deferred(),h=fixture({ai:()=>aiGate.promise}),q=await get(h.actions),generating=h.actions.recommendationsAi({token:q.result.token,requestId:'ai-1',allowMetadata:true});await new Promise(r=>setImmediate(r))
 await h.actions.recommendationsCancel({requestId:'ai-1',token:q.result.token,discardContext:false});aiGate.resolve([]);assert.equal((await generating).code,'cancelled')
 assert.equal((await h.actions.recommendationsWanted({token:q.result.token,candidateId:target(q)})).ok,true)
})
test('AI requires explicit metadata consent; invalid IDs/anchors and provider bodies do not escape',async()=>{
 const f=fixture(),r=await get(f.actions);assert.equal((await f.actions.recommendationsAi({token:r.result.token,requestId:'ai'})).code,'metadata_consent_required')
 const pair={card:r.result.related[0],source:f.rows.get('source'),target:f.rows.get(target(r))};pair.source.location='PRIVATE_CFI';pair.source.readingSeconds=987654
 const messages=ai.recommendationAiMessages([pair],'zh'),serialized=JSON.stringify(messages);assert.ok(!serialized.includes('PRIVATE_CFI'));assert.ok(!serialized.includes('987654'))
 const item={sourceId:pair.source.id,candidateId:pair.target.id,reason:pair.source.title+' 与 '+pair.target.title+' 共享已知的书目线索。',sourceAnchor:pair.source.title,targetAnchor:pair.target.title}
 assert.equal(ai.parseRecommendationAiReasons(JSON.stringify({items:[item]}),[pair]).length,1)
 assert.throws(()=>ai.parseRecommendationAiReasons(JSON.stringify({items:[{...item,candidateId:'invented'}]}),[pair]),e=>e.code==='invalid_ai_output')
 await assert.rejects(ai.generateRecommendationReasons([pair],'zh',undefined,{configured:()=>true,stream:async function*(){throw Error('PRIVATE_PROVIDER_BODY')}}),e=>e.code==='ai_failed'&&!e.message.includes('PRIVATE'))
 const ignored={configured:()=>true,timeoutMs:5,stream:async function*(){await new Promise(()=>{});yield 'late'}}
 await assert.rejects(ai.generateRecommendationReasons([pair],'zh',undefined,ignored),e=>e.code==='timeout')
})
test('TTL/cap and malformed payload gates remain bounded without unsafe storage fallbacks',async()=>{
 let now=1;const f=fixture({now:()=>now}),r=await get(f.actions);now=15*60_000+2;assert.equal((await f.actions.recommendationsWanted({token:r.result.token,candidateId:target(r)})).code,'stale_recommendations')
 for(const payload of [null,[],{mode:'invented'}, {mode:{toString:'not callable'}}, {mode:'detail',referenceId:'source',requestId:'r',extra:true}])assert.equal((await f.actions.recommendationsGet(payload)).ok,false)
 const g=fixture();for(let i=0;i<32;i++)assert.equal((await get(g.actions)).ok,true);assert.equal((await get(g.actions)).code,'recommendation_limit')
 assert.equal((await g.actions.recommendationsClearFeedback({confirmClear:false})).code,'confirmation_required')
})
test('frozen 2243-record host workload records build/rank latency without claiming device targets',async()=>{
 const count=2243,seed=13,categories=['computing-ai','science-mathematics','economics-finance','psychology-cognition']
 const books=Array.from({length:count},(_,i)=>book(`bench-${String(i).padStart(5,'0')}`,categories[(i+seed)%categories.length],['复杂系统','演化机制'],{title:`Synthetic complexity ${i}`,author:`Synthetic author ${i%300}`,lastReadAt:i===0?10:undefined}))
 const started=performance.now(),index=await m.buildRecommendationIndex(books),built=performance.now(),r=m.rankBookRecommendations(index,[books[0]],opts),ranked=performance.now()
 assert.equal(index.count,count);assert.ok(r.related.length<=6&&r.extended.length<=6)
 console.log(JSON.stringify({workload:{books:count,seed,metadataOnly:true},host:{node:process.version,platform:process.platform,cpu:cpus()[0]?.model},buildMs:built-started,rankMs:ranked-built,sampledRssBytes:process.memoryUsage().rss,deviceClaim:false}))
})
