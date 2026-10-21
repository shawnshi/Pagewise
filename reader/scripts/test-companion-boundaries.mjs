import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { chunkSection, resolveSentence } from '../src/services/PagewiseCompanion/chunker.ts'
import * as prompt from '../src/services/PagewiseCompanion/prompt.ts'
import * as protocol from '../src/services/PagewiseCompanion/protocol.ts'
import worker from '../relay/src/index.js'
import { compatibleChatBody } from '../src/services/aiProviders.ts'

function client(fetchRemote) {
  const code = ts.transpileModule(readFileSync(new URL('../src/services/PagewiseCompanion/client.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, TextDecoder, require(id) {
    if (id === '../net') return { fetchRemote }
    if (id === '../aiProviders.ts') return { compatibleChatBody }
    if (id === './prompt.ts') return prompt
    if (id === './protocol.ts') return protocol
    throw Error('Unexpected dependency: ' + id)
  } })
  return exports
}
const req = mode => ({ mode, lang: 'en', text: '[1.1] Synthetic source.', fiction: false })
const rows = '{"t":"meta","fiction":false}\n{"t":"gist","p":1,"text":"Synthetic gist"}\n'

test('RA-SOURCE-01: dense serialized input is bounded without losing sentences or inventing mandatory source IDs', () => {
  const blocks = Array.from({ length: 300 }, (_, i) => ({ block: i, sentences: ['a.'] }))
  const chunks = chunkSection(blocks)
  const seen = []
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= prompt.MAX_CHUNK_CHARS, `Serialized source exceeds3000: ${chunk.text.length}`)
    const plan = prompt.planMarkInput(chunk.text)
    const payload = JSON.parse(prompt.buildMessages({ ...req('mark'), text: chunk.text, promptVersion: prompt.PROMPT_VERSION })[1].content)
    assert.equal(payload.text, plan.text)
    assert.equal(payload.text, chunk.text)
    assert.deepEqual(payload.gistParagraphs, plan.gistParagraphs)
    for (const p of payload.gistParagraphs) {
      assert.match(payload.text, new RegExp(`(?:^|\\n)\\[${p}\\.1\\] a\\.`))
      assert.ok(protocol.resolveItem({ t: 'gist', p, text: 'Grounded' }, chunk))
    }
    for (let p = 1; p <= chunk.blocks.length; p++) {
      const pos = resolveSentence(chunk, `${p}.1`)
      seen.push([pos.block, pos.sentence])
    }
    assert.equal(protocol.resolveItem({ t: 'gist', p: chunk.blocks.length + 1, text: 'Omitted' }, chunk), null)
  }
  assert.deepEqual(seen, blocks.map(b => [b.block, 0]))
})

test('RA-SOURCE-01: long-paragraph numbering is budgeted and an unfit sentence fails before either network boundary', async () => {
  const chunks = chunkSection([{ block: 0, sentences: Array.from({ length: 600 }, () => 'a.') }])
  const seen = []
  for (const c of chunks) {
    assert.ok(c.text.length <= 3000)
    for (let s = 1; s <= c.blocks[0].sentences.length; s++) seen.push(resolveSentence(c, `1.${s}`).sentence)
  }
  assert.deepEqual(seen, Array.from({ length: 600 }, (_, i) => i))
  assert.throws(() => prompt.planMarkInput('[1.1] ' + 'X'.repeat(4000)), /long|3000|limit/i)
  for (const kind of ['own', 'builtin']) {
    const calls = [], runtime = client(async (...args) => { calls.push(args); throw Error('Network forbidden') })
    await assert.rejects(runtime.streamPagewiseCompanion({ ...req('mark'), text: '[1.1] ' + 'X'.repeat(4000) },
      { kind, baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic' }, () => {}), /long|3000|limit/i)
    assert.equal(calls.length, 0)
  }
})

test('retired builtin mark/summary channels fail closed without metadata, device IDs or document requests', async () => {
  for (const mode of ['mark', 'summary', 'translate']) {
    const calls = [], accepted = []
    const runtime = client(async (...args) => { calls.push(args); throw Error('Network forbidden') })
    await assert.rejects(runtime.streamPagewiseCompanion(req(mode), { kind: 'builtin', baseUrl: 'https://synthetic.invalid/v1' }, raw => accepted.push(raw)), e => e.code === 'config')
    assert.deepEqual(calls, [])
    assert.deepEqual(accepted, [])
  }
})

test('own service streams bounded current output without consulting the retired relay', async () => {
  // Standalone server code is not an application route and is not deployed by this task.
  const metadata = await worker.fetch(new Request('https://synthetic.invalid/v1/models'), {}, { waitUntil() {} })
  assert.equal((await metadata.json()).dianjingPromptVersion, prompt.PROMPT_VERSION)
  const calls = [], accepted = []
  const runtime = client(async (url, _proxy, init = {}) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: rows } }] }), { headers: { 'content-type': 'application/json' } })
  })
  const result = await runtime.streamPagewiseCompanion(req('mark'), { kind: 'own', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-key', model: 'synthetic' }, raw => accepted.push(raw))
  assert.equal(result.good, 2); assert.equal(result.bad, 0); assert.equal(accepted.length, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://synthetic.invalid/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer synthetic-key')
  assert.equal(calls[0].init.headers['x-device-id'], undefined)
})
