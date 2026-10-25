import assert from 'node:assert/strict'
import {test} from 'node:test'
import {resolve} from 'node:path'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import {createServer} from './vite-isolated.mjs'
const root=resolve(import.meta.dirname,'..'),base=resolve(root,'../.cache/stats-settings-ui-20261025',process.env.PW_UI_RUN??'browser-v1')
async function stress(page,scale,selector){await page.evaluate(({scale,selector})=>{const entries=[...document.querySelectorAll(selector)].filter(e=>!e.dataset.uiStress).map(e=>{const s=getComputedStyle(e);return[e,parseFloat(s.fontSize),parseFloat(s.lineHeight)]});for(const[e,font,line]of entries){e.dataset.uiStress='true';e.style.fontSize=font*scale+'px';if(Number.isFinite(line))e.style.lineHeight=line*scale+'px'}},{scale,selector})}
async function frame(page){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
async function geometry(page,selector){return page.locator(selector).evaluate(el=>({width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth+1,text:el.textContent?.slice(0,100)}))}
test('synthetic storage-backed statistics and settings presentation; no external services',{timeout:155000},async t=>{
 await mkdir(base,{recursive:true});const server=await createServer({root,logLevel:'error',cacheDir:resolve(base,'vite'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();let browser;const errors=[],external=[],renders=[]
 try{
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{}),args:['--disable-background-networking']});const page=await browser.newPage({viewport:{width:992,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(60000)
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin||['blob:','data:'].includes(u.protocol))return route.continue();external.push(u.origin);return route.abort()})
  await page.goto(origin+'/#/library',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#app')?.childElementCount>0)
  const today=await page.evaluate(async()=>{const{getStorage}=await import('/src/storage/index.ts'),{useLibrary}=await import('/src/stores/library.ts'),{useSettings}=await import('/src/stores/settings.ts'),log=await import('/src/services/readingLog.ts');const s=await getStorage(),settings=useSettings();settings.language='zh';settings.dailyGoalMinutes=30;settings.readingMode.eink.enabled=true;document.documentElement.classList.add('pagewise-eink');const id=await s.addBook({title:'合成阅读记录 Synthetic long book title without private content',author:'Synthetic author',format:'txt',fileName:'synthetic.txt',tags:[],addedAt:1,readingStatus:'reading'},new Blob(['Synthetic fixture only']));await log.recordReading({id,title:'Synthetic statistics fixture'},1800);await useLibrary().refresh();return log.localDay()})
  for(const [width,scale,dark]of [[320,1.8,false],[600,1.3,false],[992,1,false],[992,1.8,true]])await t.test(`stats ${width}px text stress ${scale} dark=${dark}`,async()=>{
   await page.setViewportSize({width,height:1000});await page.goto(origin+'/#/stats',{waitUntil:'domcontentloaded'});await page.waitForSelector('.stats-subnav');await page.evaluate(dark=>{document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.classList.add('pagewise-eink')},dark);await stress(page,scale,'.stats, .stats *');await frame(page)
   assert.equal(await page.getByRole('tab').count(),3);assert.match(await page.locator('.view-overview').innerText(),/30/);assert.ok(!(await geometry(page,'.stats')).overflow,'Statistics root overflows')
   await page.getByRole('tab',{name:'趋势',exact:true}).click();await page.locator('.view-trends').getByRole('button',{name:'年',exact:true}).click();await page.getByRole('tab',{name:'概览',exact:true}).click();await page.getByRole('tab',{name:'趋势',exact:true}).click();assert.equal(await page.locator('.view-trends button[aria-pressed="true"]').first().innerText(),'年')
   await page.getByRole('tab',{name:'日历',exact:true}).click();await page.locator('.calendar-date input').fill(today);await page.waitForSelector('.dd-panel');await stress(page,scale,'.dd-panel, .dd-panel *');await frame(page)
   const bounds=await page.locator('.dd-panel').boundingBox();assert.ok(bounds&&bounds.x>=-1&&bounds.y>=-1&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=1001,'Day sheet outside viewport')
   await page.keyboard.press('Escape');await page.waitForSelector('.dd-panel',{state:'detached'});assert.equal(await page.locator('.calendar-date input').evaluate(el=>document.activeElement===el),true)
   await page.getByRole('tab',{name:'概览',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'趋势',exact:true}).getAttribute('aria-selected'),'true');assert.equal(await page.getByRole('tab',{name:'趋势',exact:true}).evaluate(el=>document.activeElement===el),true)
   renders.push({kind:'stats',width,scale,dark,geometry:await geometry(page,'.stats')});await page.screenshot({path:resolve(base,`stats-${width}-${scale}-${dark}.png`)})
  })
  for(const [width,scale]of [[320,1.8],[600,1.3],[992,1]])await t.test(`settings directory ${width}px text stress ${scale}`,async()=>{
   await page.setViewportSize({width,height:1000});await page.goto(origin+'/#/settings',{waitUntil:'domcontentloaded'});await page.waitForSelector('.settings-sidebar');await stress(page,scale,'.settings, .settings *');await frame(page);assert.equal(await page.locator('.dir-item').count(),8)
   for(const group of ['general','folder','library-display','reading','ai','network','data','about']){if(width<960&&await page.locator('.back-btn:visible').count())await page.locator('.back-btn').click();await page.locator(`[data-section="${group}"]`).click();await frame(page);assert.equal(await page.locator(`#settings-${group}`).isVisible(),true);assert.equal(await page.locator('.settings .section:visible').count(),1)}
   await page.evaluate(()=>{location.hash='/settings?section=reading'});await page.waitForFunction(()=>document.querySelector('#settings-reading')?.getBoundingClientRect().height>0);assert.ok(!(await geometry(page,'.settings')).overflow,'Settings root overflows')
   if(width>=960){const nav=await page.locator('.settings-sidebar').boundingBox();assert.equal(Math.round(nav.width),232)}
   renders.push({kind:'settings',width,scale,geometry:await geometry(page,'.settings')});await page.screenshot({path:resolve(base,`settings-${width}-${scale}.png`)})
  })
  assert.deepEqual(external,[]);assert.deepEqual(errors,[])
 }finally{await writeFile(resolve(base,'result.json'),JSON.stringify({errors,external,renders,textStress:'CSS font/line-height stress, not Android OS fontScale',noPrivateLibrary:true,noRealModel:true},null,2));await browser?.close();await server.close()}
})
