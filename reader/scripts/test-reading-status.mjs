import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isReadingStatus,
  resolveReadingStatus,
  READING_STATUS_LABELS,
  createNewBookReadingStatus,
} from '../src/services/readingStatus.ts'

test('legacy unmarked books never falsely infer unread or finished from progress alone', () => {
  // progress: 0 without explicit status or lastReadAt remains undefined (unmarked legacy)
  const legacyNew = { title: 'Legacy Zero Progress', progress: 0 }
  const resNew = resolveReadingStatus(legacyNew)
  assert.equal(resNew.explicit, undefined)
  assert.equal(resNew.effective, undefined, 'progress: 0 alone must NEVER infer unread')
  assert.equal(resNew.isLegacy, true)

  // progress: 1 without explicit status or lastReadAt remains undefined (unmarked legacy)
  const legacyComplete = { title: 'Legacy Finished Progress', progress: 1 }
  const resComplete = resolveReadingStatus(legacyComplete)
  assert.equal(resComplete.explicit, undefined)
  assert.equal(resComplete.effective, undefined, 'progress: 1 alone must NEVER infer finished')
  assert.equal(resComplete.isLegacy, true)

  // arbitrary intermediate progress without lastReadAt
  const legacyPartial = { title: 'Legacy Partial', progress: 0.42 }
  const resPartial = resolveReadingStatus(legacyPartial)
  assert.equal(resPartial.explicit, undefined)
  assert.equal(resPartial.effective, undefined)
  assert.equal(resPartial.isLegacy, true)
})

test('positive valid lastReadAt supports reading state for unmarked legacy records', () => {
  const readBook = { title: 'Legacy Positive Last Read', lastReadAt: 1710000000000 }
  const res = resolveReadingStatus(readBook)
  assert.equal(res.explicit, undefined)
  assert.equal(res.effective, 'reading', 'positive lastReadAt supports reading')
  assert.equal(res.isLegacy, true)

  // non-positive or invalid lastReadAt does not infer reading
  const zeroLastRead = { title: 'Zero Last Read', lastReadAt: 0 }
  assert.equal(resolveReadingStatus(zeroLastRead).effective, undefined)

  const negLastRead = { title: 'Neg Last Read', lastReadAt: -100 }
  assert.equal(resolveReadingStatus(negLastRead).effective, undefined)

  const nanLastRead = { title: 'NaN Last Read', lastReadAt: NaN }
  assert.equal(resolveReadingStatus(nanLastRead).effective, undefined)
})

test('explicit readingStatus takes precedence over progress and lastReadAt', () => {
  for (const status of ['unread', 'reading', 'finished', 'paused']) {
    const book = {
      title: `Explicit ${status}`,
      readingStatus: status,
      lastReadAt: 1700000000,
      progress: 0.9,
    }
    const res = resolveReadingStatus(book)
    assert.equal(res.explicit, status)
    assert.equal(res.effective, status)
    assert.equal(res.isLegacy, false)
  }
})

test('corrupted or invalid readingStatus is ignored and treated as unmarked legacy', () => {
  const corrupt = [
    { readingStatus: 'unknown' },
    { readingStatus: '' },
    { readingStatus: 123 },
    { readingStatus: null },
    { readingStatus: {} },
  ]
  for (const item of corrupt) {
    const res = resolveReadingStatus(item)
    assert.equal(res.explicit, undefined)
    assert.equal(res.isLegacy, true)
  }
})

test('new imports can explicitly initialize with unread status', () => {
  const initial = createNewBookReadingStatus('unread')
  assert.equal(initial, 'unread')
  const res = resolveReadingStatus({ readingStatus: initial })
  assert.equal(res.explicit, 'unread')
  assert.equal(res.effective, 'unread')
  assert.equal(res.isLegacy, false)
})

test('isReadingStatus type guard and labels', () => {
  assert.equal(isReadingStatus('unread'), true)
  assert.equal(isReadingStatus('reading'), true)
  assert.equal(isReadingStatus('finished'), true)
  assert.equal(isReadingStatus('paused'), true)
  assert.equal(isReadingStatus('other'), false)
  assert.equal(isReadingStatus(undefined), false)
  assert.equal(isReadingStatus(null), false)

  assert.equal(READING_STATUS_LABELS.unread, '未读')
  assert.equal(READING_STATUS_LABELS.reading, '在读')
  assert.equal(READING_STATUS_LABELS.finished, '已读完')
  assert.equal(READING_STATUS_LABELS.paused, '搁置')
})
