import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdirSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import vue from '@vitejs/plugin-vue'
import {chromium} from 'playwright'
import {createServer} from './vite-isolated.mjs'
const root=resolve(import.meta.dirname,'..')
const output=process.env.PW_INTRO_BROWSER_OUT&&resolve(process.env.PW_INTRO_BROWSER_OUT)
if(output){assert.ok(!existsSync(output),'Preserve prior browser evidence');mkdirSync(output,{recursive:true})}
async function harness(){
  const server=await createServer({root,configFile:false,logLevel:'error',define:{__APP_VERSION__:'"test"'},cacheDir:resolve(root,'../.cache/book-introduction-20261024/vite-ui',crypto.randomUUID()),
    optimizeDeps:{noDiscovery:true,include:['vue','pinia','vue-router','dexie','fflate','yaml']},server:{host:'127.0.0.1',port:0},plugins:[vue(),{
      name:'introduction-controlled-ui',enforce:'pre',resolveId(source,importer){if(source==='/__test_vendor.ts')return '\0intro-vendor';if(importer?.includes('BookIntroductionDialog.vue')&&source.endsWith('bookIntroductionActions.ts'))return '\0controlled-introduction'},
      load(id){if(id==='\0intro-vendor')return `export {createApp,h,reactive,ref,computed} from 'vue';export {createPinia} from 'pinia';export {createRouter,createMemoryHistory,RouterView,useRoute} from 'vue-router'`;if(id==='\0controlled-introduction')return `import {createBookIntroductionActions as real} from '/src/services/bookIntroductionActions.ts';export const createBookIntroductionActions=()=>real(window.__introDependencies)`},
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/__intro')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>')}else next()})}
    }]})
  let browser
  try{
    await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`
    browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{}),args:['--disable-background-networking']})
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:992,height:900}}), blocked=[]
    await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();blocked.push(new URL(route.request().url()).origin);return route.abort()})
    const page=await context.newPage()
    async function reset(){
      await page.goto(base+'/__intro');await page.evaluate(async()=>{
        const {createApp,h,reactive,ref,computed,createPinia,createRouter,createMemoryHistory,RouterView,useRoute}=await import('/__test_vendor.ts')
        const {bookDescriptionSnapshot,bookDescriptionMatches,BookDescriptionConflictError}=await import('/src/services/bookDescription.ts')
        const {default:Dialog}=await import('/src/components/BookIntroductionDialog.vue')
        const model=id=>({id,title:id==='a'?'合成书名':'Synthetic other book',author:'Synthetic author',publisher:'Synthetic press',publicationDate:'2001-02-03',description:'Original '+id,format:'epub',fileName:'fixture.epub',addedAt:1,tags:['keep']})
        const books=reactive({a:model('a'),b:model('b')}), open=ref(true), calls={generations:0,writes:0,cancels:0,saved:[]}
        let mode='ok', aiResolve, saveResolve
        const source=()=>mode==='html'?'<img src=x onerror="window.__executed=true">\nSynthetic draft':'Synthetic generated draft'
        const storage={getBook:async id=>structuredClone(JSON.parse(JSON.stringify(books[id]))),updateBookDescription:async(id,expected,value)=>{
          if(!bookDescriptionMatches(books[id],expected))throw new BookDescriptionConflictError()
          if(mode==='save-deferred')await new Promise(r=>{saveResolve=r})
          calls.writes++;books[id].description=value
          if(mode==='unknown')throw Error('Synthetic lost ACK')
        }}
        window.__introDependencies={storage:async()=>storage,ready:async()=>mode==='settings'?{ok:false,code:'settings_recovery_required'}:undefined,
          generate:async()=>{calls.generations++;if(mode==='deferred')return new Promise(r=>{aiResolve=r});return source()}}
        const BookRoute={setup(){const route=useRoute(),id=computed(()=>String(route.params.id));return()=>h('main',[h('p','Synthetic host '+id.value),h(Dialog,{modelValue:open.value,bookId:id.value,book:books[id.value],'onUpdate:modelValue':v=>open.value=v,onSaved:(bookId,description)=>calls.saved.push({bookId,description})})])}}
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/book/:id',component:BookRoute},{path:'/other',component:{render:()=>h('p','Other route')}}]})
        await router.push('/book/a');await router.isReady();const app=createApp({render:()=>h(RouterView)});app.use(createPinia());app.use(router);app.mount('#app')
        const {useSettings}=await import('/src/stores/settings.ts');useSettings().language='zh'
        window.intro={books,open,calls,router,setMode:v=>mode=v,resolveAi:()=>aiResolve?.('Late generated draft'),resolveSave:()=>saveResolve?.(),get aiPending(){return !!aiResolve},get savePending(){return !!saveResolve},snapshot:()=>bookDescriptionSnapshot(books.a)}
      });await page.getByRole('dialog').waitFor()
    }
    return{page,reset,blocked,close:async()=>{await browser.close();await server.close()}}
  }catch(e){await browser?.close();await server.close();throw e}
}
const generate=async p=>{await p.getByRole('button',{name:'生成简介',exact:true}).click();await p.getByRole('button',{name:'确认替换简介',exact:true}).waitFor();await p.waitForFunction(()=>document.querySelector('textarea')?.value.length>0)}
test('Web introduction dialog: controlled transport, no real AI or private library',async t=>{
  const h=await harness(),p=h.page
  try{
    await t.test('generate then close changes no description; focus and labels remain usable',async()=>{
      await h.reset();await generate(p);assert.equal(await p.evaluate(()=>intro.calls.writes),0)
      assert.equal(await p.evaluate(()=>intro.books.a.description),'Original a')
      await p.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await p.getByRole('dialog').count(),0);assert.equal(await p.evaluate(()=>intro.calls.writes),0)
    })
    await t.test('explicit replacement saves edited text, once, without touching another book',async()=>{
      await h.reset();await generate(p);await p.getByRole('textbox',{name:'生成预览（可编辑、可复制）'}).fill('User-edited synthetic draft')
      await p.getByRole('button',{name:'确认替换简介',exact:true}).click();await p.waitForFunction(()=>intro.calls.writes===1)
      assert.deepEqual(await p.evaluate(()=>({a:intro.books.a.description,b:intro.books.b.description,saved:intro.calls.saved})),{a:'User-edited synthetic draft',b:'Original b',saved:[{bookId:'a',description:'User-edited synthetic draft'}]})
    })
    await t.test('CAS conflict retains draft and newer description without a write',async()=>{
      await h.reset();await generate(p);await p.evaluate(()=>intro.books.a.description='Concurrent description')
      await p.getByRole('button',{name:'确认替换简介',exact:true}).click();await p.getByRole('alert').waitFor()
      assert.equal(await p.evaluate(()=>intro.calls.writes),0);assert.equal(await p.evaluate(()=>intro.books.a.description),'Concurrent description')
      assert.equal(await p.locator('textarea').inputValue(),'Synthetic generated draft')
    })
    await t.test('cancel and book switch reject a late model reply',async()=>{
      await h.reset();await p.evaluate(()=>intro.setMode('deferred'));await p.getByRole('button',{name:'生成简介',exact:true}).click();await p.waitForFunction(()=>intro.aiPending)
      await p.evaluate(()=>intro.router.push('/book/b'));await p.evaluate(()=>intro.resolveAi());await p.waitForTimeout(30)
      assert.equal(await p.getByRole('dialog').count(),0);assert.equal(await p.evaluate(()=>intro.calls.writes),0);assert.equal(await p.evaluate(()=>intro.books.b.description),'Original b')
    })
    await t.test('submitted save blocks both route leave and same-component book-param updates',async()=>{
      await h.reset();await generate(p);await p.evaluate(()=>intro.setMode('save-deferred'));await p.getByRole('button',{name:'确认替换简介',exact:true}).click();await p.waitForFunction(()=>intro.savePending)
      await p.evaluate(async()=>{await intro.router.push('/book/b');await intro.router.push('/other')})
      assert.equal(await p.evaluate(()=>intro.router.currentRoute.value.fullPath),'/book/a')
      await p.evaluate(()=>intro.resolveSave());await p.waitForFunction(()=>intro.calls.writes===1);assert.equal(await p.evaluate(()=>intro.books.b.description),'Original b')
    })
    await t.test('unknown commit disables replay but preserves the copyable draft',async()=>{
      await h.reset();await generate(p);await p.evaluate(()=>intro.setMode('unknown'));await p.getByRole('button',{name:'确认替换简介',exact:true}).click();await p.getByRole('alert').waitFor()
      assert.equal(await p.evaluate(()=>intro.calls.writes),1);assert.equal(await p.locator('textarea').inputValue(),'Synthetic generated draft')
      assert.equal(await p.getByRole('button',{name:'确认替换简介',exact:true}).isDisabled(),true)
      assert.equal(await p.getByRole('button',{name:'重新生成',exact:true}).isDisabled(),true)
      assert.equal(await p.evaluate(()=>intro.calls.generations),1)
    })
    await t.test('HTML remains text and settings recovery prevents generation',async()=>{
      await h.reset();await p.evaluate(()=>intro.setMode('html'));await generate(p);assert.ok((await p.locator('textarea').inputValue()).includes('<img'));assert.equal(await p.evaluate(()=>window.__executed===true),false)
      await h.reset();await p.evaluate(()=>intro.setMode('settings'));await p.getByRole('button',{name:'生成简介',exact:true}).click();await p.getByRole('alert').waitFor();assert.equal(await p.evaluate(()=>intro.calls.generations),0)
    })
    await t.test('320px, wide, and enlarged-text layouts do not horizontally overflow',async()=>{
      for(const [width,scale] of [[320,1],[1400,1],[320,1.8]]){
        await p.setViewportSize({width,height:1000});await h.reset();await generate(p);await p.evaluate(scale=>{document.documentElement.style.fontSize=16*scale+'px'},scale)
        const geometry=await p.getByRole('dialog').evaluate(el=>({right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,scroll:el.scrollWidth,client:el.clientWidth}))
        assert.ok(geometry.right<=width+1);assert.ok(geometry.scroll<=geometry.client+1)
        if(output)await p.screenshot({path:join(output,`web-${width}-${scale}.png`)})
      }
    })
    assert.deepEqual(h.blocked,[],'No external requests should even be attempted')
  }finally{await h.close()}
})
