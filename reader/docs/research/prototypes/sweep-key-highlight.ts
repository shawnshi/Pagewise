/**
 * 「点亮重点词」参数扫描: node docs/research/prototypes/sweep-key-highlight.ts <texts目录> <gold目录>
 * 指标 (对自标关键词, 严格匹配): P@50 = 分数前 50 的词里有几个是关键词; hit = 8% 密度下点亮的词次里关键词占比;
 * rec = 8% 密度下点亮过的词覆盖了几成关键词。四个文本取平均。
 */
import { readFileSync } from 'node:fs'
import { parseZhLexicon } from '../../../src/services/readingModes/zhSegment.ts'
import { DEFAULTS, prepareBook, scoreTypes, selectBook, type Params } from './keyHighlight.ts'

const [dir, gdir] = process.argv.slice(2)
const lex = parseZhLexicon(readFileSync(new URL('../../../src/data/zh-lexicon.txt', import.meta.url), 'utf8'))
const han = (w: string) => /^\p{Script=Han}/u.test(w)
const books = ['fiction', 'science', 'technical', 'nahan'].map(f => {
  const paras: string[] = [], chapters: number[] = [0]
  for (const raw of readFileSync(`${dir}/${f}.txt`, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('###')) { if (paras.length) chapters.push(paras.length); continue }
    paras.push(line)
  }
  const gold = new Set(readFileSync(`${gdir}/${f}.txt`, 'utf8').split(/\s+/).filter(Boolean))
  return { f, gold, b0: prepareBook(paras, lex, false, chapters), b1: prepareBook(paras, lex, true, chapters) }
})

function run(p: Partial<Params>, nw: boolean) {
  const cells: string[] = []
  let sp = 0, sh = 0, sr = 0
  for (const B of books) {
    const book = nw ? B.b1 : B.b0
    const prm = { ...DEFAULTS, ...p }
    const types = scoreTypes(book, prm)
    const ranked = [...types.values()].filter(x => x.eligible && han(x.word)).sort((a, b) => b.S - a.S).slice(0, 50).map(x => x.word)
    const p50 = ranked.filter(t => B.gold.has(t)).length / 50
    const picked = selectBook(book, types, prm).filter(x => han(x.word))
    const hit = picked.filter(x => B.gold.has(x.word)).length / picked.length
    const ty = new Set(picked.map(x => x.word))
    const rec = [...B.gold].filter(g => ty.has(g)).length / B.gold.size
    sp += p50; sh += hit; sr += rec
    cells.push(`${B.f.slice(0, 4)} ${p50.toFixed(2)}/${hit.toFixed(2)}/${rec.toFixed(2)}`)
  }
  const n = books.length
  return `P@50 ${(sp / n).toFixed(3)}  hit ${(sh / n).toFixed(3)}  rec ${(sr / n).toFixed(3)} | ${cells.join('  ')}`
}

const grid: Array<[string, Partial<Params>, boolean]> = [
  ['V0 只自信息', { alpha: 1, beta: 0, gamma: 0 }, false],
  ['只关键度', { alpha: 0, beta: 1, gamma: 0 }, false],
  ['V1 +关键度', { alpha: 1, beta: 1, gamma: 0 }, false],
  ['V2 +聚集C', { alpha: 1, beta: 1, gamma: 0.5 }, false],
  ['V2e +分块熵', { alpha: 1, beta: 1, gamma: 0.5, burst: 'entropy' }, false],
  ['V3 新词 γ0', { alpha: 1, beta: 1, gamma: 0 }, true],
  ['V3 γ.25', { alpha: 1, beta: 1, gamma: 0.25 }, true],
  ['V3 γ.5 推荐', { alpha: 1, beta: 1, gamma: 0.5 }, true],
  ['V3 γ1', { alpha: 1, beta: 1, gamma: 1 }, true],
  ['V3 熵 γ.5', { alpha: 1, beta: 1, gamma: 0.5, burst: 'entropy' }, true],
  ['V3 β.5', { alpha: 1, beta: 0.5, gamma: 0.5 }, true],
  ['V3 β2', { alpha: 1, beta: 2, gamma: 0.5 }, true],
  ['V3 α.5', { alpha: 0.5, beta: 1, gamma: 0.5 }, true],
  ['V3 α0', { alpha: 0, beta: 1, gamma: 0.5 }, true],
  ['V3 decay0', { decay: 0 }, true],
  ['V3 decay2', { decay: 2 }, true],
  ['V3 硬门槛', { kOverride: Infinity }, true],
  ['V3 kOverride4', { kOverride: 4 }, true],
  ['V3 kOverride6', { kOverride: 6 }, true],
  ['V3 minRank500', { minRank: 500 }, true],
  ['V3 minRank4000', { minRank: 4000 }, true],
]
console.log('方案'.padEnd(14), '平均 (fict/sci/tech/nahan 各为 P@50/hit/rec)')
for (const [name, p, nw] of grid) console.log(name.padEnd(14), run(p, nw))
