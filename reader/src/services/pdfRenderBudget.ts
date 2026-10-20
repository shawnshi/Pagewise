/**
 * PDF 单页位图预算。
 *
 * 位图按设备像素生成: RGBA 一份 = 4 × 宽 × 高。MuPDF 路径同时存在 pixmap、ImageData
 * 与 canvas 副本，滚动模式还会有附近页常驻；只限制单边 (8192) 无法阻止高倍率放大时
 * 单页达到数百 MiB。这里给单页总像素设上限，超出时等比降低栅格化分辨率，由 CSS
 * 放大显示；文字仍然可读，但内存与主线程耗时保持有界。
 */
import { nativePdfPixelBudget } from './nativeReaderEnvironment.ts'

export const PDF_MAX_RENDER_PIXELS = 12_000_000
export const PDF_MAX_DIM = 8192

export interface PdfTargetSize {
  width: number
  height: number
}

export function pdfRenderTarget(displayW: number, displayH: number, dpr: number, maxDim = PDF_MAX_DIM): PdfTargetSize {
  const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 1
  const w = positive(displayW)
  const h = positive(displayH)
  const density = positive(dpr)
  const limit = positive(maxDim)
  const scale = Math.min(density, limit / w, limit / h)
  let width = Math.max(1, Math.round(w * scale))
  let height = Math.max(1, Math.round(h * scale))
  const pixels = width * height
  const budget = nativePdfPixelBudget(PDF_MAX_RENDER_PIXELS)
  if (pixels > budget) {
    const factor = Math.sqrt(budget / pixels)
    width = Math.max(1, Math.floor(width * factor))
    height = Math.max(1, Math.floor(height * factor))
  }
  return { width, height }
}
