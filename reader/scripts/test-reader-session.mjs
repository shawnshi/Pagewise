import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReaderSession, createReaderContext, readerBackTarget, blocksReaderTurn, isReaderInteractive } from '../src/services/readerSession.ts'
import { readFileSync } from 'node:fs'

const location = (cfi, fraction = 0.1) => ({ cfi, fraction })
function fixture(navigate = async () => {}) {
  const saves = []
  const session = createReaderSession({ save: async loc => { saves.push(loc) }, navigate, delay: 60_000 })
  return { session, saves }
}

test('inspection, nested footnotes and return never save inspection positions; source context round-trips', async () => {
  const { session, saves } = fixture(async cfi => session.relocate(location(cfi, 0.8)))
  try {
    session.relocate(location('main'))
    const answer = { panel: 'ai', answer: 'existing cached answer', scroll: 238 }
    await session.inspect('citation', answer)
    session.relocate(location('citation-scroll', 0.9))
    await session.inspect('nested-footnote', { panel: 'none', scroll: 0 })
    assert.equal(session.reading.cfi, 'main')
    assert.equal((await session.returnFromInspection()).panel, 'none')
    assert.deepEqual(await session.returnFromInspection(), answer)
    await session.flush()
    assert.deepEqual(saves, [location('main')])
  } finally { session.dispose() }
})

test('only explicit promotion replaces reading location', async () => {
  const { session, saves } = fixture(async cfi => session.relocate(location(cfi, 0.8)))
  try {
    session.relocate(location('main'))
    await session.inspect('source', {})
    assert.equal(session.reading.cfi, 'main')
    assert.equal(session.promote(), true)
    assert.equal(session.inspecting, false)
    assert.equal(session.reading.cfi, 'source')
    await session.flush()
    assert.deepEqual(saves, [location('source', 0.8)])
  } finally { session.dispose() }
})

test('leave flushes the debounced primary position; cancel drops only pending work', async () => {
  const { session, saves } = fixture()
  session.relocate(location('first'))
  session.relocate(location('last', 0.4))
  await session.flush()
  session.relocate(location('cancelled'))
  session.cancelPending()
  await session.flush()
  session.dispose()
  session.relocate(location('stale'))
  await session.flush()
  assert.deepEqual(saves, [location('last', 0.4)])
})

test('storage failure remains retryable and serial writes cannot finish in reverse order', async () => {
  let release
  let fail = true
  const saves = []
  const session = createReaderSession({ delay: 60_000, navigate: async () => {}, save: async loc => {
    if (fail) { fail = false; throw new Error('quota') }
    if (loc.cfi === 'first') await new Promise(resolve => { release = resolve })
    saves.push(loc.cfi)
  } })
  try {
    session.relocate(location('first'))
    await assert.rejects(session.flush(), /quota/)
    const saving = session.flush()
    session.relocate(location('second'))
    assert.equal(session.flush(), saving)
    release()
    await saving
    assert.deepEqual(saves, ['first', 'second'])
  } finally { session.dispose() }
})

test('failed navigation restores main or retains safe inspection until a successful Return', async () => {
  let failure = true
  const { session, saves } = fixture(async cfi => {
    session.relocate(location(cfi, 0.9))
    if (failure) throw new Error('missing original')
  })
  try {
    session.relocate(location('main'))
    await assert.rejects(session.inspect('missing', { answer: 'preserve' }), /missing original/)
    assert.equal(session.inspecting, true)
    assert.equal(session.promote(), false)
    failure = false
    assert.deepEqual(await session.returnFromInspection(), { answer: 'preserve' })
    assert.equal(session.inspecting, false)
    await session.flush()
    assert.deepEqual(saves, [location('main')])
  } finally { session.cancelPending(); session.dispose() }
})

test('concurrent navigation and stale completion after disposal cannot promote or mutate progress', async () => {
  let release
  const { session, saves } = fixture(() => new Promise(resolve => { release = resolve }))
  session.relocate(location('main'))
  const inspecting = session.inspect('source', {})
  await assert.rejects(session.inspect('second', {}), /unavailable/)
  assert.equal(session.promote(), false)
  session.cancelPending()
  session.dispose()
  release()
  await inspecting
  assert.equal(session.promote(), false)
  await session.flush()
  assert.deepEqual(saves, [])
  const context = createReaderContext()
  const stale = context.capture()
  context.invalidate()
  assert.equal(context.current(stale), false)
  const latest = context.capture()
  context.dispose()
  assert.equal(context.current(latest), false)
})

test('malformed locations and empty/missing sources never enter save queue', async () => {
  const { session, saves } = fixture()
  try {
    assert.equal(session.relocate(location('', 0.5)), false)
    assert.equal(session.relocate(location('bad', NaN)), false)
    await assert.rejects(session.inspect('source', {}), /location unavailable/)
    session.relocate(location('main'))
    await assert.rejects(session.inspect('', {}), /Source unavailable/)
    session.cancelPending()
    await session.flush()
    assert.deepEqual(saves, [])
  } finally { session.dispose() }
})

test('Back priority is editor, selection, inspection, panel, toolbar, leave', () => {
  const state = { editor: true, selection: true, inspection: true, panel: true, toolbar: true }
  for (const target of ['editor', 'selection', 'inspection', 'panel', 'toolbar']) {
    assert.equal(readerBackTarget(state), target)
    state[target] = false
  }
  assert.equal(readerBackTarget(state), 'leave')
})

test('native links/images, long selection mouseup, open panels and pending navigation block page turns', () => {
  for (const key of ['panel', 'selection', 'navigating', 'interactive', 'selectionGesture']) {
    assert.equal(blocksReaderTurn({ panel: false, selection: false, [key]: true }), true)
  }
  assert.equal(blocksReaderTurn({ panel: false, selection: false }), false)
  let queried = ''
  assert.equal(isReaderInteractive({ closest: selector => { queried = selector; return {} } }), true)
  assert.match(queried, /a\[href\]/)
  assert.match(queried, /img/)
  assert.equal(isReaderInteractive(null), false)
})

test('real foliate view exposes cancelable link events and renderer navigation; view.goTo masks errors', () => {
  const engine = readFileSync(new URL('../node_modules/foliate-js/view.js', import.meta.url), 'utf8')
  assert.match(engine, /#emit\('link', \{ a, href \}, true\)/)
  assert.match(engine, /async goTo\(target\)[\s\S]*?renderer.goTo\(resolved\)[\s\S]*?catch\(e\)/)
})
