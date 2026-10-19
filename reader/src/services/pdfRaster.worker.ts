import { PdfiumDoc } from './pdfium'
import { initMupdf } from './mupdf'
import type { Document, Page, Pixmap, DrawDevice } from 'mupdf'

// Only this owner touches raster WASM and pixel upload; the UI retains PDFium geometry.
let pdfium: PdfiumDoc | null = null
let mupdfDoc: Document | null = null
let bytes: ArrayBuffer | null = null
let activeSession = 0
// SAFETY: Vite instantiates this module only as a dedicated Worker, never a Window.
const host = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void }
host.onmessage = async ({ data: request }) => {
  const { session, revision, id } = request
  const reply = { session, revision, id }
  try {
    if (request.kind === 'open') {
      activeSession = session
      bytes = await request.blob.arrayBuffer()
      host.postMessage({ ...reply, ok: true })
      return
    }
    if (session !== activeSession || !bytes) throw new Error('PDF worker document closed')
    const { page: index, width, height, renderer } = request
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 12_000_000) throw new Error('Invalid PDF raster dimensions')
    let image: ImageData | undefined
    let actual = renderer
    if (renderer === 'mupdf') {
      let page: Page | undefined, pixmap: Pixmap | undefined, device: DrawDevice | undefined
      try {
        const mupdf = await initMupdf()
        mupdfDoc ??= mupdf.Document.openDocument(bytes, 'application/pdf')
        page = mupdfDoc.loadPage(index)
        const bounds = page.getBounds()
        const ctm = mupdf.Matrix.concat(mupdf.Matrix.translate(-bounds[0], -bounds[1]), mupdf.Matrix.scale(width / (bounds[2] - bounds[0]), height / (bounds[3] - bounds[1])))
        pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true)
        pixmap.clear(255)
        device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
        page.run(device, ctm)
        device.close()
        if (pixmap.getStride() !== width * 4) throw new Error('Unexpected PDF pixmap stride')
        // The upload completes before pixmap destruction; no detached WASM heap escapes.
        const canvas = new OffscreenCanvas(width, height)
        const pixels = pixmap.getPixels()
        if (!(pixels.buffer instanceof ArrayBuffer)) throw new Error('Unexpected shared PDF pixel heap')
        const rgba = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
        canvas.getContext('2d', { alpha: false })!.putImageData(new ImageData(rgba, width, height), 0, 0)
        const bitmap = canvas.transferToImageBitmap()
        canvas.width = canvas.height = 0
        host.postMessage({ ...reply, bitmap, renderer: actual }, [bitmap])
        return
      } catch (error) {
        // Preserve the existing engine fallback, but never move raster work to the UI.
        console.warn('MuPDF worker raster failed; using PDFium worker', error)
        actual = 'pdfium'
      } finally { device?.destroy(); pixmap?.destroy(); page?.destroy() }
    }
    pdfium ??= await PdfiumDoc.open(bytes)
    image = pdfium.renderToSize(index, width, height)
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d', { alpha: false })!.putImageData(image, 0, 0)
    const bitmap = canvas.transferToImageBitmap()
    canvas.width = canvas.height = 0
    host.postMessage({ ...reply, bitmap, renderer: actual }, [bitmap])
  } catch (error) {
    host.postMessage({ ...reply, error: error instanceof Error ? error.message : String(error) })
  }
}
