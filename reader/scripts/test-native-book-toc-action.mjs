import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativeBookTocActions } from '../src/services/nativeBookTocAction.ts'
function fixture(toc = [{ label: 'One', subitems: [{ title: 'Nested' }] }, { label: 'Two' }]) {
  const calls = []; let now = 0, count = 0
  const book = { id: 'synthetic-book', title: 'Synthetic', author: 'Synthetic', fileName: 'synthetic.epub', format: 'epub', tags: [], hasCover: false, addedAt: 1 }
  const flags = { readFail: false, openFail: false, size: 10 }
  const handler = createNativeBookTocActions({ metadata: async id => { calls.push('metadata'); return id === book.id ? book : undefined }, file: async () => { calls.push('file'); if (flags.readFail) throw new Error('permission_denied'); return flags.size === 10 ? new Blob(['synthetic']) : { size: flags.size } }, open: async () => { calls.push('open'); if (flags.openFail) throw new Error('invalid_archive'); return { toc, destroy: async () => { calls.push('destroy') } } }, now: () => now, token: () => 'toc-' + ++count }).bookToc
  return { book, flags, calls, handler, advance: () => { now += 300001 } }
}
test('ordered hierarchy is a readonly snapshot; pages reuse it without another parser/file owner', async () => {
  const f = fixture(), first = await f.handler({ bookId: f.book.id, limit: 2 })
  assert.deepEqual(first.items, [{ title: 'One', depth: 0 }, { title: 'Nested', depth: 1 }]); assert.equal(first.total, 3)
  const second = await f.handler({ bookId: f.book.id, token: first.token, offset: 2, limit: 2 })
  assert.deepEqual(second.items, [{ title: 'Two', depth: 0 }]); assert.equal(f.calls.filter(c => c === 'open').length, 1); assert.equal(f.calls.filter(c => c === 'destroy').length, 1)
  f.advance(); await assert.rejects(f.handler({ bookId: f.book.id, token: first.token }), /stale_toc_context/)
})
test('legitimate no-navigation MOBI/EPUB is distinct from malformed parser output', async () => {
  const f = fixture(null); const r = await f.handler({ bookId: f.book.id }); assert.equal(r.supported, true); assert.equal(r.total, 0); assert.equal(f.calls.at(-1), 'destroy')
  const bad = fixture({ invalid: true }); await assert.rejects(bad.handler({ bookId: bad.book.id }), /invalid_toc_response/); assert.equal(bad.calls.at(-1), 'destroy')
})
test('installed Foliate null leaf subitems remain a valid leaf, not a malformed tree', async () => {
  const f = fixture([{ label: 'Leaf', subitems: null }]); const result = await f.handler({ bookId: f.book.id }); assert.deepEqual(result.items, [{ title: 'Leaf', depth: 0 }])
})
test('unsupported format is explicit and never opened; missing/permission/parse errors never become empty TOC', async () => {
  const f = fixture(); f.book.format = 'pdf'; const r = await f.handler({ bookId: f.book.id }); assert.equal(r.code, 'toc_format_unsupported'); assert.equal(f.calls.includes('file'), false)
  await assert.rejects(f.handler({ bookId: 'missing' }), /book_not_found/)
  f.book.format = 'epub'; f.flags.readFail = true; await assert.rejects(f.handler({ bookId: f.book.id }), /permission_denied/)
  f.flags.readFail = false; f.flags.openFail = true; await assert.rejects(f.handler({ bookId: f.book.id }), /invalid_archive/)
})
test('snapshot token cannot be reused for another book; unknown token and context-free later page reject', async () => {
  const f = fixture(), r = await f.handler({ bookId: f.book.id })
  await assert.rejects(f.handler({ bookId: 'different', token: r.token }), /stale_toc_context/)
  await assert.rejects(f.handler({ bookId: f.book.id, token: 'unknown' }), /stale_toc_context/)
  await assert.rejects(f.handler({ bookId: f.book.id, offset: 1 }), /toc_context_required/)
})
test('cycles/depth/size fail closed and always destroy an admitted parser', async () => {
  const cycle = { label: 'Cycle', subitems: [] }; cycle.subitems.push(cycle)
  const f = fixture([cycle]); await assert.rejects(f.handler({ bookId: f.book.id }), /invalid_toc_cycle/); assert.equal(f.calls.at(-1), 'destroy')
  let deep = { label: 'Deep' }; for (let i = 0; i < 70; i++) deep = { label: 'Level', subitems: [deep] }
  const d = fixture([deep]); await assert.rejects(d.handler({ bookId: d.book.id }), /resource_limit/); assert.equal(d.calls.at(-1), 'destroy')
  const huge = fixture(); huge.flags.size = 1024 ** 3 + 1; await assert.rejects(huge.handler({ bookId: huge.book.id }), /resource_limit/); assert.equal(huge.calls.includes('open'), false)
})
for (const p of [{ bookId: '' }, { bookId: 'synthetic-book', limit: 0 }, { bookId: 'synthetic-book', limit: '50' }, { bookId: 'synthetic-book', offset: -1 }, { bookId: 'synthetic-book', unexpected: true }]) test(`reject invalid TOC request ${JSON.stringify(p)}`, async () => { await assert.rejects(fixture().handler(p), /invalid_payload/) })
