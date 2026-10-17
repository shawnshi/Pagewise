// 仿生阅读的中文分词 (src/services/readingModes/zhSegment.ts) 与着色规则 (wordGuide.ts guideSpans)。
// 运行: npm run test:zh-segment
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  cutHan,
  lexiconFromRanked,
  parseZhLexicon,
  segmentZh,
  segmentZhIcu,
  splitRuns,
} from '../src/services/readingModes/zhSegment.ts'
import { ZH_MERGE_WORDS, guideSpans, usesZhLexicon } from '../src/services/readingModes/wordGuide.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LEXICON_PATH = join(ROOT, 'src/data/zh-lexicon.txt')
const lexiconText = readFileSync(LEXICON_PATH, 'utf8')
const lex = parseZhLexicon(lexiconText)
const icu = new Intl.Segmenter('zh', { granularity: 'word' })

/** 切分结果写成「词｜词」, 没把握的词前面加 ? */
const show = segs => segs.map(s => (s.unsure ? '?' : '') + s.text).join('｜')
const colored = (text, opts) => {
  const r = guideSpans(text, 'zh', opts)
  return r.alt.map(([a, b]) => text.slice(a, b))
}
/** 两种颜色都还原出来: 着色顺序里所有的词 (偶数位正文色 + 奇数位混合色) */
function allColoredWords(text, lexicon) {
  return segmentZh(text, lexicon).filter(s => s.kind === 'han' && !s.unsure && s.text.length >= 2).map(s => s.text)
}

// ---------------------------------------------------------------------------
// 词表资源
// ---------------------------------------------------------------------------

test('词表资源: 约 6.6 万词, 体积在预算内, 带来源与许可说明', () => {
  assert.ok(lex.size > 60000 && lex.size < 70000, `size ${lex.size}`)
  assert.ok(lex.maxLen <= 8)
  for (const w of ['的', '了', '图书馆', '人工智能', '祸不单行', '新能源', '公交车', '客运量']) assert.ok(lex.cost.has(w), w)
  // 越常用代价越小
  assert.ok(lex.cost.get('的') < lex.cost.get('图书馆'))
  assert.ok(lex.cost.get('图书馆') < lex.unk)
  const gz = gzipSync(lexiconText, { level: 9 }).length
  assert.ok(gz < 240 * 1024, `gzip ${gz}`)
  const head = lexiconText.split('\n').filter(l => l.startsWith('#')).join('\n')
  assert.match(head, /jieba.*MIT.*Sun Junyi/s)
  assert.match(head, /DeepSeek-R1.*MIT.*DeepSeek/s)
  const readme = readFileSync(join(ROOT, 'src/data/zh-lexicon.README.md'), 'utf8')
  assert.match(readme, /Copyright \(c\) 2013 Sun Junyi/)
  assert.match(readme, /Copyright \(c\) 2023 DeepSeek/)
})

test('词表格式: 分档 + 前缀压缩, 也接受每行一个词的纯文本', () => {
  const tiered = '# comment\n0的\n-\n0图书\n2馆\n0人工智能\n'
  const a = parseZhLexicon(tiered)
  assert.deepEqual([...a.cost.keys()], ['的', '图书', '图书馆', '人工智能'])
  // 同一档代价相同, 后一档更大
  assert.equal(a.cost.get('图书'), a.cost.get('图书馆'))
  assert.ok(a.cost.get('的') < a.cost.get('图书'))
  const plain = parseZhLexicon('的\r\n图书馆\n人工智能\n')
  assert.deepEqual([...plain.cost.keys()], ['的', '图书馆', '人工智能'])
  assert.ok(plain.cost.get('的') < plain.cost.get('图书馆'))
  const ranked = lexiconFromRanked(['的', '的', '图书馆'])
  assert.equal(ranked.size, 2)
})

test('回退合并表: 约 2,600 个三四字常用词, 覆盖 ICU 常切开的词', () => {
  assert.ok(ZH_MERGE_WORDS.size > 2500 && ZH_MERGE_WORDS.size < 2800, `size ${ZH_MERGE_WORDS.size}`)
  for (const w of ['图书馆', '新能源', '公交车', '人工智能', '数据库']) assert.ok(ZH_MERGE_WORDS.has(w), w)
  for (const w of ZH_MERGE_WORDS) assert.ok(w.length === 3 || w.length === 4, w)
})

test('词表构建可复现: 用缓存的原始数据重建, 结果与入库的文件一致', {
  skip: !existsSync(join(process.env.ZH_LEXICON_CACHE ?? join(homedir(), '.cache/lightread/zh-lexicon'), 'jieba-v0.42.1-dict.txt'))
    && '本机没有词表原始数据缓存 (node scripts/build-zh-lexicon.mjs 会下载)',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-lexicon-'))
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/build-zh-lexicon.mjs'), '--offline',
      '--out', join(dir, 'lex.txt'), '--out-merge', join(dir, 'merge.ts')], { stdio: 'pipe' })
    assert.equal(readFileSync(join(dir, 'lex.txt'), 'utf8'), lexiconText)
    assert.equal(readFileSync(join(dir, 'merge.ts'), 'utf8'),
      readFileSync(join(ROOT, 'src/services/readingModes/zhMergeWords.ts'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 切分
// ---------------------------------------------------------------------------

test('预切分: 汉字串 / 西文词 / 数字 / 空白 / 标点分开, 下标是原文下标', () => {
  const text = '在 BERT 上训练了 3.5 小时，准确率 92%。'
  const runs = splitRuns(text)
  assert.deepEqual(runs.map(r => `${r.kind}:${r.text}`), [
    'han:在', 'space: ', 'latin:BERT', 'space: ', 'han:上训练了', 'space: ', 'num:3.5', 'space: ', 'han:小时',
    'punct:，', 'han:准确率', 'space: ', 'num:92%', 'punct:。',
  ])
  for (const r of runs) assert.equal(text.slice(r.index, r.index + r.text.length), r.text)
})

test('按词表切分: 三四字常用词、成语整体成词', () => {
  assert.equal(show(segmentZh('他慢慢地走进了图书馆，翻开一本关于人工智能的书。', lex)),
    '他｜慢慢｜地｜走进｜了｜图书馆｜，｜翻开｜一｜本｜关于｜人工智能｜的｜书｜。')
  assert.equal(show(segmentZh('正是祸不单行的日子', lex)), '正是｜祸不单行｜的｜日子')
  assert.equal(show(segmentZh('提高换乘效率', lex)), '提高｜换乘｜效率')
})

test('歧义不上色: 「冷风」与「风吹」交叉, 「冷风」标为没把握', () => {
  const segs = segmentZh('冷风吹进船舱中', lex)
  assert.equal(show(segs), '?冷风｜吹｜进｜船舱｜中')
  // 不做歧义检查时它会被当成普通词
  assert.equal(show(segmentZh('冷风吹进船舱中', lex, { unsureMargin: null })), '冷风｜吹｜进｜船舱｜中')
  assert.deepEqual(allColoredWords('冷风吹进船舱中', lex), ['船舱'])
  // 「研究生命」: 「研究生」跨过「生命」的起点
  assert.equal(show(segmentZh('研究生命的起源', lex)), '研究｜?生命｜的｜起源')
})

test('数字和单位: 数字单独成段不上色, 单位词照常切分', () => {
  const text = '新能源公交车已达到3200辆，日均客运量超过450万人次，比去年同期增长12.3%。'
  const segs = segmentZh(text, lex)
  assert.deepEqual(segs.filter(s => s.kind === 'num').map(s => s.text), ['3200', '450', '12.3%'])
  assert.equal(show(segs), '新能源｜公交车｜已｜达到｜3200｜辆｜，｜日均｜客运量｜超过｜450｜万人次｜，｜比｜去年同期｜增长｜12.3%｜。')
  // 数字不上色
  const r = guideSpans(text, 'zh', { lexicon: lex })
  for (const [a, b] of r.alt) assert.match(text.slice(a, b), /^\p{Script=Han}+$/u)
})

test('中英混排: 夹在中文里的西文词整体当一个单元, 不切开', () => {
  const text = 'Transformer 模型使用自注意力机制，BERT、GPT 等模型都在它的基础上发展起来。'
  const segs = segmentZh(text, lex)
  assert.deepEqual(segs.filter(s => s.kind === 'latin').map(s => s.text), ['Transformer', 'BERT', 'GPT'])
  assert.ok(segs.some(s => s.text === '注意力'))
})

test('未登录字落成单字 (不猜新词), 扩展区汉字不被切成半个', () => {
  const text = '𠀋𠀋龘龘'
  const segs = segmentZh(text, lex)
  assert.equal(segs.map(s => s.text).join(''), text)
  assert.deepEqual(segs.map(s => s.text), ['𠀋', '𠀋', '龘', '龘'])
  assert.deepEqual(guideSpans(text, 'zh', { lexicon: lex }).alt, [])
  // cutHan 的终点单调递增并覆盖整串
  const { ends } = cutHan('图书馆里的人工智能', lex)
  assert.equal(ends.at(-1), 9)
  assert.ok(ends.every((e, i) => i === 0 || e > ends[i - 1]))
})

test('回退: 词表没加载时用 ICU + 合并表 (「新｜能源」「公｜交｜车」合并)', () => {
  const text = '本市新能源公交车已达到3200辆'
  const segs = segmentZhIcu(text, ZH_MERGE_WORDS, icu)
  assert.ok(segs.some(s => s.text === '新能源'), show(segs))
  assert.ok(segs.some(s => s.text === '公交车'), show(segs))
  assert.equal(segs.map(s => s.text).join(''), text)
  assert.ok(segs.some(s => s.kind === 'num' && s.text === '3200'))
  // 没有 Intl.Segmenter: 全部落成单字, 不上色
  const bare = segmentZhIcu(text, ZH_MERGE_WORDS, null)
  assert.ok(bare.filter(s => s.kind === 'han').every(s => s.text.length === 1))
  // guideSpans 不传词表即走回退
  assert.ok(colored('他慢慢地走进了图书馆，翻开一本关于人工智能的书。').length > 0)
})

// ---------------------------------------------------------------------------
// 着色规则
// ---------------------------------------------------------------------------

test('交替: 只给多字词着色, 单字 / 数字 / 标点 / 西文不占交替序号', () => {
  // 着色顺序: 新能源(正文色) 公交车(混合色) 达到(正文色) …「已」「3200」「辆」「，」都跳过
  const text = '新能源公交车已达到3200辆，'
  assert.deepEqual(allColoredWords(text, lex), ['新能源', '公交车', '达到'])
  assert.deepEqual(colored(text, { lexicon: lex }), ['公交车'])
  // 西文夹在中间也不占序号
  const mixed = '模型 BERT 训练'
  assert.deepEqual(colored(mixed, { lexicon: lex }), ['训练'])
  // 没把握的词不占序号:「冷风」跳过, 船舱(正文色) 呜呜(混合色)
  assert.deepEqual(colored('冷风吹进船舱中，呜呜的响', { lexicon: lex }), ['呜呜'])
  // 只做西文时中文不着色
  assert.deepEqual(guideSpans(text, 'zh', { lexicon: lex, style: 'fixation' }).alt, [])
})

test('西文: 中文为主的段落里西文词不淡化, 西文为主的段落照旧做词首强调', () => {
  const zhMain = '在大规模数据集上训练 BERT 模型'
  assert.deepEqual(guideSpans(zhMain, 'zh', { lexicon: lex }).tail, [])
  const enMain = '我们阅读 English books 吧'
  const r = guideSpans(enMain, 'zh', { lexicon: lex })
  assert.deepEqual(r.tail.map(([a, b]) => enMain.slice(a, b)), ['lish', 'oks'])
  // 只做西文 (fixation) 时, 中文段落里的西文词也淡化
  assert.deepEqual(guideSpans(zhMain, 'zh', { lexicon: lex, style: 'fixation' }).tail.map(([a, b]) => zhMain.slice(a, b)), ['RT'])
  // 纯西文: 行为不变
  const en = 'A reading lamp, extraordinarily bright.'
  assert.deepEqual(guideSpans(en, 'en', { lexicon: lex }).tail.map(([a, b]) => en.slice(a, b)), ['ding', 'mp', 'rdinarily', 'ght'])
})

test('每段重新开始交替: 同一段文字结果固定, 与前文无关 (可按段落缓存)', () => {
  const p = '他慢慢地走进了图书馆，翻开一本关于人工智能的书。'
  const a = guideSpans(p, 'zh', { lexicon: lex })
  const b = guideSpans(p, 'zh', { lexicon: lex })
  assert.deepEqual(a, b)
  // 每段第一个着色词总是正文色 (偶数位)
  const first = allColoredWords(p, lex)[0]
  assert.ok(!a.alt.some(([s, e]) => p.slice(s, e) === first))
  // 显式传起点仍可接续 (旧接口)
  const shifted = guideSpans(p, 'zh', { lexicon: lex, parityStart: 1 })
  assert.ok(shifted.alt.some(([s, e]) => p.slice(s, e) === first))
})

test('日文 / 韩文不用中文词表', () => {
  assert.equal(usesZhLexicon('图书馆', 'zh-CN'), true)
  assert.equal(usesZhLexicon('図書館で本を読む', 'zh'), false)
  assert.equal(usesZhLexicon('図書館', 'ja'), false)
  assert.equal(usesZhLexicon('Library', 'zh'), false)
})

// ---------------------------------------------------------------------------
// 速度
// ---------------------------------------------------------------------------

test('速度: 每万字 < 15 ms (含歧义检查与着色规则)', () => {
  const para = [
    '我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。时候既然是深冬；渐近故乡时，天气又阴晦了，冷风吹进船舱中，呜呜的响，',
    '从篷隙向外一望，苍黄的天底下，远近横着几个萧索的荒村，没有一些活气。Transformer 模型使用自注意力机制来捕捉序列中任意两个位置之间的依赖关系，',
    '因此在大规模数据集上训练速度更快。截至9月底，本市新能源公交车已达到3200辆，占公交车总数的86%，地铁日均客运量超过450万人次。',
  ].join('')
  let text = ''
  while (text.length < 10000) text += para
  text = text.slice(0, 10000)
  const paragraphs = text.match(/[^。]+。?/g)
  const run = () => { for (const p of paragraphs) guideSpans(p, 'zh', { lexicon: lex }) }
  for (let i = 0; i < 5; i++) run()
  const ts = []
  for (let i = 0; i < 21; i++) {
    const t0 = performance.now()
    run()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  const median = ts[10]
  const limit = Number(process.env.ZH_SEG_MS_LIMIT ?? 15)
  console.log(`# guideSpans with lexicon: ${median.toFixed(2)} ms / 10k chars (limit ${limit})`)
  assert.ok(median < limit, `${median.toFixed(2)} ms`)
})

test('西文词不吞后面的汉字: 「阿Q的名字」', async () => {
  const { splitRuns } = await import('../src/services/readingModes/zhSegment.ts')
  const runs = splitRuns('阿Q的名字，iPhone手机')
  assert.deepEqual(runs.map(r => [r.text, r.kind]), [['阿', 'han'], ['Q', 'latin'], ['的名字', 'han'], ['，', 'punct'], ['iPhone', 'latin'], ['手机', 'han']])
})
