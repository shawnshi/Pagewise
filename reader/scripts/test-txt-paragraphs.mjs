// TXT 断行还原契约: 只有固定列宽硬换行的文本才合并段内断行
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksHardWrapped, packSections, toParagraphs } from '../src/services/txtParagraphs.ts'

/** 按列宽硬换行 (模拟古登堡 TXT), 段间空行 */
function wrap(paragraphs, width, { cjk = false } = {}) {
  const out = []
  for (const p of paragraphs) {
    if (cjk) {
      for (let i = 0; i < p.length; i += width) out.push(p.slice(i, i + width))
    } else {
      let line = ''
      for (const word of p.split(' ')) {
        if (line && line.length + 1 + word.length > width) {
          out.push(line)
          line = word
        } else line = line ? `${line} ${word}` : word
      }
      if (line) out.push(line)
    }
    out.push('')
  }
  return out
}

const EN = Array.from({ length: 12 }, (_, i) =>
  `Paragraph ${i} begins here and it keeps going with plenty of ordinary words so that the ` +
  'wrapping produces several lines of roughly equal width, just like a Project Gutenberg text file.')
const ZH = Array.from({ length: 12 }, (_, i) =>
  `第${i}段：却说那猴王在花果山水帘洞中，每日操演兵马，与群妖饮酒作乐，自在逍遥，不觉又过了许多年月，` +
  '忽一日与众猴正在欢宴之间，猴王心中烦恼，堕下泪来，众猴慌忙罗拜道大王何为烦恼。')

test('英文硬换行: 合并为整段, 行间补空格', () => {
  const lines = wrap(EN, 70)
  assert.equal(looksHardWrapped(lines), true)
  const paras = toParagraphs(lines, true)
  assert.deepEqual(paras, EN)
})

test('中文硬换行: 合并时不插空格', () => {
  const lines = wrap(ZH, 35, { cjk: true })
  assert.equal(looksHardWrapped(lines), true)
  assert.deepEqual(toParagraphs(lines, true), ZH)
})

test('全角缩进开段、段间无空行的硬换行中文也能还原', () => {
  const lines = wrap(ZH, 35, { cjk: true }).filter(Boolean)
  const indented = []
  let start = true
  for (const l of wrap(ZH, 35, { cjk: true })) {
    if (!l) { start = true; continue }
    indented.push(start ? `　　${l}` : l)
    start = false
  }
  assert.ok(lines.length > ZH.length)
  assert.equal(looksHardWrapped(indented), true)
  assert.deepEqual(toParagraphs(indented, true), ZH)
})

test('网络小说式一行一段 (长短不一) 不合并', () => {
  const lines = []
  for (let i = 0; i < 40; i++) {
    lines.push(`　　${'他说'.repeat(1 + (i * 7) % 23)}。`)
    if (i % 2) lines.push('')
  }
  assert.equal(looksHardWrapped(lines), false)
  assert.equal(toParagraphs(lines, false).length, 40)
})

test('无空行的连续短行 (诗、列表) 不合并', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(i % 30)}`)
  assert.equal(looksHardWrapped(lines), false)
})

test('硬换行里的缩进诗句各自成段, 行尾连字符原样保留', () => {
  const lines = [
    ...wrap(EN, 70),
    '    Twinkle, twinkle, little bat!',
    '    How I wonder what you\'re at!',
    '',
    'A well-',
    'known saying.',
  ]
  const paras = toParagraphs(lines, true)
  assert.ok(paras.includes('Twinkle, twinkle, little bat!'))
  assert.ok(paras.includes('How I wonder what you\'re at!'))
  assert.equal(paras.at(-1), 'A well-known saying.')
})

test('章节按字数装进分节: 顺序不变, 超限另起一节, 超长单章独占', () => {
  const ch = n => ({ html: 'x'.repeat(n) })
  const secs = packSections([ch(30), ch(30), ch(50), ch(200), ch(10)], 100)
  assert.deepEqual(secs.map(s => s.map(c => c.html.length)), [[30, 30], [50], [200], [10]])
})
