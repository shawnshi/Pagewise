/**
 * 「点亮重点词」原型评测: node docs/research/prototypes/run-key-highlight.ts <texts目录> <gold目录> <输出目录>
 * 文本 (每行一段, `### 篇名` 行分章): fiction.txt (阿Q正传) science.txt (维基百科「黑洞」) technical.txt (维基百科「传输控制协议」)
 * nahan.txt (呐喊); 维基百科文本是 CC BY-SA, 只在本地评测, 不随仓库分发。自标关键词 (空格分隔) 见 key-highlight-gold/。
 * 输出: results.json (指标) 与 preview-*.html (预览)。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { parseZhLexicon } from '../../../src/services/readingModes/zhSegment.ts'
import { DEFAULTS, prepareBook, scoreTypes, selectBook, type Params, type Picked, type TypeInfo } from './keyHighlight.ts'

const [textDir, goldDir, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const lexText = readFileSync(new URL('../../../src/data/zh-lexicon.txt', import.meta.url), 'utf8')
let t0 = performance.now()
const lex = parseZhLexicon(lexText)
const lexMs = performance.now() - t0

const TEXTS = [
  { id: 'fiction', name: '小说 · 鲁迅《阿Q正传》', file: 'fiction.txt' },
  { id: 'science', name: '科普 · 维基百科「黑洞」', file: 'science.txt' },
  { id: 'technical', name: '技术 · 维基百科「传输控制协议」', file: 'technical.txt' },
  { id: 'nahan', name: '整本书 · 鲁迅《呐喊》(12 篇, 按篇定阈值)', file: 'nahan.txt' },
]
const DENSITIES = [0.03, 0.08, 0.15, 0.3]
/** 读入文本: 每行一段; `### 标题` 行是章节分隔 (不进正文) */
function loadText(path: string) {
  const paras: string[] = [], chapters: number[] = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('###')) { chapters.push(paras.length); continue }
    paras.push(line)
  }
  if (!chapters.length || chapters[0] !== 0) chapters.unshift(0)
  return { paras, chapters: [...new Set(chapters)] }
}
const VARIANTS: Array<{ id: string; name: string; p: Partial<Params>; random?: boolean }> = [
  { id: 'R', name: '随机多字词 (对照)', p: { alpha: 0, beta: 0, gamma: 0, newWords: false, decay: 0 }, random: true },
  { id: 'V0', name: '只用自信息 (词越罕见越亮)', p: { alpha: 1, beta: 0, gamma: 0, newWords: false } },
  { id: 'V1', name: '+ 本书关键度 G²', p: { alpha: 1, beta: 1, gamma: 0, newWords: false } },
  { id: 'V2', name: '+ 聚集度 (Carpena C)', p: { alpha: 1, beta: 1, gamma: 0.5, newWords: false } },
  { id: 'V2e', name: '+ 聚集度 (分块熵)', p: { alpha: 1, beta: 1, gamma: 0.5, burst: 'entropy', newWords: false } },
  { id: 'V3', name: '+ 本书新词 (推荐)', p: { alpha: 1, beta: 1, gamma: 0.5, newWords: true } },
]

const strictMatch = (t: string, g: string) => t === g
const lenientMatch = (t: string, g: string) => t === g || (t.length >= 2 && g.includes(t)) || t.includes(g)

function evalRun(types: Map<string, TypeInfo>, picked: Picked[], gold: string[]) {
  const ranked = [...types.values()].filter(x => x.eligible && /^\p{Script=Han}/u.test(x.word)).sort((a, b) => b.S - a.S).slice(0, 50).map(x => x.word)
  const p50 = ranked.filter(t => gold.some(g => strictMatch(t, g))).length / 50
  const p50l = ranked.filter(t => gold.some(g => lenientMatch(t, g))).length / 50
  const r50 = gold.filter(g => ranked.some(t => strictMatch(t, g))).length / gold.length
  const han = picked.filter(p => /^\p{Script=Han}/u.test(p.word))
  const hit = han.filter(p => gold.some(g => strictMatch(p.word, g))).length / Math.max(1, han.length)
  const hitL = han.filter(p => gold.some(g => lenientMatch(p.word, g))).length / Math.max(1, han.length)
  const types2 = new Set(picked.map(p => p.word))
  const rec = gold.filter(g => [...types2].some(t => strictMatch(t, g))).length / gold.length
  const recL = gold.filter(g => [...types2].some(t => lenientMatch(t, g))).length / gold.length
  return { p50, p50l, r50, hit, hitL, rec, recL, picked: picked.length, types: types2.size, top: ranked.slice(0, 20) }
}

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;') }
function renderParas(paras: string[], picked: Picked[], from: number, to: number): string {
  const by = new Map<number, Picked[]>()
  for (const p of picked) { if (p.para < from || p.para >= to) continue; let a = by.get(p.para); if (!a) by.set(p.para, a = []); a.push(p) }
  let html = ''
  for (let i = from; i < to; i++) {
    const t = paras[i]
    const ps = (by.get(i) ?? []).sort((a, b) => a.index - b.index)
    let s = '', at = 0
    for (const p of ps) {
      s += esc(t.slice(at, p.index)) + `<mark class="${p.strong ? 's' : 'w'}" title="${p.score.toFixed(1)}">${esc(t.slice(p.index, p.index + p.len))}</mark>`
      at = p.index + p.len
    }
    s += esc(t.slice(at))
    html += `<p>${s}</p>`
  }
  return html
}
const CSS = `body{font:15px/1.9 "Noto Serif CJK SC","Source Han Serif SC",serif;margin:16px;background:#faf8f3;color:#222}
h1{font:600 18px sans-serif;margin:0 0 8px}h2{font:600 14px sans-serif;margin:0 0 6px;color:#555}
.grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:14px}.panel{background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:10px 14px}
p{margin:0 0 .6em;text-indent:2em}mark{background:none;color:inherit}
mark.s{color:#9a3412;background:#fdecc8;border-radius:2px;font-weight:600}mark.w{color:#9a3412}
.meta{font:12px sans-serif;color:#777;margin-bottom:6px}`

const results: Record<string, unknown> = { lexMs }
for (const T of TEXTS) {
  const { paras, chapters } = loadText(`${textDir}/${T.file}`)
  const chars = paras.reduce((n, p) => n + p.length, 0)
  const gold = readFileSync(`${goldDir}/${T.file}`, 'utf8').split(/\s+/).filter(Boolean)
  const tr: Record<string, unknown> = { chars, paras: paras.length, gold: gold.length }
  const runs: Record<string, Picked[]> = {}
  for (const V of VARIANTS) {
    const prm: Params = { ...DEFAULTS, ...V.p }
    const mem0 = process.memoryUsage().heapUsed
    const t1 = performance.now()
    const book = prepareBook(paras, lex, prm.newWords, chapters)
    const t2 = performance.now()
    const types = scoreTypes(book, prm)
    if (V.random) { let seed = 7; for (const ty of types.values()) { seed = (seed * 1103515245 + 12345) % 2147483648; ty.S = seed / 2147483648 * 10; if (ty.word.length < 2) ty.eligible = false } }
    const t3 = performance.now()
    const picked = selectBook(book, types, prm)
    const t4 = performance.now()
    const mem1 = process.memoryUsage().heapUsed
    const ev = evalRun(types, picked, gold)
    tr[V.id] = { ...ev, newWords: [...book.newWords].slice(0, 40), nNew: book.newWords.size, ms: { seg: t2 - t1, score: t3 - t2, select: t4 - t3, total: t4 - t1 }, msPer10k: (t4 - t1) / chars * 1e4, heapMB: (mem1 - mem0) / 1e6, N: book.N }
    runs[V.id] = picked
  }
  // 密度对比 (推荐方案)
  const dens: Record<string, Picked[]> = {}
  for (const d of DENSITIES) {
    const prm = { ...DEFAULTS, density: d }
    const book = prepareBook(paras, lex, true, chapters)
    const types = scoreTypes(book, prm)
    dens[String(d)] = selectBook(book, types, prm)
    const litChars = dens[String(d)].reduce((a, p) => a + p.len, 0)
    tr['V3@' + d] = { ...evalRun(types, dens[String(d)], gold), achievedTok: dens[String(d)].length / book.N, achievedChar: litChars / chars }
  }
  // 速度: 推荐方案 5 次取中位数
  const ts: number[] = []
  for (let k = 0; k < 5; k++) { const a = performance.now(); const b = prepareBook(paras, lex, true, chapters); selectBook(b, scoreTypes(b, DEFAULTS), DEFAULTS); ts.push(performance.now() - a) }
  ts.sort((a, b) => a - b)
  tr.speedMedianMsPer10k = ts[2] / chars * 1e4
  results[T.id] = tr

  // 预览: 选 2 段区间 (约 700 字)
  const pick = (start: number) => { let n = 0, e = start; while (e < paras.length && n < 650) n += paras[e++].length; return [start, e] as const }
  const ranges = [pick(T.id === 'fiction' ? 3 : 0), pick(Math.floor(paras.length * 0.55))]
  for (const [ri, [a, b]] of ranges.entries()) {
    const v = VARIANTS.filter(x => x.id !== 'V2e').map(V => `<div class="panel"><h2>${V.id} · ${V.name}</h2><div class="meta">密度 8% · 首次出现=底色加粗, 重复=只变色</div>${renderParas(paras, runs[V.id], a, b)}</div>`).join('')
    writeFileSync(`${outDir}/preview-${T.id}-${ri + 1}-variants.html`, `<!doctype html><meta charset="utf-8"><style>${CSS}</style><h1>${T.name} · 片段 ${ri + 1} · 各方案对比</h1><div class="grid" style="--cols:3">${v}</div>`)
    const d = Object.entries(dens).map(([k, p]) => `<div class="panel"><h2>V3 · 密度 ${Math.round(+k * 100)}% (实际 ${(p.length / Math.max(1, (results[T.id] as any)?.V3?.N ?? 1) * 100).toFixed(1)}%)</h2>${renderParas(paras, p, a, b)}</div>`).join('')
    writeFileSync(`${outDir}/preview-${T.id}-${ri + 1}-density.html`, `<!doctype html><meta charset="utf-8"><style>${CSS}</style><h1>${T.name} · 片段 ${ri + 1} · 推荐方案在不同密度下</h1><div class="grid" style="--cols:4">${d}</div>`)
  }
}
t0 = performance.now()
writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 1))
console.log(JSON.stringify(results, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 1))
