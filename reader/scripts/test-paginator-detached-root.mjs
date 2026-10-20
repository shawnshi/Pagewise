import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer, readerRoot } from './vite-isolated.mjs'

test('production paginator render tolerates a document emptied during unload', { timeout: 90000 }, async () => {
  let server, browser
  const origin = 'http://127.0.0.1:4424'
  try {
    server = await createServer({ root: readerRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 4424, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const context = await browser.newContext({ viewport: { width: 930, height: 1240 }, serviceWorkers: 'block' })
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      return /^https?:$/.test(url.protocol) && url.origin !== origin ? route.abort() : route.continue()
    })
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/detached-root.html', route => route.fulfill({ contentType: 'text/html', body: '<style>html,body{margin:0;width:100%;height:100%}foliate-paginator{width:930px;height:1240px}</style>' }))
    await page.goto(`${origin}/detached-root.html`)
    const result = await page.evaluate(async () => {
      const { Paginator } = await import('/src/vendor/foliate/paginator.js')
      const p = new Paginator()
      const url = URL.createObjectURL(new Blob(['<html><head><style>body{background:rgb(12,34,56)}</style></head><body><p>Detached-root synthetic text</p></body></html>'], { type: 'text/html' }))
      document.body.append(p)
      try {
        p.open({ sections: [{ load: () => url }] })
        await p.goTo({ index: 0 })
        p.render()
        const doc = p.getContents()[0].doc
        const liveText = doc.body.textContent
        doc.documentElement.remove()
        const removed = doc.documentElement === null
        // The actual ResizeObserver callback calls this public production method.
        p.render()
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return { liveText, removed, renderSettled: true }
      } finally {
        p.destroy()
        p.remove()
        URL.revokeObjectURL(url)
      }
    })
    assert.deepEqual(result, { liveText: 'Detached-root synthetic text', removed: true, renderSettled: true })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ ...result, pageErrors: errors }))
  } finally {
    await browser?.close()
    await server?.close()
  }
})
