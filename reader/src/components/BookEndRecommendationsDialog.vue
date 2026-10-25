<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useSettings } from '../stores/settings'
import { getBookRecommendationActions } from '../services/bookRecommendationActions.ts'
import type { RecommendationResult } from '../services/bookRecommendations.ts'
import BookRecommendationsPanel from './BookRecommendationsPanel.vue'
const props=defineProps<{modelValue:boolean;bookId:string}>()
const emit=defineEmits<{'update:modelValue':[value:boolean];navigate:[id:string]}>()
const settings=useSettings(),panel=ref<InstanceType<typeof BookRecommendationsPanel>|null>(null),root=ref<HTMLElement|null>(null),writing=ref(false),closeButton=ref<HTMLButtonElement|null>(null)
const en=computed(()=>settings.language==='en'),tr=(zh:string,english:string)=>en.value?english:zh
const actions=getBookRecommendationActions(),visible=ref(false),initialReply=ref<{ok:boolean;result?:RecommendationResult;canAddWanted?:boolean;code?:string}>()
let previousFocus:HTMLElement|null=null,epoch=0,requestId=''
function cancel(){
 const payload={...(requestId?{requestId}:{}),...(initialReply.value?.result?{token:initialReply.value.result.token,discardContext:true}:{})}
 if(Object.keys(payload).length)void actions.recommendationsCancel(payload).catch(()=>{})
 requestId=''
}
function requestClose(){if(writing.value||panel.value?.isWriting())return false;emit('update:modelValue',false);return true}
function keydown(event:KeyboardEvent){
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();requestClose();return}
 if(event.key!=='Tab'||!root.value)return
 const nodes=Array.from(root.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')).filter(node=>node.getClientRects().length)
 if(!nodes.length){event.preventDefault();root.value.focus();return}
 const first=nodes[0]!,last=nodes.at(-1)!
 if(event.shiftKey&&(document.activeElement===first||document.activeElement===root.value)){event.preventDefault();last.focus()}
 else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
watch(()=>props.modelValue,async open=>{
 const owner=++epoch;cancel();visible.value=false;initialReply.value=undefined
 if(!open){if(previousFocus?.isConnected)previousFocus.focus();return}
 previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null
 const id=requestId=crypto.randomUUID()
 let reply
 try{reply=await actions.recommendationsGet({mode:'finish',referenceId:props.bookId,language:settings.language,onlyNotStarted:false,requestId:id})}
 catch{reply={ok:false,code:'recommendations_unavailable'}}
 if(owner!==epoch||!props.modelValue){if(reply.ok&&reply.result)void actions.recommendationsCancel({token:reply.result.token,discardContext:true}).catch(()=>{});return}
 requestId=''
 if(reply.ok&&reply.result&&reply.result.related.length===0){void actions.recommendationsCancel({token:reply.result.token,discardContext:true}).catch(()=>{});emit('update:modelValue',false);return}
 initialReply.value=reply;visible.value=true
 await nextTick();if(owner===epoch)closeButton.value?.focus()
},{immediate:true})
onBeforeUnmount(()=>{epoch++;cancel();if(previousFocus?.isConnected)previousFocus.focus()})
defineExpose({requestClose,isWriting:()=>writing.value||panel.value?.isWriting()===true})
</script>
<template>
 <Teleport to="body">
  <div v-if="modelValue && visible" class="book-end-backdrop" @click.self="requestClose">
   <section ref="root" class="book-end-dialog" role="dialog" aria-modal="true" aria-labelledby="book-end-heading" tabindex="-1" @keydown="keydown">
    <header><h2 id="book-end-heading">{{ tr('已到书末，接下来读什么？','At the end — what next?') }}</h2><p>{{ tr('没有自动标记读完，也不会自动打开下一本。以下只列当前馆藏中的相关书。','No automatic Finished status or next-book navigation. These are related books already in your library.') }}</p></header>
    <div class="book-end-body"><BookRecommendationsPanel ref="panel" mode="finish" :reference-id="bookId" :initial-reply="initialReply" @writing="writing = $event" @navigate="emit('navigate',$event)" /></div>
    <footer><span v-if="writing" role="status">{{ tr('提交处理中，请等待结果。','Saving. Wait for the result.') }}</span><button ref="closeButton" type="button" :disabled="writing" @click="requestClose">{{ tr('返回阅读','Return to reading') }}</button></footer>
   </section>
  </div>
 </Teleport>
</template>
<style scoped>
.book-end-backdrop {position:fixed;inset:0;z-index:10000;background:rgb(0 0 0 / 35%);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;}
.book-end-dialog {width:min(960px,100%);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;min-height:0;border:2px solid currentColor;border-radius:6px;background:var(--bg,#fff);color:var(--text,#111);}
header,footer {padding:16px;flex:none;}
header {border-bottom:1px solid currentColor;}
h2 {margin:0 0 8px;font-size:1.3rem;overflow-wrap:anywhere;}
p {margin:0;line-height:1.6;overflow-wrap:anywhere;}
.book-end-body {padding:16px;overflow:auto;min-height:0;overscroll-behavior:contain;}
footer {border-top:1px solid currentColor;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px;align-items:center;}
button {min-width:48px;min-height:48px;padding:8px 16px;font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;}
button:disabled {opacity:.55;}
button:focus-visible {outline:2px solid currentColor;outline-offset:3px;}
@media(prefers-reduced-motion:reduce){*{animation:none;transition:none;}}
</style>
