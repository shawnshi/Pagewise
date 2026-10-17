// 跑 LLM 选词: B (按块读正文) 与 C (只凭书名回忆)。结果写 out/sel-<method>-<model>-<book>.json
// node scripts/run-select.mjs B|C model1,model2 [book ids]
import { writeFileSync, mkdirSync } from 'node:fs'
import { chat, parseJsonLoose, extractTerms } from './sf.mjs'
import { SYS_B, userB, SYS_C, userC } from './prompts.mjs'
import { BOOKS, loadText, chunks } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
mkdirSync(ROOT + 'out', { recursive: true })
const [method, modelArg, ...ids] = process.argv.slice(2)
const models = modelArg.split(',')
const books = BOOKS.filter(b => !ids.length || ids.includes(b.id))
const slug = m => m.split('/').pop()

async function runB(model, book) {
  const { paras, chapters } = loadText(book.id)
  const cs = chunks(paras, chapters)
  const t0 = Date.now()
  const res = await Promise.all(cs.map(async (c, i) => {
    try {
      const r = await chat(model, [{ role: 'system', content: SYS_B }, { role: 'user', content: userB(book, c.text) }], { thinking: false, max_tokens: 1500, tag: 'B' })
      const j = parseJsonLoose(r.content)
      return { i, chapter: c.chapter, chars: c.text.length, ms: r.ms, cached: !!r.cached, usage: r.usage, ok: !!j, finish: r.finish, terms: extractTerms(r.content) }
    } catch (e) { return { i, chapter: c.chapter, chars: c.text.length, error: String(e.message).slice(0, 200), terms: [] } }
  }))
  return { method: 'B', model, book: book.id, wallMs: Date.now() - t0, chunks: res }
}

async function runC(model, book) {
  const N = book.id === 'science' || book.id === 'technical' ? 80 : 120
  const r = await chat(model, [{ role: 'system', content: SYS_C.replace('{N}', String(N)) }, { role: 'user', content: userC(book) }], { thinking: false, max_tokens: 3000, tag: 'C' })
  const j = parseJsonLoose(r.content)
  const known = /"known"\s*:\s*true/.test(r.content)
  return { method: 'C', model, book: book.id, ms: r.ms, usage: r.usage, known, ok: !!j, finish: r.finish, terms: extractTerms(r.content).slice(0, N) }
}

await Promise.all(models.flatMap(m => books.map(async b => {
  const out = method === 'B' ? await runB(m, b) : await runC(m, b)
  writeFileSync(`${ROOT}out/sel-${method}-${slug(m)}-${b.id}.json`, JSON.stringify(out))
  const n = method === 'B' ? out.chunks.reduce((a, c) => a + c.terms.length, 0) : out.terms.length
  const errs = method === 'B' ? out.chunks.filter(c => c.error || !c.ok).length : (out.ok ? 0 : 1)
  console.log(method, slug(m), b.id, 'terms', n, 'bad', errs)
})))
