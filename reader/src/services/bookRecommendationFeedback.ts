import { getNativeState, hasNativeState, type JsonObject } from './nativeState.ts'
import { RecommendationError, type RecommendationFeedback } from './bookRecommendations.ts'

const ROOT_KEY = 'bookRecommendationFeedbackV1'
const WEB_PREFIX = 'pagewise.book-recommendation.feedback.v1:'
const LIMIT = 512
export interface RecommendationFeedbackStore { read(): Promise<RecommendationFeedback[]>; put(value:RecommendationFeedback):Promise<void>; clear():Promise<void> }
function validate(raw:unknown):RecommendationFeedback {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecommendationError('feedback_corrupt')
  const r=raw as Record<string,unknown>
  if(Object.keys(r).some(key=>!['candidateId','sourceId','kind','at'].includes(key)))throw new RecommendationError('feedback_corrupt')
  if(typeof r.candidateId!=='string'||!r.candidateId||r.candidateId.length>512||typeof r.sourceId!=='string'||!r.sourceId||r.sourceId.length>512||/[\u0000-\u001f]/u.test(r.candidateId+r.sourceId)||(r.kind!=='not-interested'&&r.kind!=='unrelated')||!Number.isSafeInteger(r.at)||Number(r.at)<0)throw new RecommendationError('feedback_corrupt')
  return {candidateId:r.candidateId,sourceId:r.sourceId,kind:r.kind,at:Number(r.at)}
}
function namespace(raw:unknown,present:boolean):Record<string,RecommendationFeedback> {
  if(!present)return {}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecommendationError('feedback_corrupt')
  const result:Record<string,RecommendationFeedback>={}
  if(Object.keys(raw).length>LIMIT)throw new RecommendationError('feedback_limit')
  for(const [key,value]of Object.entries(raw)){if(!/^[a-f0-9]{64}$/u.test(key))throw new RecommendationError('feedback_corrupt');result[key]=validate(value)}
  return result
}
async function key(value:RecommendationFeedback):Promise<string> {
  const input=JSON.stringify(value.kind==='not-interested'?['global',value.candidateId]:['pair',value.sourceId,value.candidateId])
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input))
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')
}
function webStorage():Storage { return window.localStorage }
/** Native JSON namespace CAS and isolated per-record browser keys: never rewrite other preferences. */
export function createRecommendationFeedbackStore(overrides:Partial<{native:typeof getNativeState;isNative:()=>boolean;web:()=>Storage}>={}):RecommendationFeedbackStore {
  const native=overrides.native??getNativeState,isNative=overrides.isNative??hasNativeState,web=overrides.web??webStorage
  async function nativeValue(){const client=native();await client.refreshSettings();const raw=client.settings();return {client,present:Object.hasOwn(raw,ROOT_KEY),value:raw[ROOT_KEY]}}
  function webKeys(storage:Storage){const keys:string[]=[];for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(WEB_PREFIX))keys.push(k)}return keys}
  return {
    async read(){
      if(isNative()){const {present,value}=await nativeValue();return Object.values(namespace(value,present))}
      const storage=web(),keys=webKeys(storage);if(keys.length>LIMIT)throw new RecommendationError('feedback_limit')
      return keys.map(k=>{if(!/^[a-f0-9]{64}$/u.test(k.slice(WEB_PREFIX.length)))throw new RecommendationError('feedback_corrupt');const raw=storage.getItem(k);if(raw===null)throw new RecommendationError('feedback_read_error');try{return validate(JSON.parse(raw))}catch(error){if(error instanceof RecommendationError)throw error;throw new RecommendationError('feedback_corrupt')}})
    },
    async put(raw){
      const value=validate(raw),id=await key(value)
      if(isNative()){
        const {client,present,value:old}=await nativeValue(),map=namespace(old,present)
        if(!Object.hasOwn(map,id)&&Object.keys(map).length>=LIMIT)throw new RecommendationError('feedback_limit')
        const previous=map[id]
        if(previous?.kind===value.kind&&previous.candidateId===value.candidateId&&previous.sourceId===value.sourceId)return
        const next:JsonObject={}
        for(const [entryId,entry]of Object.entries({...map,[id]:value}))next[entryId]={candidateId:entry.candidateId,sourceId:entry.sourceId,kind:entry.kind,at:entry.at}
        // Whole-namespace CAS also makes the capacity check atomic; a concurrent writer
        // gets a visible conflict, not a lost feedback record or a blind retry.
        await client.patchSettings([{path:[ROOT_KEY],before:present?{present:true,value:old!}:{present:false},after:{present:true,value:next}}])
        return
      }
      const storage=web(),name=WEB_PREFIX+id
      if(storage.getItem(name)===null&&webKeys(storage).length>=LIMIT)throw new RecommendationError('feedback_limit')
      storage.setItem(name,JSON.stringify(value))
    },
    async clear(){
      if(isNative()){
        const {client,present,value}=await nativeValue();if(!present)return
        await client.patchSettings([{path:[ROOT_KEY],before:{present:true,value:value!},after:{present:false}}]);return
      }
      const storage=web();for(const k of webKeys(storage))storage.removeItem(k)
    },
  }
}
