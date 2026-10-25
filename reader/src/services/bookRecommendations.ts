import type { BookMeta, ReadingStatus, BookReadingStatusSnapshot } from '../storage/types.ts'
import { BOOK_CATEGORIES, normalizeTagName } from './bookClassification.ts'
import { isReadingStatus, normalizeReadingStatus, resolveReadingStatus } from './readingStatus.ts'

export type RecommendationMode = 'reading' | 'detail' | 'finish'
export type RecommendationLane = 'related' | 'extended'
export type RecommendationLanguage = 'zh' | 'en'
export interface RecommendationFeedback { candidateId: string; sourceId: string; kind: 'not-interested' | 'unrelated'; at: number }
export interface RecommendationEvidence { kind: 'author' | 'topic' | 'terms'; shared: string[]; sourceCategory: string | null; targetCategory: string | null }
export interface RecommendationBook { id: string; title: string; author: string; publisher?: string; publicationDate?: string; format: string; hasCover: boolean; readingStatus: ReadingStatus | 'unknown'; progress?: number }
export interface RecommendationCard {
  book: RecommendationBook; sourceId: string; sourceTitle: string; lane: RecommendationLane; reason: string; reasonKind: 'local' | 'ai'; evidence: RecommendationEvidence; recordCount: number
}
export interface RecommendationResult { token: string; mode: RecommendationMode; referenceId: string | null; seedKind: 'reference' | 'recent-reading' | 'marked-reading' | 'recent-added'; sources: { id: string; title: string }[]; related: RecommendationCard[]; extended: RecommendationCard[]; libraryCount: number; filteredCount: number; language: RecommendationLanguage; onlyNotStarted: boolean }
export type RecommendationStatusSnapshot = BookReadingStatusSnapshot
export class RecommendationError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'RecommendationError'; this.code = code }
}
export class RecommendationStatusConflictError extends RecommendationError { constructor() { super('book_conflict') } }
const categories = new Map(BOOK_CATEGORIES.map(item => [item.id, item.label]))
const stop = new Set(['the','and','with','from','this','that','book','books','introduction','study','studies','history','general','edition','null','undefined','的','与','和','一种','这个','我们','他们','问题','研究','介绍','内容','作品','作者','读者','阅读','方法','生活','社会','历史','发展','思想','世界','中国','人类','经典','基础','关于','如何','理论','实践','视角','科学','文化','方面','提供','通过','不同','相关','以及','一个','theory','practice','unknown'])
const norm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu,' ').trim().slice(0,max) : ''
const authorOf = (book: BookMeta): string | null => { const value = norm(text(book.author,256)); return !value || /^(?:unknown(?: author)?|未知作者|佚名|不详|暂无)$/u.test(value) ? null : value }
const categoryOf = (book: BookMeta) => { const key=book.classification?.category?.value; return key && categories.has(key) ? key : null }
function topicsOf(book: BookMeta): string[] {
  const raw = [...(book.classification?.topics.map(item=>item.value)??[]), ...(book.classification?.legacyTags??[]), ...book.tags]
  return [...new Set(raw.slice(0,48).map(value=>normalizeTagName(text(value,80))).filter(value=>value.length>1&&!stop.has(norm(value))&&!BOOK_CATEGORIES.some(c=>c.id===value||c.label===value)))].slice(0,24)
}
function words(raw: string): string[] {
  const value=norm(raw.replace(/<[^>]*>/gu,' ')), result: string[]=[]
  for(const word of value.match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu)??[]) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars=Array.from(word);for(let i=0;i<chars.length-1;i++){const token=chars.slice(i,i+2).join('');if(!stop.has(token))result.push(token)}
    } else if(!stop.has(word)&&word.length<=40) result.push(word)
  }
  return result
}
function vectorTerms(book: BookMeta): Map<string,number> {
  const terms=new Map<string,number>()
  const add=(raw:string,weight:number)=>{for(const word of words(raw)){if(terms.size>=160&&!terms.has(word))continue;terms.set(word,(terms.get(word)??0)+weight)}}
  add(text(book.title,512),4)
  for(const topic of topicsOf(book))add(topic,5)
  add(text(book.classification?.feature?.value,80),1)
  add(text(book.description,2048),0.25)
  return terms
}
export function recommendationMetadataKey(book: BookMeta): string {
  return JSON.stringify([book.id,text(book.title,512),text(book.author,256),text(book.publisher,256),text(book.publicationDate,128),text(book.description,2048),categoryOf(book),topicsOf(book),book.classification?.feature?.value??null])
}
export function recommendationCorpusKey(books: readonly BookMeta[]): string {
  return JSON.stringify(books.map(book=>[recommendationMetadataKey(book),book.readingStatus??null,book.lastReadAt??null,book.progress??null,book.readingSeconds??null,book.addedAt,book.fileAvailability??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
}
export function recommendationNotStarted(book: BookMeta): boolean {
  const status=normalizeReadingStatus(book.readingStatus)
  return (status==='wanted'||status==='unmarked') && !(book.lastReadAt && book.lastReadAt>0) && !(typeof book.progress==='number'&&book.progress>0) && !(book.readingSeconds && book.readingSeconds>0)
}
export function recommendationStatusSnapshot(book: BookMeta): RecommendationStatusSnapshot {
  const raw:unknown=book.readingStatus
  const readingStatus=normalizeReadingStatus(raw)
  if(raw!=null && raw!=='unread' && readingStatus===undefined)throw new RecommendationStatusConflictError()
  for(const value of [book.lastReadAt,book.progress])if(value!=null&&(typeof value!=='number'||!Number.isFinite(value)))throw new RecommendationStatusConflictError()
  return {readingStatus:readingStatus??null,lastReadAt:book.lastReadAt??null,progress:book.progress??null}
}
export function validateRecommendationStatusUpdate(id:string,expected:RecommendationStatusSnapshot,status:ReadingStatus):void {
  if(typeof id!=='string'||!id||id.length>512||!isReadingStatus(status)||!expected||Object.keys(expected).sort().join(',')!=='lastReadAt,progress,readingStatus'||(expected.readingStatus!==null&&!isReadingStatus(expected.readingStatus))||[expected.lastReadAt,expected.progress].some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v))))throw new RecommendationError('invalid_payload')
}
export function recommendationStatusMatches(book: BookMeta, expected: RecommendationStatusSnapshot): boolean {
  try { const current=recommendationStatusSnapshot(book);return current.readingStatus===expected.readingStatus&&current.lastReadAt===expected.lastReadAt&&current.progress===expected.progress } catch { return false }
}
interface IndexedBook { book: BookMeta; author: string|null; category: string|null; topics: string[]; terms: Map<string,number>; vector: Map<string,number>; length: number; group: string }
export interface RecommendationIndex { records: IndexedBook[]; byId: Map<string, IndexedBook>; count: number }
function groupKey(book: BookMeta): string {
  const author=authorOf(book);if(!author)return 'id:'+book.id
  const title=norm(text(book.title,512)).replace(/\s+/gu,'')
  const base=title.replace(/[（(\[]?(?:第[一二三四五六七八九十百0-9]+[册卷部]|[上中下][册卷])[）)\]]?$/u,'').trim()
  return base!==title && base.length>=3 ? JSON.stringify(['volume',base,author,norm(text(book.publisher,256))]) : JSON.stringify(['title-author',title,author])
}
/** Bounded sparse lexical vectors, not semantic embeddings. Caller supplies only local metadata. */
export async function buildRecommendationIndex(books: readonly BookMeta[], yieldControl:()=>Promise<void> = ()=>new Promise(resolve=>setTimeout(resolve,0))): Promise<RecommendationIndex> {
  if(books.length>10_000)throw new RecommendationError('library_limit')
  const records: IndexedBook[]=[], byId=new Map<string,IndexedBook>(), df=new Map<string,number>()
  for(let i=0;i<books.length;i++) {
    const book=books[i]!
    if(typeof book.id!=='string'||!book.id||book.id.length>512||byId.has(book.id)||typeof book.title!=='string'||!book.title.trim()||!Array.isArray(book.tags))throw new RecommendationError('invalid_library')
    const terms=vectorTerms(book), record:IndexedBook={book,author:authorOf(book),category:categoryOf(book),topics:topicsOf(book),terms,vector:new Map(),length:0,group:groupKey(book)}
    records.push(record);byId.set(book.id,record);for(const term of terms.keys())df.set(term,(df.get(term)??0)+1)
    if(i%64===63)await yieldControl()
  }
  for(let i=0;i<records.length;i++) {
    const record=records[i]!
    for(const [term,weight] of record.terms){const value=Math.log1p(weight)* (Math.log((books.length+1)/((df.get(term)??0)+1))+1);record.vector.set(term,value);record.length+=value*value}
    record.length=Math.sqrt(record.length)
    if(i%64===63)await yieldControl()
  }
  return {records,byId,count:books.length}
}
function cosine(a:IndexedBook,b:IndexedBook):number {
  if(!a.length||!b.length)return 0
  const [small,large]=a.vector.size<=b.vector.size?[a.vector,b.vector]:[b.vector,a.vector]
  let sum=0;for(const [term,value]of small)sum+=value*(large.get(term)??0)
  return Math.min(1,Math.max(0,sum/(a.length*b.length)))
}
export interface RecommendationSeedSelection { kind: RecommendationResult['seedKind']; books: BookMeta[] }
export function recommendationSeeds(index:RecommendationIndex,mode:RecommendationMode,referenceId:string|null):RecommendationSeedSelection {
  if(mode!=='reading'||referenceId) {
    const record=referenceId?index.byId.get(referenceId):undefined;if(!record)throw new RecommendationError('book_missing')
    return {kind:'reference',books:[record.book]}
  }
  const usable=index.records.filter(r=>resolveReadingStatus(r.book).effective!=='abandoned')
  const recent=usable.filter(r=>typeof r.book.lastReadAt==='number'&&r.book.lastReadAt>0).sort((a,b)=>b.book.lastReadAt!-a.book.lastReadAt!||a.book.id.localeCompare(b.book.id)).slice(0,5)
  if(recent.length)return {kind:'recent-reading',books:recent.map(r=>r.book)}
  const marked=usable.filter(r=>normalizeReadingStatus(r.book.readingStatus)==='reading').slice(0,5)
  if(marked.length)return {kind:'marked-reading',books:marked.map(r=>r.book)}
  return {kind:'recent-added',books:usable.sort((a,b)=>b.book.addedAt-a.book.addedAt||a.book.id.localeCompare(b.book.id)).slice(0,3).map(r=>r.book)}
}
interface Ranked { source:IndexedBook; target:IndexedBook; lane:RecommendationLane; score:number; evidence:RecommendationEvidence }
function reason(pair:Ranked,language:RecommendationLanguage):string {
  const token=pair.evidence.shared[0]??'', targetCategory=categories.get(pair.target.category??'')??''
  if(language==='en') {
    if(pair.evidence.kind==='author')return `By the same author as the source book: ${text(pair.target.book.author,48)}. Compare the titles and topics before choosing.`
    return pair.lane==='extended'?`Both records mention “${token}”; this one is classified as ${targetCategory}, offering a cross-category comparison.`:`Shared metadata points to “${token}”${targetCategory?` within ${targetCategory}`:''}. A related library record to explore.`
  }
  if(pair.evidence.kind==='author')return `与来源书同为「${text(pair.target.book.author,32)}」所著，可对照两书题名与主题安排后续阅读。`
  return pair.lane==='extended'?`两书均含「${text(token,24)}」，这本属「${targetCategory}」，可作跨类对照。`:`两书共享「${text(token,24)}」线索${targetCategory?`，同属「${targetCategory}」`:''}，可继续核对主题与内容。`
}
function card(pair:Ranked,language:RecommendationLanguage,count:number):RecommendationCard {
  const b=pair.target.book
  return {book:{id:b.id,title:b.title,author:b.author,publisher:b.publisher,publicationDate:b.publicationDate,format:b.format,hasCover:!!b.hasCover,readingStatus:resolveReadingStatus(b).effective??'unknown',...(typeof b.progress==='number'&&Number.isFinite(b.progress)?{progress:b.progress}:{})},sourceId:pair.source.book.id,sourceTitle:pair.source.book.title,lane:pair.lane,reason:reason(pair,language),reasonKind:'local',evidence:pair.evidence,recordCount:count}
}
export function rankBookRecommendations(index:RecommendationIndex,seeds:readonly BookMeta[],options:{language:RecommendationLanguage;onlyNotStarted:boolean;relatedLimit:number;extendedLimit:number;feedback:readonly RecommendationFeedback[]}):{related:RecommendationCard[];extended:RecommendationCard[];filteredCount:number} {
  const seedRecords=seeds.map(b=>index.byId.get(b.id)).filter((r):r is IndexedBook=>!!r), seedIds=new Set(seeds.map(b=>b.id)), seedGroups=new Set(seedRecords.map(r=>r.group))
  const banned=new Set(options.feedback.filter(f=>f.kind==='not-interested').map(f=>f.candidateId)), badPairs=new Set(options.feedback.filter(f=>f.kind==='unrelated').map(f=>JSON.stringify([f.sourceId,f.candidateId])))
  const best=new Map<string,Ranked>();let filteredCount=0
  for(const target of index.records) {
    const b=target.book
    if(seedIds.has(b.id)||seedGroups.has(target.group)||banned.has(b.id)||!['epub','pdf','txt'].includes(b.format)||b.fileAvailability==='missing'||b.fileAvailability==='permission-denied'||resolveReadingStatus(b).effective==='abandoned'||(options.onlyNotStarted&&!recommendationNotStarted(b))){filteredCount++;continue}
    for(const source of seedRecords) {
      if(badPairs.has(JSON.stringify([source.book.id,b.id])))continue
      const sameAuthor=!!source.author&&source.author===target.author, sameCategory=!!source.category&&source.category===target.category
      const sourceMaterial=norm([source.book.title,source.book.description??'',...source.topics].join(' '))
      const targetMaterial=norm([target.book.title,target.book.description??'',...target.topics].join(' '))
      const sharedTopics=[...new Set([...source.topics,...target.topics])].filter(topic=>sourceMaterial.includes(norm(topic))&&targetMaterial.includes(norm(topic)))
      const common=[...source.vector.keys()].filter(term=>target.vector.has(term)&&!stop.has(term)).sort((a,b)=>(source.vector.get(b)??0)*(target.vector.get(b)??0)-(source.vector.get(a)??0)*(target.vector.get(a)??0))
      const similarity=cosine(source,target), bridge=sharedTopics.length?sharedTopics:common.filter(term=>/^[a-z][a-z0-9+#.-]{3,}$/u.test(term)).slice(0,3)
      let lane:RecommendationLane,kind:RecommendationEvidence['kind']
      if(sameAuthor || (sameCategory&&(sharedTopics.length>0||(similarity>=0.08&&common.length>=2))) || ((!source.category||!target.category)&&sharedTopics.length>=2&&similarity>=0.12)) {lane='related';kind=sameAuthor?'author':sharedTopics.length?'topic':'terms'}
      else if(source.category&&target.category&&source.category!==target.category&&!sameAuthor&&bridge.length&&(sharedTopics.length>0||similarity>=0.06&&common.length>=3)) {lane='extended';kind=sharedTopics.length?'topic':'terms'}
      else continue
      const evidence:RecommendationEvidence={kind,shared:sameAuthor?[text(b.author,256)]:(bridge.length?bridge:common).slice(0,3),sourceCategory:source.category,targetCategory:target.category}
      const score=similarity*0.6+(sameAuthor?0.65:0)+(sameCategory?0.15:0)+Math.min(sharedTopics.length,3)*0.12+(recommendationNotStarted(b)?0.12:0)-(resolveReadingStatus(b).effective==='finished'?0.08:0)
      const pair:Ranked={source,target,lane,score,evidence}, previous=best.get(b.id)
      if(!previous || (lane==='related'&&previous.lane==='extended') || lane===previous.lane&&score>previous.score)best.set(b.id,pair)
    }
  }
  const sorted=[...best.values()].sort((a,b)=>b.score-a.score||a.target.book.id.localeCompare(b.target.book.id)), groupCounts=new Map<string,number>()
  for(const p of sorted)groupCounts.set(p.target.group,(groupCounts.get(p.target.group)??0)+1)
  const usedIds=new Set<string>(), usedGroups=new Set<string>(),related:RecommendationCard[]=[],extended:RecommendationCard[]=[]
  function choose(lane:RecommendationLane,limit:number,out:RecommendationCard[]) {
    const authorCounts=new Map<string,number>(), selectedCategories=new Set<string>()
    const pending=sorted.filter(p=>p.lane===lane)
    while(out.length<limit&&pending.length) {
      let at=0
      if(lane==='extended'&&selectedCategories.size<3){const found=pending.findIndex(p=>!!p.target.category&&!selectedCategories.has(p.target.category));if(found>=0)at=found}
      const p=pending.splice(at,1)[0]!,author=p.target.author??p.target.book.id
      if(usedIds.has(p.target.book.id)||usedGroups.has(p.target.group)||(authorCounts.get(author)??0)>=(lane==='related'?2:1))continue
      usedIds.add(p.target.book.id);usedGroups.add(p.target.group);authorCounts.set(author,(authorCounts.get(author)??0)+1);if(p.target.category)selectedCategories.add(p.target.category)
      out.push(card(p,options.language,groupCounts.get(p.target.group)??1))
    }
  }
  choose('related',options.relatedLimit,related);choose('extended',options.extendedLimit,extended)
  return {related,extended,filteredCount}
}
