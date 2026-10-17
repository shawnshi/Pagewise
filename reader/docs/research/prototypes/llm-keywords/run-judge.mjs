// 词池标注: node scripts/run-judge.mjs <model> [sampleFracForBooks]
// 输出 out/judge-<model>-<book>.json {词: 0|1|2} (只对送标的词)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { chat, parseJsonLoose } from './sf.mjs'
import { BOOKS } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const model = process.argv[2]
const frac = Number(process.argv[3] || 1)
const BATCH = 120
const SYS = `你是严格的阅读研究标注员。「点亮重点词」功能只把少数词加亮，让读者扫读时一眼抓住在讲谁、在哪、讲什么。点亮错了会干扰阅读，所以标准要严。
给你一部作品的若干候选词，每个词附出现次数和第一次出现处的上下文（【】内为该词）。逐个判断：
2 = 核心：主要人物、关键地名/机构、核心术语或概念、贯穿全文的关键物件或事件；
1 = 可以：次要但有名有姓的人物、地名、专有名词、学科术语、本书特有的说法或物件；
0 = 不该点亮：一切普通词汇——即使是具体名词或生动的词也算普通词（如 嘴巴、两手、酒钱、屋子里、开口、胡说、帮忙、留心、心满意足、汗流满面、可能性、解决方案、描述、成正比）；一般动词、形容词、副词、成语、虚词；被切碎的半个词或跨词片段（看上下文：如「大卫」其实是「大卫·芬克尔斯坦」的一部分、「德拉」「罗斯」「约瑟」这类残片）；与主题无关的偶然词。
拿不准时判 0。
只输出 JSON：{"labels":{"候选词":分数,...}}，必须覆盖每个候选词，原样照抄。`
let rng = 12345
const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648
const only = process.argv[4] ? process.argv[4].split(',') : null
await Promise.all(BOOKS.filter(b => !only || only.includes(b.id)).map(async b => {
  let items = JSON.parse(readFileSync(`${ROOT}out/pool-${b.id}.json`, 'utf8'))
  const isBook = ['nahan', 'laocan'].includes(b.id)
  if (frac < 1) items = items.filter(() => rand() < frac)
  const out = {}
  const parts = []
  for (let i = 0; i < items.length; i += BATCH) parts.push(items.slice(i, i + BATCH))
  const usage = []
  await Promise.all(parts.map(async p => {
    const user = `作品：${b.kind}《${b.title}》${b.author ? ' ' + b.author : ''}\n候选词（词｜次数｜上下文）：\n` + p.map(x => `${x.w}｜${x.f}｜${x.ctx}`).join('\n')
    const r = await chat(model, [{ role: 'system', content: SYS }, { role: 'user', content: user }], { thinking: false, max_tokens: 3000, tag: 'judge2', timeout: 600000 })
    usage.push(r.usage)
    const j = parseJsonLoose(r.content) ?? {}
    const set = new Set(p.map(x => x.w))
    for (const x of p) out[x.w] = 0
    const labs = j.labels ?? j
    for (const [w, v] of Object.entries(labs)) if (set.has(w) && [0, 1, 2].includes(Number(v))) out[w] = Number(v)
  }))
  writeFileSync(`${ROOT}out/judge-${model.split('/').pop()}-${b.id}.json`, JSON.stringify(out))
  const vals = Object.values(out)
  console.log(model, b.id, items.length, '2:', vals.filter(v => v === 2).length, '1:', vals.filter(v => v === 1).length, JSON.stringify(usage.reduce((a, u) => ({ p: a.p + (u?.prompt_tokens ?? 0), c: a.c + (u?.completion_tokens ?? 0) }), { p: 0, c: 0 })))
}))
