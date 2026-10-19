/**
 * 把 Blob 切成固定大小的块供 plugin-fs 流式写入。
 * 默认 Blob.stream() 的块约 64 KB，40 MB 文件会产生数百次 IPC。
 */
export const WRITE_CHUNK_BYTES = 2 * 1024 * 1024

export function blobChunks(blob: Blob, chunkSize = WRITE_CHUNK_BYTES): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError('Chunk size must be a positive integer')
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= blob.size) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, blob.size)
      controller.enqueue(new Uint8Array(await blob.slice(offset, end).arrayBuffer()))
      offset = end
    },
  })
}
