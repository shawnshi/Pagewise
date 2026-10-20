import { strFromU8, strToU8 } from 'fflate'

const MiB = 1024 * 1024
/** This first restore slice is deliberately bounded, not an arbitrary-size library reader. */
export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 64 * MiB,
  totalBytes: 128 * MiB,
  entryBytes: 64 * MiB,
  metadataBytes: 4 * MiB,
  directoryBytes: 2 * MiB,
  entries: 2048,
})

function invalid(reason: string): never {
  throw new Error(`Invalid archive: ${reason}. Limits: ZIP 64 MiB, expanded 128 MiB, entry 64 MiB, metadata 4 MiB, 2048 entries. Split the library into smaller archives.`)
}
/** Exact fflate ZipPassThrough layout: local header + 16-byte descriptor + central record. */
export class StoredArchiveBudget {
  private names = new Set<string>()
  private expanded = 0
  private directory = 0
  private local = 0
  get zipBytes(): number { return this.local + this.directory + 22 }

  add(path: string, byteLength: number, role: 'metadata' | 'asset'): void {
    const nameBytes = strToU8(path)
    pathName(nameBytes)
    if (this.names.has(path)) invalid('duplicate export path')
    const entryLimit = role === 'metadata' ? ARCHIVE_LIMITS.metadataBytes : ARCHIVE_LIMITS.entryBytes
    const expanded = this.expanded + byteLength
    const directory = this.directory + 46 + nameBytes.length
    const local = this.local + 30 + nameBytes.length + byteLength + 16
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > entryLimit
      || expanded > ARCHIVE_LIMITS.totalBytes || this.names.size + 1 > ARCHIVE_LIMITS.entries
      || directory > ARCHIVE_LIMITS.directoryBytes || local + directory + 22 > ARCHIVE_LIMITS.archiveBytes) {
      invalid('export exceeds restore capacity (including ZIP headers, descriptors and directory)')
    }
    this.names.add(path)
    this.expanded = expanded
    this.directory = directory
    this.local = local
  }
}

const isTextMetadataCandidate = (name: string) => /\.(json|md)$/i.test(name)
const isControlMetadata = (name: string) => ['index.md', 'manifest.json', 'reading-log.json', 'booklists.json'].includes(name)
export type ArchiveAssetResolver = (boundedMetadata: Record<string, Uint8Array>) => ReadonlySet<string>

export function checkArchiveAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Archive restore cancelled', 'AbortError')
}
function pathName(bytes: Uint8Array): string {
  const name = strFromU8(bytes)
  const parts = name.replace(/\/$/, '').split('/')
  if (!name || name.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(name)
    || parts.some(part => !part || part === '.' || part === '..')) invalid('unsafe ZIP path')
  return name
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return crc
}
interface Entry {
  name: string
  nameBytes: Uint8Array
  compressed: number
  expanded: number
  crc: number
  method: number
  flags: number
  offset: number
  start: number
}

/** Read only bounded slices; validate every ZIP record and all actual output before any caller writes. */
export async function readBoundedArchive(file: Blob, signal?: AbortSignal, resolveAssets?: ArchiveAssetResolver): Promise<Record<string, Uint8Array>> {
  if (file.size > ARCHIVE_LIMITS.archiveBytes) invalid('archive size exceeded')
  if (file.size < 22) invalid('truncated ZIP')
  const slice = async (start: number, length: number) => {
    checkArchiveAbort(signal)
    if (start < 0 || length < 0 || start + length > file.size) invalid('truncated ZIP record')
    const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
    if (bytes.length !== length) invalid('short ZIP read')
    return bytes
  }
  const tailStart = Math.max(0, file.size - 65557)
  const tail = await slice(tailStart, file.size - tailStart)
  const tailView = new DataView(tail.buffer)
  let end = tail.length - 22
  while (end >= 0 && (tailView.getUint32(end, true) !== 0x06054b50
    || end + 22 + tailView.getUint16(end + 20, true) !== tail.length)) end--
  if (end < 0) invalid('missing ZIP end record (possibly truncated)')
  const count = tailView.getUint16(end + 10, true)
  const directorySize = tailView.getUint32(end + 12, true)
  const directoryStart = tailView.getUint32(end + 16, true)
  if (tailView.getUint16(end + 4, true) || tailView.getUint16(end + 6, true)
    || tailView.getUint16(end + 8, true) !== count || count === 65535
    || directoryStart + directorySize !== tailStart + end) invalid('unsupported split/ZIP64 or malformed directory')
  if (count > ARCHIVE_LIMITS.entries || directorySize > ARCHIVE_LIMITS.directoryBytes) invalid('directory budget exceeded')
  const directory = await slice(directoryStart, directorySize)
  const view = new DataView(directory.buffer)
  const entries: Entry[] = []
  const names = new Set<string>()
  let pos = 0
  let total = 0
  for (let index = 0; index < count; index++) {
    if (pos + 46 > directory.length || view.getUint32(pos, true) !== 0x02014b50) invalid('malformed central directory')
    const flags = view.getUint16(pos + 8, true)
    const method = view.getUint16(pos + 10, true)
    const compressed = view.getUint32(pos + 20, true)
    const expanded = view.getUint32(pos + 24, true)
    const nameLength = view.getUint16(pos + 28, true)
    const recordEnd = pos + 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true)
    if (recordEnd > directory.length || view.getUint16(pos + 34, true)) invalid('truncated/split directory entry')
    const nameBytes = directory.subarray(pos + 46, pos + 46 + nameLength)
    const name = pathName(nameBytes)
    if (names.has(name) || names.has(name.replace(/\/$/, '')) || names.has(`${name}/`)) invalid('duplicate ZIP path')
    names.add(name)
    if (flags & ~0x080e || (method !== 0 && method !== 8)
      || ((view.getUint32(pos + 38, true) >>> 16) & 0xf000) === 0xa000) invalid('encrypted or unsupported ZIP entry')
    // With a resolver, large text entries remain unopened until bounded metadata
    // proves they are actual book/cover assets. Control documents never get an exemption.
    const limit = isControlMetadata(name) || (!resolveAssets && isTextMetadataCandidate(name))
      ? ARCHIVE_LIMITS.metadataBytes : ARCHIVE_LIMITS.entryBytes
    total += expanded
    if (expanded > limit || total > ARCHIVE_LIMITS.totalBytes || compressed > ARCHIVE_LIMITS.archiveBytes
      || (method === 0 && compressed !== expanded) || (name.endsWith('/') && expanded)) invalid('expansion budget exceeded')
    entries.push({ name, nameBytes, compressed, expanded, crc: view.getUint32(pos + 16, true), method, flags,
      offset: view.getUint32(pos + 42, true), start: 0 })
    pos = recordEnd
  }
  if (pos !== directory.length) invalid('unexpected directory records')
  entries.sort((a, b) => a.offset - b.offset)
  let expected = 0
  // Validate local headers and data descriptors too: no hidden entries, overlaps or aliases.
  for (const entry of entries) {
    if (entry.offset !== expected) invalid('overlapping or unindexed ZIP records')
    const header = new DataView((await slice(entry.offset, 30)).buffer)
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== entry.flags
      || header.getUint16(8, true) !== entry.method) invalid('local header mismatch')
    const nameLength = header.getUint16(26, true)
    const localName = await slice(entry.offset + 30, nameLength)
    if (localName.length !== entry.nameBytes.length || localName.some((byte, i) => byte !== entry.nameBytes[i])) invalid('local path mismatch')
    entry.start = entry.offset + 30 + nameLength + header.getUint16(28, true)
    expected = entry.start + entry.compressed
    if (expected > directoryStart) invalid('entry overlaps directory')
    if (entry.flags & 8) {
      const first = new DataView((await slice(expected, 4)).buffer).getUint32(0, true)
      const descriptor = new DataView((await slice(expected + (first === 0x08074b50 ? 4 : 0), 12)).buffer)
      if (descriptor.getUint32(0, true) !== entry.crc || descriptor.getUint32(4, true) !== entry.compressed
        || descriptor.getUint32(8, true) !== entry.expanded) invalid('invalid ZIP data descriptor')
      expected += first === 0x08074b50 ? 16 : 12
    } else if (header.getUint32(14, true) !== entry.crc || header.getUint32(18, true) !== entry.compressed
      || header.getUint32(22, true) !== entry.expanded) invalid('local size/CRC mismatch')
  }
  if (expected !== directoryStart) invalid('unindexed ZIP payload')

  const result: Record<string, Uint8Array> = Object.create(null)
  let turns = 0
  const readEntry = async (entry: Entry): Promise<Uint8Array> => {
    const output = new Uint8Array(entry.expanded)
    let written = 0
    let crc = -1
    const consume = (chunk: Uint8Array) => {
      if (written + chunk.length > output.length) invalid('actual expansion exceeds declared size')
      output.set(chunk, written)
      written += chunk.length
      crc = updateCrc(crc, chunk)
    }
    if (entry.method === 8) {
      // Unlike fflate's Inflate callback, native streams apply output backpressure
      // and reject an unfinished DEFLATE stream even if all expected bytes appeared.
      // Feed explicit 1 KiB slices, not Blob.stream()'s implementation-defined chunks:
      // one DEFLATE input chunk can expand ~1032x before output backpressure applies.
      let decompressor: DecompressionStream
      try { decompressor = new DecompressionStream('deflate-raw') }
      catch { invalid('this WebView lacks bounded deflate-raw support. The original archive is unchanged. Update the WebView if available, or use a supported environment to rebuild an uncompressed ZIP') }
      let compressedOffset = 0
      const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          checkArchiveAbort(signal)
          if (compressedOffset === entry.compressed) { controller.close(); return }
          const length = Math.min(1024, entry.compressed - compressedOffset)
          const bytes = await slice(entry.start + compressedOffset, length)
          checkArchiveAbort(signal)
          compressedOffset += length
          controller.enqueue(bytes)
        },
      }, { highWaterMark: 0 })
      const reader = input.pipeThrough(decompressor).getReader()
      const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        for (;;) {
          checkArchiveAbort(signal)
          const { done, value } = await reader.read()
          checkArchiveAbort(signal)
          if (done) break
          consume(value)
          if (++turns % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0))
        }
      } finally {
        signal?.removeEventListener('abort', cancel)
        try { await reader.cancel() } finally { reader.releaseLock() }
      }
    } else {
      for (let offset = 0; offset < entry.compressed; offset += 16384) {
        consume(await slice(entry.start + offset, Math.min(16384, entry.compressed - offset)))
        if (++turns % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    if (written !== entry.expanded || ((crc ^ -1) >>> 0) !== entry.crc) invalid(`size/CRC mismatch for ${entry.name}`)
    return output
  }
  if (resolveAssets) {
    // Only bounded text is materialized for role discovery. A suffix or assets/
    // namespace alone cannot exempt an oversized document from the metadata limit.
    for (const entry of entries) {
      if (isTextMetadataCandidate(entry.name) && entry.expanded <= ARCHIVE_LIMITS.metadataBytes) {
        result[entry.name] = await readEntry(entry)
      }
    }
    const assets = resolveAssets(result)
    for (const entry of entries) {
      if (isTextMetadataCandidate(entry.name) && (!assets.has(entry.name) || isControlMetadata(entry.name))
        && entry.expanded > ARCHIVE_LIMITS.metadataBytes) invalid('metadata expansion budget exceeded')
    }
  }
  for (const entry of entries) {
    if (!(entry.name in result)) {
      const output = await readEntry(entry)
      if (!entry.name.endsWith('/')) result[entry.name] = output
    }
  }
  checkArchiveAbort(signal)
  return result
}
