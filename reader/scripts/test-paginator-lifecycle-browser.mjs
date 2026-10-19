import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'

// Actual iframe/animation ownership, not a replacement paginator model.
test('real paginator: committed rapid turns, selection, late section/iframe and animation close', { timeout: 90000 }, async () => {
  let server, browser
  try {
    server = await createServer({ root: readerRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 4412, strictPort: true } })
    await server.listen();browser=await chromium.launch({channel:'msedge',headless:true})
    const context=await browser.newContext({viewport:{width:930,height:1240},serviceWorkers:'block'})
    await context.route('**/*',route=>{const u=new URL(route.request().url());return /^https?:$/.test(u.protocol)&&u.origin!=='http://127.0.0.1:4412'?route.abort():route.continue()})
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.route('**/lifecycle.html',route=>route.fulfill({contentType:'text/html',body:`<style>html,body{margin:0;width:100%;height:100%}foliate-paginator{width:930px;height:1240px}</style><script type="module">
      import {Paginator} from '/src/vendor/foliate/paginator.js';
      window.fresh=()=>{const p=new Paginator();document.body.append(p);return p};
      window.section=()=>URL.createObjectURL(new Blob(['<html><body>'+Array.from({length:900},(_,i)=>'<p>Paragraph '+i+' '+'Readable synthetic text '.repeat(25)+'</p>').join('')+'</body></html>'],{type:'text/html'}));
      window.ready=true;
    </script>`}))
    await page.goto('http://127.0.0.1:4412/lifecycle.html');await page.waitForFunction(()=>window.ready)
    const rapid=await page.evaluate(async()=>{
      const p=fresh(),url=section();p.open({sections:[{load:()=>url}]});await p.goTo({index:0});
      let relocations=0;p.addEventListener('relocate',()=>relocations++);
      for(let i=0;i<100;i++)await p.next();
      const forward=relocations;await p.prev();
      const doc=p.getContents()[0].doc,range=doc.createRange();range.selectNodeContents(doc.body.firstElementChild);await p.scrollToAnchor(range,true);
      const selected=doc.getSelection().toString();p.destroy();p.remove();URL.revokeObjectURL(url);
      return{forward,backward:relocations>forward,selected:selected.startsWith('Paragraph')};
    })
    assert.equal(rapid.forward,100);assert.equal(rapid.backward,true);assert.equal(rapid.selected,true)
    const late=await page.evaluate(async()=>{
      const p=fresh(),url=section();let resolveOld;
      p.open({sections:[{load:()=>new Promise(r=>resolveOld=r)}]});const pending=p.goTo({index:0});
      await Promise.resolve();
      p.destroy();p.open({sections:[{load:()=>url}]});await p.goTo({index:0});const doc=p.getContents()[0].doc;
      let events=0;p.addEventListener('load',()=>events++);p.addEventListener('create-overlayer',()=>events++);
      resolveOld(url);await pending;const same=p.getContents()[0].doc===doc;
      p.destroy();p.remove();URL.revokeObjectURL(url);return{same,events};
    })
    assert.deepEqual(late,{same:true,events:0})
    let seen;const requested=new Promise(r=>seen=r);let release;const response=new Promise(r=>release=r)
    await page.route('**/slow-section.html',async route=>{seen();await response;await route.fulfill({contentType:'text/html',body:'<html><body>Late</body></html>'})})
    await page.evaluate(()=>{
      window.slow=fresh();slow.open({sections:[{load:()=>'/slow-section.html'}]});window.settled=false;
      window.pending=slow.goTo({index:0}).then(()=>window.settled=true);
    })
    await requested
    await page.evaluate(()=>slow.destroy());await page.waitForFunction(()=>window.settled,{},{timeout:3000})
    release();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    assert.equal(await page.evaluate(()=>{const n=slow.getContents().length;slow.remove();return n}),0)
    const animated=await page.evaluate(async()=>{
      const p=fresh(),url=section();p.open({sections:[{load:()=>url}]});await p.goTo({index:0});p.setAttribute('animated','');
      const turn=p.next();p.destroy();let events=0;p.addEventListener('relocate',()=>events++);
      await turn;p.remove();URL.revokeObjectURL(url);return events;
    })
    assert.equal(animated,0);assert.deepEqual(errors,[])
    console.log(JSON.stringify({rapid,late,iframeCloseSettled:true,animatedLateRelocations:animated,pageErrors:errors}))
  } finally {await browser?.close();await server?.close()}
})
