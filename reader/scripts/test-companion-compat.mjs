import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { DB_NAME, createMemoryCache, cacheKey, sectionKey, feedbackKey } from '../src/services/PagewiseCompanion/cache.ts'
import { migrateLevel, smartOnFor } from '../src/services/PagewiseCompanion/level.ts'
import { PROMPT_VERSION } from '../src/services/PagewiseCompanion/prompt.ts'
import relay from '../relay/src/index.js'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'

const file = name => new URL(name, import.meta.url)

test('canonical module, composable and components replace internal old paths', () => {
  for (const name of ['Card', 'ChapterCard', 'Consent', 'Outline', 'Skim', 'Status', 'Toggle']) {
    assert.ok(existsSync(file(`../src/components/PagewiseCompanion${name}.vue`)))
    assert.equal(existsSync(file(`../src/components/Dianjing${name}.vue`)), false)
  }
  assert.ok(existsSync(file('../src/composables/usePagewiseCompanion.ts')))
  assert.equal(existsSync(file('../src/composables/useDianjing.ts')), false)
  assert.equal(existsSync(file('../src/services/dianjing')), false)
  assert.match(readFileSync(file('../src/services/PagewiseCompanion/engine.ts'), 'utf8'), /export class PagewiseCompanion\s*\{/)
})

test('existing offline cache namespace, key layout and records survive branding changes', async () => {
  assert.equal(DB_NAME, 'lightread-dianjing')
  assert.equal(PROMPT_VERSION, 'dj3')
  const key = cacheKey('synthetic-book', 2, 'content-hash', 'synthetic-model', 'dj3')
  assert.equal(key, 'synthetic-book:2:content-hash:synthetic-model:dj3')
  assert.equal(sectionKey('synthetic-book', 2, 'dj3'), 'synthetic-book:s2:dj3')
  assert.equal(feedbackKey('synthetic-book', 'item-1'), 'synthetic-book:item-1')
  const cache = createMemoryCache()
  const record = { key, bookId: 'synthetic-book', section: 2, items: [], complete: true, at: 1 }
  await cache.put('chunks', record)
  assert.deepEqual(await cache.get('chunks', key), record)
})

test('legacy serialized smart consent and explicit book opt-out keep their meaning', () => {
  const legacy = { dianjing: { consentAll: true, enabled: true, perBook: { 'synthetic-book': false } } }
  assert.equal(migrateLevel(legacy).level, 'smart')
  assert.equal(smartOnFor(legacy.dianjing, 'another-synthetic-book'), true)
  assert.equal(smartOnFor(legacy.dianjing, 'synthetic-book'), false)
  assert.equal(migrateLevel({ readingMode: { wordGuide: { enabled: true } } }).level, 'basic')
})

test('relay metadata retains the real client handshake field and x-dj header without networking', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External request forbidden') })
  const response = await relay.fetch(new Request('https://synthetic.invalid/v1/models'), {}, {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-dj-prompt-version'), 'dj3')
  const body = await response.json()
  assert.equal(body.dianjingPromptVersion, 'dj3')
  assert.equal(body.companionPromptVersion, undefined)
  for (const name of ['x-dj-model', 'x-dj-remaining', 'x-dj-prompt-version']) {
    assert.ok(response.headers.get('access-control-expose-headers').includes(name))
  }
})

test('legacy POST route still reaches the configuration gate, not an invented new endpoint', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External request forbidden') })
  const response = await relay.fetch(new Request('https://synthetic.invalid/v1/dianjing', { method: 'POST', body: '{}' }), {}, {})
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'config')
})

test('actual dictionaries expose Companion names and source actions, not raw missing keys', () => {
  assert.equal(zh['companion.title'], '伴读')
  assert.equal(en['companion.title'], 'Companion')
  for (const key of Object.keys(zh).filter(key => key.startsWith('companion.'))) {
    assert.equal(typeof en[key], 'string', `English dictionary contains ${key}`)
    assert.equal(/点睛|Spotlight Reading/.test(zh[key] + en[key]), false, key)
  }
  assert.equal(zh['companion.viewSource'], '查看原文')
  assert.equal(en['companion.sourceText'], 'Source excerpt')
})

test('legacy test command and manual deep-link resource remain compatible', () => {
  const manifest = JSON.parse(readFileSync(file('../package.json'), 'utf8'))
  assert.equal(manifest.scripts['test:dianjing'], 'node --experimental-strip-types --test scripts/test-dianjing.mjs')
  const manual = readFileSync(file('../docs/manual/05-点睛阅读.md'), 'utf8')
  assert.match(manual, /^# 五、伴读/m)
  assert.equal(manual.includes('画龙伴读'), false)
})
