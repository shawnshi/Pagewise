/**
 * 阅读焦点 (src/services/readingFocus.ts) 的纯函数契约:
 * 可读区 (扣掉顶栏 / 底栏 / 抽屉) · 舒适区 25%–65% · 焦点线 38% · 长句对齐舒适区上沿 ·
 * 跟随时在区内不动 · 手动滚动后 4 秒不跟 · 滚动方式 (减少动态效果 / 远距离瞬移)。
 *
 *   npm run test:reading-focus
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FOCUS_BAND_TOP, FOCUS_BAND_BOTTOM, FOCUS_LINE, FOLLOW_HOLD_MS,
  readingArea, focusBand, isTall, isComfortable, focusTarget, followTarget, jumpLine,
  isOnScreen, followHeld, scrollMotion,
} from '../src/services/readingFocus.ts'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)

test('constants: band 25%–65%, focus line 38% inside the band, 4 s hold', () => {
  assert.equal(FOCUS_BAND_TOP, 0.25)
  assert.equal(FOCUS_BAND_BOTTOM, 0.65)
  assert.equal(FOCUS_LINE, 0.38)
  assert.ok(FOCUS_LINE > FOCUS_BAND_TOP && FOCUS_LINE < FOCUS_BAND_BOTTOM)
  assert.equal(FOLLOW_HOLD_MS, 4000)
})

test('readingArea: immersive = whole viewport', () => {
  assert.deepEqual(readingArea(800), { top: 0, bottom: 800 })
  assert.deepEqual(readingArea(800, 0, 0), { top: 0, bottom: 800 })
})

test('readingArea: bars visible shrink the area from both ends', () => {
  assert.deepEqual(readingArea(844, 56, 112), { top: 56, bottom: 732 })
})

test('readingArea: negative / oversize insets are clamped', () => {
  assert.deepEqual(readingArea(800, -10, -5), { top: 0, bottom: 800 })
  const a = readingArea(800, 900, 900)
  assert.ok(a.bottom - a.top >= 280, JSON.stringify(a))
})

test('readingArea: a tall bottom sheet is ignored rather than leaving a sliver', () => {
  // phone 844 high, top bar 56, TTS sheet covers 78% (658px) → 130px left: too small
  const a = readingArea(844, 56, 658)
  assert.equal(a.top, 56)
  assert.ok(a.bottom - a.top >= 0.35 * 844 - 1, JSON.stringify(a))
  // a moderate sheet (40%) is respected
  assert.deepEqual(readingArea(844, 56, 338), { top: 56, bottom: 506 })
})

test('focusBand: proportions of the reading area, offset by the top inset', () => {
  const b = focusBand({ top: 100, bottom: 900 })
  near(b.top, 100 + 800 * 0.25)
  near(b.bottom, 100 + 800 * 0.65)
  near(b.line, 100 + 800 * 0.38)
})

test('followTarget: inside the band and fully visible → stay (null)', () => {
  const area = { top: 0, bottom: 1000 }
  assert.equal(followTarget({ top: 300, bottom: 380 }, area), null)
  assert.equal(followTarget({ top: 250, bottom: 300 }, area), null) // exactly at band top
  assert.equal(followTarget({ top: 650, bottom: 700 }, area), null) // exactly at band bottom
})

test('followTarget: below the band → first line to the focus line', () => {
  const area = { top: 0, bottom: 1000 }
  near(followTarget({ top: 700, bottom: 760 }, area), 380)
})

test('followTarget: above the band (top edge / under the top bar) → focus line', () => {
  const area = readingArea(1000, 60, 0)
  // sentence at y=20 (under a 60px bar) and at y=100 (just under it, but above 25%)
  near(followTarget({ top: 20, bottom: 60 }, area), 60 + 940 * 0.38)
  near(followTarget({ top: 100, bottom: 140 }, area), 60 + 940 * 0.38)
})

test('followTarget: off screen (either side) → focus line', () => {
  const area = { top: 0, bottom: 800 }
  near(followTarget({ top: -400, bottom: -360 }, area), 304)
  near(followTarget({ top: 2400, bottom: 2440 }, area), 304)
})

test('followTarget: starts in band but runs past the bottom edge → move', () => {
  const area = { top: 0, bottom: 1000 }
  // 300px high (shorter than the 400px band), starts at 64% → ends below the area
  assert.equal(followTarget({ top: 640, bottom: 940 }, area), null)
  near(followTarget({ top: 640, bottom: 1010 }, area), 380)
})

test('long sentence (taller than the band): align its start to the band top', () => {
  const area = { top: 0, bottom: 1000 }
  const tall = { top: 700, bottom: 1300 } // 600 > 400
  assert.ok(isTall(tall, area))
  near(focusTarget(tall, area), 250)
  near(followTarget(tall, area), 250)
  // already high enough (between band top and focus line) → stay
  assert.equal(followTarget({ top: 260, bottom: 860 }, area), null)
  assert.equal(followTarget({ top: 375, bottom: 975 }, area), null)
  // starting at 50% (in band, but most of it below the fold) → move up
  near(followTarget({ top: 500, bottom: 1100 }, area), 250)
})

test('isComfortable matches followTarget', () => {
  const area = { top: 50, bottom: 750 }
  for (const top of [0, 100, 225, 300, 505, 600, 760]) {
    const box = { top, bottom: top + 40 }
    assert.equal(isComfortable(box, area), followTarget(box, area) === null, `top=${top}`)
  }
})

test('jumpLine: one-shot jumps land on the focus line below the bars', () => {
  near(jumpLine({ top: 0, bottom: 900 }), 342)
  near(jumpLine(readingArea(844, 56, 112)), 56 + 676 * 0.38)
})

test('isOnScreen: any overlap with the viewport counts', () => {
  assert.equal(isOnScreen({ top: -50, bottom: 1 }, 800), true)
  assert.equal(isOnScreen({ top: 799, bottom: 840 }, 800), true)
  assert.equal(isOnScreen({ top: -50, bottom: 0 }, 800), false)
  assert.equal(isOnScreen({ top: 800, bottom: 840 }, 800), false)
})

test('followHeld: 4 s after the reader scrolled', () => {
  assert.equal(followHeld(-Infinity, 1000), false)
  assert.equal(followHeld(1000, 1000), true)
  assert.equal(followHeld(1000, 4999), true)
  assert.equal(followHeld(1000, 5000), false)
  assert.equal(followHeld(1000, 1500, 400), false)
})

test('scrollMotion: smooth for short moves, scaled duration', () => {
  const short = scrollMotion(40, 800)
  assert.equal(short.behavior, 'smooth')
  assert.ok(short.duration >= 220 && short.duration <= 240, JSON.stringify(short))
  const half = scrollMotion(-400, 800)
  assert.equal(half.behavior, 'smooth')
  assert.equal(half.duration, 320)
  const screen = scrollMotion(1200, 800)
  assert.equal(screen.behavior, 'smooth')
  assert.equal(screen.duration, 420)
})

test('scrollMotion: instant when far away or reduced motion is requested', () => {
  assert.deepEqual(scrollMotion(1201, 800), { behavior: 'auto', duration: 0 })
  assert.deepEqual(scrollMotion(100, 800, true), { behavior: 'auto', duration: 0 })
  assert.equal(scrollMotion(10, 0).behavior, 'auto') // degenerate viewport
})
