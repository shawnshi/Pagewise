import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import zh from '../src/i18n/zh.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runName = process.env.UI_E2E_RUN || 'browser'
if (!/^[a-zA-Z0-9_-]+$/.test(runName)) throw new Error('Invalid artifact run name')
const artifacts = resolve(root, '../.cache/ui-v02-20261017-01', runName)
const fixtures = resolve(root, '../.cache/ui-v02-20261017-01/fixtures')
mkdirSync(artifacts, { recursive: true })
const port = 4189, base = `http://127.0.0.1:${port}`
const report = { status: 'RUNNING', syntheticOnly: true, nativeDeviceTested: false, checks: [], blockedExternalOrigins: [], pageErrors: [], screenshots: [] }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore','pipe','pipe'] })
let serverLog = '', browser, page, context
const t = key => zh[key]
async function step(name, fn) {
  report.active = name
  await fn()
  report.checks.push({ name, passed: true })
  writeFileSync(join(artifacts,'report.json'), JSON.stringify(report,null,2))
}
async function screenshot(name) {
  await page.screenshot({ path: join(artifacts,name) })
  report.screenshots.push(name)
}
async function readerReady() {
  await page.locator('foliate-view').waitFor({ state:'attached',timeout:20000 })
  await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().some(c => c.doc?.body?.textContent?.includes('合成')), undefined, { timeout:20000 })
}
async function showTools() {
  if (await page.locator('.bar-peek.top').count()) await page.locator('.bar-peek.top').dispatchEvent('mouseenter')
}
async function openTypography() {
  await showTools()
  await page.getByRole('button',{ name:t('reader.typography'),exact:true }).click()
  await page.locator('.settings-pop').waitFor({state:'visible'})
}
async function bodyFont() {
  return page.evaluate(() => {
    const doc=document.querySelector('foliate-view').renderer.getContents()[0].doc
    return doc.defaultView.getComputedStyle(doc.documentElement).fontSize
  })
}
async function setDraftFont(value) {
  await page.locator('.settings-pop input[type="range"]').first().evaluate((input,v)=>{input.value=String(v);input.dispatchEvent(new Event('input',{bubbles:true}))},value)
}
async function bookRecord(id) {
  return page.evaluate(id=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('lightread')
    request.onerror=()=>reject(request.error)
    request.onsuccess=()=>{ const db=request.result; const get=db.transaction('books').objectStore('books').get(id);get.onerror=()=>reject(get.error);get.onsuccess=()=>{ const b=get.result;db.close();resolve(b ? {location:b.location,progress:b.progress,lastReadAt:b.lastReadAt}:null) } }
  }),id)
}
async function settingsRecord() {
  return page.evaluate(()=>{
    const s=JSON.parse(localStorage.getItem('lightread-settings')||'{}')
    return { reader:s.reader, books:s.typographyBooks, languages:s.typographyLanguages }
  })
}

try {
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Preview start timeout')),10000)
    function collect(chunk){serverLog+=chunk;if(serverLog.replace(/\u001b\[[0-9;]*m/g,'').includes(base)){clearTimeout(timeout);resolve()}}
    server.stdout.on('data',collect);server.stderr.on('data',collect)
    server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Preview exited ${code}`))})
  })
  assert.equal((await fetch(base)).status,200)
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
  context=await browser.newContext({viewport:{width:992,height:1323},deviceScaleFactor:1.875,reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=new URL(route.request().url())
    if(['http:','https:'].includes(url.protocol)&&url.origin!==base){report.blockedExternalOrigins.push(url.origin);return route.abort('blockedbyclient')}
    return route.continue()
  })
  await context.addInitScript(()=>{
    if(!localStorage.getItem('lightread-settings'))localStorage.setItem('lightread-settings',JSON.stringify({language:'zh',version:14,appearance:'dark',readingMode:{eink:{enabled:true}},reader:{theme:'light',flow:'paginated',portraitScroll:false},dianjing:{enabled:false},sync:{autoSync:false}}))
  })
  page=await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror',error=>report.pageErrors.push(error.message))
  await page.goto(`${base}/#/library`)
  await step('import 15 generated books and render a list with independent actions',async()=>{
    await page.locator('input[type="file"]').first().waitFor({state:'attached'})
    const files=Array.from({length:14},(_,i)=>join(fixtures,`UI-Library-${String(i+1).padStart(2,'0')}.txt`))
    files.push(join(fixtures,'UI-Source.epub'))
    await page.locator('input[type="file"]').first().setInputFiles(files)
    await page.waitForFunction(()=>new Promise(resolve=>{const q=indexedDB.open('lightread');q.onsuccess=()=>{const d=q.result;const r=d.transaction('books').objectStore('books').count();r.onsuccess=()=>{d.close();resolve(r.result===15)}}}))
    await page.locator('.import-bar').waitFor({state:'hidden'})
    assert.equal(await page.locator('.book-card').count(),12)
    const bodies=await page.locator('.book-card .book-body').count()
    assert.equal(bodies,12)
    assert.equal(await page.locator('.book-body button').count(),0)
    assert.match(await page.locator('.read-action').first().innerText(),/阅读|继续/)
    const contrast=await page.locator('.read-action').first().evaluate(el=>{
      const style=getComputedStyle(el)
      const luminance=value=>{const c=value.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4});return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722}
      const values=[luminance(style.color),luminance(style.backgroundColor)].sort((a,b)=>a-b)
      return {foreground:style.color,background:style.backgroundColor,ratio:(values[1]+0.05)/(values[0]+0.05),height:el.getBoundingClientRect().height}
    })
    assert.ok(contrast.ratio>=4.5);assert.ok(contrast.height>=48)
    report.readActionContrast=contrast
    assert.equal(await page.locator('html.pagewise-eink[data-theme="light"]').count(),1)
    assert.equal(await page.locator('.sidebar .nav a').count(),3)
    await screenshot('01-library.png')
  })
  await step('advanced filter changes are a draft; Escape cancels and Apply commits once',async()=>{
    await page.locator('.open-filter').click()
    const dialog=page.locator('.advanced-filter-dialog')
    await dialog.waitFor({state:'visible'})
    await dialog.getByLabel(t('library.filterFormat'),{exact:true}).selectOption('epub')
    assert.equal(await page.locator('.book-card').count(),12)
    await screenshot('02-filter-draft.png')
    await page.keyboard.press('Escape')
    await dialog.waitFor({state:'detached'})
    assert.equal(await page.locator('.book-card').count(),12)
    await page.locator('.open-filter').click()
    await dialog.getByLabel(t('library.filterFormat'),{exact:true}).selectOption('epub')
    await dialog.locator('.apply-filter').click()
    await page.waitForFunction(()=>document.querySelectorAll('.book-card').length===1)
    assert.match(await page.locator('.active-chips').innerText(),/EPUB/)
    await page.getByRole('button',{name:'清空全部',exact:true}).click()
  })
  await step('detail and reload preserve query page and visible list item',async()=>{
    await page.locator('select.sort').selectOption('title')
    await page.locator('.pagination').getByRole('button',{name:t('library.nextPage'),exact:true}).click()
    const first=page.locator('.book-card').first()
    const title=await first.locator('.title').innerText()
    const pageLabel=await page.locator('.pagination [role="status"]').innerText()
    await first.locator('.book-body').click()
    await page.locator('.book-detail').waitFor({state:'visible'})
    assert.equal(await page.locator('.book-detail .book-title').innerText(),title)
    await screenshot('03-detail.png')
    await page.locator('.book-detail .detail-header button').first().click()
    await page.locator('.book-card').first().waitFor()
    assert.equal(await page.locator('.pagination [role="status"]').innerText(),pageLabel)
    assert.equal(await page.locator('.book-card .title').first().innerText(),title)
    await page.goto(`${base}/#/library`)
    assert.equal(await page.locator('.pagination [role="status"]').innerText(),pageLabel)
  })
  await step('explicit Read action enters reader without visiting details',async()=>{
    const search=page.locator('input[type="search"]').first()
    await search.fill('UI-Source')
    await page.waitForFunction(()=>document.querySelectorAll('.book-card').length===1)
    await page.locator('.book-card .read-action').click()
    await readerReady()
    assert.equal(await page.locator('.book-detail').count(),0)
    await screenshot('04-reader.png')
  })
  await step('typography Cancel leaves persistence and real iframe CSS unchanged',async()=>{
    const before=await settingsRecord(),font=await bodyFont()
    await openTypography()
    await setDraftFont(25)
    assert.equal(await bodyFont(),font)
    assert.deepEqual(await settingsRecord(),before)
    await screenshot('05-typography-preview.png')
    await page.locator('.settings-pop').getByRole('button',{name:t('common.cancel'),exact:true}).click()
    await page.locator('.settings-pop').waitFor({state:'detached'})
    assert.equal(await bodyFont(),font)
  })
  await step('host failure rolls back the body, retains draft and allows an actual successful retry',async()=>{
    const before=await settingsRecord(),font=await bodyFont()
    await openTypography();await setDraftFont(25)
    await page.evaluate(()=>{
      const r=document.querySelector('foliate-view').renderer,original=r.goTo
      let fail=true
      r.goTo=function(...args){if(fail){fail=false;return Promise.reject(new Error('synthetic navigation failure'))}return original.apply(this,args)}
    })
    await page.locator('.settings-pop .tp-actions .btn-primary').click()
    await page.waitForFunction(()=>document.querySelector('.tp-error-banner')?.textContent?.includes('synthetic navigation failure'))
    assert.equal(await bodyFont(),font)
    assert.deepEqual(await settingsRecord(),before)
    assert.equal(await page.locator('.settings-pop input[type="range"]').first().inputValue(),'25')
    const id=decodeURIComponent(new URL(page.url()).hash.split('/read/')[1].split('?')[0])
    const positionBeforeRetry=await bookRecord(id)
    assert.equal(typeof positionBeforeRetry.location,'string')
    await screenshot('06-typography-rollback.png')
    await page.locator('.settings-pop .tp-error-banner').getByRole('button',{name:t('common.retry'),exact:true}).click()
    await page.locator('.settings-pop').waitFor({state:'detached'})
    assert.equal(await bodyFont(),'25px')
    const saved=await settingsRecord()
    assert.equal(saved.books[id].fontSize,25)
    assert.equal((await bookRecord(id)).location,positionBeforeRetry.location)
  })
  await step('footnote inspection and Return never overwrite the primary reading position',async()=>{
    const id=decodeURIComponent(new URL(page.url()).hash.split('/read/')[1].split('?')[0])
    const before=await bookRecord(id)
    await page.evaluate(()=>document.querySelector('foliate-view').renderer.getContents()[0].doc.querySelector('a[href="#note1"]').click())
    await page.locator('.inspection-bar').waitFor({state:'visible'})
    await page.locator('.inspection-bar').getByRole('button',{name:t('reader.continueHere'),exact:true}).waitFor({state:'visible'})
    assert.equal(await page.locator('.inspection-bar').getByRole('button',{name:t('reader.continueHere'),exact:true}).isEnabled(),true)
    // Observe one full progress-debounce horizon to detect a late accidental write.
    await page.waitForTimeout(800)
    assert.equal((await bookRecord(id)).location,before.location)
    await screenshot('source-inspection.png')
    await page.locator('.inspection-bar').getByRole('button',{name:t('reader.returnToReading'),exact:true}).click()
    await page.locator('.inspection-bar').waitFor({state:'detached'})
    await page.waitForTimeout(800)
    assert.equal((await bookRecord(id)).location,before.location)
  })
  await step('20 selection mouseup/click sequences do not turn pages; Reader draft survives immediate close',async()=>{
    const id=decodeURIComponent(new URL(page.url()).hash.split('/read/')[1].split('?')[0])
    const before=await bookRecord(id)
    await page.evaluate(()=>{
      const doc=document.querySelector('foliate-view').renderer.getContents()[0].doc
      const p=doc.querySelector('p[id]'),walker=doc.createTreeWalker(p,doc.defaultView.NodeFilter.SHOW_TEXT),node=walker.nextNode()
      const range=doc.createRange();range.setStart(node,0);range.setEnd(node,Math.min(12,node.textContent.length))
      const selection=doc.defaultView.getSelection()
      for(let n=0;n<20;n++){
        selection.removeAllRanges();selection.addRange(range.cloneRange())
        doc.dispatchEvent(new doc.defaultView.Event('selectionchange'))
        doc.body.dispatchEvent(new doc.defaultView.MouseEvent('mouseup',{bubbles:true}))
        doc.body.dispatchEvent(new doc.defaultView.MouseEvent('click',{bubbles:true}))
      }
    })
    await page.waitForTimeout(800)
    assert.equal((await bookRecord(id)).location,before.location)
    report.selectionSequences=20
    await page.getByRole('button',{name:t('reader.writeNote'),exact:true}).click()
    const input=page.locator('.annotation-pop textarea')
    await input.fill('来自阅读器的合成草稿')
    await page.locator('.annotation-pop').getByRole('button',{name:t('common.cancel'),exact:true}).click()
    await input.waitFor({state:'detached'})
    const drafts=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('pagewise:note-draft:')).map(k=>JSON.parse(localStorage.getItem(k))))
    assert.ok(drafts.some(d=>d.text==='来自阅读器的合成草稿'))
  })
  await step('global notes restore draft, commit once and restore an intentionally empty draft',async()=>{
    await page.goto(`${base}/#/notes`)
    const edit=page.getByRole('button',{name:'编辑想法',exact:true}).first()
    await edit.click()
    const input=page.locator('.notes-view textarea')
    assert.equal(await input.inputValue(),'来自阅读器的合成草稿')
    await input.fill('已提交的合成想法')
    await page.locator('.notes-view .editor-buttons').getByRole('button',{name:t('common.save'),exact:true}).click()
    await input.waitFor({state:'detached'})
    assert.match(await page.locator('.notes-view').innerText(),/已提交的合成想法/)
    await edit.click();await input.fill('')
    await page.locator('.notes-view .editor-buttons').getByRole('button',{name:t('common.cancel'),exact:true}).click()
    await edit.click()
    assert.equal(await input.inputValue(),'')
    await screenshot('07-notes-empty-draft.png')
  })
  await step('storage quota failure cannot close the only unsaved input; formal note save remains possible',async()=>{
    await page.evaluate(()=>{const original=Storage.prototype.setItem;window.__restoreTestStorage=()=>{Storage.prototype.setItem=original};Storage.prototype.setItem=function(key,value){if(key.startsWith('pagewise:note-draft:'))throw new DOMException('synthetic quota','QuotaExceededError');return original.call(this,key,value)}})
    const input=page.locator('.notes-view textarea')
    await input.fill('存储失败时仍须保留的合成输入')
    await page.locator('.notes-view .editor-buttons').getByRole('button',{name:t('common.cancel'),exact:true}).click()
    assert.equal(await input.inputValue(),'存储失败时仍须保留的合成输入')
    await page.locator('.notes-view .editor-buttons').getByRole('button',{name:t('common.save'),exact:true}).click()
    await input.waitFor({state:'detached'})
    await page.evaluate(()=>window.__restoreTestStorage())
    assert.match(await page.locator('.notes-view').innerText(),/存储失败时仍须保留的合成输入/)
    await screenshot('08-notes.png')
  })
  await step('root startup restores last meaningful view; narrow screen remains usable',async()=>{
    await page.goto(base)
    await page.locator('.notes-view').waitFor()
    assert.match(page.url(),/#\/notes$/)
    await page.goto(`${base}/#/reading`)
    await page.locator('.sidebar .nav').waitFor({state:'visible'})
    assert.equal(await page.locator('.sidebar .nav a').count(),3)
    await page.goto(`${base}/#/notes`)
    await page.locator('.notes-view').waitFor()
    await page.setViewportSize({width:390,height:844})
    await screenshot('09-notes-narrow.png')
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)
    assert.equal(overflow,false)
    assert.deepEqual(report.pageErrors,[])
  })
  await step('English UI and disabling e-ink restore the saved dark appearance',async()=>{
    await page.evaluate(()=>{
      const settings=JSON.parse(localStorage.getItem('lightread-settings'))
      settings.language='en'
      settings.appearance='dark'
      settings.readingMode.eink.enabled=false
      localStorage.setItem('lightread-settings',JSON.stringify(settings))
    })
    await page.reload()
    await page.getByRole('tab',{name:/Thoughts \(/}).waitFor({state:'visible'})
    assert.equal(await page.locator('html[data-theme="dark"]').count(),1)
    assert.equal(await page.locator('html.pagewise-eink').count(),0)
    assert.deepEqual(report.pageErrors,[])
    await screenshot('10-english-dark.png')
  })
  report.status='PASSED'
} catch(error) {
  report.status='FAILED';report.error=error.stack||String(error)
  if(page&&!page.isClosed()){
    try{await page.screenshot({path:join(artifacts,'failure.png')});writeFileSync(join(artifacts,'failure-visible.txt'),(await page.locator('body').innerText()).slice(0,9000))}catch(captureError){report.captureError=String(captureError)}
  }
  process.exitCode=1
} finally {
  report.blockedExternalOrigins=[...new Set(report.blockedExternalOrigins)]
  writeFileSync(join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n')
  await browser?.close()
  server.kill()
  console.log(JSON.stringify(report,null,2))
}
