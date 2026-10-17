// 逐词标注的一致性 (DeepSeek-V3.2 vs Kimi-K2.6), 二值 (≥1) 的 Cohen κ 与三级完全一致率
import { readFileSync, existsSync } from 'node:fs'
import { BOOKS } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const rd = (m, b) => existsSync(`${ROOT}out/judge-${m}-${b}.json`) ? JSON.parse(readFileSync(`${ROOT}out/judge-${m}-${b}.json`, 'utf8')) : null
function kappa(pairs) {
  const n = pairs.length; if (!n) return {}
  const po = pairs.filter(([a, b]) => (a >= 1) === (b >= 1)).length / n
  const pa = pairs.filter(([a]) => a >= 1).length / n, pb = pairs.filter(([, b]) => b >= 1).length / n
  const pe = pa * pb + (1 - pa) * (1 - pb)
  return { n, po: +po.toFixed(3), kappa: +((po - pe) / (1 - pe)).toFixed(3), exact3: +(pairs.filter(([a, b]) => a === b).length / n).toFixed(3), posD: +pa.toFixed(2), posK: +pb.toFixed(2) }
}
const all = []
const rows = []
for (const B of BOOKS) {
  const d = rd('DeepSeek-V3.2', B.id), k = rd('Kimi-K2.6', B.id)
  if (!d || !k) continue
  const pairs = Object.keys(k).filter(w => w in d).map(w => [d[w], k[w]])
  all.push(...pairs)
  rows.push({ book: B.id, ...kappa(pairs) })
}
rows.push({ book: 'ALL', ...kappa(all) })
console.table(rows)
