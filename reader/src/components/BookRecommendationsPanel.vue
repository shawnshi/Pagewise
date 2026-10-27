<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { acquireLibraryCover } from '../services/libraryCovers'
import { getBookRecommendationActions } from '../services/bookRecommendationActions.ts'
import type { RecommendationCard, RecommendationMode, RecommendationResult } from '../services/bookRecommendations.ts'

const props=withDefaults(defineProps<{mode:RecommendationMode;referenceId?:string;initialReply?:{ok:boolean;result?:RecommendationResult;canAddWanted?:boolean;code?:string}}>(),{referenceId:''})
const emit=defineEmits<{navigate:[id:string];writing:[value:boolean];count:[value:number|null]}>()
const settings=useSettings(),library=useLibrary(),actions=getBookRecommendationActions()
const en=computed(()=>settings.language==='en'),tr=(zh:string,english:string)=>en.value?english:zh
const result=ref<RecommendationResult|null>(null),loading=ref(false),aiBusy=ref(false),writing=ref(false),unknown=ref(false),onlyNotStarted=ref(false),confirmClear=ref(false),error=ref(''),notice=ref(''),canAddWanted=ref(false),covers=ref<Record<string,string>>({})
let alive=true,epoch=0,aiEpoch=0,getRequest='',aiRequest=''
const allCards=computed(()=>[...(result.value?.related??[]),...(result.value?.extended??[])])
const busy=computed(()=>loading.value||aiBusy.value||writing.value)
const status=(card:RecommendationCard)=>({unmarked:tr('未标记','Unmarked'),wanted:tr('想读','Want to read'),reading:tr('在读','Reading'),paused:tr('暂缓','Paused'),finished:tr('已读','Finished'),abandoned:tr('弃读','Abandoned'),unknown:tr('状态未知','Status unknown')})[card.book.readingStatus]
const context=()=>JSON.stringify([props.mode,props.referenceId])
function message(code:string):string {
 const messages:Record<string,[string,string]>={
  unconfigured:['请先配置 AI；本地推荐仍可使用。','Configure AI first. Local recommendations remain available.'],
  settings_recovery_required:['设置有待核对或未提交项，请先在设置中处理。','Resolve pending settings changes first.'],
  settings_unavailable:['设置不可用，未把读取错误当作空数据。','Settings are unavailable; this is not empty data.'],
  stale_recommendations:['书目或推荐上下文已变化，请刷新核对。','Book metadata or recommendation context changed. Refresh to check.'],
  book_conflict:['阅读状态或进度已变化，未覆盖；请刷新核对。','Status or progress changed. Nothing was overwritten; refresh to check.'],
  commit_outcome_unknown:['提交结果未知。请先打开详情或设置核对，不要重复提交本次操作。','Save outcome unknown. Check details or settings before any new request; do not replay this operation.'],
  feedback_limit:['推荐负反馈已达上限；可明确清空本功能偏好后再使用。','Recommendation feedback is at capacity. Explicitly clear this feature’s preferences if desired.'],
  feedback_corrupt:['推荐偏好读取异常，未按空偏好处理。可核对或明确清空本功能偏好。','Recommendation preferences could not be read. They were not treated as empty; inspect or explicitly clear this feature’s preferences.'],
  cancelled:['AI 请求已取消，本地理由保留。','AI request cancelled. Local reasons are retained.'],
  timeout:['AI 请求超时，本地理由保留。','AI timed out. Local reasons are retained.'],
  invalid_ai_output:['AI 理由未通过候选与双锚点校验，本地理由保留。','AI reasons failed candidate/anchor validation. Local reasons are retained.'],
  library_limit:['书库超出本轮有界处理上限，未截断后假称完整推荐。','The library exceeds the bounded processing limit; no truncated complete-result claim was made.'],
  busy:['已有操作正在处理，请等待。','An operation is in progress. Please wait.'],
 }
 const pair=messages[code];return pair?pair[en.value?1:0]:tr('推荐操作未完成，请重试或核对配置；未把错误当作空书库。','Recommendation processing failed. Retry or check configuration; errors are not an empty library.')
}
function cancel(discardContext:boolean){
 const token=result.value?.token
 for(const requestId of [getRequest,aiRequest].filter(Boolean))void actions.recommendationsCancel({requestId,...(token?{token}:{}),discardContext})
 if(discardContext&&token&&!getRequest&&!aiRequest)void actions.recommendationsCancel({token,discardContext:true})
 getRequest='';aiRequest=''
}
async function load(refresh=false){
 if(!alive||writing.value)return
 cancel(true);result.value=null;canAddWanted.value=false;const owner=++epoch;aiEpoch++;aiBusy.value=false;loading.value=true;error.value='';notice.value='';confirmClear.value=false;emit('count',null)
 const ownContext=context(),requestId=crypto.randomUUID();getRequest=requestId
 const reply=await actions.recommendationsGet({mode:props.mode,referenceId:props.referenceId||null,language:en.value?'en':'zh',onlyNotStarted:onlyNotStarted.value,requestId,refresh})
 if(!alive||owner!==epoch||ownContext!==context()){if(reply.result)void actions.recommendationsCancel({token:reply.result.token,discardContext:true});return}
 getRequest='';loading.value=false
 if(!reply.ok||!reply.result){error.value=message(reply.code??'recommendations_unavailable');emit('count',null);return}
 result.value=reply.result;canAddWanted.value=reply.canAddWanted===true;emit('count',allCards.value.length)
}
async function explain(){
 if(busy.value||unknown.value||!result.value||!allCards.value.length)return
 const owner=epoch,ownContext=context(),generation=++aiEpoch,token=result.value.token,requestId=crypto.randomUUID();aiRequest=requestId;aiBusy.value=true;error.value=''
 const reply=await actions.recommendationsAi({token,requestId,allowMetadata:true})
 if(!alive||owner!==epoch||generation!==aiEpoch||ownContext!==context())return
 aiRequest='';aiBusy.value=false
 if(!reply.ok||!reply.result){error.value=message(reply.code??'ai_failed');return}
 if(result.value?.token!==token||reply.result.token!==token)return
 const incoming=[...reply.result.related,...reply.result.extended]
 for(const card of allCards.value){const next=incoming.find(c=>c.book.id===card.book.id&&c.sourceId===card.sourceId);if(next){card.reason=next.reason;card.reasonKind=next.reasonKind}}
 notice.value=tr('AI 理由未经事实核验；入选书目仍由本地规则限定。','AI reasons are not fact-checked. Candidate eligibility remains locally constrained.')
}
function cancelAi(){
 if(!aiRequest)return
 void actions.recommendationsCancel({requestId:aiRequest,token:result.value?.token,discardContext:false});aiRequest='';aiEpoch++;aiBusy.value=false;notice.value=message('cancelled')
}
async function mutate(kind:'wanted'|'not-interested'|'unrelated',card:RecommendationCard){
 if(busy.value||unknown.value||!result.value)return
 const owner=epoch,ownContext=context(),token=result.value.token
 writing.value=true;emit('writing',true);error.value='';let reload=false
 try{
  const payload={token,candidateId:card.book.id,requestId:crypto.randomUUID()}
  const reply=kind==='wanted'?await actions.recommendationsWanted(payload):await actions.recommendationsFeedback({...payload,kind})
  if(!alive||owner!==epoch||ownContext!==context())return
  if(!reply.ok){if(reply.code==='commit_outcome_unknown')unknown.value=true;error.value=message(reply.code??'recommendations_unavailable');return}
  if(kind==='wanted'){
    card.book.readingStatus='wanted';const existing=library.books.find(book=>book.id===card.book.id);if(existing)existing.readingStatus='wanted'
    notice.value=tr('已加入想读，未修改阅读进度。','Added to Want to read. Progress was not changed.')
  }else reload=true
 }finally{writing.value=false;emit('writing',false)}
 if(reload&&alive)await load(true)
}
async function clearFeedback(){
 if(busy.value||unknown.value||!confirmClear.value)return
 writing.value=true;emit('writing',true);error.value='';let reload=false
 try{const reply=await actions.recommendationsClearFeedback({confirmClear:true,requestId:crypto.randomUUID()});if(!alive)return;if(!reply.ok){if(reply.code==='commit_outcome_unknown')unknown.value=true;error.value=message(reply.code??'recommendations_unavailable')}else{confirmClear.value=false;reload=true}}
 finally{writing.value=false;emit('writing',false)}
 if(reload&&alive)await load(true)
}
function beforeNavigate(){return !writing.value}
onBeforeRouteLeave(beforeNavigate);onBeforeRouteUpdate(beforeNavigate)
watch(()=>[props.mode,props.referenceId,settings.language],()=>{void load()})
watch(()=>allCards.value.filter(card=>card.book.hasCover).map(card=>card.book.id),(ids,_old,cleanup)=>{
 let active=true;covers.value={};const leases=ids.map(id=>{const lease=acquireLibraryCover(id);void lease.ready.then(url=>{if(active&&url)covers.value[id]=url}).catch(()=>{});return lease})
 cleanup(()=>{active=false;leases.forEach(lease=>lease.release())})
})
onMounted(()=>{
 if(props.initialReply){
  const reply=props.initialReply
  if(reply.ok&&reply.result){result.value=reply.result;canAddWanted.value=reply.canAddWanted===true;emit('count',reply.result.related.length+reply.result.extended.length)}
  else error.value=message(reply.code??'recommendations_unavailable')
 }else void load()
})
onBeforeUnmount(()=>{alive=false;epoch++;aiEpoch++;cancel(true)})
defineExpose({isWriting:()=>writing.value,reload:()=>load(true)})
</script>

<template>
 <section class="book-recommendations" :aria-busy="busy">
  <div class="recommendation-tools">
   <label><input v-model="onlyNotStarted" type="checkbox" :disabled="busy" @change="load(true)">{{ tr('仅看未开始（无应用内阅读记录）','Not started only (no app reading records)') }}</label>
   <button type="button" :disabled="busy" @click="load(true)">{{ tr('刷新推荐','Refresh recommendations') }}</button>
   <button v-if="mode !== 'finish'" type="button" :disabled="busy || unknown" @click="confirmClear = !confirmClear">{{ tr('清空推荐负反馈','Clear recommendation feedback') }}</button>
  </div>
  <div v-if="confirmClear" class="recommendation-confirm" role="group">
   <p>{{ tr('只清空本功能的负反馈，不修改书籍、进度或其他设置。','Clears only recommendation feedback, not books, progress, or other settings.') }}</p>
   <button type="button" :disabled="busy || unknown" @click="clearFeedback">{{ tr('确认清空','Confirm clear') }}</button>
   <button type="button" :disabled="writing" @click="confirmClear = false">{{ tr('取消','Cancel') }}</button>
  </div>
  <p v-if="loading" role="status">{{ tr('正在读取馆藏元数据并计算本地推荐…','Reading library metadata and computing local recommendations…') }}</p>
  <p v-if="error" class="recommendation-message" role="alert">{{ error }}</p>
  <p v-if="notice" class="recommendation-message" role="status">{{ notice }}</p>
  <template v-if="result && !loading">
   <p class="recommendation-basis">{{ result.seedKind === 'recent-reading' ? tr('根据最近有阅读记录的书目','Based on the most recently recorded reading') : result.seedKind === 'marked-reading' ? tr('根据你标记在读的书目','Based on books marked Reading') : result.seedKind === 'recent-added' ? tr('没有阅读上下文，暂按最近入库书目探索','No reading context; exploring from recently added books') : tr('参考当前书目','Using the current book as reference') }}：{{ result.sources.map(source=>source.title).join(' · ') || tr('暂无参考书','No reference book') }}</p>
   <p v-if="!result.sources.length">{{ tr('书库暂无可用上下文。请先导入图书，或从一本书的详情进入推荐。','No usable library context. Import books or open recommendations from book details.') }}</p>
   <section v-for="lane in mode === 'finish' ? (['related'] as const) : (['related','extended'] as const)" :key="lane" class="recommendation-lane">
    <h3>{{ lane === 'related' ? tr('相关阅读','Related reading') : tr('拓展阅读','Extended reading') }} ({{ result[lane].length }})</h3>
    <p v-if="!result[lane].length" class="recommendation-empty">{{ tr('没有足够可靠的馆藏关联；不以弱相关条目凑数。完善分类、主题或简介后可刷新。','No sufficiently grounded library matches. No weak filler. Add categories, topics or descriptions and refresh.') }}</p>
    <div class="recommendation-grid">
     <article v-for="card in result[lane]" :key="card.book.id" class="recommendation-card">
      <div class="recommendation-identity">
       <div class="recommendation-cover" aria-hidden="true"><img v-if="covers[card.book.id]" :src="covers[card.book.id]" alt=""><span v-else>{{ card.book.format.toUpperCase() }}</span></div>
       <div class="recommendation-meta">
        <div class="recommendation-title-row">
          <button type="button" class="recommendation-title" :disabled="writing" @click="emit('navigate', card.book.id)">{{ card.book.title }}</button>
          <span class="recommendation-author">· {{ card.book.author || tr('未知作者','Unknown author') }}</span>
        </div>
        <p class="recommendation-status">{{ status(card) }}<template v-if="card.book.progress != null"> · {{ Math.round(card.book.progress * 100) }}%</template></p>
        <p v-if="card.recordCount > 1">{{ tr('同题名／明确分卷记录','Same-title / explicitly numbered records') }}：{{ card.recordCount }}</p>
       </div>
      </div>
      <p class="recommendation-source">{{ tr('来源','From') }}：《{{ card.sourceTitle }}》</p>
      <p class="recommendation-reason"><span>{{ tr('推荐理由','Recommendation reason') }}：</span>{{ card.reason }} <span v-if="card.reasonKind === 'ai'">{{ tr('〔AI，未核验〕','[AI, unverified]') }}</span></p>
      <div class="recommendation-actions">
       <button type="button" :disabled="writing" @click="emit('navigate', card.book.id)">{{ tr('查看详情','View details') }}</button>
       <button type="button" :disabled="busy || unknown || !canAddWanted || card.book.readingStatus === 'wanted'" @click="mutate('wanted',card)">{{ card.book.readingStatus === 'wanted' ? tr('已在想读','Already wanted') : tr('加入想读','Want to read') }}</button>
       <button type="button" :disabled="busy || unknown" @click="mutate('not-interested',card)">{{ tr('不感兴趣','Not interested') }}</button>
       <button type="button" :disabled="busy || unknown" @click="mutate('unrelated',card)">{{ tr('关联不符','Not related') }}</button>
      </div>
     </article>
    </div>
   </section>
   <div v-if="mode !== 'finish' && allCards.length" class="recommendation-ai">
    <p>{{ tr('本地词项向量与规则不上传数据。下方 AI 操作会向当前服务发送这次参考书与候选书的题名、作者、分类、主题及简介摘要；不发送阅读轨迹、正文或笔记。理由未经事实核验。','Local lexical vectors and rules upload nothing. The AI action sends only this set’s source/candidate titles, authors, categories, topics and description excerpts to your current service, never reading history, book text or notes. Reasons are not fact-checked.') }}</p>
    <button v-if="!aiBusy" type="button" :disabled="busy || unknown" @click="explain">{{ tr('发送书目摘要生成 AI 理由','Send book summaries for AI reasons') }}</button>
    <button v-else type="button" :disabled="writing" @click="cancelAi">{{ tr('取消 AI 请求','Cancel AI request') }}</button>
   </div>
  </template>
 </section>
</template>

<style scoped>
.book-recommendations { min-width: 0; color: inherit; }
.recommendation-tools,.recommendation-actions { display:flex;flex-wrap:wrap;gap:8px;align-items:center; }
.recommendation-tools label {display:flex;align-items:center;gap:8px;min-height:48px;}
button {min-width:48px;min-height:48px;padding:8px 12px;border:1px solid currentColor;border-radius:4px;background:var(--surface,#fff);color:inherit;font:inherit;cursor:pointer;white-space:normal;overflow-wrap:anywhere;}
button:disabled {opacity:.55;cursor:default;}
button:focus-visible,input:focus-visible {outline:2px solid currentColor;outline-offset:3px;}
.recommendation-message,.recommendation-confirm {border-inline-start:3px solid currentColor;padding:8px 12px;}
.recommendation-lane {margin-block:20px;}
h3 {font-size:1.1rem;margin:12px 0;}
.recommendation-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;}
.recommendation-card {border:1px solid currentColor;padding:14px;min-width:0;border-radius:6px;}
.recommendation-identity {display:flex;gap:12px;align-items:flex-start;}
.recommendation-cover {width:64px;min-width:64px;height:88px;border:1px solid currentColor;display:grid;place-items:center;font-size:12px;}
.recommendation-cover img {width:100%;height:100%;object-fit:cover;}
.recommendation-meta {flex:1;min-width:0;}
.recommendation-title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.recommendation-author { font-size: 0.85rem; opacity: 0.75; }
.recommendation-status { font-size: 0.85rem; opacity: 0.8; margin: 2px 0; }
.recommendation-title {border:0;text-align:start;font-weight:600;padding:0;display:inline-block;width:auto;}
p {line-height:1.6;overflow-wrap:anywhere;margin:6px 0;}
.recommendation-source,.recommendation-basis {font-size:.9rem;}
.recommendation-reason {margin-block:12px;}
.recommendation-ai {border-top:1px solid currentColor;padding-block:12px;}
@media (max-width:480px) {.recommendation-actions>button {flex:1 1 calc(50% - 8px);} .recommendation-tools {align-items:stretch;} }
@media (prefers-reduced-motion:reduce) {* {animation:none;transition:none;}}
</style>
