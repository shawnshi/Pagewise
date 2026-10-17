// 重排书页码契约: 实测优先 + 密度推算 / 双栏页码 / 跳页往返 / 进度条预览 / 跳页输入
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  sectionSizes, bytesPerPage, fallbackBytesPerPage, sectionPageCounts,
  pagePosition, locatePage, pageToFraction, fractionToPage, parseJumpInput,
} from '../src/services/readerPages.ts'
import { effectiveReaderLayout, effectivePdfLayout, portraitSpacing, isPortraitView } from '../src/services/portraitLayout.ts'

// ---- 竖屏单页滚动 (services/portraitLayout.ts) ----
test('竖屏且开启时生效为单栏滚动, 横屏 / 关闭时用用户设置', () => {
  const base = { flow: 'paginated', maxColumnCount: 2, portraitScroll: true }
  assert.deepEqual(effectiveReaderLayout({ ...base, portrait: true }), { flow: 'scrolled', maxColumnCount: 1, portraitLocked: true })
  assert.deepEqual(effectiveReaderLayout({ ...base, portrait: false }), { flow: 'paginated', maxColumnCount: 2, portraitLocked: false })
  assert.deepEqual(effectiveReaderLayout({ ...base, portraitScroll: false, portrait: true }), { flow: 'paginated', maxColumnCount: 2, portraitLocked: false })
  assert.equal(effectiveReaderLayout({ ...base, portrait: false, forceSingleColumn: true }).maxColumnCount, 1)
})

test('竖屏判定: 占满屏宽时按屏幕方向, 屏幕键盘压矮视口不翻成横屏', () => {
  // Surface 竖放最大化 (960×1440), 点墨 / 系统键盘停靠后视口只剩 960×880
  const surface = { screenWidth: 960, screenHeight: 1440, orientationType: 'portrait-primary' }
  assert.equal(isPortraitView({ ...surface, width: 960, height: 1378 }), true)
  assert.equal(isPortraitView({ ...surface, width: 960, height: 880 }), true)
  // 横放最大化, 键盘弹出依旧横屏
  const land = { screenWidth: 1440, screenHeight: 960, orientationType: 'landscape-primary' }
  assert.equal(isPortraitView({ ...land, width: 1440, height: 898 }), false)
  // 桌面上把窗口拉成竖长条: 仍按视口
  assert.equal(isPortraitView({ ...land, width: 587, height: 880 }), true)
  assert.equal(isPortraitView({ ...land, width: 900, height: 600 }), false)
  // 手机竖屏弹出软键盘 (390×844 → 390×420)
  assert.equal(isPortraitView({ width: 390, height: 420, screenWidth: 390, screenHeight: 844, orientationType: 'portrait-primary' }), true)
  // 旧 iOS: screen 恒为竖放尺寸, 只有 window.orientation
  assert.equal(isPortraitView({ width: 1180, height: 760, screenWidth: 820, screenHeight: 1180, legacyOrientation: 90 }), false)
  assert.equal(isPortraitView({ width: 820, height: 600, screenWidth: 820, screenHeight: 1180, legacyOrientation: 0 }), true)
  // 拿不到 screen 时退回视口宽高比
  assert.equal(isPortraitView({ width: 500, height: 800 }), true)
})

test('PDF 竖屏锁定为单页连续滚动, 放映不受影响', () => {
  const base = { mode: 'paged', spreadMode: 'facing', portraitScroll: true }
  assert.deepEqual(effectivePdfLayout({ ...base, portrait: true }), { mode: 'scroll', spreadMode: 'single', portraitLocked: true })
  assert.deepEqual(effectivePdfLayout({ ...base, portrait: false }), { mode: 'paged', spreadMode: 'facing', portraitLocked: false })
  assert.equal(effectivePdfLayout({ ...base, portrait: true, presentation: true }).mode, 'paged')
})

test('竖屏留白按像素: 手机约 18px / 平板约 36px, 随用户页边距缩放且不超过原百分比', () => {
  const phone = portraitSpacing(390, 6)
  assert.ok(Math.abs(phone.gapPercent / 100 * 390 - 18) < 0.5)
  const tablet = portraitSpacing(912, 6)
  assert.ok(Math.abs(tablet.gapPercent / 100 * 912 - 36) < 0.5)
  assert.ok(tablet.maxInlineSize >= 912, '行宽上限不再卡住竖屏平板')
  assert.ok(portraitSpacing(912, 12).gapPercent > tablet.gapPercent, '调大页边距仍然有效')
  assert.ok(portraitSpacing(200, 6).gapPercent <= 6, '窄窗口不比原百分比更宽')
})

test('非线性与空章不计入', () => {
  assert.deepEqual(sectionSizes([{ size: 100 }, { size: 50, linear: 'no' }, { size: 0 }, {}]), [100, 0, 0, 0])
})

test('密度只用 ≥2 页的章, 末页按半页计', () => {
  const sizes = [300, 10000, 6000]
  assert.equal(bytesPerPage(sizes, { 0: 1 }), null, '只有封面一页时不可用')
  assert.equal(bytesPerPage(sizes, { 0: 1, 1: 5 }), 10000 / 4.5)
  assert.equal(bytesPerPage(sizes, { 1: 5, 2: 3 }), 16000 / 7)
})

test('测过的章用实测, 没测过的按密度推算且至少一页', () => {
  const sizes = [300, 9000, 4500, 0, 50]
  const counts = sectionPageCounts(sizes, { 1: 4 }, 999)
  // 密度 9000 / 3.5 ≈ 2571 字节/页
  assert.deepEqual(counts, [1, 4, 2, 0, 1])
  // 没有可用测量时用兜底密度
  assert.deepEqual(sectionPageCounts([3000, 6000], {}, 1000), [3, 6])
})

test('兜底密度: 中文一字 3 字节, 版面越大每页越多', () => {
  const zh = fallbackBytesPerPage({ width: 360, height: 600, fontSize: 18, lineHeight: 1.8, cjk: true })
  const en = fallbackBytesPerPage({ width: 360, height: 600, fontSize: 18, lineHeight: 1.8, cjk: false })
  assert.ok(zh > en)
  assert.ok(fallbackBytesPerPage({ width: 720, height: 600, fontSize: 18, lineHeight: 1.8, cjk: true }) > zh)
})

test('当前页 = 前面各章页数 + 章内页; 本章剩余页', () => {
  const counts = [1, 10, 0, 5]
  assert.deepEqual(pagePosition(counts, 0, 1), { current: 1, last: 1, total: 16, sectionLeft: 0 })
  assert.deepEqual(pagePosition(counts, 1, 3), { current: 4, last: 4, total: 16, sectionLeft: 7 })
  assert.deepEqual(pagePosition(counts, 3, 5), { current: 16, last: 16, total: 16, sectionLeft: 0 })
  // 章内页越界时收敛
  assert.equal(pagePosition(counts, 1, 99).current, 11)
  // 不计入进度的章停在前一章末页
  assert.deepEqual(pagePosition(counts, 2, 1), { current: 11, last: 11, total: 16, sectionLeft: 0 })
})

test('双栏一屏两页, 末屏只有左栏时不越界', () => {
  const counts = [1, 9]
  assert.deepEqual(pagePosition(counts, 1, 3, 2), { current: 4, last: 5, total: 10, sectionLeft: 5 })
  assert.deepEqual(pagePosition(counts, 1, 9, 2), { current: 10, last: 10, total: 10, sectionLeft: 0 })
})

test('页码定位到章', () => {
  const counts = [1, 10, 0, 5]
  assert.deepEqual(locatePage(counts, 1), { index: 0, local: 1 })
  assert.deepEqual(locatePage(counts, 11), { index: 1, local: 10 })
  assert.deepEqual(locatePage(counts, 12), { index: 3, local: 1 })
  assert.deepEqual(locatePage(counts, 999), { index: 3, local: 5 })
  assert.equal(locatePage([0, 0], 1), null)
})

/** 模拟 foliate: goToFraction → getSection → round(章内进度 × (屏数-1)) 选屏 */
function landOn(sizes, counts, fraction, perScreen) {
  const total = sizes.reduce((a, b) => a + b, 0)
  const target = fraction * total + 1e-9
  let acc = 0
  for (let i = 0; i < sizes.length; i++) {
    if (!sizes[i]) continue
    if (target < acc + sizes[i] || i === sizes.length - 1) {
      const inSection = (fraction * total - acc) / sizes[i]
      const screens = Math.ceil(counts[i] / perScreen)
      const screen = Math.round(inSection * (screens - 1))
      return pagePosition(counts, i, screen * perScreen + 1, perScreen).current
    }
    acc += sizes[i]
  }
}

test('跳页往返: 每一页都能精确落到 (单栏 / 双栏)', () => {
  const sizes = [200, 12000, 0, 7000, 900]
  for (const per of [1, 2]) {
    const counts = per === 1 ? [1, 8, 0, 5, 1] : [1, 8, 0, 6, 2]
    const total = counts.reduce((a, b) => a + b, 0)
    for (let page = 1; page <= total; page++) {
      const f = pageToFraction(sizes, counts, page, { perScreen: per })
      assert.ok(f >= 0 && f <= 1)
      const landed = landOn(sizes, counts, f, per)
      const expected = pagePosition(counts, locatePage(counts, page).index, locatePage(counts, page).local, per)
      // 双栏落在包含目标页的那一屏
      assert.ok(landed <= page && page <= landed + per - 1, `per=${per} page=${page} landed=${landed} (${expected.current})`)
    }
  }
})

test('滚动模式按章内比例', () => {
  const f = pageToFraction([1000, 1000], [2, 4], 5, { scrolled: true })
  assert.equal(f, (1000 + 0.5 * 1000) / 2000)
})

test('进度条预览: 进度 → 页码与章', () => {
  const sizes = [100, 900, 0, 1000]
  const counts = [1, 9, 0, 10]
  assert.deepEqual(fractionToPage(sizes, counts, 0), { page: 1, index: 0 })
  assert.deepEqual(fractionToPage(sizes, counts, 0.05), { page: 2, index: 1 })
  assert.deepEqual(fractionToPage(sizes, counts, 0.1), { page: 3, index: 1 })
  assert.deepEqual(fractionToPage(sizes, counts, 0.5), { page: 11, index: 3 })
  assert.deepEqual(fractionToPage(sizes, counts, 1), { page: 20, index: 3 })
})

test('跳页输入: 页码 / 百分比 / 全角 / 越界', () => {
  assert.deepEqual(parseJumpInput(' 128 ', 500), { page: 128 })
  assert.deepEqual(parseJumpInput('25%', 500), { fraction: 0.25 })
  assert.deepEqual(parseJumpInput('33.5 ％', 500), { fraction: 0.335 })
  assert.equal(parseJumpInput('0', 500), null)
  assert.equal(parseJumpInput('501', 500), null)
  assert.equal(parseJumpInput('120%', 500), null)
  assert.equal(parseJumpInput('abc', 500), null)
  assert.equal(parseJumpInput('', 500), null)
})
