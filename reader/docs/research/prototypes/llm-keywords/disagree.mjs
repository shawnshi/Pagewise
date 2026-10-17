// 列出两个标注模型二值不一致的词 (带上下文), 供人工裁决
import { readFileSync } from 'node:fs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const b = process.argv[2]
const d = JSON.parse(readFileSync(`${ROOT}out/judge-DeepSeek-V3.2-${b}.json`, 'utf8'))
const k = JSON.parse(readFileSync(`${ROOT}out/judge-Kimi-K2.6-${b}.json`, 'utf8'))
const pool = new Map(JSON.parse(readFileSync(`${ROOT}out/pool-${b}.json`, 'utf8')).map(x => [x.w, x]))
for (const w of Object.keys(k)) if (w in d && (d[w] >= 1) !== (k[w] >= 1)) console.log(`${w}\tD${d[w]}K${k[w]}\t${pool.get(w)?.f}\t${pool.get(w)?.ctx}`)
