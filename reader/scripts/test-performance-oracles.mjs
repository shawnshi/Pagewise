import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { statistics, assertCompletion, waitForCommit, syntheticFixtures, installObserver, browserCommit } from './perf-five-stage.mjs'

test('nearest-rank tails retain outliers; reject empty/NaN samples', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.deepEqual([statistics(values).p50, statistics(values).p95, statistics(values).p99], [50, 95, 99])
  assert.equal(statistics(values).max, 100)
  assert.match(statistics([5]).tailEvidence, /exploratory/)
  for (const input of [[], [NaN], [-1], [Infinity]]) assert.throws(() => statistics(input))
})
test('unfinished, wrong-target, blank and missing-clock results cannot become fast samples', async () => {
  const before = { identity: 'cfi-a', section: 0 }
  const valid = { ready: true, identity: 'cfi-b', section: 1, eventAt: 10, doneAt: 35 }
  assert.equal(assertCompletion(before, valid, 'chapter', 1), 25)
  for (const after of [{ ...valid, identity: before.identity }, { ...valid, ready: false }, { ...valid, eventAt: null }, { ...valid, doneAt: 1 }, { ...valid, section: 9 }]) assert.throws(() => assertCompletion(before, after, 'chapter', 1))
  await assert.rejects(waitForCommit(async () => ({ ...valid, identity: before.identity }), before, { timeout: 20 }), /unfinished action timed out/)
  await assert.rejects(waitForCommit(async () => ({ ...valid, section: 9 }), before, { timeout: 20, expected: 1 }), /timed out/)
  await assert.rejects(waitForCommit(async () => { throw Error('dependency failed') }, before), /dependency failed/)
  assert.deepEqual(await waitForCommit(async () => valid, before), valid)
})
test('fixtures stay byte-identical across ZIP timestamp ticks', async () => {
  const a = syntheticFixtures()
  await new Promise(resolve => setTimeout(resolve, 2100))
  const b = syntheticFixtures()
  for (const f of ['pdf', 'epub', 'txt']) assert.deepEqual(a[f], b[f])
  assert.match(a.pdf.toString(), /^%PDF-1.4/)
  assert.match(a.pdf.toString(), /\/Count 120/)
  assert.match(a.txt.toString(), /第12章/)
})
test('real Edge oracle rejects changed page without bitmap and unchanged completed bitmap', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => route.request().url() === 'http://127.0.0.1:4388/' ? route.fulfill({ contentType: 'text/html', body: '<html><input class="page-input" value="1"><div class="p-holder" data-page="1"><div class="p-canvas"></div></div><button>Turn</button></html>' }) : route.abort())
    await context.addInitScript(installObserver)
    const page = await context.newPage()
    await page.goto('http://127.0.0.1:4388/')
    await page.evaluate(() => {
      window.paint = page => {
        document.querySelector('.page-input').value = String(page)
        const holder = document.querySelector('.p-holder'); holder.dataset.page = String(page)
        const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 30
        const ctx = canvas.getContext('2d'); const gray = Math.round((.1 + (page - 1) / 200) * 255)
        ctx.fillStyle = `rgb(${gray},${gray},${gray})`; ctx.fillRect(0, 0, 30, 30)
        holder.querySelector('.p-canvas').replaceChildren(canvas)
      }
      window.paint(1)
      window.__perfProbe.armed = true
    })
    const before = await page.evaluate(() => window.__perfRead('pdf'))
    assert.equal(before.ready, true)
    await page.locator('button').click()
    await assert.rejects(browserCommit(page, before, 'pdf', 100, 2), /Timeout/)
    await page.evaluate(() => { document.querySelector('.page-input').value = '2'; document.querySelector('.p-holder').dataset.page = '2'; document.querySelector('canvas').remove() })
    await assert.rejects(browserCommit(page, before, 'pdf', 100, 2), /Timeout/)
    await page.evaluate(() => window.paint(2))
    const after = await browserCommit(page, before, 'pdf', 1000, 2)
    assert.equal(after.section, 2); assert.ok(after.ms >= 0)
  } finally { await browser.close() }
})
