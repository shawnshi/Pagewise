import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHarness } from './test-book-tag-storage.mjs'

const artifacts=resolve(import.meta.dirname,'../../.cache/book-tags/browser')
await mkdir(artifacts,{recursive:true})

test('real detail, classification, role manager and filter/session interactions; synthetic data only', async () => {
  const h=await createHarness(), page=h.page, base=new URL(page.url()).origin
  const report={checks:[],pageErrors:[],externalAttempts:[],aiRequests:[],physicalDevice:false,liveProvider:false}
  const check=async(name,fn)=>{await fn();report.checks.push(name);console.log(`PASS ${name}`)}
  const read=async id=>page.evaluate(async id=>(await(await import('/src/storage/index.ts')).getStorage()).getBook(id),id)
  const tid=id=>page.getByTestId(id)
  let mode='valid'
  const description='这是面向儿童的数学读物，通过几何图形的实例解释数学规律，讨论空间形状与逻辑推理，提供实质性的知识介绍。'
  try {
    page.on('pageerror',e=>report.pageErrors.push(e.message))
    await page.context().route('https://fixture.invalid/**',async route=>{
      const payload=route.request().postDataJSON();report.aiRequests.push(payload)
      const data=JSON.parse(payload.messages[1].content)
      const entry=value=>({value,evidence:description})
      const answer=mode==='invalid'?'not JSON':JSON.stringify({status:'classified',category:data.requested.category?entry('science-mathematics'):null,topics:Array.from({length:data.requested.topics},(_,i)=>entry(i?'数学':'几何')),feature:null,facets:{}})
      await route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({choices:[{delta:{content:answer}}]})}\n\ndata: [DONE]\n\n`})
    })
    page.on('request',req=>{const url=new URL(req.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==base&&url.hostname!=='fixture.invalid')report.externalAttempts.push(url.origin)})
    await page.evaluate(()=>localStorage.setItem('lightread-settings',JSON.stringify({version:14,language:'zh',aiProvider:'deepseek',aiBaseUrl:'https://fixture.invalid/v1',aiModel:'fixture',aiApiKey:'fixture-key',sync:{autoSync:false}})))
    const ids=await page.evaluate(async description=>{
      const s=await(await import('/src/storage/index.ts')).getStorage()
      const make=(title,tags,extra={})=>s.addBook({title,author:'Synthetic author',format:'txt',fileName:'fixture.txt',addedAt:1,tags,description,...extra},new Blob(['SYNTHETIC BODY NEVER SENT']))
      return [await make('Classification fixture',['legacy']),await make('Plain fixture',['legacy','keep'])]
    },description)
    await page.goto(`${base}/#/book/${ids[0]}`)
    await tid('classification-panel').waitFor()
    await check('no generation on mount; manual draft and independent facets',async()=>{
      assert.equal(report.aiRequests.length,0)
      await tid('select-category').selectOption('science-mathematics')
      await tid('input-new-topic').fill('数学');await tid('btn-add-topic').click()
      await tid('input-facet-audience').fill('儿童')
      await tid('select-facet-textbook').selectOption('false')
      assert.equal((await read(ids[0])).classification,undefined)
    })
    await check('one click generates without disclosure; completion preserves unsaved manual assignments',async()=>{
      await tid('btn-generate-classification').click()
      assert.equal(await tid('ai-disclosure-modal').count(),0)
      await tid('topic-chip').filter({hasText:'几何'}).waitFor()
      assert.equal(await tid('topic-chip').count(),2)
      assert.equal(await tid('input-facet-audience').inputValue(),'儿童')
      assert.equal(await tid('btn-generate-classification').isDisabled(),true)
      assert.equal((await read(ids[0])).classification,undefined)
      assert.equal(report.aiRequests.length,1)
      assert.ok(!JSON.stringify(report.aiRequests).includes('SYNTHETIC BODY'))
      assert.ok(!Object.hasOwn(JSON.parse(report.aiRequests[0].messages[1].content).existing,'legacyTags'))
      await tid('btn-save-classification').click()
      await page.waitForFunction(id=>new Promise(resolve=>{const q=indexedDB.open('lightread');q.onsuccess=()=>{const db=q.result,r=db.transaction('books').objectStore('books').get(id);r.onsuccess=()=>{resolve(r.result.classification?.revision===1);db.close()}}}),ids[0])
      assert.equal((await read(ids[0])).classification.facets.textbook,false)
    })
    await check('keyboard editing, accessible lock, pointer long-press and locked deletion confirmation',async()=>{
      await tid('btn-edit-topic').first().focus();await page.keyboard.press('Enter')
      await tid('checkbox-tag-lock').check();await tid('tag-edit-dialog').getByRole('button',{name:'保存',exact:true}).click()
      assert.match(await tid('topic-chip').first().innerText(),/\[锁\]/)
      const chip=tid('topic-chip').first();await chip.scrollIntoViewIfNeeded();const box=await chip.boundingBox()
      await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.waitForTimeout(550);await page.mouse.up()
      await tid('tag-edit-dialog').waitFor();await tid('btn-delete-tag').click()
      assert.equal(await tid('topic-chip').count(),2)
      await tid('btn-delete-tag').click();assert.equal(await tid('topic-chip').count(),1)
      assert.match(await tid('classification-status').innerText(),/未完整|不完整|待补全/)
      await tid('topic-chip').first().click({button:'right'});await tid('tag-edit-dialog').waitFor();await page.keyboard.press('Escape')
      assert.equal(await tid('tag-edit-dialog').count(),0)
      await tid('btn-save-classification').click()
      await page.waitForTimeout(100)
      assert.equal((await read(ids[0])).classification.topics.length,1)
    })
    await check('invalid AI output leaves draft and persisted tags unchanged',async()=>{
      mode='invalid';const before=await read(ids[0])
      await tid('btn-generate-classification').click()
      await tid('classification-error').waitFor()
      assert.deepEqual(await read(ids[0]),before)
      assert.equal(await tid('topic-chip').count(),1)
    })
    await check('empty facets omitted on save; category lock has explicit unlock control',async()=>{
      await tid('input-facet-audience').fill('')
      await tid('btn-edit-category').click();await tid('checkbox-tag-lock').check();await tid('tag-edit-dialog').getByRole('button',{name:'保存',exact:true}).click()
      assert.equal(await tid('select-category').isDisabled(),true)
      await tid('btn-edit-category').click();await tid('checkbox-tag-lock').uncheck();await tid('tag-edit-dialog').getByRole('button',{name:'保存',exact:true}).click()
      assert.equal(await tid('select-category').isDisabled(),false)
      await tid('btn-save-classification').click();await page.waitForTimeout(100)
      assert.equal((await read(ids[0])).classification.facets.audience,undefined)
    })
    await page.goto(`${base}/#/library`)
    await page.locator('.book-card').first().waitFor()
    await check('advanced filters preview, cancel, apply, reload and reset distinguish false from unknown',async()=>{
      await page.locator('.open-filter').click()
      const dialog=page.locator('#library-filters')
      await dialog.locator('select').filter({has:page.locator('option[value="science-mathematics"]')}).selectOption('science-mathematics')
      assert.match(await dialog.innerText(),/1/)
      await page.keyboard.press('Escape');assert.equal(await page.locator('.book-card').count(),2)
      await page.locator('.open-filter').click()
      await dialog.locator('select').filter({has:page.locator('option[value="science-mathematics"]')}).selectOption('science-mathematics')
      await dialog.locator('.apply-filter').click()
      assert.equal(await page.locator('.book-card').count(),1)
      await page.reload();await page.locator('.book-card').waitFor();assert.equal(await page.locator('.book-card').count(),1)
      await page.getByRole('button',{name:'清空全部',exact:true}).click();assert.equal(await page.locator('.book-card').count(),2)
    })
    await check('global legacy manager preserves plain books and reports role-scoped affected count',async()=>{
      await page.getByRole('button',{name:'管理标签',exact:true}).click()
      await page.locator('.tag-role-select').selectOption('legacy')
      const row=page.locator('.tag-manage-item').filter({has:page.locator('.tag-manage-name',{hasText:'legacy'})})
      await row.getByRole('button',{name:'重命名',exact:true}).click();await page.locator('.tag-rename-input').fill('merged')
      page.once('dialog',async d=>{assert.match(d.message(),/2/);await d.accept()})
      await page.locator('.tag-manage-item').filter({has:page.locator('input')}).getByRole('button',{name:'保存',exact:true}).click()
      await page.waitForTimeout(150)
      assert.deepEqual((await read(ids[1])).tags,['merged','keep'])
      assert.equal((await read(ids[1])).classification,undefined)
      assert.deepEqual((await read(ids[0])).classification.legacyTags,['merged'])
      assert.equal(await page.locator('.tag-manage-name',{hasText:'自然科学与数学'}).count(),0)
    })
    await page.screenshot({path:resolve(artifacts,'library-manager.png'),fullPage:true})
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.externalAttempts,[])
  } finally {
    await writeFile(resolve(artifacts,'report.json'),JSON.stringify(report,null,2))
    await h.close()
  }
})

test('BT-REVIEW-01: normalized manager confirmations equal committed alias/whitespace scope', async () => {
  const h = await createHarness(), page = h.page, base = new URL(page.url()).origin
  const report = { cases: [], pageErrors: [], externalAttempts: [] }
  const readBooks = () => page.evaluate(async () =>
    (await (await import('/src/storage/index.ts')).getStorage()).listBooks())
  try {
    page.on('pageerror', error => report.pageErrors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) report.externalAttempts.push(url.origin)
    })
    await page.evaluate(() => localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, language: 'zh', sync: { autoSync: false } })))
    for (const [role, operation] of [['legacy', 'delete'], ['legacy', 'merge'], ['topic', 'merge'], ['feature', 'delete']]) {
      const ids = await page.evaluate(async role => {
        const storage = await (await import('/src/storage/index.ts')).getStorage()
        const { createClassification } = await import('/src/services/bookClassification.ts')
        for (const book of await storage.listBooks()) await storage.deleteBook(book.id)
        const ids = []
        const variants = [['AI', '人工智能'], ['人工智能'], [' ＡＩ '], [' Artificial   Intelligence ']]
        for (const [index, tags] of variants.entries()) {
          const classification = role === 'legacy' && index < 3 ? undefined : createClassification(role === 'legacy' ? tags : [])
          if (classification && role !== 'legacy') {
            const tag = { value: tags[0], locked: index === 0, source: 'manual' }
            if (role === 'topic') classification.topics = [tag]
            else classification.feature = tag
          }
          ids.push(await storage.addBook({ title: `Alias fixture ${index}`, author: 'Synthetic', format: 'txt', fileName: 'fixture.txt', addedAt: 1, tags, classification }, new Blob(['SYNTHETIC'])))
        }
        const unrelated = createClassification(role === 'legacy' ? [] : ['AI'])
        if (role === 'legacy') unrelated.topics = [{ value: 'AI', locked: true, source: 'manual' }]
        await storage.addBook({ title: 'Unrelated role fixture', author: 'Synthetic', format: 'txt', fileName: 'fixture.txt', addedAt: 1, tags: [], classification: unrelated }, new Blob(['SYNTHETIC']))
        return ids
      }, role)
      await page.goto(`${base}/#/library`)
      await page.reload()
      await page.locator('.book-card').first().waitFor()
      await page.getByRole('button', { name: '管理标签', exact: true }).click()
      await page.locator('.tag-role-select').selectOption(role)
      const row = page.locator('.tag-manage-item').filter({ has: page.locator('.tag-manage-name', { hasText: /^人工智能$/ }) })
      const displayedCount = await row.locator('.tag-manage-count').innerText()
      const before = await readBooks()
      const trigger = async accept => {
        if (operation === 'merge') {
          await row.getByRole('button', { name: '重命名', exact: true }).click()
          await page.locator('.tag-rename-input').fill('计算方法')
        }
        const dialogPromise = page.waitForEvent('dialog')
        const click = operation === 'merge'
          ? page.locator('.tag-manage-item').filter({ has: page.locator('input') }).getByRole('button', { name: '保存', exact: true }).click()
          : row.getByRole('button', { name: '删除', exact: true }).click()
        const dialog = await dialogPromise, message = dialog.message()
        await (accept ? dialog.accept() : dialog.dismiss())
        await click
        return message
      }
      const cancelled = await trigger(false)
      assert.deepEqual(await readBooks(), before, 'Cancelled confirmation must write nothing')
      if (operation === 'merge') await page.locator('.tag-manage-item').filter({ has: page.locator('input') }).getByRole('button', { name: '取消', exact: true }).click()
      const confirmed = await trigger(true)
      await page.waitForFunction(async ids => {
        const storage = await (await import('/src/storage/index.ts')).getStorage()
        const books = await Promise.all(ids.map(id => storage.getBook(id)))
        return books.every(book => !(book.classification?.legacyTags ?? book.tags).includes('AI') &&
          !book.classification?.topics.some(tag => tag.value === '人工智能') && book.classification?.feature?.value !== '人工智能')
      }, ids)
      const after = await readBooks()
      const changedIds = after.filter(book => JSON.stringify(book) !== JSON.stringify(before.find(old => old.id === book.id))).map(book => book.id).sort()
      const locked = role === 'legacy' ? 0 : 1
      report.cases.push({ role, operation, displayedCount, cancelled, confirmed, expectedAffected: ids.length, expectedLocked: locked, committedAffected: changedIds.length })
      console.log(JSON.stringify(report.cases.at(-1)))
      assert.deepEqual(changedIds, [...ids].sort(), 'Only matching books in this role may change')
      assert.match(confirmed, new RegExp(`影响 ${changedIds.length} 本书（其中包含 ${locked} 个已锁定标签）`))
      assert.equal(cancelled, confirmed)
      assert.equal(displayedCount, `(${ids.length})`, 'Manager groups all equivalent aliases once per book')
      if (operation === 'merge' && role === 'topic') assert.equal(after.find(book => book.id === ids[0]).classification.topics[0].locked, true)
      await page.locator('.tag-manage-modal .form-actions button').click()
    }
    assert.deepEqual(report.pageErrors, [])
    assert.deepEqual(report.externalAttempts, [])
  } finally {
    await writeFile(resolve(artifacts, 'review-01-report.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
