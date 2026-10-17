import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bookIdentity, fileStem, formatRank, IMPORT_FORMATS, isIgnoredEntry, planFolderPick,
} from '../src/services/folderPick.ts'

const f = (path, size = 1000) => ({ path, name: path.split(/[\\/]/).pop(), size })
const names = list => list.map(e => e.path)
const plan = (entries, opts = {}) => planFolderPick(entries, { formats: IMPORT_FORMATS, ...opts })

test('active import ranking is EPUB > MOBI > PDF > TXT > Markdown', () => {
  const order = ['epub', 'mobi', 'pdf', 'txt', 'md']
  assert.deepEqual(IMPORT_FORMATS, order)
  for (let i = 1; i < order.length; i++) assert.ok(formatRank(order[i - 1]) < formatRank(order[i]), `${order[i - 1]} before ${order[i]}`)
  assert.ok(formatRank(null) > formatRank('md'))
  for (const format of ['azw', 'azw3', 'fb2', 'fbz', 'cbz', 'cbr', 'djvu', 'html']) {
    assert.ok(!IMPORT_FORMATS.includes(format))
    const result = plan([f(`retired.${format}`)])
    assert.equal(result.selected.length, 0)
    assert.equal(result.unsupported, 1)
  }
})

test('keeps only the most recommended format of the same book', () => {
  const r = plan([f('三体.pdf'), f('三体.mobi'), f('三体.epub'), f('三体.azw3'), f('三体.txt')])
  assert.deepEqual(names(r.selected), ['三体.epub'])
  assert.equal(r.skippedDuplicates.length, 1)
  assert.equal(r.skippedDuplicates[0].kept.path, '三体.epub')
  assert.deepEqual(names(r.skippedDuplicates[0].dropped), ['三体.mobi', '三体.pdf', '三体.txt'])
  assert.equal(r.unsupported, 1)
  const kindle = plan([f('a.mobi'), f('a.azw'), f('a.pdf'), f('a.djvu'), f('a.fb2')])
  assert.deepEqual(names(kindle.selected), ['a.mobi'])
  assert.equal(kindle.unsupported, 3)
  assert.deepEqual(names(plan([f('b.pdf'), f('b.djvu'), f('b.fb2.zip')]).selected), ['b.pdf'])
})

test('same format twice keeps the larger file, then the first by path', () => {
  const r = plan([f('x/book.epub', 500), f('y/book.epub', 900)])
  assert.deepEqual(names(r.selected), ['y/book.epub'])
  assert.deepEqual(names(r.skippedDuplicates[0].dropped), ['x/book.epub'])
  const tie = plan([f('b/book.epub', 10), f('a/book.epub', 10)])
  assert.deepEqual(names(tie.selected), ['a/book.epub'])
})

test('strips download-site noise and copy markers', () => {
  const same = [
    '人类简史.epub', '人类简史 (z-lib.org).mobi', '人类简史（Z-Library）.pdf', '[www.sobooks.cc]人类简史.azw3',
    '人类简史 - 副本.epub', '人类简史【www.ebook.com】.fb2', '人类简史 copy 2.txt', '人类简史 - Copy (2).md',
    'Copy of 人类简史.html', '人类简史 -- Anna’s Archive.djvu',
  ]
  const keys = new Set(same.map(n => bookIdentity(n).key))
  assert.equal(keys.size, 1, [...keys].join(' | '))
  const r = plan(same.map(n => f(n)))
  assert.equal(r.selected.length, 1)
  assert.equal(r.skippedDuplicates[0].dropped.length, 5)
  assert.equal(r.unsupported, 4)
})

test('whitespace, case, punctuation, underscores and dashes do not split a book', () => {
  const keys = ['The Great Gatsby.epub', 'the_great_gatsby.mobi', 'The-Great-Gatsby.pdf', 'THE  GREAT. GATSBY!.azw3', 'Ｔｈｅ Ｇｒｅａｔ Ｇａｔｓｂｙ.txt']
    .map(n => bookIdentity(n).key)
  assert.equal(new Set(keys).size, 1)
  assert.notEqual(bookIdentity('C++ Primer.pdf').key, bookIdentity('C Primer.pdf').key)
  assert.equal(fileStem('a.b.fb2.zip'), 'a.b')
  assert.equal(fileStem('.epub'), '.epub')
})

test('different volumes stay distinct', () => {
  const vols = ['三体 卷1.epub', '三体 卷2.epub', '明朝那些事儿(上).epub', '明朝那些事儿(下).epub', '史记 第一册.pdf', '史记 第二册.pdf',
    'Dune Vol.1.epub', 'Dune Vol.2.epub', 'Foundation 1.mobi', 'Foundation 2.mobi', 'Foundation 11.mobi']
  const r = plan(vols.map(n => f(n)))
  assert.equal(r.selected.length, vols.length)
  assert.equal(r.skippedDuplicates.length, 0)
  // 「 (1)」「 (2)」单独出现时是分卷, 不合并
  const numbered = plan([f('三体 (1).epub'), f('三体 (2).epub')])
  assert.equal(numbered.selected.length, 2)
  // 但有不带编号的同名书时是浏览器的重复下载
  const dl = plan([f('other.epub'), f('other (1).epub'), f('other (2).mobi')])
  assert.deepEqual(names(dl.selected), ['other.epub'])
  assert.equal(dl.skippedDuplicates[0].dropped.length, 2)
})

test('hidden, system, temp and empty files are ignored, other formats counted unsupported', () => {
  const entries = [
    f('.hidden.epub'), f('.git/book.epub'), f('__MACOSX/book.epub'), f('sub/.cache/x.pdf'), f('Thumbs.db'), f('desktop.ini'),
    f('~$draft.epub'), f('big.epub.part'), f('movie.pdf.crdownload'), f('empty.epub', 0), f('$RECYCLE.BIN/old.epub'),
    f('notes.docx'), f('cover.jpg'), f('readme'), f('ok.epub'),
  ]
  assert.equal(isIgnoredEntry(f('.hidden.epub')), true)
  assert.equal(isIgnoredEntry(f('ok.epub')), false)
  const r = plan(entries)
  assert.deepEqual(names(r.selected), ['ok.epub'])
  assert.equal(r.ignored, 11)
  assert.equal(r.unsupported, 3)
})

test('groups across subfolders and sorts the selection naturally', () => {
  const r = plan([f('科幻/刘慈欣/三体.mobi'), f('下载/三体.epub'), f('历史/史记.pdf'), f('a/book 10.epub'), f('a/book 2.epub'), f('Windows\\sub\\三体.pdf')])
  assert.deepEqual(names(r.selected), ['历史/史记.pdf', '下载/三体.epub', 'a/book 2.epub', 'a/book 10.epub'])
  assert.deepEqual(names(r.skippedDuplicates[0].dropped), ['科幻/刘慈欣/三体.mobi', 'Windows\\sub\\三体.pdf'])
})

test('local import size budget: oversize falls back to a smaller active format', () => {
  const MB = 1048576
  const r = planFolderPick([f('a.epub', 120 * MB), f('a.pdf', 20 * MB), f('b.pdf', 95 * MB), f('c.txt'), f('d.fb2'), f('e.mobi')],
    { formats: IMPORT_FORMATS, maxBytes: 90 * MB })
  assert.deepEqual(names(r.selected), ['a.pdf', 'c.txt', 'e.mobi'])
  assert.deepEqual(names(r.oversize), ['b.pdf'])
  assert.equal(r.unsupported, 1)
  assert.equal(r.skippedDuplicates[0].kept.path, 'a.pdf')
  assert.deepEqual(names(r.skippedDuplicates[0].dropped), ['a.epub'])
})

test('files already in the library (same file name) are not imported again', () => {
  const r = plan([f('x/三体.epub'), f('x/三体.mobi'), f('y/Dune.MOBI'), f('y/Dune.pdf'), f('new.epub')], { existingFileNames: ['三体.EPUB', 'dune.pdf'] })
  assert.deepEqual(names(r.selected), ['new.epub', 'y/Dune.MOBI'])
  assert.deepEqual(names(r.alreadyInLibrary), ['x/三体.epub'])
  assert.equal(r.skippedDuplicates.length, 2)
})
