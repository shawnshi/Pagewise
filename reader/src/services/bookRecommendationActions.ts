import type { BookMeta, LibraryStorage, BookReadingStatusSnapshot } from '../storage/types.ts'
import { buildRecommendationIndex, rankBookRecommendations, recommendationCorpusKey, recommendationMetadataKey, recommendationSeeds, recommendationStatusSnapshot, RecommendationError, RecommendationStatusConflictError, type RecommendationIndex, type RecommendationResult, type RecommendationMode, type RecommendationLanguage, type RecommendationCard } from './bookRecommendations.ts'
import { createRecommendationFeedbackStore, type RecommendationFeedbackStore } from './bookRecommendationFeedback.ts'
import { generateRecommendationReasons, type RecommendationAiPair, type RecommendationAiReason } from './bookRecommendationAi.ts'

export interface RecommendationReply { ok:boolean; code?:string; result?:RecommendationResult; [key:string]:unknown }
export type RecommendationHandler=(payload:Record<string,unknown>)=>Promise<RecommendationReply>
export type RecommendationActionName='recommendationsGet'|'recommendationsAi'|'recommendationsCancel'|'recommendationsFeedback'|'recommendationsClearFeedback'|'recommendationsWanted'
export type RecommendationActions=Record<RecommendationActionName,RecommendationHandler>
export interface RecommendationDependencies {
  storage():Promise<LibraryStorage>
  feedback:RecommendationFeedbackStore
  ready():Promise<RecommendationReply|undefined>
  ai(pairs:readonly RecommendationAiPair[],language:RecommendationLanguage,signal:AbortSignal):Promise<RecommendationAiReason[]>
  now():number
  token():string
}
interface Session { requestId:string; result:RecommendationResult; books:Map<string,BookMeta>; metadata:Map<string,string>; statuses:Map<string,BookReadingStatusSnapshot>; created:number; writing:boolean; unknown:Set<string> }
const TTL=15*60_000,CAP=32
const valid=(value:unknown,max=512):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/u.test(value)
const fail=(code:string):RecommendationReply=>({ok:false,code})
const code=(error:unknown,fallback='recommendations_unavailable')=>error instanceof RecommendationError?error.code:typeof (error as {code?:unknown})?.code==='string'&&/^[a-z_]{1,64}$/u.test(String((error as {code:string}).code))?String((error as {code:string}).code):fallback
const defaults:RecommendationDependencies={
  storage:async()=> (await import('../storage/index.ts')).getStorage(),feedback:createRecommendationFeedbackStore(),
  ready:async()=>{const {hasNativeState}=await import('./nativeState.ts');if(!hasNativeState())return undefined;const settings=(await import('../stores/settings.ts')).useSettings();const report=await settings.reloadNativeSettings();if(report.unsavedPaths.length||report.failedCommits.length)return fail('settings_recovery_required');await settings.flushNativeSettings();return undefined},
  ai:generateRecommendationReasons,now:Date.now,token:()=>crypto.randomUUID(),
}
async function fingerprint(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')}
function cards(session:Session):RecommendationCard[]{return [...session.result.related,...session.result.extended]}
/** Library/feedback/AI share an ephemeral, book-bound context; no model runs on a plain Get. */
export function createBookRecommendationActions(overrides:Partial<RecommendationDependencies>={}):RecommendationActions {
  const deps={...defaults,...overrides},sessions=new Map<string,Session>(),running=new Map<string,{controller:AbortController;token?:string;kind:'get'|'ai'}>(),writes=new Set<string>()
  let corpus:{key:string;index:RecommendationIndex}|undefined
  function prune(){for(const [key,session]of sessions)if(!session.writing&&deps.now()-session.created>=TTL)sessions.delete(key)}
  function sessionFor(payload:Record<string,unknown>):Session {
    prune();if(!valid(payload.token,128))throw new RecommendationError('invalid_payload')
    const session=sessions.get(payload.token);if(!session)throw new RecommendationError('stale_recommendations');return session
  }
  async function ready(){try{return await deps.ready()}catch{return fail('settings_unavailable')}}
  async function freshPair(session:Session,candidateId:unknown):Promise<{card:RecommendationCard;storage:LibraryStorage;source:BookMeta;target:BookMeta}> {
    if(!valid(candidateId))throw new RecommendationError('invalid_payload')
    const card=cards(session).find(c=>c.book.id===candidateId);if(!card)throw new RecommendationError('invalid_recommendations')
    const storage=await deps.storage(),source=await storage.getBook(card.sourceId),target=await storage.getBook(card.book.id)
    if(!source||!target||source.id!==card.sourceId||target.id!==card.book.id||recommendationMetadataKey(source)!==session.metadata.get(source.id)||recommendationMetadataKey(target)!==session.metadata.get(target.id))throw new RecommendationError('stale_recommendations')
    return {card,storage,source,target}
  }
  const handlers:RecommendationActions = {
    recommendationsGet:async payload=>{
      prune()
      const mode=payload.mode,referenceId=payload.referenceId??null,language=payload.language??'zh',onlyNotStarted=payload.onlyNotStarted??false,requestId=payload.requestId
      if(typeof mode!=='string'||!['reading','detail','finish'].includes(mode)||(referenceId!==null&&!valid(referenceId))||(mode!=='reading'&&referenceId===null)||(typeof language!=='string'||!['zh','en'].includes(language))||typeof onlyNotStarted!=='boolean'||!valid(requestId,128))return fail('invalid_payload')
      if(running.has(requestId)||running.size>=8)return fail('busy')
      if(sessions.size>=CAP)return fail('recommendation_limit')
      const controller=new AbortController();running.set(requestId,{controller,kind:'get'})
      try{
        const blocked=await ready();if(blocked)return blocked;controller.signal.throwIfAborted()
        const storage=await deps.storage(),books=await (storage.listRecommendationBooks?storage.listRecommendationBooks():storage.listBooks())
        const feedback=await deps.feedback.read();controller.signal.throwIfAborted()
        const key=await fingerprint(recommendationCorpusKey(books))
        if(!corpus||corpus.key!==key||payload.refresh===true){const index=await buildRecommendationIndex(books);corpus={key,index}}
        else {for(const book of books){const record=corpus.index.byId.get(book.id);if(record)record.book=book}}
        controller.signal.throwIfAborted()
        const index=corpus.index,seeds=recommendationSeeds(index,mode as RecommendationMode,referenceId as string|null)
        const ranked=rankBookRecommendations(index,seeds.books,{language:language as RecommendationLanguage,onlyNotStarted,relatedLimit:mode==='finish'?4:mode==='reading'?5:6,extendedLimit:mode==='finish'?0:mode==='reading'?5:6,feedback})
        const token=deps.token();if(!valid(token,128)||sessions.has(token))throw new RecommendationError('token_conflict')
        const result:RecommendationResult={token,mode:mode as RecommendationMode,referenceId:referenceId as string|null,seedKind:seeds.kind,sources:seeds.books.map(book=>({id:book.id,title:book.title})),related:ranked.related,extended:ranked.extended,libraryCount:index.count,filteredCount:ranked.filteredCount,language:language as RecommendationLanguage,onlyNotStarted}
        const selected=new Map<string,BookMeta>(),metadata=new Map<string,string>(),statuses=new Map<string,BookReadingStatusSnapshot>()
        for(const card of [...result.related,...result.extended])for(const id of [card.sourceId,card.book.id]){const book=index.byId.get(id)!.book;selected.set(id,book);metadata.set(id,recommendationMetadataKey(book))}
        for(const card of [...result.related,...result.extended])statuses.set(card.book.id,recommendationStatusSnapshot(selected.get(card.book.id)!))
        controller.signal.throwIfAborted();if(sessions.size>=CAP)return fail('recommendation_limit');sessions.set(token,{requestId,result,books:selected,metadata,statuses,created:deps.now(),writing:false,unknown:new Set()})
        return {ok:true,result,canAddWanted:!!storage.updateBookReadingStatus,feedbackCount:feedback.length}
      }catch(error){return fail(controller.signal.aborted?'cancelled':code(error))}
      finally{if(running.get(requestId)?.controller===controller)running.delete(requestId)}
    },
    recommendationsAi:async payload=>{
      if(payload.allowMetadata!==true||!valid(payload.requestId,128))return fail('metadata_consent_required')
      const requestId=payload.requestId
      if([...running.values()].some(r=>r.kind==='ai')||running.has(requestId))return fail('busy')
      const controller=new AbortController();running.set(requestId,{controller,token:typeof payload.token==='string'?payload.token:undefined,kind:'ai'})
      try{
        const session=sessionFor(payload),blocked=await ready();if(blocked)return blocked
        if(session.writing)return fail('busy')
        const pairs:RecommendationAiPair[]=[]
        for(const card of cards(session)){controller.signal.throwIfAborted();pairs.push(await freshPair(session,card.book.id))}
        if(!pairs.length)return fail('no_recommendations')
        controller.signal.throwIfAborted()
        const reasons=await deps.ai(pairs,session.result.language,controller.signal)
        controller.signal.throwIfAborted()
        if(sessions.get(String(payload.token))!==session)return fail('cancelled')
        // Recheck after remote work too; an old explanation must not label a newer book/edition.
        for(const pair of pairs)await freshPair(session,pair.card.book.id)
        controller.signal.throwIfAborted();if(sessions.get(String(payload.token))!==session)return fail('cancelled');if(session.writing)return fail('busy')
        const result={...session.result,related:session.result.related.map(card=>({...card})),extended:session.result.extended.map(card=>({...card}))}
        for(const card of [...result.related,...result.extended]){const reason=reasons.find(item=>item.candidateId===card.book.id&&item.sourceId===card.sourceId);if(!reason)throw new RecommendationError('invalid_ai_output');card.reason=reason.reason;card.reasonKind='ai'}
        session.result=result;return {ok:true,result,unverified:true}
      }catch(error){return fail(controller.signal.aborted?'cancelled':code(error,'ai_failed'))}
      finally{if(running.get(requestId)?.controller===controller)running.delete(requestId)}
    },
    recommendationsCancel:async payload=>{
      if(payload.requestId!==undefined&&!valid(payload.requestId,128)||payload.token!==undefined&&!valid(payload.token,128))return fail('invalid_payload')
      for(const [id,run]of running)if(id===payload.requestId||run.token===payload.token&&payload.token!==undefined){run.controller.abort();running.delete(id)}
      if(payload.discardContext===true)for(const [token,session]of sessions)if((token===payload.token||session.requestId===payload.requestId)&&!session.writing)sessions.delete(token)
      return {ok:true,cancelled:true}
    },
    recommendationsFeedback:async payload=>{
      let session:Session|undefined,submitted=false,acquired=false
      try{
        session=sessionFor(payload);if(payload.kind!=='not-interested'&&payload.kind!=='unrelated')return fail('invalid_payload')
        if(session.writing||writes.has('feedback'))return fail('busy')
        if(session.unknown.has('feedback'))return fail('commit_outcome_unknown')
        acquired=true;session.writing=true;writes.add('feedback')
        const blocked=await ready();if(blocked)return blocked
        const {card}=await freshPair(session,payload.candidateId)
        submitted=true;await deps.feedback.put({candidateId:card.book.id,sourceId:card.sourceId,kind:payload.kind,at:deps.now()})
        return {ok:true,saved:true,candidateId:card.book.id}
      }catch(error){const known=code(error);if(submitted&&!['feedback_limit','feedback_corrupt','feedback_conflict','settings_conflict'].includes(known)){session?.unknown.add('feedback');return fail('commit_outcome_unknown')}return fail(known)}
      finally{if(acquired&&session){session.writing=false;writes.delete('feedback')}}
    },
    recommendationsClearFeedback:async payload=>{
      if(payload.confirmClear!==true)return fail('confirmation_required')
      if(writes.has('feedback'))return fail('busy')
      writes.add('feedback');let submitted=false
      try{const blocked=await ready();if(blocked)return blocked;submitted=true;await deps.feedback.clear();return {ok:true,cleared:true}}
      catch(error){const known=code(error);return fail(submitted&&!['settings_conflict','feedback_conflict'].includes(known)?'commit_outcome_unknown':known)}
      finally{writes.delete('feedback')}
    },
    recommendationsWanted:async payload=>{
      let session:Session|undefined,submitted=false,key='',acquired=false
      try{
        session=sessionFor(payload);if(!valid(payload.candidateId))return fail('invalid_payload');key='wanted:'+payload.candidateId
        if(session.writing||writes.has(key))return fail('busy');if(session.unknown.has(key))return fail('commit_outcome_unknown')
        acquired=true;session.writing=true;writes.add(key)
        const blocked=await ready();if(blocked)return blocked
        const {target,storage}=await freshPair(session,payload.candidateId)
        if(!storage.updateBookReadingStatus)return fail('unsupported_storage')
        if(target.readingStatus==='wanted')return {ok:true,saved:true,candidateId:target.id,alreadyWanted:true}
        const expected=session.statuses.get(target.id);if(!expected)throw new RecommendationError('invalid_recommendations')
        submitted=true;await storage.updateBookReadingStatus(target.id,expected,'wanted')
        for(const card of cards(session))if(card.book.id===target.id)card.book={...card.book,readingStatus:'wanted'}
        return {ok:true,saved:true,candidateId:target.id}
      }catch(error){if(error instanceof RecommendationStatusConflictError||code(error)==='book_conflict')return fail('book_conflict');if(submitted){session?.unknown.add(key);return fail('commit_outcome_unknown')}return fail(code(error))}
      finally{if(acquired&&session){session.writing=false;writes.delete(key)}}
    },
  }
  const allowed:Record<RecommendationActionName,readonly string[]>={recommendationsGet:['mode','referenceId','language','onlyNotStarted','requestId','refresh'],recommendationsAi:['token','requestId','allowMetadata'],recommendationsCancel:['token','requestId','discardContext'],recommendationsFeedback:['token','candidateId','kind','requestId'],recommendationsClearFeedback:['confirmClear','requestId'],recommendationsWanted:['token','candidateId','requestId']}
  return Object.fromEntries(Object.entries(handlers).map(([name,handler])=>[name,async(payload:Record<string,unknown>)=>{
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed[name as RecommendationActionName].includes(key))||(payload.requestId!==undefined&&!valid(payload.requestId,128))||(payload.refresh!==undefined&&typeof payload.refresh!=='boolean')||(payload.discardContext!==undefined&&typeof payload.discardContext!=='boolean'))return fail('invalid_payload')
    return handler(payload)
  }])) as RecommendationActions
}
let shared:RecommendationActions|undefined
export function getBookRecommendationActions():RecommendationActions { return shared??=(createBookRecommendationActions()) }
