/**
 * 阅读焦点: 滚动模式下, 程序替读者把视图移到一段文字时的统一落点规则。
 *
 * 读者视角:
 *  - 正在读 / 正在听的那句应当在屏幕中上部 (最舒服的视线区), 不贴着顶边, 更不能被顶栏盖住;
 *  - 跟读 (听书) 时它还在舒适区里就别动, 出了舒适区才平稳地挪一次, 不要每句都滚;
 *  - 读者自己动了手 (滑动 / 拖滚动条), 几秒内不去抢。
 *
 * 规则 (比例都相对「可读区」= 视口减去显示中的顶栏 / 底栏):
 *  - 舒适区: 25%–65%。跟随目标的首行在区内且整句可见 → 不滚动。
 *  - 焦点线: 38%。出了舒适区 (或在屏外) → 首行平滑地落到焦点线。
 *  - 长句 (比舒适区还高): 句首对齐舒适区上沿 (25%), 尽量多露出整句。
 *  - 一次性跳转 (搜索结果 / 划线 / 点睛 / 回到朗读位置): 目标首行直接落在焦点线。
 *  - 动画: 系统要求减少动态效果时瞬移; 距离超过 1.5 屏也瞬移 (长距离滑过无关文字只会晃眼)。
 *
 * 纯函数, 坐标一律是「相对滚动视口顶边的 px」, 与 renderer.rangeBox() 的返回一致。
 */

/** 舒适区上沿 (可读区高度的比例) */
export const FOCUS_BAND_TOP = 0.25
/** 舒适区下沿 */
export const FOCUS_BAND_BOTTOM = 0.65
/** 焦点线: 最佳视线位置 */
export const FOCUS_LINE = 0.38
/** 读者手动滚动后多久内不自动跟随 */
export const FOLLOW_HOLD_MS = 4000
/** 可读区至少保留的高度: 底部抽屉等把正文压得太矮时, 宁可忽略它 */
const MIN_AREA_PX = 160
const MIN_AREA_RATIO = 0.35

export interface Area {
  /** 可读区上沿 / 下沿, 相对视口顶边的 px */
  top: number
  bottom: number
}

export interface Box {
  /** 目标首行顶边 / 末行底边, 相对视口顶边的 px */
  top: number
  bottom: number
}

export interface Band {
  top: number
  bottom: number
  /** 焦点线 */
  line: number
}

/**
 * 可读区: 视口减去盖在正文上的顶栏 / 底栏 (及手机上的听书抽屉)。
 * 剩下的太矮时先不算底部遮挡, 再不算顶部, 保证焦点规则总有意义。
 */
export function readingArea(viewport: number, insetTop = 0, insetBottom = 0): Area {
  const h = Math.max(0, viewport)
  let top = clamp(insetTop, 0, h)
  let bottom = clamp(insetBottom, 0, h)
  const min = Math.min(h, Math.max(MIN_AREA_PX, h * MIN_AREA_RATIO))
  if (h - top - bottom < min) bottom = Math.max(0, h - top - min)
  if (h - top - bottom < min) top = Math.max(0, h - min)
  return { top, bottom: h - bottom }
}

export function focusBand(area: Area): Band {
  const h = Math.max(0, area.bottom - area.top)
  return {
    top: area.top + h * FOCUS_BAND_TOP,
    bottom: area.top + h * FOCUS_BAND_BOTTOM,
    line: area.top + h * FOCUS_LINE,
  }
}

/** 比舒适区还高的目标 (长句 / 长段) */
export function isTall(box: Box, area: Area): boolean {
  const band = focusBand(area)
  return box.bottom - box.top > band.bottom - band.top
}

/**
 * 跟随目标是否已经在舒适位置:
 *  - 普通目标: 首行在舒适区内, 且整句都在可读区里;
 *  - 长句: 首行在「舒适区上沿 ~ 焦点线」之间 (已经尽可能多地露出来了)。
 */
export function isComfortable(box: Box, area: Area): boolean {
  const band = focusBand(area)
  if (isTall(box, area)) return box.top >= band.top - 1 && box.top <= band.line + 1
  return box.top >= band.top && box.top <= band.bottom && box.bottom <= area.bottom
}

/** 目标首行该落在哪儿 (相对视口顶边的 px): 普通目标 → 焦点线; 长句 → 舒适区上沿 */
export function focusTarget(box: Box, area: Area): number {
  const band = focusBand(area)
  return isTall(box, area) ? band.top : band.line
}

/** 跟随 (听书当前句等): 在舒适区里 → null (不动); 否则返回首行应落的位置 */
export function followTarget(box: Box, area: Area): number | null {
  return isComfortable(box, area) ? null : focusTarget(box, area)
}

/** 一次性跳转 (搜索结果 / 划线 / 点睛 / 回到朗读位置): 目标首行落在焦点线 */
export function jumpLine(area: Area): number {
  return focusBand(area).line
}

/** 目标与视口有交集 (哪怕被顶栏盖着, 也算还在屏上) */
export function isOnScreen(box: Box, viewport: number): boolean {
  return box.bottom > 0 && box.top < viewport
}

/** 读者最近手动滚动过: 跟随暂停 */
export function followHeld(lastSteerAt: number, now: number, holdMs = FOLLOW_HOLD_MS): boolean {
  return now - lastSteerAt < holdMs
}

export interface Motion {
  behavior: 'smooth' | 'auto'
  /** 平滑滚动的时长 (ms) */
  duration: number
}

/**
 * 滚动方式: 系统要求减少动态效果 → 瞬移; 距离超过 1.5 屏 → 瞬移;
 * 否则平滑, 时长随距离 220–420ms (挪一两行很快, 挪大半屏稍慢一点, 眼睛跟得上)。
 */
export function scrollMotion(distance: number, viewport: number, reducedMotion = false): Motion {
  const d = Math.abs(distance)
  const vp = Math.max(1, viewport)
  if (reducedMotion || d > vp * 1.5) return { behavior: 'auto', duration: 0 }
  return { behavior: 'smooth', duration: Math.round(clamp(220 + 200 * (d / vp), 220, 420)) }
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0))
}
