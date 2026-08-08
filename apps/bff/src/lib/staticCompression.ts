/**
 * Bun 1.2 没有浏览器的 CompressionStream 全局对象。静态文件使用 Bun 原生 gzip，
 * 避免 Accept-Encoding: gzip 请求被 ReferenceError 文本替代。
 */
export async function gzipBlob(blob: Blob): Promise<ArrayBuffer> {
  const compressed = Bun.gzipSync(new Uint8Array(await blob.arrayBuffer()))
  const output = new ArrayBuffer(compressed.byteLength)
  new Uint8Array(output).set(compressed)
  return output
}
