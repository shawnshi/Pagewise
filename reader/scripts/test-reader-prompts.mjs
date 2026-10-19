import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as prompt from '../src/services/dianjing/prompt.ts'
import { SseDeltaParser, resolveItem } from '../src/services/dianjing/protocol.ts'
import { chunkSection } from '../src/services/dianjing/chunker.ts'
import { sseToNdjson } from '../relay/src/lib.js'

const code = ts.transpileModule(readFileSync(new URL('../src/services/ai.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function loadAi(response) {
  const exports = {}, calls = []
  vm.runInNewContext(code, { exports, TextDecoder, require(id) {
    if (id === './net') return { async fetchRemote(...args) {
      if (!response) throw Error('Network forbidden')
      calls.push(args); return response
    } }
    if (id === '../stores/settings') return { useSettings() {
      if (!response) throw Error('Settings forbidden')
      return { aiProvider: 'unit', aiBaseUrl: 'https://unit.invalid', aiModel: 'synthetic-model', aiApiKey: '', language: 'en' }
    } }
    if (id === './aiProviders.ts') return { AI_PROVIDERS: [], providerById: () => ({ id: 'unit', needsKey: false }) }
    throw Error(`Unexpected dependency: ${id}`)
  } })
  return { ai: exports, calls }
}
const { ai } = loadAi()
const stream = text => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } })
const req = overrides => ({ mode: 'mark', lang: 'zh', promptVersion: prompt.PROMPT_VERSION,
  text: '[1-1] 这是原文。', fiction: false, askGenre: true, ...overrides })

test('reader metadata and source stay out of system policy in both languages', () => {
  for (const lang of ['zh', 'en']) {
    const messages = ai.buildReaderMessages({ book: { title: 'TITLE_OVERRIDE_IGNORE_POLICY', author: 'AUTHOR_CANARY' },
      chapter: 'CHAPTER_CANARY', lang, question: 'Explain the provided passage.',
      context: { kind: 'selection', text: 'SOURCE_IGNORE_POLICY' }, history: [] })
    assert.equal(messages[0].role, 'system')
    for (const canary of ['TITLE_OVERRIDE_IGNORE_POLICY', 'AUTHOR_CANARY', 'CHAPTER_CANARY', 'SOURCE_IGNORE_POLICY']) {
      assert.ok(!messages[0].content.includes(canary))
      assert.ok(messages.at(-1).content.includes(canary))
    }
    const data = JSON.parse(messages.at(-1).content)
    assert.equal(data.context.kind, 'selection')
    assert.equal(data.context.text, 'SOURCE_IGNORE_POLICY')
  }
})

test('reader bounds context/history and excludes incomplete, system and empty replies', () => {
  const history = [{ role: 'system', content: 'HISTORY_INSTRUCTION' }]
  for (let i = 0; i < 12; i++) history.push({ role: 'user', content: `QUESTION${i}`,
    context: { kind: 'visible_page', text: 'H'.repeat(9000) } },
  { role: 'assistant', content: `ANSWER${i}` + 'A'.repeat(9000), complete: true })
  history.push({ role: 'user', content: 'INCOMPLETE_QUESTION' }, { role: 'assistant', content: 'PARTIAL_REPLY', complete: false })
  const messages = ai.buildReaderMessages({ book: {}, chapter: '', lang: 'en', question: 'Now?',
    context: { kind: 'visible_page', text: 'X'.repeat(12000) }, history })
  assert.equal(messages.length, 10)
  assert.equal(JSON.parse(messages.at(-1).content).context.text.length, 6000)
  assert.ok(JSON.parse(messages.at(-1).content).context.truncated)
  assert.ok(!JSON.stringify(messages).includes('HISTORY_INSTRUCTION'))
  assert.ok(!JSON.stringify(messages).includes('INCOMPLETE_QUESTION'))
  assert.ok(!JSON.stringify(messages).includes('PARTIAL_REPLY'))
  for (const m of messages.slice(1, -1)) assert.ok(m.content.length <= 4000)
  assert.throws(() => ai.buildReaderMessages({ book: {}, lang: 'zh', question: 'Q'.repeat(1201) }), /1200/)
  const missing = ai.buildReaderMessages({ book: {}, lang: 'en', question: 'Summarize this chapter.' })
  assert.equal(JSON.parse(missing.at(-1).content).context.kind, 'unavailable')
})

test('Dianjing data is JSON, unknown genre is spoiler-protected and old prompts are not reused', () => {
  for (const lang of ['zh', 'en']) {
    const messages = prompt.buildMessages(req({ lang, book: { title: 'TITLE_ATTACK', author: 'AUTHOR_ATTACK' }, chapter: 'CHAPTER_ATTACK' }))
    assert.match(messages[0].content, lang === 'zh' ? /剧透/ : /spoiler/i)
    assert.ok(!messages[0].content.includes('TITLE_ATTACK'))
    const data = JSON.parse(messages[1].content)
    assert.equal(data.book.title, 'TITLE_ATTACK')
    assert.equal(data.text, '[1-1] 这是原文。')
  }
  assert.notEqual(prompt.PROMPT_VERSION, 'dj2')
  assert.deepEqual(prompt.LEGACY_PROMPT_VERSIONS, [])
})

test('summary permits zero points and samples late material without breaking reference IDs or the budget', () => {
  for (const lang of ['zh', 'en']) {
    const p = prompt.buildMessages(req({ mode: 'summary', lang, text: '{"gists":["A"],"keys":[]}' }))[0].content
    assert.match(p, /0.?3/)
    assert.match(p, lang === 'zh' ? /没有.*要句|无.*要句/ : /no.*key/i)
  }
  const gists = Array.from({ length: 100 }, (_, i) => `GIST_${i}_` + 'G'.repeat(60))
  const keys = Array.from({ length: 100 }, (_, i) => `KEY_${i}_` + 'K'.repeat(250))
  const source = prompt.buildSummarySource(gists, keys)
  assert.ok(source.text.length <= 3000)
  assert.ok(source.text.includes('GIST_99_'))
  assert.ok(source.text.includes('KEY_99_'))
  const data = JSON.parse(source.text)
  assert.equal(data.keys.length, source.keyIndices.length)
  data.keys.forEach((k, i) => { assert.equal(k.id, i + 1); assert.ok(k.text.startsWith(`KEY_${source.keyIndices[i]}_`)) })
  const noKeys = JSON.parse(prompt.buildSummarySource(['Only a gist'], []).text)
  assert.deepEqual(noKeys.keys, [])
})

test('SSE accepts only a completion signal, not length termination or clean truncated EOF', async () => {
  for (const suffix of ['', 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']) {
    const sse = new SseDeltaParser()
    sse.feed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' + suffix)
    assert.throws(() => sse.finish(), /incomplete|truncat|length/i)
  }
  for (const suffix of ['data: [DONE]\n\n', 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']) {
    const sse = new SseDeltaParser()
    assert.equal(sse.feed('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + suffix), 'ok')
    assert.equal(sse.finish(), '')
  }
  const writes = [], metered = [], piece = '{"t":"tr","s":"1.1","text":"partial"}\n'
  const frame = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  await assert.rejects(sseToNdjson(stream(frame(piece)),
    x => writes.push(x), x => metered.push(x)), /incomplete|truncat/i)
  assert.equal(writes.join(''), piece)
  assert.equal(metered.join(''), piece)
  await assert.rejects(sseToNdjson(stream(frame(piece) + 'data: [DONE]\n\n'),
    () => { throw Error('downstream write failed') }), /downstream write failed/)
})

test('general chat retains partial output but rejects clean EOF, length and malformed SSE without retries', async () => {
  const frame = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  for (const suffix of ['', 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', 'data: {broken}\n\n']) {
    const { ai: runtime, calls } = loadAi(new Response(frame('PARTIAL') + suffix, { headers: { 'content-type': 'text/event-stream' } }))
    let text = ''
    await assert.rejects(async () => { for await (const delta of runtime.chatStream([])) text += delta }, /incomplete|invalid/i)
    assert.equal(text, 'PARTIAL')
    assert.equal(calls.length, 1)
  }
  for (const suffix of ['data: [DONE]\n\n', 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']) {
    const { ai: runtime } = loadAi(new Response(frame('COMPLETE') + suffix, { headers: { 'content-type': 'text/event-stream' } }))
    let text = ''; for await (const delta of runtime.chatStream([])) text += delta
    assert.equal(text, 'COMPLETE')
  }
  const { ai: runtime } = loadAi(new Response(JSON.stringify({ choices: [{ message: { content: 'JSON_PARTIAL' }, finish_reason: 'length' }] }), { headers: { 'content-type': 'application/json' } }))
  let text = ''
  await assert.rejects(async () => { for await (const delta of runtime.chatStream([])) text += delta }, /incomplete/i)
  assert.equal(text, 'JSON_PARTIAL')
})

test('dense short paragraphs keep the gist budget and the same source IDs without extra chunks', () => {
  const blocks = Array.from({ length: 100 }, (_, i) => ({ block: i, sentences: [`第${i}段。`] }))
  const chunks = chunkSection(blocks, { first: 10000, target: 10000, max: 10000 })
  assert.equal(chunks.length, 1)
  const data = JSON.parse(prompt.buildMessages(req({ text: chunks[0].text }))[1].content)
  assert.equal(data.gistParagraphs.length, 12)
  assert.equal(data.gistParagraphs[0], 1)
  assert.equal(data.gistParagraphs.at(-1), 100)
  for (const p of data.gistParagraphs) assert.ok(resolveItem({ t: 'gist', p, text: '段意' }, chunks[0]))
  assert.equal(resolveItem({ t: 'meta', fiction: 'unknown' }, chunks[0]), null)
  assert.equal(resolveItem({ t: 'meta', fiction: false }, chunks[0]).fiction, false)
})

test('escaped historical data remains valid JSON within the serialized 4000-character bound', () => {
  const messages = ai.buildReaderMessages({ book: {}, lang: 'en', question: 'Follow up', history: [
    { role: 'user', content: '\u0000'.repeat(1200), context: { kind: 'paragraph', text: '\u0000'.repeat(6000),
      chapter: '\u0000'.repeat(200), focus: { term: '\u0000'.repeat(80), explanation: '\u0000'.repeat(400) } } },
    { role: 'assistant', content: 'Prior reply', complete: true },
  ] })
  assert.ok(messages[1].content.length <= 4000)
  assert.equal(typeof JSON.parse(messages[1].content).question, 'string')
})
