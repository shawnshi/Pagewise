/**
 * 「点亮重点词」算例: 打印某一段里每个候选词的各项分数, 以及在给定密度下是否点亮。
 * node docs/research/prototypes/explain-key-highlight.ts <文本> <段号> [密度=0.08]
 */
import { readFileSync } from 'node:fs'
import { parseZhLexicon } from '../../../src/services/readingModes/zhSegment.ts'
import { DEFAULTS, prepareBook, rankOf, scoreTypes, selectBook } from './keyHighlight.ts'

const [file, paraArg, densArg] = process.argv.slice(2)
const lex = parseZhLexicon(readFileSync(new URL('../../../src/data/zh-lexicon.txt', import.meta.url), 'utf8'))
const paras = readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('###'))
const pi = Number(paraArg)
const prm = { ...DEFAULTS, density: densArg ? Number(densArg) : DEFAULTS.density }
const book = prepareBook(paras, lex, true)
const types = scoreTypes(book, prm)
const picked = selectBook(book, types, prm).filter(p => p.para === pi)
const lit = new Map(picked.map(p => [p.index, p]))
console.log(`段 ${pi}: ${paras[pi]}\n全书 ${book.N} 词; 密度 ${prm.density}; 本段点亮 ${picked.length} 个\n`)
console.log('词\t名次\tI(nat)\t次数f\t期望E\tK=ln(1+G²)\tB\tS\t结果')
const seen = new Set<string>()
for (const t of book.toks.filter(t => t.para === pi)) {
  if (!t.text) continue
  const ty = types.get(t.text)!
  const r = rankOf(book.lex, t.text)
  const E = book.N * Math.exp(-ty.I)
  const p = lit.get(t.index)
  const res = p ? (p.strong ? '点亮(首次)' : '点亮(重复)') : !ty.eligible ? '不参选' : seen.has(t.text) ? '—(本段已亮/重复)' : '—'
  seen.add(t.text)
  if (!ty.eligible && t.text.length < 2) continue // 单字虚词不列
  console.log([t.text, r === undefined ? '-' : (ty.isNew ? '新词' : Math.round(r)), ty.I.toFixed(1), ty.f, E.toFixed(2), ty.K.toFixed(1), ty.B.toFixed(1), ty.S.toFixed(1), res].join('\t'))
}
