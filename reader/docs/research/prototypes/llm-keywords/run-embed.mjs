// E2: KeyBERT 式嵌入中心度 (BAAI/bge-m3, 免费): 统计候选前 400 词 vs 全书 (各块均值) 的余弦相似度
import { readFileSync, writeFileSync } from 'node:fs'
import { embed } from './sf.mjs'
import { BOOKS, loadText, chunks } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const cands = JSON.parse(readFileSync(ROOT + 'out/stat-cands.json', 'utf8'))
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n) }
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
for (const b of BOOKS) {
  const t0 = Date.now()
  const { paras, chapters } = loadText(b.id)
  const cs = chunks(paras, chapters, 1500).map(c => c.text)
  const docVecs = []
  for (let i = 0; i < cs.length; i += 16) docVecs.push(...await embed('BAAI/bge-m3', cs.slice(i, i + 16)))
  const dim = docVecs[0].length
  const doc = norm(Array.from({ length: dim }, (_, k) => docVecs.reduce((s, v) => s + v[k], 0)))
  const words = cands[b.id].map(c => c.w)
  const wv = []
  for (let i = 0; i < words.length; i += 64) wv.push(...await embed('BAAI/bge-m3', words.slice(i, i + 64)))
  const sc = words.map((w, i) => ({ w, s: dot(norm(wv[i]), doc), statRank: i }))
  sc.sort((a, b) => b.s - a.s)
  const terms = sc.slice(0, 120).map((x, i) => ({ w: x.w, r: i < 40 ? 3 : i < 80 ? 2 : 1, s: x.s }))
  writeFileSync(`${ROOT}out/sel-K-bge-m3-${b.id}.json`, JSON.stringify({ method: 'K', model: 'bge-m3', book: b.id, ms: Date.now() - t0, terms }))
  console.log(b.id, Date.now() - t0, 'ms', terms.slice(0, 15).map(x => x.w).join(' '))
}
