// 听书句子游标的纯函数契约: 断句 / 偏移换算 / 断点时间分档
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitSentences, locateOffset, agoBucket } from '../src/services/readAloud.ts'
import { LISTEN_MARKS, READER_THEMES, EINK_THEMES, listenMarkStyle } from '../src/services/readerTheme.ts'

const pieces = (text, lang) => splitSentences(text, lang).map(s => text.slice(s.start, s.end))

test('中文按句末标点断句, 引号跟着句子走', () => {
  assert.deepEqual(pieces('他说：“走吧。”她没有回头。风很大！', 'zh'), ['他说：“走吧。”', '她没有回头。', '风很大！'])
})

test('句末的左引号归下一句', () => {
  assert.deepEqual(pieces('他走了。“你来。”她说。', 'zh'), ['他走了。', '“你来。”', '她说。'])
})

test('只有标点的碎片并入前一句, 分隔符不读', () => {
  assert.deepEqual(pieces('第一句。……\n* * *', 'zh'), ['第一句。……'])
  assert.deepEqual(pieces('* * *', 'zh'), [])
})

test('西文按句点断句, 两端空白去掉', () => {
  assert.deepEqual(pieces('  The rain fell. It was cold!  ', 'en'), ['The rain fell.', 'It was cold!'])
})

test('过长无句号的段在逗号处再切, 不切出碎句', () => {
  const clause = '夜色像一块浸了水的墨布慢慢压下来，'
  const text = clause.repeat(20) + '完。'
  const out = pieces(text, 'zh')
  assert.ok(out.length > 1)
  assert.equal(out.join(''), text)
  for (const s of out) assert.ok(s.length <= 160 && s.length >= 20, s.length)
})

test('长句没有逗号: 在空格处切, 不把西文单词切成两半', () => {
  const words = ['reading', 'quietly', 'beneath', 'lanterns', 'gives', 'everyone', 'patience']
  let text = ''
  for (let i = 0; text.length < 600; i++) text += words[i % words.length] + ' '
  text = text.trim() + '.'
  const out = pieces(text, 'en')
  assert.ok(out.length >= 4, out.length)
  assert.equal(out.join(' '), text)
  for (const s of out) {
    assert.ok(s.length <= 160, s.length)
    for (const w of s.replace(/\.$/, '').split(' ')) assert.ok(words.includes(w), `切断了单词: ${w}`)
  }
})

test('长句没有标点的中文: 按词边界切, 夹在中间的英文词和数字不切开', () => {
  const unit = '我们在图书馆里慢慢读完了Shakespeare的十四行诗然后讨论了3.1415926和12,000这两个数字'
  const text = unit.repeat(8)
  const out = pieces(text, 'zh')
  assert.ok(out.length > 1)
  assert.equal(out.join(''), text)
  for (let k = 0; k + 1 < out.length; k++) {
    const a = out[k]
    const b = out[k + 1]
    assert.ok(a.length <= 160 && a.length >= 50, a.length)
    const joint = a.slice(-1) + b[0]
    assert.ok(!/^[A-Za-z0-9]{2}$/.test(joint), `切在词或数字中间: ${a.slice(-6)}|${b.slice(0, 6)}`)
    assert.ok(!/[0-9][.,]$/.test(a) || !/^[0-9]/.test(b), `切开了数字: ${a.slice(-6)}|${b.slice(0, 6)}`)
  }
})

test('数字里的逗号、冒号不算软断点', () => {
  // 数字落在切分窗口里 (第 53–160 字), 旧实现会切成「12:」「30」
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(6) + '营收达到1,234,567元' + '子丑寅卯辰巳午未申酉'.repeat(6) + '会议在12:30开始' + '甲乙丙丁戊己庚辛壬癸'.repeat(10) + '。'
  const out = pieces(text, 'zh')
  assert.equal(out.join(''), text)
  assert.ok(out.some(s => s.includes('1,234,567')), out.join(' | '))
  assert.ok(out.some(s => s.includes('12:30')), out.join(' | '))
})

test('超长的无空格串 (网址) 不在中间切, 宁可这句长一点', () => {
  const url = 'https://example.com/' + 'abcdefghij'.repeat(20)
  const text = '请访问 ' + url + ' 了解更多。'
  const out = pieces(text, 'zh')
  assert.ok(out.some(s => s.includes(url)), out.join(' | '))
})

test('偏移换算回文本节点, 结束偏移可停在节点末尾', () => {
  const lengths = [3, 0, 4]
  assert.deepEqual(locateOffset(lengths, 0), { node: 0, offset: 0 })
  assert.deepEqual(locateOffset(lengths, 3), { node: 2, offset: 0 })
  assert.deepEqual(locateOffset(lengths, 3, true), { node: 0, offset: 3 })
  assert.deepEqual(locateOffset(lengths, 6), { node: 2, offset: 3 })
  assert.deepEqual(locateOffset(lengths, 99), { node: 2, offset: 4 })
})

test('断点时间分档', () => {
  const now = Date.UTC(2026, 9, 5, 12)
  assert.deepEqual(agoBucket(now - 20_000, now), { kind: 'justNow', n: 0 })
  assert.deepEqual(agoBucket(now - 5 * 60_000, now), { kind: 'minutes', n: 5 })
  assert.deepEqual(agoBucket(now - 3 * 3600_000, now), { kind: 'hours', n: 3 })
  assert.deepEqual(agoBucket(now - 30 * 3600_000, now), { kind: 'yesterday', n: 1 })
  assert.deepEqual(agoBucket(now - 5 * 86400_000, now), { kind: 'days', n: 5 })
})

// ---- 朗读句标记随正文主题取色 (readerTheme.LISTEN_MARKS) ----
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const channel = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const luminance = c => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
const contrast = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
/** overlayer 的色块盖在文字上面: 底色和字色都按 opacity 混入标记色 */
const over = (base, mark, a) => base.map((v, i) => v * (1 - a) + mark[i] * a)

test('朗读句标记: 四种正文主题下句内文字对色块对比度 ≥ 4.5:1, 色块和纸面看得出区别', () => {
  for (const [name, theme] of Object.entries(READER_THEMES)) {
    const mark = LISTEN_MARKS[name]
    assert.ok(mark && !mark.underline, name)
    const bg = over(rgb(theme.bg), rgb(mark.color), mark.opacity)
    const fg = over(rgb(theme.fg), rgb(mark.color), mark.opacity)
    assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${contrast(fg, bg).toFixed(2)}`)
    assert.ok(contrast(bg, rgb(theme.bg)) >= 1.25, `${name} 色块太淡: ${contrast(bg, rgb(theme.bg)).toFixed(2)}`)
  }
})

test('朗读句标记: 墨水屏用与正文同色的下划线, auto 跟随外观', () => {
  assert.deepEqual(listenMarkStyle('sepia', false, { eink: true }), LISTEN_MARKS.eink)
  assert.deepEqual(listenMarkStyle('dark', true, { eink: true }), LISTEN_MARKS['eink-dark'])
  assert.equal(LISTEN_MARKS.eink.underline, true)
  assert.equal(LISTEN_MARKS.eink.color, EINK_THEMES.light.fg)
  assert.equal(LISTEN_MARKS['eink-dark'].color, EINK_THEMES.dark.fg)
  assert.equal(listenMarkStyle('auto', true), LISTEN_MARKS.dark)
  assert.equal(listenMarkStyle('auto', false), LISTEN_MARKS.light)
})
