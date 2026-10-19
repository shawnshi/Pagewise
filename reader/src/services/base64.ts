/** 分块 base64: 避免 `String.fromCharCode(...largeArray)` 的调用栈与内存峰值。 */
const BASE64_STEP = 0x8000

export function toBase64Chunk(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_STEP) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + BASE64_STEP, bytes.length)))
  }
  return btoa(binary)
}
