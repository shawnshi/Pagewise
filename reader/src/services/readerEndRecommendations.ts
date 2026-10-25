export interface ReaderEndObservation {
  bookId:string
  atEnd:boolean
  primary:boolean
  loading:boolean
  unstable:boolean
  navigating:boolean
  inspecting:boolean
  blocked:boolean
  reason:unknown
}
/** At most one offer per Reader instance. Never infer completion from a fraction,
 * initial restoration, typography reflow, selection, or a programmatic jump. */
export function createReaderEndRecommendationGate(ownerBookId:string){
  let interior=false,pending=false,shown=false,disposed=false
  const consume=(bookId:string,atEnd:boolean,blocked:boolean)=>{
    if(bookId!==ownerBookId||!atEnd){pending=false;return false}
    if(disposed||shown||blocked||!pending)return false
    shown=true;pending=false;return true
  }
  return {
    observe(value:ReaderEndObservation):boolean {
      if(value.bookId!==ownerBookId||value.loading||value.unstable||value.navigating||value.inspecting){pending=false;return false}
      if(disposed||shown||!value.primary)return false
      if(!value.atEnd){interior=true;pending=false;return false}
      if(interior&&typeof value.reason==='string'&&['page','scroll','snap'].includes(value.reason))pending=true
      return consume(value.bookId,value.atEnd,value.blocked)
    },
    consume,
    cancelPending(){pending=false},
    dispose(){disposed=true;pending=false},
    get shown(){return shown},
    get pending(){return pending},
  }
}

export function isPdfDocumentEnd(value:{pageCount:number;lastPage:number;rendered:boolean;viewport:Pick<HTMLElement,'scrollTop'|'clientHeight'|'scrollHeight'|'scrollLeft'|'clientWidth'|'scrollWidth'>|null}):boolean {
  const v=value.viewport
  if(!v||!value.rendered||!Number.isSafeInteger(value.pageCount)||value.pageCount<1||value.lastPage!==value.pageCount)return false
  if(![v.scrollTop,v.clientHeight,v.scrollHeight,v.scrollLeft,v.clientWidth,v.scrollWidth].every(Number.isFinite)||v.clientHeight<=0||v.clientWidth<=0||v.scrollHeight<v.clientHeight||v.scrollWidth<v.clientWidth)return false
  return v.scrollTop+v.clientHeight>=v.scrollHeight-2&&v.scrollLeft+v.clientWidth>=v.scrollWidth-2
}
