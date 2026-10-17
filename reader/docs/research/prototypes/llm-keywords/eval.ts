/**
 * 各选词方案在 6 个文本上的对比 (调研见 docs/research/llm-keyword-selection.md)。
 * LLMKW_DIR=<工作目录> node docs/research/prototypes/llm-keywords/eval.ts [--pool] [--density 0.08] [--only fiction,science]
 * 工作目录里放 texts/<book>.txt (每行一段, ### 分章) 与 out/sel-*.json (run-select / run-rerank / run-embed 的输出)
 *   --pool: 导出待标注词池 out/pool-<book>.json (所有方案点亮的词 + 前 50 + 标注员自由列表 + 旧金标)
 * 标注: labels/<book>.json  {词: 0|1|2}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { prepare, scoreTypes, selectBook, DEFAULTS, metrics, loadLabels, normTerm, rankTypes, type TypeInfo, type Book, type Params } from './harness.ts'
import { BOOKS, loadText } from './books.mjs'

const ROOT = (process.env.LLMKW_DIR ?? process.cwd()) + '/'
const args = process.argv.slice(2)
const POOL = args.includes('--pool')
const DENS = Number(args[args.indexOf('--density') + 1]) || 0.08
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null
mkdirSync(ROOT + 'labels', { recursive: true })
const REVIEW = ['B DeepSeek-V4-Flash', 'B 免费≥2票', 'B Qwen3.5-4B', 'F V4F B∪E', 'F B+E 合计≥3票', 'E DeepSeek-V4-Flash']

export const FREE = ['Qwen3-8B', 'GLM-4-9B-0414', 'Qwen3.5-4B', 'Qwen2.5-7B-Instruct', 'Xing4.0-29B']
export const MODELS = [...FREE, 'DeepSeek-V4-Flash']
const OLD_GOLD_DIR = new URL('../key-highlight-gold/', import.meta.url).pathname

type TermSet = Map<string, { r: number; votes: number }>
function readSel(method: string, model: string, book: string): Array<{ w: string; r: number }> | null {
  const f = `${ROOT}out/sel-${method}-${model}-${book}.json`
  if (!existsSync(f)) return null
  const j = JSON.parse(readFileSync(f, 'utf8'))
  if (method === 'B') {
    const m = new Map<string, number>()
    for (const c of j.chunks) for (const t of c.terms) m.set(t.w, Math.max(m.get(t.w) ?? 0, t.r))
    return [...m].map(([w, r]) => ({ w, r }))
  }
  return j.terms
}
/** 规范化 + 只留在正文里出现的; 返回 [集合, 原始数, 不在文中数] */
function toSet(list: Array<{ w: string; r: number }>, text: string): { set: TermSet; raw: number; missing: number; missingList: string[] } {
  const set: TermSet = new Map()
  const missingList: string[] = []
  const seen = new Set<string>()
  for (const { w, r } of list) {
    const n = normTerm(w)
    if (!n || seen.has(n)) continue
    seen.add(n)
    if (n.length < 2 || n.length > 12) continue
    if (!text.includes(n)) { missingList.push(n); continue }
    const cur = set.get(n)
    set.set(n, { r: Math.max(cur?.r ?? 0, Math.min(3, Math.max(1, r))), votes: 1 })
  }
  return { set, raw: seen.size, missing: missingList.length, missingList }
}
function union(sets: TermSet[]): TermSet {
  const out: TermSet = new Map()
  for (const s of sets) for (const [w, v] of s) {
    const c = out.get(w)
    out.set(w, c ? { r: Math.max(c.r, v.r), votes: c.votes + 1 } : { ...v })
  }
  return out
}
const vote = (s: TermSet, k: number): TermSet => new Map([...s].filter(([, v]) => v.votes >= k))

interface Variant { id: string; terms?: TermSet; mode: 'stat' | 'only' | 'boost' | 'filterNew'; lambda?: number; note?: string }

/** 给定方案, 产出 types (eligible + S) 与点亮结果 */
function run(paras: string[], chapters: number[], v: Variant, prm: Params) {
  const forced = v.terms ? [...v.terms.keys()] : []
  const book = prepare(paras, chapters, forced, true)
  const types = scoreTypes(book, prm)
  if (v.mode !== 'stat') {
    const T = v.terms!
    for (const ty of types.values()) {
      const t = T.get(ty.word)
      if (v.mode === 'only') {
        ty.eligible = !!t
        if (t) ty.S = 4 * t.r + Math.log(t.votes) * 2 + ty.K + 0.5 * ty.B
      } else if (v.mode === 'boost') {
        if (t) { ty.eligible = true; ty.S += (v.lambda ?? 8) + 2 * t.r + Math.log(t.votes) * 2 }
      } else if (v.mode === 'filterNew') {
        // LLM 词 + 统计新词里关键度高的 (LLM 漏掉的人名)
        if (t) { ty.eligible = true; ty.S = 4 * t.r + Math.log(t.votes) * 2 + ty.K + 0.5 * ty.B }
        else ty.eligible = ty.eligible && (book as any).found.has(ty.word) && ty.f >= 3 && ty.K >= (v.lambda ?? 6)
      }
    }
  }
  const picked = selectBook(book, types, prm)
  return { book, types, picked }
}

const results: any = {}
const prm: Params = { ...DEFAULTS, density: DENS }
for (const B of BOOKS) {
  if (ONLY && !ONLY.includes(B.id)) continue
  const { paras, chapters } = loadText(B.id)
  const text = paras.join('\n')
  let lab = loadLabels(`${ROOT}labels/${B.id}.json`)
  if (!lab.size) { // 仓库里只存正例 (gold/<book>.txt); 没列出的词按 0 计
    const g = new URL(`./gold/${B.id}.txt`, import.meta.url)
    if (existsSync(g)) for (const line of readFileSync(g, 'utf8').split('\n')) { const m = line.match(/^([12]): (.*)$/); if (m) for (const w of m[2].split(' ')) if (w) lab.set(w.replace(/_/g, ' '), Number(m[1])) }
  }
  const oldGold = existsSync(OLD_GOLD_DIR + B.id + '.txt') ? readFileSync(OLD_GOLD_DIR + B.id + '.txt', 'utf8').split(/\s+/).filter(Boolean) : []
  const sets: Record<string, TermSet> = {}
  const halluc: Record<string, any> = {}
  for (const meth of ['B', 'C', 'E']) for (const m of MODELS) {
    const l = readSel(meth, m, B.id)
    if (!l) continue
    const s = toSet(l, text)
    sets[`${meth}:${m}`] = s.set
    halluc[`${meth}:${m}`] = { raw: s.raw, missing: s.missing, rate: s.raw ? s.missing / s.raw : null, ex: s.missingList.slice(0, 12) }
  }
  { const l = readSel('K', 'bge-m3', B.id); if (l) sets['K:bge-m3'] = toSet(l, text).set }
  const S = (k: string) => sets[k] ?? new Map()
  const freeB = union(FREE.map(m => S('B:' + m)))
  const freeE = union(FREE.map(m => S('E:' + m)))
  const freeC = union(FREE.map(m => S('C:' + m)))
  const variants: Variant[] = [{ id: 'A 统计 V3', mode: 'stat' }]
  const oracle: TermSet = new Map([...lab].filter(([w, v]) => v >= 1 && text.includes(w)).map(([w, v]) => [w, { r: v + 1, votes: 1 }]))
  variants.push({ id: 'O 上限 (只亮标注正例)', terms: oracle, mode: 'only' })
  for (const m of MODELS) {
    if (sets['B:' + m]) variants.push({ id: `B ${m}`, terms: S('B:' + m), mode: 'only' })
    if (sets['C:' + m]) variants.push({ id: `C ${m}`, terms: S('C:' + m), mode: 'only' })
    if (sets['E:' + m]) variants.push({ id: `E ${m}`, terms: S('E:' + m), mode: 'only' })
    if (sets['B:' + m]) variants.push({ id: `D ${m} 统计+B加分`, terms: union([S('B:' + m), S('C:' + m)]), mode: 'boost', lambda: 8 })
  }
  if (sets['K:bge-m3']) variants.push({ id: 'E2 bge-m3 中心度', terms: S('K:bge-m3'), mode: 'only' })
  variants.push({ id: 'B 免费≥2票', terms: vote(freeB, 2), mode: 'only' })
  const rge = (t: TermSet, k: number): TermSet => new Map([...t].filter(([, v]) => v.r >= k))
  variants.push({ id: 'B V4F r≥2', terms: rge(S('B:DeepSeek-V4-Flash'), 2), mode: 'only' })
  variants.push({ id: 'B Qwen3-8B r≥2', terms: rge(S('B:Qwen3-8B'), 2), mode: 'only' })
  variants.push({ id: 'G V4F∪免费≥2', terms: union([S('B:DeepSeek-V4-Flash'), vote(freeB, 2)]), mode: 'only' })
  variants.push({ id: 'G 免费B≥2∪免费E≥3', terms: union([vote(freeB, 2), vote(freeE, 3)]), mode: 'only' })
  const free3 = union(['Qwen3-8B', 'GLM-4-9B-0414', 'Qwen2.5-7B-Instruct'].map(m => S('B:' + m)))
  variants.push({ id: 'B 免费3选≥2', terms: vote(free3, 2), mode: 'only' })
  for (const k of [6, 8, 10]) {
    variants.push({ id: `H 免费B≥2 + 统计新词K≥${k}`, terms: vote(freeB, 2), mode: 'filterNew', lambda: k })
    variants.push({ id: `H V4F B + 统计新词K≥${k}`, terms: S('B:DeepSeek-V4-Flash'), mode: 'filterNew', lambda: k })
  }
  variants.push({ id: 'H 免费3选≥2 + 统计新词K≥8', terms: vote(free3, 2), mode: 'filterNew', lambda: 8 })
  variants.push({ id: 'B 免费≥3票', terms: vote(freeB, 3), mode: 'only' })
  variants.push({ id: 'E 免费≥2票', terms: vote(freeE, 2), mode: 'only' })
  variants.push({ id: 'E 免费≥3票', terms: vote(freeE, 3), mode: 'only' })
  const BE = union([vote(freeB, 2), vote(freeE, 2)])
  variants.push({ id: 'F B≥2∪E≥2', terms: BE, mode: 'only' })
  const BEall = union([...FREE.map(m => S('B:' + m)), ...FREE.map(m => S('E:' + m))])
  variants.push({ id: 'F B+E 合计≥3票', terms: vote(BEall, 3), mode: 'only' })
  variants.push({ id: 'F B+E 合计≥4票', terms: vote(BEall, 4), mode: 'only' })
  if (sets['B:DeepSeek-V4-Flash'] && sets['E:DeepSeek-V4-Flash']) {
    variants.push({ id: 'F V4F B∩E', terms: new Map([...S('B:DeepSeek-V4-Flash')].filter(([w]) => S('E:DeepSeek-V4-Flash').has(w))), mode: 'only' })
    variants.push({ id: 'F V4F B∪E', terms: union([S('B:DeepSeek-V4-Flash'), S('E:DeepSeek-V4-Flash')]), mode: 'only' })
  }
  const out: any = { chars: text.length, halluc, variants: {} }
  const pool = new Set<string>()
  const review = new Set<string>()
  for (const v of variants) {
    const r = run(paras, chapters, v, prm)
    const mt = metrics(r.book, r.types, r.picked, lab, oldGold)
    out.variants[v.id] = { ...mt, nTerms: v.terms?.size }
    if (REVIEW.some(x => v.id.startsWith(x))) {
      for (const p of r.picked) review.add(p.word)
      for (const w of rankTypes(r.types).slice(0, 50)) review.add(w)
    }
    if (v.id.startsWith('A ') || v.id.startsWith('D DeepSeek')) for (const w of rankTypes(r.types).slice(0, 50)) review.add(w)
    if (POOL) {
      for (const p of r.picked) pool.add(p.word)
      for (const w of rankTypes(r.types).slice(0, 50)) pool.add(w)
      if (v.terms) for (const w of v.terms.keys()) pool.add(w)
    }
  }
  if (POOL) {
    for (const f of ['DeepSeek-V3.2', 'Kimi-K2.6']) {
      const p = `${ROOT}out/goldfree-${f}-${B.id}.json`
      if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); for (const w of [...j.core, ...j.ok]) { const n = normTerm(String(w)); if (n.length >= 2 && text.includes(n)) pool.add(n) } }
    }
    for (const w of oldGold) if (text.includes(w)) pool.add(w)
    // 关键词上下文 (KWIC): 第一次出现前后各 18 字 + 次数
    const items = [...pool].map(w => {
      const i = text.indexOf(w)
      let f = 0; for (let k = text.indexOf(w); k >= 0; k = text.indexOf(w, k + 1)) f++
      return { w, f, ctx: text.slice(Math.max(0, i - 18), i).replace(/\n/g, '/') + '【' + w + '】' + text.slice(i + w.length, i + w.length + 18).replace(/\n/g, '/') }
    })
    writeFileSync(`${ROOT}out/pool-${B.id}.json`, JSON.stringify(items))
    out.pool = items.length
  }
  out.review = [...review]
  results[B.id] = out
  console.error(B.id, 'done', POOL ? 'pool ' + out.pool : '')
}
writeFileSync(`${ROOT}out/results-${DENS}.json`, JSON.stringify(results, null, 1))
// 汇总表
const ids = Object.keys(Object.values(results)[0]?.variants ?? {})
const allIds = [...new Set(Object.values(results).flatMap((r: any) => Object.keys(r.variants)))]
const f2 = (x: number) => x === undefined || Number.isNaN(x) ? ' — ' : x.toFixed(2)
console.log('方案 | ' + Object.keys(results).join(' | ') + ' | 平均 (P@50 / hit / recK / dens)')
for (const id of allIds) {
  const cells = Object.keys(results).map(b => { const v = results[b].variants[id]; return v ? `${f2(v.p50)}/${f2(v.hit)}/${f2(v.recK)}/${(v.dens * 100).toFixed(1)}%${v.unjudged ? ' u' + v.unjudged : ''}` : '—' })
  const vs = Object.keys(results).map(b => results[b].variants[id]).filter(Boolean)
  const avg = (k: string) => vs.reduce((a: number, v: any) => a + v[k], 0) / vs.length
  console.log(`${id} | ${cells.join(' | ')} | ${f2(avg('p50'))}/${f2(avg('hit'))}/${f2(avg('recK'))}/${(avg('dens') * 100).toFixed(1)}%`)
}
