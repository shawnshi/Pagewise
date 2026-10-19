/** Byte accounting includes typed arrays and a conservative per-line geometry allowance. */
export class PdfByteLru<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>()
  private pinned = new Set<K>()
  bytes = 0
  readonly limit: number
  private dispose: (value: V) => void
  constructor(limit: number, dispose: (value: V) => void = () => {}) {
    this.limit = limit
    this.dispose = dispose
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }
  set(key: K, value: V, bytes: number): boolean {
    this.delete(key)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit) return false
    while (this.bytes + bytes > this.limit) {
      const candidate = [...this.entries.keys()].find(entry => !this.pinned.has(entry))
      if (candidate === undefined) return false
      this.delete(candidate)
    }
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    return true
  }
  delete(key: K) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.bytes -= entry.bytes
    this.dispose(entry.value)
  }
  pin(key: K) { this.pinned.add(key) }
  unpinAll() { this.pinned.clear() }
  clear() {
    for (const key of this.entries.keys()) this.delete(key)
    this.unpinAll()
  }
}
export const PDF_GEOMETRY_BYTES = 8 * 1024 * 1024
// Two maximum-size facing pages fit without forcing DPR reduction. One worker
// reserves four RGBA surfaces (pixmap/upload/transfer/UI draw) outside retained LRU.
export const PDF_BITMAP_BYTES = 96 * 1024 * 1024
export const PDF_RASTER_RESERVED_BYTES = 4 * 12_000_000 * 4
export const PDF_TOTAL_BITMAP_BYTES = PDF_BITMAP_BYTES + PDF_RASTER_RESERVED_BYTES
