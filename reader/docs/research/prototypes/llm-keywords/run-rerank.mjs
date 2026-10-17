// E: 统计算法 (V3) 的候选前 K 个词 (只发词和次数, 不发正文) → LLM 筛选
import { writeFileSync } from 'node:fs'
import { chat, extractTerms } from './sf.mjs'
import { SYS_E, userE } from './prompts.mjs'
import { BOOKS, loadText } from './books.mjs'
import { prepare, scoreTypes, DEFAULTS, rankTypes } from './harness.ts'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const models = process.argv[2].split(',')
const K = Number(process.argv[3] || 400)
const BATCH = 200
const cands = {}
for (const b of BOOKS) {
  const { paras, chapters } = loadText(b.id)
  const book = prepare(paras, chapters, [], true)
  const types = scoreTypes(book, DEFAULTS)
  cands[b.id] = rankTypes(types).slice(0, K).map(w => ({ w, f: types.get(w).f }))
}
writeFileSync(ROOT + 'out/stat-cands.json', JSON.stringify(cands))
await Promise.all(models.flatMap(m => BOOKS.map(async b => {
  const list = cands[b.id]
  const t0 = Date.now()
  const parts = []
  for (let i = 0; i < list.length; i += BATCH) parts.push(list.slice(i, i + BATCH))
  const res = await Promise.all(parts.map(p => chat(m, [{ role: 'system', content: SYS_E }, { role: 'user', content: userE(b, p) }], { thinking: false, max_tokens: 3000, tag: 'E' })))
  const allowed = new Set(list.map(c => c.w))
  const keep = res.flatMap(r => extractTerms(r.content)).filter(x => allowed.has(x.w))
  writeFileSync(`${ROOT}out/sel-E-${m.split('/').pop()}-${b.id}.json`, JSON.stringify({ method: 'E', model: m, book: b.id, K, wallMs: Date.now() - t0, usage: res.map(r => r.usage), ms: res.map(r => r.ms), terms: keep }))
  console.log('E', m, b.id, keep.length, '/', list.length)
})))
