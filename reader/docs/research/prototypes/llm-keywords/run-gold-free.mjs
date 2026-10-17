// 两个标注模型 (不参与选词) 各自通读全文, 自由标注 core / ok 两级关键词
import { writeFileSync } from 'node:fs'
import { chat, parseJsonLoose } from './sf.mjs'
import { SYS_GOLD_FREE } from './prompts.mjs'
import { BOOKS, loadText } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const JUDGES = ['deepseek-ai/DeepSeek-V3.2', 'Pro/moonshotai/Kimi-K2.6']
await Promise.all(JUDGES.flatMap(m => BOOKS.map(async b => {
  const { paras } = loadText(b.id)
  const long = paras.reduce((a, p) => a + p.length, 0) > 40000
  const sys = long ? SYS_GOLD_FREE.replace('约 40–80 个', '约 80–150 个').replace('约 40–120 个', '约 100–200 个') : SYS_GOLD_FREE
  const r = await chat(m, [{ role: 'system', content: sys }, { role: 'user', content: `${b.kind}：《${b.title}》${b.author ? ' ' + b.author : ''}\n正文：\n${paras.join('\n')}` }], { thinking: false, max_tokens: 6000, tag: 'gold-free', timeout: 600000 })
  const j = parseJsonLoose(r.content)
  writeFileSync(`${ROOT}out/goldfree-${m.split('/').pop()}-${b.id}.json`, JSON.stringify({ model: m, book: b.id, usage: r.usage, ms: r.ms, finish: r.finish, core: j?.core ?? [], ok: j?.ok ?? [] }))
  console.log(m, b.id, r.ms, r.finish, JSON.stringify(r.usage), j?.core?.length, j?.ok?.length)
})))
