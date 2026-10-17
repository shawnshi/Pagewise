// 自由标注的一致性: 旧金标 (单 agent) vs DeepSeek-V3.2 vs Kimi-K2.6 (只看正文里出现的词)
import { readFileSync, existsSync } from 'node:fs'
import { BOOKS, loadText } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const norm = w => String(w).normalize('NFKC').replace(/[《》“”"'「」]/g, '').trim()
const J = (a, b) => { const i = [...a].filter(x => b.has(x)).length; return i / (a.size + b.size - i) }
const cov = (a, b) => [...a].filter(x => b.has(x)).length / a.size // a 被 b 覆盖的比例
const rows = []
for (const B of BOOKS) {
  if (!existsSync(`${ROOT}out/goldfree-DeepSeek-V3.2-${B.id}.json`)) continue
  const text = loadText(B.id).paras.join('\n')
  const inT = l => new Set(l.map(norm).filter(w => w.length >= 2 && text.includes(w)))
  const old = existsSync(`${new URL('../key-highlight-gold/', import.meta.url).pathname}${B.id}.txt`) ? inT(readFileSync(`${new URL('../key-highlight-gold/', import.meta.url).pathname}${B.id}.txt`, 'utf8').split(/\s+/)) : null
  const g = f => JSON.parse(readFileSync(`${ROOT}out/goldfree-${f}-${B.id}.json`, 'utf8'))
  const d = g('DeepSeek-V3.2'), k = g('Kimi-K2.6')
  const dc = inT(d.core), kc = inT(k.core), da = inT([...d.core, ...d.ok]), ka = inT([...k.core, ...k.ok])
  const r = { book: B.id, n: `${old?.size ?? '-'}/${dc.size}/${kc.size}`, notInText: `${(1 - dc.size / new Set(d.core.map(norm)).size).toFixed(2)}/${(1 - kc.size / new Set(k.core.map(norm)).size).toFixed(2)}`,
    J_core_DK: J(dc, kc).toFixed(2), J_all_DK: J(da, ka).toFixed(2) }
  if (old) Object.assign(r, { J_old_Dcore: J(old, dc).toFixed(2), J_old_Kcore: J(old, kc).toFixed(2), old_in_Dall: cov(old, da).toFixed(2), old_in_Kall: cov(old, ka).toFixed(2), Dcore_in_Kall: cov(dc, ka).toFixed(2), Kcore_in_Dall: cov(kc, da).toFixed(2) })
  else Object.assign(r, { Dcore_in_Kall: cov(dc, ka).toFixed(2), Kcore_in_Dall: cov(kc, da).toFixed(2) })
  rows.push(r)
}
console.table(rows)
