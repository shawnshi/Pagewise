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
const invalidAuthor = /^(?:unknown(?: author)?|未知作者|佚名|不详|暂无|et al\.?)$/iu
export function authorsOf(book: BookMeta): string[] {
  const raw = text(book.author, 256)
  if (!raw) return []
  const segments = raw.split(/[,;，；、/&]|(?:\s+and\s+)/iu)
  const result: string[] = []
  for (let seg of segments) {
    seg = seg.trim()
    if (!seg) continue
    const isTranslatorOnly = /\s+(?:译|校|译注|校注)$/u.test(seg) && result.length > 0
    if (isTranslatorOnly) continue
    seg = seg.replace(/^(?:[(\[【（][^)\]】）]{1,10}[)\]】）]\s*)+/gu, '')
    seg = seg.replace(/\s+(?:著|编著|主编|副主编|编|译|校|合著|等著|选注|注|整理|et\s+al\.?)$/iu, '')
    seg = seg.replace(/(?<=[\p{Script=Han}]{2,})(?:著|编著|主编|编)$/u, '')
    const cleaned = norm(seg).replace(/[·•・]/gu, '·')
    if (cleaned && !invalidAuthor.test(cleaned) && !result.includes(cleaned)) result.push(cleaned)
  }
  return result.slice(0, 8)
}
const authorOf = (book: BookMeta): string | null => authorsOf(book)[0] ?? null
const categoryOf = (book: BookMeta) => { const key=book.classification?.category?.value; return key && categories.has(key) ? key : null }
const featureOf = (book: BookMeta) => { const val=text(book.classification?.feature?.value, 80); return val ? norm(val) : null }
const kindOf = (book: BookMeta): 'book' | 'paper' => book.kind === 'paper' ? 'paper' : 'book'
function facetsOf(book: BookMeta) {
  const f = book.classification?.facets
  if (!f) return null
  const workCountry = text(f.workCountry, 80) || undefined
  const workPeriod = text(f.workPeriod, 80) || undefined
  const audience = text(f.audience, 80) || undefined
  const textbook = typeof f.textbook === 'boolean' ? f.textbook : undefined
  const ancientText = typeof f.ancientText === 'boolean' ? f.ancientText : undefined
  return (workCountry || workPeriod || audience || textbook !== undefined || ancientText !== undefined)
    ? { workCountry, workPeriod, audience, textbook, ancientText }
    : null
}
export function seedEngagementWeight(book: BookMeta): number {
  const seconds = typeof book.readingSeconds === 'number' && Number.isFinite(book.readingSeconds) && book.readingSeconds > 0 ? book.readingSeconds : 0
  const progress = typeof book.progress === 'number' && Number.isFinite(book.progress) && book.progress > 0 ? book.progress : 0
  if (seconds >= 1800 || (progress >= 0.15 && progress <= 0.95 && seconds >= 300)) return 1.08
  if ((book.lastReadAt ?? 0) > 0 && seconds > 0 && seconds < 120 && progress < 0.03) return 0.85
  return 1.0
}
function topicsOf(book: BookMeta): string[] {
  const raw = [...(book.classification?.topics.map(item=>item.value)??[]), ...(book.classification?.legacyTags??[]), ...book.tags]
  return [...new Set(raw.slice(0,48).map(value=>normalizeTagName(text(value,80))).filter(value=>value.length>1&&!stop.has(norm(value))&&!BOOK_CATEGORIES.some(c=>c.id===value||c.label===value)))].slice(0,24)
}
function words(raw: string): string[] {
  const value=norm(raw.replace(/<[^>]*>/gu,' ')), result: string[]=[]
  for(const word of value.match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu)??[]) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars=Array.from(word)
      if (chars.length>=3 && chars.length<=4 && /^\p{Script=Han}+$/u.test(word) && !stop.has(word)) result.push(word)
      for(let i=0;i<chars.length-1;i++){const token=chars.slice(i,i+2).join('');if(!stop.has(token))result.push(token)}
    } else if(!stop.has(word)&&word.length<=40) result.push(word)
  }
  return result
}
function vectorTerms(book: BookMeta): { terms: Map<string,number>; salient: Set<string> } {
  const rawTerms=new Map<string,number>(), salient=new Set<string>()
  const add=(raw:string,weight:number,isSalient:boolean)=>{
    for(const word of words(raw)){
      if(rawTerms.size>=1024&&!rawTerms.has(word))continue
      rawTerms.set(word,(rawTerms.get(word)??0)+weight)
      if(isSalient)salient.add(word)
    }
  }
  add(text(book.title,512),4,true)
  for(const topic of topicsOf(book))add(topic,5,true)
  add(text(book.classification?.feature?.value,80),1,true)
  add(text(book.description,2048),0.25,false)
  for(const [word,weight] of rawTerms){if(weight>=0.75)salient.add(word)}
  if(rawTerms.size<=160)return {terms:rawTerms,salient}
  const top=[...rawTerms.entries()].sort((a,b)=>b[1]-a[1]).slice(0,160)
  const terms=new Map<string,number>(top)
  for(const word of [...salient]){if(!terms.has(word))salient.delete(word)}
  return {terms,salient}
}
export function recommendationMetadataKey(book: BookMeta): string {
  return JSON.stringify([book.id,text(book.title,512),text(book.author,256),text(book.publisher,256),text(book.publicationDate,128),text(book.description,2048),categoryOf(book),topicsOf(book),book.classification?.feature?.value??null,facetsOf(book),kindOf(book)])
}
export function recommendationLexicalKey(books: readonly BookMeta[]): string {
  return JSON.stringify(books.map(book=>[recommendationMetadataKey(book),book.format,book.fileAvailability??null,book.addedAt]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
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
interface IndexedBook {
  book: BookMeta
  author: string|null
  authors: string[]
  category: string|null
  feature: string|null
  kind: 'book'|'paper'
  topics: string[]
  normTopics: { raw: string; key: string }[]
  material: string
  facets: ReturnType<typeof facetsOf>
  salient: Set<string>
  terms: Map<string,number>
  vector: Map<string,number>
  length: number
  group: string
  workGroup: string
}
export interface RecommendationIndex { records: IndexedBook[]; byId: Map<string, IndexedBook>; df: Map<string, number>; count: number }
const VOLUME_SUFFIX_RE = /[（(\[]?(?:第[一二三四五六七八九十百0-9ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[册卷部辑篇]|[上中下][册卷部篇]?|(?:卷|vol\.?|volume|part)[一二三四五六七八九十0-9ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)[）)\]]?$/iu
function stripVolumeSuffix(rawTitle: string): string {
  return rawTitle.replace(VOLUME_SUFFIX_RE, '').trim()
}
function groupKey(book: BookMeta): string {
  const author=authorOf(book);if(!author)return 'id:'+book.id
  const title=norm(text(book.title,512)).replace(/\s+/gu,'')
  const base=stripVolumeSuffix(title)
  return base!==title && base.length>=2 ? JSON.stringify(['volume',base,author,norm(text(book.publisher,256))]) : JSON.stringify(['title-author',title,author])
}
function workGroupKey(book: BookMeta): string {
  const author=authorOf(book);if(!author)return 'id:'+book.id
  const rawTitle=stripVolumeSuffix(norm(text(book.title,512)))
  const mainPart=rawTitle.split(/\s*(?:[:：—－]|--)\s*/u)[0]?.replace(/\s+/gu,'') ?? ''
  const canonical=mainPart.length>=3 ? mainPart : rawTitle.replace(/\s+/gu,'')
  return JSON.stringify(['work',canonical,author])
}
/** Bounded sparse lexical vectors, not semantic embeddings. Caller supplies only local metadata. */
export async function buildRecommendationIndex(books: readonly BookMeta[], yieldControl:()=>Promise<void> = ()=>new Promise(resolve=>setTimeout(resolve,0))): Promise<RecommendationIndex> {
  if(books.length>10_000)throw new RecommendationError('library_limit')
  const records: IndexedBook[]=[], byId=new Map<string,IndexedBook>(), df=new Map<string,number>()
  for(let i=0;i<books.length;i++) {
    const book=books[i]!
    if(typeof book.id!=='string'||!book.id||book.id.length>512||byId.has(book.id)||typeof book.title!=='string'||!book.title.trim()||!Array.isArray(book.tags))throw new RecommendationError('invalid_library')
    const topics=topicsOf(book), normTopics=topics.map(raw=>({raw,key:norm(raw)}))
    const material=norm([text(book.title,512),text(book.description,2048),text(book.classification?.feature?.value,80),...topics].join(' '))
    const {terms,salient}=vectorTerms(book), authors=authorsOf(book)
    const record:IndexedBook={book,author:authors[0]??null,authors,category:categoryOf(book),feature:featureOf(book),kind:kindOf(book),topics,normTopics,material,facets:facetsOf(book),salient,terms,vector:new Map(),length:0,group:groupKey(book),workGroup:workGroupKey(book)}
    records.push(record);byId.set(book.id,record);for(const term of terms.keys())df.set(term,(df.get(term)??0)+1)
    if(i%64===63)await yieldControl()
  }
  for(let i=0;i<records.length;i++) {
    const record=records[i]!
    for(const [term,weight] of record.terms){const value=Math.log1p(weight)* (Math.log((books.length+1)/((df.get(term)??0)+1))+1);record.vector.set(term,value);record.length+=value*value}
    record.length=Math.sqrt(record.length)
    if(i%64===63)await yieldControl()
  }
  return {records,byId,df,count:books.length}
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
function isDiscriminativeTerm(term: string, index: RecommendationIndex): boolean {
  if (stop.has(term)) return false
  if (index.count >= 4 && (index.df.get(term) ?? 0) * 4 >= index.count * 3) return false
  return true
}
function isBridgeTerm(term: string, source: IndexedBook, target: IndexedBook): boolean {
  if (/^[a-z][a-z0-9+#.-]{3,}$/u.test(term)) return true
  if (/^\p{Script=Han}{2,6}$/u.test(term)) return source.salient.has(term) && target.salient.has(term)
  return false
}
const JUVENILE_AUDIENCE_RE = /(?:儿童|少儿|幼儿|低幼|小学|绘本|children|kids)/iu
function facetBonus(source: IndexedBook, target: IndexedBook): number {
  const sf = source.facets, tf = target.facets
  let bonus = 0
  if (source.feature && source.feature === target.feature) bonus += 0.04
  if (source.kind === 'paper' && target.kind === 'paper') bonus += 0.04
  if (sf && tf) {
    if (sf.workCountry && sf.workCountry === tf.workCountry) bonus += 0.04
    if (sf.workPeriod && sf.workPeriod === tf.workPeriod) bonus += 0.04
    if (sf.ancientText === true && tf.ancientText === true) bonus += 0.04
    if (sf.textbook === true && tf.textbook === true) bonus += 0.03
  }
  const sourceJuvenile = sf?.audience ? JUVENILE_AUDIENCE_RE.test(sf.audience) : false
  const targetJuvenile = tf?.audience ? JUVENILE_AUDIENCE_RE.test(tf.audience) : false
  if (!sourceJuvenile && targetJuvenile && (source.kind === 'paper' || sf?.audience || source.feature)) {
    bonus -= 0.15
  }
  return Math.max(-0.15, Math.min(0.12, bonus))
}
export interface SeedAnnotationSnippet { text?: string; note?: string }
function enrichSeedWithAnnotations(source: IndexedBook, index: RecommendationIndex, snippets: readonly SeedAnnotationSnippet[] | undefined): IndexedBook {
  if (!snippets || !snippets.length) return source
  const mergedTerms = new Map(source.terms)
  const mergedSalient = new Set(source.salient)
  const extraText: string[] = []
  for (const item of snippets.slice(0, 32)) {
    const noteText = text(item.note, 256)
    const quoteText = text(item.text, 256)
    if (noteText) {
      extraText.push(noteText)
      for (const w of words(noteText)) {
        if (mergedTerms.size >= 160 && !mergedTerms.has(w)) continue
        mergedTerms.set(w, (mergedTerms.get(w) ?? 0) + 2.5)
        mergedSalient.add(w)
      }
    }
    if (quoteText) {
      extraText.push(quoteText)
      for (const w of words(quoteText)) {
        if (mergedTerms.size >= 160 && !mergedTerms.has(w)) continue
        mergedTerms.set(w, (mergedTerms.get(w) ?? 0) + 1.0)
        if ((mergedTerms.get(w) ?? 0) >= 2.0) mergedSalient.add(w)
      }
    }
  }
  if (!extraText.length) return source
  const vector = new Map<string, number>()
  let sum = 0
  for (const [term, weight] of mergedTerms) {
    const value = Math.log1p(weight) * (Math.log((index.count + 1) / ((index.df.get(term) ?? 1) + 1)) + 1)
    vector.set(term, value)
    sum += value * value
  }
  return {
    ...source,
    material: norm(source.material + ' ' + extraText.join(' ')),
    salient: mergedSalient,
    terms: mergedTerms,
    vector,
    length: Math.sqrt(sum),
  }
}
export interface RecommendationRankOptions {
  language: RecommendationLanguage
  onlyNotStarted: boolean
  relatedLimit: number
  extendedLimit: number
  feedback: readonly RecommendationFeedback[]
  booklists?: ReadonlyMap<string, readonly string[]>
  seedAnnotations?: ReadonlyMap<string, readonly SeedAnnotationSnippet[]>
}
export function rankBookRecommendations(index:RecommendationIndex,seeds:readonly BookMeta[],options:RecommendationRankOptions):{related:RecommendationCard[];extended:RecommendationCard[];filteredCount:number} {
  const rawSeedRecords=seeds.map(b=>index.byId.get(b.id)).filter((r):r is IndexedBook=>!!r)
  const seedRecords=rawSeedRecords.map(r=>enrichSeedWithAnnotations(r,index,options.seedAnnotations?.get(r.book.id)))
  const seedIds=new Set(seeds.map(b=>b.id)), seedGroups=new Set(seedRecords.map(r=>r.group)), seedWorkGroups=new Set(seedRecords.map(r=>r.workGroup))
  const banned=new Set(options.feedback.filter(f=>f.kind==='not-interested').map(f=>f.candidateId)), badPairs=new Set(options.feedback.filter(f=>f.kind==='unrelated').map(f=>JSON.stringify([f.sourceId,f.candidateId])))
  const best=new Map<string,Ranked>();let filteredCount=0
  for(const target of index.records) {
    const b=target.book
    if(seedIds.has(b.id)||seedGroups.has(target.group)||seedWorkGroups.has(target.workGroup)||banned.has(b.id)||!['epub','pdf','txt'].includes(b.format)||b.fileAvailability==='missing'||b.fileAvailability==='permission-denied'||resolveReadingStatus(b).effective==='abandoned'||(options.onlyNotStarted&&!recommendationNotStarted(b))){filteredCount++;continue}
    for(let seedIndex=0;seedIndex<seedRecords.length;seedIndex++) {
      const source=seedRecords[seedIndex]!
      if(badPairs.has(JSON.stringify([source.book.id,b.id])))continue
      const sameAuthor=source.authors.length>0&&target.authors.length>0&&source.authors.some(a=>target.authors.includes(a))
      const sameCategory=!!source.category&&source.category===target.category
      const sourceLists=options.booklists?.get(source.book.id)??[], targetLists=options.booklists?.get(b.id)??[]
      const sharedListCount=sourceLists.length&&targetLists.length?sourceLists.filter(id=>targetLists.includes(id)).length:0
      const seenTopic=new Set<string>(), sharedTopics:string[]=[]
      for(const item of [...source.normTopics,...target.normTopics]) {
        if(!seenTopic.has(item.raw)&&source.material.includes(item.key)&&target.material.includes(item.key)){seenTopic.add(item.raw);sharedTopics.push(item.raw)}
      }
      const common=[...source.vector.keys()].filter(term=>target.vector.has(term)&&isDiscriminativeTerm(term,index)).sort((a,b)=>(source.vector.get(b)??0)*(target.vector.get(b)??0)-(source.vector.get(a)??0)*(target.vector.get(a)??0))
      const similarity=cosine(source,target), bridge=sharedTopics.length?sharedTopics:common.filter(term=>isBridgeTerm(term,source,target)).slice(0,3)
      let lane:RecommendationLane,kind:RecommendationEvidence['kind']
      if(sameAuthor || (sameCategory&&(sharedTopics.length>0||sharedListCount>0||(similarity>=0.08&&common.length>=2))) || (sharedListCount>0&&(sharedTopics.length>0||common.length>=1)) || ((!source.category||!target.category)&&sharedTopics.length>=2&&similarity>=0.12)) {lane='related';kind=sameAuthor?'author':sharedTopics.length?'topic':'terms'}
      else if(source.category&&target.category&&source.category!==target.category&&!sameAuthor&&bridge.length&&(sharedTopics.length>0||similarity>=0.06&&common.length>=3)) {lane='extended';kind=sharedTopics.length?'topic':'terms'}
      else continue
      const evidence:RecommendationEvidence={kind,shared:sameAuthor?[text(b.author,256)]:(bridge.length?bridge:common.length?common:source.topics.slice(0,1)).slice(0,3),sourceCategory:source.category,targetCategory:target.category}
      const listBonus=Math.min(0.25,sharedListCount*0.18)
      const rawScore=similarity*0.6+(sameAuthor?0.65:0)+(sameCategory?0.15:0)+Math.min(sharedTopics.length,3)*0.12+facetBonus(source,target)+listBonus+(recommendationNotStarted(b)?0.12:0)-(resolveReadingStatus(b).effective==='finished'?0.08:0)
      const seedDecay=Math.max(0.88,1-seedIndex*0.03)
      const engagement=seedRecords.length>1?seedEngagementWeight(source.book):1.0
      const score=rawScore*seedDecay*engagement
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
