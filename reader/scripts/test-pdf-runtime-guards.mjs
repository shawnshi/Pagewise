import assert from 'node:assert/strict'
import test from 'node:test'
import { pdfRenderTarget, PDF_MAX_RENDER_PIXELS, PDF_MAX_DIM } from '../src/services/pdfRenderBudget.ts'
import { retryWhileBusy, BUSY_RETRY_MS } from '../src/storage/sourceFile.ts'

const pixels = size => size.width * size.height

test('PDF target keeps full DPR for ordinary pages and a bounded total pixel budget', () => {
  const page = pdfRenderTarget(900, 1165, 2)
  assert.deepEqual(page, { width: 1800, height: 2330 })
  assert.ok(pixels(page) < PDF_MAX_RENDER_PIXELS)

  const zoomed = pdfRenderTarget(2700, 4050, 2)
  assert.ok(pixels(zoomed) <= PDF_MAX_RENDER_PIXELS, `${pixels(zoomed)} exceeds the budget`)
  assert.ok(Math.abs(zoomed.width / zoomed.height - 2700 / 4050) < 0.01, 'the cap preserves the page aspect ratio')

  const huge = pdfRenderTarget(20000, 30000, 4)
  assert.ok(huge.width <= PDF_MAX_DIM && huge.height <= PDF_MAX_DIM)
  assert.ok(pixels(huge) <= PDF_MAX_RENDER_PIXELS)
})

test('PDF target degrades to a valid 1x1 bitmap instead of NaN on bad input', () => {
  for (const size of [pdfRenderTarget(0, 0, 0), pdfRenderTarget(Number.NaN, 100, 2), pdfRenderTarget(-5, 20, -1)]) {
    assert.ok(Number.isSafeInteger(size.width) && size.width >= 1)
    assert.ok(Number.isSafeInteger(size.height) && size.height >= 1)
  }
})

test('busy folder reads retry with backoff and stop as soon as the scan releases the worker', async () => {
  const sleeps = []
  let runs = 0
  const result = await retryWhileBusy(async () => {
    runs++
    if (runs < 3) throw Object.assign(new Error('busy'), { code: 'busy' })
    return 'bytes'
  }, BUSY_RETRY_MS, async ms => { sleeps.push(ms) })
  assert.equal(result, 'bytes')
  assert.equal(runs, 3)
  assert.deepEqual(sleeps, BUSY_RETRY_MS.slice(0, 2))
})

test('busy retry never hides a real I/O or permission failure', async () => {
  let runs = 0
  await assert.rejects(retryWhileBusy(async () => {
    runs++
    throw Object.assign(new Error('denied'), { code: 'permission_denied' })
  }, BUSY_RETRY_MS, async () => {}), /denied/)
  assert.equal(runs, 1)
})

test('an exhausted busy retry still reports busy instead of a fake empty result', async () => {
  let runs = 0
  await assert.rejects(retryWhileBusy(async () => {
    runs++
    throw Object.assign(new Error('busy'), { code: 'busy' })
  }, [1, 2], async () => {}), /busy/)
  assert.equal(runs, 3)
})
