// 书单: 待找条目的匹配 / 自动关联、分享格式往返、推荐书单数据校验 (纯函数, 见 docs/booklists.md)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  authorsCompatible, buildShare, cleanEntry, doubanSearchUrl, entryKey, entryMatchesBook, findMatchingBook, findQuery,
  normalizeIsbn, parseCuratedIndex, parseShareMarkdown, parseShareText, planAutoLink, planListImport, sameEntry,
  shareFileName, shareToJson, shareToMarkdown, titleKey, titlesMatch, validateCuratedList, yearLabel,
} from '../src/services/booklists.ts'

const DATA_DIR = fileURLToPath(new URL('../src/data/booklists/', import.meta.url))
const book = (id, title, author, extra = {}) => ({ id, title, author, kind: 'book', addedAt: 1, ...extra })
const matches = (entry, b) => entryMatchesBook(entry, book('x', b.title, b.author))

// ---- 匹配 ----

test('titles: punctuation, brackets, articles, subtitles and extensions are ignored', () => {
  assert.equal(titleKey('《红楼梦》'), titleKey('红楼梦'))
  assert.equal(titleKey('红楼梦（程乙本）'), titleKey('红楼梦'))
  assert.equal(titleKey('The Republic'), titleKey('Republic'))
  assert.equal(titleKey('walden.epub'), titleKey('Walden'))
  assert.ok(titlesMatch('Walden', 'Walden; or, Life in the Woods'))
  assert.ok(titlesMatch('Jane Eyre', 'Jane Eyre: An Autobiography'))
  assert.ok(titlesMatch('On the Origin of Species', 'On the Origin of Species By Means of Natural Selection / Or, the Preservation of Favoured Races'))
  assert.ok(!titlesMatch('诗', '诗经'), 'short CJK prefix is not a match')
  assert.ok(!titlesMatch('Emma', 'Emmanuel'), 'short latin prefix is not a match')
})

test('authors: order, dynasty brackets, role suffixes, life years and diacritics', () => {
  assert.ok(authorsCompatible('Jane Austen', 'Austen, Jane'))
  assert.ok(authorsCompatible('曹雪芹', '[清] 曹雪芹 著'))
  assert.ok(authorsCompatible('Henry David Thoreau', 'Thoreau, Henry David, 1817-1862'))
  assert.ok(authorsCompatible('马克思 恩格斯', '卡尔·马克思'))
  assert.ok(authorsCompatible('Emily Brontë', 'Emily Bronte'))
  assert.ok(!authorsCompatible('Spinoza', 'Aristotle'))
  assert.ok(!authorsCompatible('鲁迅', '老舍'))
  assert.ok(!authorsCompatible('', 'Plato'))
})

test('entry ↔ library book matching (incl. original-language title)', () => {
  assert.ok(matches({ title: 'Pride and Prejudice', author: 'Jane Austen' }, { title: 'Pride and Prejudice', author: 'Austen, Jane' }))
  assert.ok(matches({ title: '红楼梦', author: '曹雪芹' }, { title: '红楼梦（程乙本）', author: '[清] 曹雪芹 著' }))
  assert.ok(matches({ title: '理想国', author: '柏拉图', originalTitle: 'The Republic', originalAuthor: 'Plato' }, { title: 'The Republic', author: 'Plato' }))
  assert.ok(!matches({ title: 'Ethics', author: 'Spinoza' }, { title: 'Ethics', author: 'Aristotle' }), 'same title, different author')
  assert.ok(!matches({ title: '理想国', author: '柏拉图', originalTitle: 'The Republic', originalAuthor: 'Plato' }, { title: 'The Republic', author: 'Cicero' }))
  // 缺作者: 只认完全相同且足够长的书名
  assert.ok(matches({ title: '三体', author: '' }, { title: '三体', author: '刘慈欣' }))
  assert.ok(matches({ title: 'Poems', author: '' }, { title: 'Poems', author: 'Emily Dickinson' }), 'five-letter latin titles are long enough')
  assert.ok(!matches({ title: 'War', author: '' }, { title: 'War', author: 'X' }), 'too short alone')
  assert.ok(!matches({ title: '诗经', author: '' }, { title: '诗经选', author: '' }))
})

test('findMatchingBook ignores papers', () => {
  const books = [book('p', 'Walden', 'Thoreau', { kind: 'paper' }), book('b', 'Walden', 'Henry David Thoreau')]
  assert.equal(findMatchingBook({ title: 'Walden', author: 'Thoreau' }, books)?.id, 'b')
  assert.equal(findMatchingBook({ title: 'Walden', author: 'Thoreau' }, [books[0]]), undefined)
})

test('planAutoLink links wanted entries to the earliest matching book, per booklist', () => {
  const wanted = [
    { id: 'w1', booklistId: 'l1', title: 'Walden', author: 'Thoreau', addedAt: 1 },
    { id: 'w2', booklistId: 'l2', title: '红楼梦', author: '曹雪芹', addedAt: 2 },
    { id: 'w3', booklistId: 'l2', title: 'Moby-Dick', author: 'Herman Melville', addedAt: 3 },
  ]
  const books = [
    book('late', 'Walden; or, Life in the Woods', 'Henry David Thoreau', { addedAt: 9 }),
    book('early', 'Walden', 'Thoreau, Henry David', { addedAt: 2 }),
    book('hlm', '红楼梦', '[清] 曹雪芹', { addedAt: 5 }),
    book('paper', 'Moby-Dick', 'Herman Melville', { kind: 'paper' }),
  ]
  assert.deepEqual(planAutoLink(wanted, books), [
    { wantedId: 'w1', booklistId: 'l1', bookId: 'early' },
    { wantedId: 'w2', booklistId: 'l2', bookId: 'hlm' },
  ])
  assert.deepEqual(planAutoLink([], books), [])
  assert.deepEqual(planAutoLink(wanted, []), [])
})

test('planListImport: owned books linked once, the rest become deduped wanted entries', () => {
  const books = [book('b1', 'Walden', 'Thoreau'), book('b2', '红楼梦', '曹雪芹')]
  const plan = planListImport([
    { title: 'Walden', author: 'Henry David Thoreau' },
    { title: 'Walden', author: 'Thoreau' }, // 同一本
    { title: '红楼梦', author: '曹雪芹' }, // 已在书单
    { title: '理想国', author: '柏拉图' },
    { title: '《理想国》', author: '[古希腊] 柏拉图 著' }, // 重复
    { title: '瓦尔登湖', author: '梭罗', isbn: '978-0-306-40615-7' },
    { title: '已经想读', author: '某人' },
    { title: '  ', author: 'x' }, // 无书名
  ], books, { bookIds: ['b2'], wanted: [{ title: '已经想读', author: '某人' }] })
  assert.deepEqual(plan.bookIds, ['b1'])
  assert.deepEqual(plan.wanted.map(e => e.title), ['理想国', '瓦尔登湖'])
  assert.equal(plan.wanted[1].isbn, '9780306406157')
})

test('ISBN normalization and entry keys', () => {
  assert.equal(normalizeIsbn('0-306-40615-2'), '9780306406157')
  assert.equal(normalizeIsbn('978-0-306-40615-7'), '9780306406157')
  assert.equal(normalizeIsbn('9780306406158'), undefined, 'bad check digit')
  assert.equal(normalizeIsbn('080442957X'), '9780804429573')
  assert.equal(normalizeIsbn('abc'), undefined)
  assert.equal(entryKey({ title: 'A', author: 'B', isbn: '0306406152' }), 'isbn:9780306406157')
  assert.equal(entryKey({ title: '《红楼梦》', author: '曹雪芹 著' }), entryKey({ title: '红楼梦', author: '曹雪芹' }))
  assert.ok(sameEntry({ title: 'X', author: 'Y', isbn: '0306406152' }, { title: 'Other', author: 'Z', isbn: '9780306406157' }))
  assert.ok(!sameEntry({ title: 'X', author: 'Y', isbn: '0306406152' }, { title: 'X', author: 'Y', isbn: '080442957X' }))
})

test('cleanEntry trims, drops invalid fields and flattens original', () => {
  assert.deepEqual(
    cleanEntry({ title: '  理想国 ', author: ' 柏拉图', year: -375.5, isbn: 'nope', note: '  ', original: { title: 'The Republic', author: 'Plato' }, extra: 1 }),
    { title: '理想国', author: '柏拉图', originalTitle: 'The Republic', originalAuthor: 'Plato' },
  )
  assert.equal(cleanEntry({ author: 'x' }), undefined)
  assert.equal(cleanEntry(null), undefined)
  assert.deepEqual(cleanEntry({ title: 'T', year: -375 }), { title: 'T', author: '', year: -375 })
})

// ---- 分享 ----

const sample = [
  { title: '红楼梦', author: '曹雪芹', year: 1791, note: '读三遍' },
  { title: '理想国', author: '柏拉图', year: -375, originalTitle: 'The Republic', originalAuthor: 'Plato' },
  { title: 'Walden', author: 'Henry David Thoreau', isbn: '0306406152' },
]

test('share JSON round trip keeps every field', () => {
  const share = buildShare('  我的书单 ', sample, { description: '冬天读的书', now: new Date('2026-10-06T00:00:00Z') })
  assert.equal(share.name, '我的书单')
  assert.equal(share.exportedAt, '2026-10-06T00:00:00.000Z')
  assert.deepEqual(share.books[1].original, { title: 'The Republic', author: 'Plato' })
  assert.equal(share.books[2].isbn, '9780306406157')
  const back = parseShareText(shareToJson(share))
  assert.deepEqual(back, share)
})

test('share Markdown is readable and parses back (titles, authors, years, notes)', () => {
  const share = buildShare('我的书单', sample, { description: '冬天读的书' })
  const md = shareToMarkdown(share)
  assert.match(md, /^# 我的书单\n\n冬天读的书\n\n1\. 《红楼梦》 — 曹雪芹（1791）\n {3}读三遍\n2\. 《理想国》 — 柏拉图（前375）/)
  assert.match(md, /共 3 本 · 来自轻阅 LightRead$/)
  const back = parseShareText(md)
  assert.equal(back.name, '我的书单')
  assert.equal(back.description, '冬天读的书')
  assert.deepEqual(back.books.map(b => [b.title, b.author, b.year, b.note]), [
    ['红楼梦', '曹雪芹', 1791, '读三遍'],
    ['理想国', '柏拉图', -375, undefined],
    ['Walden', 'Henry David Thoreau', undefined, undefined],
  ])
  const en = shareToMarkdown(share, 'en')
  assert.match(en, /2\. 《理想国》 — 柏拉图 \(375 BC\)/)
  assert.match(en, /3\. \*Walden\* — Henry David Thoreau/)
  assert.deepEqual(parseShareText(en).books.map(b => [b.title, b.year]), [['红楼梦', 1791], ['理想国', -375], ['Walden', undefined]])
})

test('pasted chat lists in common shapes are recognized', () => {
  const share = parseShareMarkdown([
    '寒假书单',
    '1. 《活着》- 余华',
    '2、围城 / 钱锺书',
    '- The Old Man and the Sea by Ernest Hemingway (1952)',
    '* 《呐喊》',
  ].join('\n'))
  assert.deepEqual(share.books.map(b => [b.title, b.author, b.year]), [
    ['活着', '余华', undefined],
    ['围城', '钱锺书', undefined],
    ['The Old Man and the Sea', 'Ernest Hemingway', 1952],
    ['呐喊', '', undefined],
  ])
  assert.equal(share.name, '活着', 'no heading: falls back to the first title')
})

test('share parsing rejects garbage and foreign formats', () => {
  assert.equal(parseShareText(''), null)
  assert.equal(parseShareText('hello world'), null)
  assert.equal(parseShareText('{ broken json'), null)
  assert.equal(parseShareText(JSON.stringify({ format: 'something.else', name: 'x', books: [{ title: 'a' }] })), null)
  assert.equal(parseShareText(JSON.stringify({ name: 'x', books: [] })), null)
  // 推荐书单文件也能当分享文件导入 (title 代替 name)
  const curated = parseShareText(JSON.stringify({ title: '哲学入门', books: [{ title: '理想国', author: '柏拉图' }] }))
  assert.equal(curated.name, '哲学入门')
})

test('share helpers: file name, douban link, find query, year label', () => {
  assert.equal(shareFileName('a/b:c*?'), 'a b c.lightread-booklist.json')
  assert.equal(shareFileName(''), 'booklist.lightread-booklist.json')
  assert.equal(doubanSearchUrl('红楼梦', '曹雪芹'), 'https://search.douban.com/book/subject_search?search_text=%E7%BA%A2%E6%A5%BC%E6%A2%A6%20%E6%9B%B9%E9%9B%AA%E8%8A%B9')
  assert.equal(findQuery('《红楼梦》', '[清] 曹雪芹'), '红楼梦 曹雪芹')
  assert.equal(findQuery('The Republic', 'Plato'), 'The Republic Plato')
  assert.equal(yearLabel(-375), '前375')
  assert.equal(yearLabel(-375, 'en'), '375 BC')
  assert.equal(yearLabel(1859), '1859')
  assert.equal(yearLabel(undefined), '')
})

// ---- 推荐书单 ----

const validList = () => ({
  id: 'demo-list', title: '示例', description: 'd', curator: '轻阅编辑部', tags: ['a'], updated: '2026-10-06',
  source: { name: '轻阅编辑部', url: 'https://github.com/yzfly/LightRead', license: 'CC0-1.0' },
  books: [{ title: 'Walden', author: 'Henry David Thoreau', year: 1854 }],
})

test('validateCuratedList: required fields, bad entries dropped, duplicates removed', () => {
  assert.equal(validateCuratedList(validList()).id, 'demo-list')
  for (const broken of [
    { ...validList(), id: 'Bad Id' },
    { ...validList(), updated: '2026/10/06' },
    { ...validList(), source: { name: 'x', url: 'ftp://x', license: 'y' } },
    { ...validList(), source: undefined },
    { ...validList(), curator: '' },
    { ...validList(), books: [] },
    { ...validList(), books: [{ title: 'No author' }] },
  ]) assert.equal(validateCuratedList(broken), null, JSON.stringify(broken).slice(0, 80))
  const list = validateCuratedList({
    ...validList(),
    books: [
      { title: 'Walden', author: 'Henry David Thoreau', wikidata: 'Q12345', original: { title: 'x', author: 'y' } },
      { title: 'Walden', author: 'Thoreau' },
      { title: '', author: 'x' },
      { title: 'Moby-Dick', author: 'Herman Melville', wikidata: 'not-q' },
    ],
  })
  assert.deepEqual(list.books.map(b => [b.title, b.wikidata]), [['Walden', 'Q12345'], ['Moby-Dick', undefined]])
})

test('bundled curated lists: index matches files, every list validates without losing entries', () => {
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && f !== 'index.json').sort()
  const index = parseCuratedIndex(JSON.parse(readFileSync(join(DATA_DIR, 'index.json'), 'utf8')))
  assert.ok(index, 'index.json parses')
  assert.match(index.updated, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual([...index.lists].sort(), files.map(f => f.replace(/\.json$/, '')), 'index lists exactly the list files')
  assert.ok(files.length >= 4, 'at least a handful of lists')
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'))
    const list = validateCuratedList(raw)
    assert.ok(list, `${file} validates`)
    assert.equal(`${list.id}.json`, file, 'id matches file name')
    assert.equal(list.books.length, raw.books.length, `${file}: no entry was dropped by validation`)
    assert.ok(list.books.length >= 5, `${file}: has books`)
    assert.ok(list.description.length > 0, `${file}: has a description`)
    assert.ok(list.source.name && list.source.url && list.source.license, `${file}: source recorded`)
    const keys = list.books.map(b => titleKey(b.title))
    assert.equal(new Set(keys).size, keys.length, `${file}: no duplicate titles`)
    for (const b of raw.books) {
      if (b.year !== undefined) assert.ok(Number.isInteger(b.year), `${file}: ${b.title} year is an integer`)
      if (b.isbn !== undefined) assert.ok(normalizeIsbn(b.isbn), `${file}: ${b.title} ISBN is valid`)
      if (b.wikidata !== undefined) assert.match(b.wikidata, /^Q\d+$/)
    }
  }
})
