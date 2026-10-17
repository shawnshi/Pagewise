import { readFileSync } from 'node:fs'
// 保守价 (元/百万 token, 取页面高值): 免费模型 0
const P = { 'deepseek-ai/DeepSeek-V4-Flash': [3, 9], 'deepseek-ai/DeepSeek-V3.2': [4, 6], 'Pro/moonshotai/Kimi-K2.6': [6.5, 27] }
const agg = {}
for (const l of readFileSync((process.env.LLMKW_DIR ?? process.cwd()) + '/usage.jsonl', 'utf8').trim().split('\n')) {
  const j = JSON.parse(l); const k = j.model + ' ' + (j.tag ?? '')
  const a = agg[k] ??= { n: 0, p: 0, c: 0, ms: 0 }
  a.n++; a.p += j.usage?.prompt_tokens ?? 0; a.c += j.usage?.completion_tokens ?? 0; a.ms += j.ms
}
let tot = 0
for (const [k, a] of Object.entries(agg)) { const pr = P[k.split(' ')[0]] ?? [0, 0]; const y = (a.p * pr[0] + a.c * pr[1]) / 1e6; tot += y; console.log(k.padEnd(45), a.n, a.p, a.c, 'avg ms', Math.round(a.ms / a.n), '¥' + y.toFixed(3)) }
console.log('total ¥', tot.toFixed(2))
