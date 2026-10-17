// 列出某方案点亮的词里被判 0 的 (误点) 和一段点亮预览
import { readFileSync } from 'node:fs'
import { prepare, scoreTypes, selectBook, DEFAULTS, normTerm } from './harness.ts'
import { loadText } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const [book, ...models] = process.argv.slice(2)
const { paras, chapters } = loadText(book); const text = paras.join('\n')
const lab: Record<string, number> = JSON.parse(readFileSync(`${ROOT}labels/${book}.json`, 'utf8'))
const STAT = models[0] === 'A'
const votes = new Map<string, { r: number; v: number }>()
for (const m of STAT ? [] : models) {
  const j = JSON.parse(readFileSync(`${ROOT}out/sel-B-${m}-${book}.json`, 'utf8'))
  const s = new Map<string, number>()
  for (const c of j.chunks) for (const t of c.terms) { const n = normTerm(t.w); if (n.length >= 2 && text.includes(n)) s.set(n, Math.max(s.get(n) ?? 0, t.r)) }
  for (const [w, r] of s) { const c = votes.get(w); votes.set(w, c ? { r: Math.max(c.r, r), v: c.v + 1 } : { r, v: 1 }) }
}

const need = models.length > 1 ? 2 : 1
const T = new Map([...votes].filter(([, x]) => x.v >= need))
const b = prepare(paras, chapters, [...T.keys()], true)
const types = scoreTypes(b, DEFAULTS)
if (!STAT) for (const ty of types.values()) { const t = T.get(ty.word); ty.eligible = !!t; if (t) ty.S = 4 * t.r + Math.log(t.v) * 2 + ty.K + 0.5 * ty.B }
const picked = selectBook(b, types, DEFAULTS)
const cnt = new Map<string, number>(); for (const p of picked) cnt.set(p.word, (cnt.get(p.word) ?? 0) + 1)
const fp = [...cnt].filter(([w]) => (lab[w] ?? -1) === 0).sort((a, b) => b[1] - a[1])
console.log('误点', fp.length, '种', fp.reduce((a, x) => a + x[1], 0), '次 /', picked.length, ':', fp.slice(0, 30).map(([w, n]) => `${w}${n}`).join(' '))
if (process.env.PREVIEW) {
  const pi = Number(process.env.PREVIEW)
  const ps = picked.filter(p => p.para === pi).sort((a, b) => a.index - b.index)
  let s = '', at = 0; const t = paras[pi]
  for (const p of ps) { s += t.slice(at, p.index) + (p.strong ? '【' : '〔') + t.slice(p.index, p.index + p.len) + (p.strong ? '】' : '〕'); at = p.index + p.len }
  console.log(s + t.slice(at))
}
