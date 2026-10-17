// 合成最终标注: 人工裁决 (adj/*.txt, 「词 分」成对; 词里含空格的用 _ 代替) > 两个模型一致 > 仅 DeepSeek-V3.2
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { BOOKS } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const rd = p => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
for (const B of BOOKS) {
  const d = rd(`${ROOT}out/judge-DeepSeek-V3.2-${B.id}.json`), k = rd(`${ROOT}out/judge-Kimi-K2.6-${B.id}.json`)
  const adj = {}
  for (const f of [`${ROOT}adj/${B.id}.txt`, `${ROOT}adj/${B.id}-review.txt`]) if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim().split(/\s+/)
    for (let i = 0; i + 1 < t.length; i += 2) adj[t[i].replace(/_/g, ' ')] = Number(t[i + 1])
  }
  const out = {}
  let nAdj = 0, nBoth = 0, nD = 0, unresolved = []
  for (const w of new Set([...Object.keys(d), ...Object.keys(k), ...Object.keys(adj)])) {
    if (w in adj) { out[w] = adj[w]; nAdj++; continue }
    if (w in d && w in k) {
      if ((d[w] >= 1) === (k[w] >= 1)) { out[w] = d[w] >= 1 ? Math.max(1, Math.min(d[w], k[w])) : 0; nBoth++ }
      else { out[w] = d[w]; unresolved.push(w) }
      continue
    }
    if (w in d) { out[w] = d[w]; nD++ } else if (w in k) out[w] = k[w]
  }
  writeFileSync(`${ROOT}labels/${B.id}.json`, JSON.stringify(out))
  const v = Object.values(out)
  console.log(B.id, 'n', v.length, 'adj', nAdj, 'both', nBoth, 'V3.2only', nD, 'unresolved', unresolved.length, unresolved.slice(0, 10).join(' '), '| 2:', v.filter(x => x === 2).length, '1:', v.filter(x => x === 1).length)
}
