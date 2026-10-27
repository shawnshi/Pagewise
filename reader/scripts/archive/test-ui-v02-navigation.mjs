import test from 'node:test'
import assert from 'node:assert/strict'
import { queryLibrarySession, sanitizeSessionState } from '../src/services/librarySession.ts'
import { restorableView, restoreView, rememberView } from '../src/services/navigationSession.ts'

const books=()=>['a','b','c'].map((id,index)=>({id,title:id,author:'generated',format:'epub',language:'zh',addedAt:1,lastReadAt:100-index,tags:[]}))

test('return snapshot preserves page/item even when reading updates the recent sort key',()=>{
  const items=books();items[1].lastReadAt=999
  const returned=queryLibrarySession(items,{sortBy:'lastRead',page:2,pageSize:1},['a','b','c'])
  assert.equal(returned.page,2);assert.equal(returned.items[0].id,'b')
  assert.equal(queryLibrarySession(items,{sortBy:'lastRead',page:1,pageSize:1}).items[0].id,'b')
})
test('snapshot never resurrects a removed or filtered book and appends new results deterministically',()=>{
  const items=books();items[1].language='en';items.push({...items[0],id:'d',title:'d'})
  const result=queryLibrarySession(items,{languages:['zh'],pageSize:10},['a','b','c'])
  assert.deepEqual(result.items.map(b=>b.id),['a','c','d']);assert.equal(result.total,3)
  assert.equal(queryLibrarySession(items,{page:Infinity,pageSize:NaN},['a']).page,1)
})
test('snapshot state is bounded and deduplicated without changing book records',()=>{
  const state=sanitizeSessionState({orderedBookIds:['a','a',null,'b'],page:2})
  assert.deepEqual(state.orderedBookIds,['a','b']);assert.equal(state.page,2)
})
test('startup restores only supported local views, never external URLs or temporary source locations',()=>{
  const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}
  assert.equal(restoreView(storage),'/library')
  assert.equal(rememberView('/read/generated-book',storage).success,true)
  assert.equal(restoreView(storage),'/read/generated-book')
  for(const bad of ['https://example.invalid','//example.invalid','/read/b?loc=temporary','/catalogs','/read-djvu/b','/read/../notes'])assert.equal(restorableView(bad),null)
  storage.getItem=()=>{throw new Error('synthetic denied')}
  assert.equal(restoreView(storage),'/library')
})
