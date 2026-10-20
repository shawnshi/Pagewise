export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function nonempty(r: Rect): boolean {
  return [r.left, r.top, r.right, r.bottom, r.width, r.height].every(Number.isFinite)
    && r.width > 0 && r.height > 0 && r.right > r.left && r.bottom > r.top
}

function visible(node: Node): boolean {
  let element = node.nodeType === 1 ? node as Element : node.parentElement
  while (element) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (!style || style.display === 'none' || style.visibility !== 'visible'
      || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false
    element = element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null
  }
  return true
}

function intersect(r: Rect, clip: Rect): Rect | null {
  const left = Math.max(r.left, clip.left), top = Math.max(r.top, clip.top)
  const right = Math.min(r.right, clip.right), bottom = Math.min(r.bottom, clip.bottom)
  const result = { left, top, right, bottom, width: right - left, height: bottom - top }
  return nonempty(result) ? result : null
}

function clippedByAncestors(rect: Rect, node: Node): Rect | null {
  let result: Rect | null = rect
  let element = node.nodeType === 1 ? node as Element : node.parentElement
  while (element && result) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (style && /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      const box = element.getBoundingClientRect()
      const clipX = style.overflowX !== 'visible', clipY = style.overflowY !== 'visible'
      const clip = { left: clipX ? box.left : result.left, right: clipX ? box.right : result.right, top: clipY ? box.top : result.top, bottom: clipY ? box.bottom : result.bottom, width: box.width, height: box.height }
      result = intersect(result, clip)
    }
    element = element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null
  }
  return result
}

/** Live, visible Range bounds in the card's host viewport; never a saved location. */
export function rangeHostRect(range: Range): Rect | null {
  try {
    if (!range || range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return null
    const doc = range.startContainer.ownerDocument
    if (!doc || doc !== range.endContainer.ownerDocument || !doc.documentElement?.isConnected) return null
    let view = doc.defaultView
    if (!view) return null
    // Read layout before style/visibility checks, using the same live API as source inspection.
    const bounds = range.getBoundingClientRect()
    if (!nonempty(bounds) || !visible(range.startContainer) || !visible(range.endContainer)) return null
    let rect = clippedByAncestors(bounds, range.commonAncestorContainer)
    if (!rect) return null
    while (view) {
      rect = intersect(rect, { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight, width: view.innerWidth, height: view.innerHeight })
      if (!rect) return null
      if (view === window) return rect
      const frame = view.frameElement as HTMLElement | null
      if (!frame?.isConnected) return null
      const f = frame.getBoundingClientRect()
      if (!visible(frame)) return null
      if (!nonempty(f) || !frame.offsetWidth || !frame.offsetHeight) return null
      const sx = f.width / frame.offsetWidth, sy = f.height / frame.offsetHeight
      const x = f.left + frame.clientLeft * sx, y = f.top + frame.clientTop * sy
      rect = { left: x + rect.left * sx, top: y + rect.top * sy, right: x + rect.right * sx, bottom: y + rect.bottom * sy, width: rect.width * sx, height: rect.height * sy }
      rect = intersect(rect, { left: x, top: y, right: x + frame.clientWidth * sx, bottom: y + frame.clientHeight * sy, width: frame.clientWidth * sx, height: frame.clientHeight * sy })
      if (!rect) return null
      rect = clippedByAncestors(rect, frame)
      if (!rect) return null
      view = frame.ownerDocument.defaultView
    }
    return null
  } catch {
    // A navigating/removed or cross-origin frame is not a usable reading target.
    return null
  }
}
