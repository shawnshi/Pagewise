// 点睛阅读「重点词」离线引擎 (src/services/readingModes/keyWords.ts) 与按书选词 (keyWordsBook.ts)。
// 运行: npm run test:key-words
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseZhLexicon } from '../src/services/readingModes/zhSegment.ts'
import {
  KW_AI_DENSITY, KW_DEFAULTS, KW_DENSITY, buildStats, decodeMixed, discoverNewWords, encodeMixed, locateTerm,
  normTerm, pickSection, scoreTypes, tokenizePara,
} from '../src/services/readingModes/keyWords.ts'
import { KwBook, packPicks } from '../src/services/readingModes/keyWordsBook.ts'

const lex = parseZhLexicon(readFileSync(new URL('../src/data/zh-lexicon.txt', import.meta.url), 'utf8'))

/** 确定性伪随机 (mulberry32) */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PEOPLE = ['阿Q', '赵太爷', '王胡', '小D', '邹七嫂', '假洋鬼子', '吴妈', '秀才']
const PLACES = ['未庄', '土谷祠', '静修庵', '县城', '酒店']
const VERBS = ['走进', '看见', '想起', '离开', '回到', '谈起', '遇见', '记得', '打听', '躲开']
const FILL = ['那天', '傍晚', '忽然', '后来', '大家', '人们', '一路', '心里', '远远地', '慢慢地', '又', '便']
const TAIL = ['，心里很不平。', '，许多人都笑了。', '，天色已经晚了。', '，说了几句闲话。', '，再也没有回来。', '，觉得十分得意。']

/** 生成一章: 人名、地名在不同上下文里反复出现 (新词发现需要左右邻字多样) */
function chapter(seed, paras = 40, people = PEOPLE) {
  const r = rng(seed)
  const pick = a => a[Math.floor(r() * a.length)]
  const out = []
  for (let i = 0; i < paras; i++) {
    const n = 2 + Math.floor(r() * 3)
    let p = ''
    for (let k = 0; k < n; k++) p += `${pick(FILL)}${pick(people)}${pick(VERBS)}${pick(PLACES)}${pick(TAIL)}`
    out.push(p)
  }
  return out
}

test('「汉字 + 短西文」编码: 阿Q ↔ 一个私用区字符, 原文写法往返不变', () => {
  for (const w of ['阿Q', '小D', 'X射线', '老Q头', '赵太爷']) assert.equal(decodeMixed(encodeMixed(w)), w)
  assert.equal(encodeMixed('阿Q').length, 2)
  assert.equal(encodeMixed('赵太爷'), '赵太爷')
  assert.notEqual(encodeMixed('阿Q'), encodeMixed('阿D'))
})

test('新词发现: 人名地名成词 (含「阿Q」), 不收短语碎片', () => {
  const paras = [1, 2, 3].flatMap(s => chapter(s))
  const found = new Set([...discoverNewWords(paras, lex).keys()].map(decodeMixed))
  for (const w of ['阿Q', '赵太爷', '邹七嫂', '土谷祠']) assert.ok(found.has(w), `应发现 ${w}: ${[...found].join(' ')}`)
  for (const w of found) {
    assert.ok(w.length >= 2 && w.length <= 4, w)
    assert.ok(!/[的了]/.test(w), `不收含虚字的片段 ${w}`)
  }
})

test('切分: 发现「阿Q」后整体成词 (之前「阿」「Q」分开, 永远点不亮)', () => {
  const p = '阿Q的名字是怎么写的？阿Q走进未庄。'
  const plain = tokenizePara(p, lex).map(t => t.text)
  assert.ok(!plain.includes('阿Q'))
  const stats = buildStats([{ section: 0, paras: chapter(7, 60) }], lex)
  assert.ok(stats.newWords.has('阿Q'))
  const toks = tokenizePara(p, stats.lex)
  const aq = toks.filter(t => t.text === '阿Q')
  assert.equal(aq.length, 2)
  assert.deepEqual(aq.map(t => [t.index, t.len]), [[0, 2], [11, 2]])
  // 下标是原文的 UTF-16 下标
  for (const t of toks) assert.equal(p.slice(t.index, t.index + t.len), t.text || p.slice(t.index, t.index + t.len))
})

test('打分: 本书人名进入前列且可参选; 停用词 / 单字 / 数字不参选', () => {
  const stats = buildStats([0, 1, 2].map(i => ({ section: i, paras: chapter(10 + i) })), lex)
  const types = scoreTypes(stats, KW_DEFAULTS)
  const top = [...types.values()].filter(t => t.eligible).sort((a, b) => b.S - a.S).slice(0, 12).map(t => t.word)
  for (const w of ['阿Q', '赵太爷', '土谷祠']) assert.ok(top.includes(w), `${w} 应在前 12: ${top.join(' ')}`)
  for (const w of ['已经', '许多', '十分', '了']) assert.ok(!types.get(w)?.eligible, `${w} 不参选`)
})

/** 选词结果的密度: 点亮词次 ÷ 本节汉字词与西文词数 */
function density(paras, picks, statsLex) {
  let words = 0
  for (const p of paras) words += tokenizePara(p, statsLex).length
  return picks.length / words
}

/** 一章普通文字 (词汇量大) 用来测密度控制 */
function richChapter(seed, paras = 60) {
  const r = rng(seed)
  // 取词表里名次靠后的二字词当「内容词」, 让候选足够多
  const vocab = []
  for (const [w, c] of lex.cost) if (w.length === 2 && c > Math.log(8000) && c < Math.log(40000) && /^\p{Script=Han}+$/u.test(w)) { vocab.push(w); if (vocab.length > 4000) break }
  const pick = a => a[Math.floor(r() * a.length)]
  const out = []
  for (let i = 0; i < paras; i++) {
    let p = ''
    for (let k = 0; k < 4; k++) p += `${pick(FILL)}${pick(vocab)}的${pick(vocab)}和${pick(vocab)}${pick(VERBS)}了${pick(vocab)}${pick(TAIL)}`
    out.push(p)
  }
  return out
}

test('密度控制: 少 / 适中 / 多 ≈ 2% / 4% / 8%, 都不超过目标, 档位越高点亮越多', () => {
  const paras = richChapter(42)
  const stats = buildStats([{ section: 0, paras }], lex)
  const types = scoreTypes(stats, KW_DEFAULTS)
  const got = {}
  for (const lv of ['low', 'normal', 'high']) {
    const prm = { ...KW_DEFAULTS, density: KW_DENSITY[lv] }
    const picks = pickSection(paras, 0, stats, types, prm)
    got[lv] = density(paras, picks, stats.lex)
    assert.ok(got[lv] <= KW_DENSITY[lv] + 1e-9, `${lv} ${got[lv]}`)
    assert.ok(got[lv] >= KW_DENSITY[lv] * 0.8, `${lv} 应接近目标: ${got[lv]}`)
  }
  assert.ok(got.low < got.normal && got.normal < got.high)
})

test('排布: 不相邻、一段同词只亮一次、每句有上限; 全书第一次出现强, 之后弱', () => {
  const paras = [0, 1].map(i => chapter(20 + i, 30))
  const stats = buildStats(paras.map((p, i) => ({ section: i, paras: p })), lex)
  const types = scoreTypes(stats, KW_DEFAULTS)
  const prm = { ...KW_DEFAULTS, density: 0.08 }
  const firstStrong = new Map()
  for (let sec = 0; sec < 2; sec++) {
    const picks = pickSection(paras[sec], sec, stats, types, prm)
    assert.ok(picks.length > 0)
    const byPara = new Map()
    for (const p of picks) {
      const list = byPara.get(p.para) ?? []
      list.push(p)
      byPara.set(p.para, list)
      assert.equal(paras[sec][p.para].slice(p.index, p.index + p.len), p.word)
    }
    for (const [pi, list] of byPara) {
      const words = list.map(p => p.word)
      assert.equal(new Set(words).size, words.length, `第 ${pi} 段同一个词只亮一次`)
      const toks = tokenizePara(paras[sec][pi], stats.lex)
      const ordOf = p => toks.find(t => t.index === p.index).ord
      const ords = list.map(ordOf).sort((a, b) => a - b)
      for (let k = 1; k < ords.length; k++) assert.ok(ords[k] - ords[k - 1] >= 2, '点亮的词不相邻')
      // 每句上限 ceil(句内词数 × d × 2.5)
      const perSent = new Map()
      for (const p of list) { const s = toks.find(t => t.index === p.index).sent; perSent.set(s, (perSent.get(s) ?? 0) + 1) }
      for (const [s, n] of perSent) {
        const words = toks.filter(t => t.sent === s).length
        assert.ok(n <= Math.max(1, Math.ceil(words * prm.density * prm.sentenceFactor)), `句子 ${s}: ${n}`)
      }
    }
    for (const p of picks) {
      if (p.strong) { assert.ok(!firstStrong.has(p.word), `${p.word} 只在全书第一次出现时强`); firstStrong.set(p.word, sec) }
    }
  }
  assert.ok(firstStrong.size > 0)
})

test('小说不剧透: 只在后面章节出现的人物, 在前面章节的统计里不存在', () => {
  const late = ['革命党', '举人老爷']
  const sections = [
    { section: 0, paras: chapter(31, 30, PEOPLE.slice(0, 4)) },
    { section: 1, paras: chapter(32, 30, late) },
  ]
  const stats = buildStats(sections, lex)
  const whole = scoreTypes(stats, KW_DEFAULTS)
  const prefix = scoreTypes(stats, KW_DEFAULTS, stats.ordEnd.get(0))
  // 只在第 1 章出现的词: 全书统计里有, 读到第 0 章为止的统计里没有
  const inCh0 = new Set(sections[0].paras.flatMap(p => tokenizePara(p, stats.lex).map(t => t.text)))
  const onlyLate = [...whole.keys()].filter(w => !inCh0.has(w))
  assert.ok(onlyLate.length > 0)
  for (const w of onlyLate) assert.ok(!prefix.has(w), w)
  // 前缀里出现次数只算到第 0 章末
  const f0 = prefix.get('阿Q')?.f ?? prefix.get('赵太爷')?.f
  assert.ok(f0 > 0)
})

test('AI 词: 只亮 AI 词; 少档只要重要度≥2; 「多」档 AI 词优先、统计词补满且一律弱样式; 长词优先定位', () => {
  const paras = chapter(50, 40)
  const stats = buildStats([{ section: 0, paras }], lex)
  const types = scoreTypes(stats, KW_DEFAULTS)
  const ai = new Map([['赵太爷', { r: 3, n: 4 }], ['未庄', { r: 2, n: 3 }], ['太爷', { r: 1, n: 1 }], ['吴妈', { r: 1, n: 1 }]])
  const prm = { ...KW_DEFAULTS, density: KW_AI_DENSITY }
  const only = pickSection(paras, 0, stats, types, prm, { ai, mode: 'ai' })
  assert.ok(only.length > 0)
  assert.ok(only.every(p => ai.has(p.word) && p.ai))
  // 「赵太爷」整体定位, 不会拆出「太爷」
  assert.ok(!only.some(p => p.word === '太爷' && paras[p.para].slice(p.index - 1, p.index) === '赵'))
  const low = pickSection(paras, 0, stats, types, prm, { ai, mode: 'ai', minR: 2 })
  assert.ok(low.length > 0 && low.every(p => ai.get(p.word).r >= 2))
  assert.ok(low.length < only.length)
  const fill = pickSection(paras, 0, stats, types, prm, { ai, mode: 'aiFill' })
  assert.ok(fill.length > only.length)
  assert.ok(fill.filter(p => !p.ai).every(p => !p.strong), '补上的统计词一律弱样式')
  assert.ok(fill.some(p => p.ai))
})

test('AI 词规范化与定位: 去空格 / 书名号 / 全角, 找回原文写法; 找不到返回 null', () => {
  assert.equal(normTerm(' 阿 Q '), '阿Q')
  assert.equal(normTerm('《呐喊》'), '呐喊')
  assert.equal(normTerm('赵太爷。'), '赵太爷')
  const text = '阿Q走进未庄，看见ＴＣＰ报文段。'
  assert.equal(locateTerm(text, '阿 Q'), '阿Q')
  assert.equal(locateTerm(text, 'TCP'), 'ＴＣＰ')
  assert.equal(locateTerm(text, '精神胜利法'), null)
  assert.equal(locateTerm(text, '庄'), null, '单字不收')
})

test('按书选词: 先用已有分节算; 智能版按段混合 AI 结果与离线结果; 结果打包成 Int32Array', () => {
  const book = new KwBook(lex)
  const p0 = chapter(60, 30)
  const off = book.pick({ section: 0, paras: p0, level: 'normal', spoilerSafe: false })
  assert.ok(off.length > 0)
  assert.ok(off.every(p => !p.ai))
  const mask = p0.map((_, i) => (i < 15 ? 1 : 0))
  const mixed = book.pick({ section: 0, paras: p0, level: 'normal', spoilerSafe: false, smart: { words: [['赵太爷', 3, 2], ['未庄', 2, 2]], aiParas: mask } })
  assert.ok(mixed.filter(p => p.para < 15).every(p => p.ai))
  assert.ok(mixed.filter(p => p.para >= 15).every(p => !p.ai))
  assert.ok(mixed.some(p => p.para >= 15))
  const packed = packPicks(mixed)
  assert.equal(packed.length, mixed.length * 4)
  assert.equal(packed[3] & 2, mixed[0].ai ? 2 : 0)
  // 加入第二节并做全书统计后, 结果仍可取
  book.addSection(1, chapter(61, 30))
  book.analyze()
  assert.ok(book.complete)
  assert.ok(book.pick({ section: 1, paras: chapter(61, 30), level: 'high', spoilerSafe: true }).length > 0)
})

test('速度: 24 万字左右的全书统计 (新词发现 + 切分) 与逐章选词', () => {
  const sections = []
  for (let i = 0; i < 40; i++) sections.push({ section: i, paras: chapter(100 + i, 60) })
  const chars = sections.reduce((a, s) => a + s.paras.reduce((b, p) => b + p.length, 0), 0)
  const t0 = performance.now()
  const stats = buildStats(sections, lex)
  const t1 = performance.now()
  const types = scoreTypes(stats, KW_DEFAULTS)
  let n = 0
  for (const s of sections.slice(0, 5)) n += pickSection(s.paras, s.section, stats, types, KW_DEFAULTS).length
  const t2 = performance.now()
  const perChapter = (t2 - t1) / 5
  console.log(`  ${chars} 字: 全书统计 ${(t1 - t0).toFixed(0)} ms, 每章选词 ${perChapter.toFixed(1)} ms (${n} 个)`)
  // 宽松上限 (CI 机器慢): 每万字 40 ms
  assert.ok((t1 - t0) / (chars / 10000) < 40, `全书统计 ${(t1 - t0).toFixed(0)} ms`)
})

test('样式: 重点词强 (着色 + 浅底) / 弱 (只着色), 随颜色与明显程度变化, 只用颜色类属性', async () => {
  const { getReaderCSS } = await import('../src/services/readerTheme.ts')
  const prefs = { theme: 'light', fontSize: 18, lineHeight: 1.8, gap: 0.06, flow: 'paginated', maxColumnCount: 2, fontFamily: '', justify: true, letterSpacing: 0 }
  const css = (intensity, color, theme = 'light') => getReaderCSS({ ...prefs, theme }, false, { wordGuideIntensity: intensity, wordGuideColor: color })
  const rule = (text, name) => new RegExp(`::highlight\\(${name}\\) \\{([^}]*)\\}`).exec(text)?.[1] ?? ''
  const a = css(0.7, 'rose')
  const strong = rule(a, 'lr-wg-kw-s')
  const weak = rule(a, 'lr-wg-kw-w')
  assert.match(strong, /background-color: rgba\(/)
  assert.doesNotMatch(weak, /background/)
  for (const r of [strong, weak]) assert.doesNotMatch(r, /font-weight|font-size|padding|margin/)
  assert.notEqual(rule(css(0.3, 'rose'), 'lr-wg-kw-w'), weak, '明显程度变化')
  assert.notEqual(rule(css(0.7, 'teal'), 'lr-wg-kw-s'), strong, '颜色变化')
  assert.match(rule(css(0.7, 'rose', 'dark'), 'lr-wg-kw-s'), /background-color/)
})
