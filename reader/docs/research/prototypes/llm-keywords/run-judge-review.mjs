// 第二意见: Kimi-K2.6 标注「主要方案实际点亮的词」中还没有双人标注的部分 (两处上下文), 并入 judge-Kimi-K2.6-<book>.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { chat, parseJsonLoose } from './sf.mjs'
import { BOOKS, loadText } from './books.mjs'
const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const model = 'Pro/moonshotai/Kimi-K2.6'
const BATCH = 100
const SYS = `你是严格的阅读研究标注员。「点亮重点词」功能只把少数词加亮，让读者扫读时一眼抓住在讲谁、在哪、讲什么。点亮错了会干扰阅读，所以标准要严。
给你一部作品的若干候选词，每个词附出现次数和两处上下文（【】内为该词）。逐个判断：
2 = 核心：主要人物、关键地名/机构、核心术语或概念、贯穿全文的关键物件、意象或事件；
1 = 可以：次要但有名有姓的人物、地名、专有名词、学科术语、本书特有的说法、在情节里有分量的物件或意象（如《药》里的乌鸦、《社戏》里的罗汉豆）；
0 = 不该点亮：普通词汇（如 嘴巴、两手、屋子里、开口、胡说、帮忙、心满意足、可能性、描述）；一般动词、形容词、副词、虚词；被切碎的半个词或跨词片段（看上下文判断它在句中是不是一个完整的词）；与主题无关的偶然词。
拿不准时判 0。
只输出 JSON：{"labels":{"候选词":分数,...}}，必须覆盖每个候选词，原样照抄。`
const res = JSON.parse(readFileSync(`${ROOT}out/results-0.08.json`, 'utf8'))
await Promise.all(BOOKS.map(async b => {
  const kf = `${ROOT}out/judge-Kimi-K2.6-${b.id}.json`
  const k = existsSync(kf) ? JSON.parse(readFileSync(kf, 'utf8')) : {}
  const text = loadText(b.id).paras.join('\n')
  const need = res[b.id].review.filter(w => !(w in k))
  const ctx = (w) => { const out = []; let n = 0; for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) { n++; if (out.length < 2) out.push(text.slice(Math.max(0, i - 15), i).replace(/\n/g, '/') + '【' + w + '】' + text.slice(i + w.length, i + w.length + 15).replace(/\n/g, '/')) } return { n, c: out.join(' ‖ ') } }
  const items = need.map(w => ({ w, ...ctx(w) }))
  const parts = []; for (let i = 0; i < items.length; i += BATCH) parts.push(items.slice(i, i + BATCH))
  let p = 0, c = 0
  await Promise.all(parts.map(async part => {
    const user = `作品：${b.kind}《${b.title}》${b.author ? ' ' + b.author : ''}\n候选词（词｜次数｜上下文）：\n` + part.map(x => `${x.w}｜${x.n}｜${x.c}`).join('\n')
    const r = await chat(model, [{ role: 'system', content: SYS }, { role: 'user', content: user }], { thinking: false, max_tokens: 2500, tag: 'judge3', timeout: 600000 })
    p += r.usage?.prompt_tokens ?? 0; c += r.usage?.completion_tokens ?? 0
    const j = parseJsonLoose(r.content) ?? {}
    const labs = j.labels ?? j
    const set = new Set(part.map(x => x.w))
    for (const x of part) k[x.w] = 0
    for (const [w, v] of Object.entries(labs)) if (set.has(w) && [0, 1, 2].includes(Number(v))) k[w] = Number(v)
  }))
  writeFileSync(kf, JSON.stringify(k))
  console.log(b.id, need.length, p, c)
}))
