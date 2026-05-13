/**
 * 给 JSON 响应套 gzip。base64 文本 + 重复 key 的 JSON 用 gzip 通常能省 20-40%。
 * 走 CompressionStream 而非 Bun.gzipSync，避免阻塞事件循环；浏览器/curl 默认带
 * Accept-Encoding: gzip，所以正常路径都能用。
 *
 * 缺省阈值 1KB：太小的响应压缩反而劣化（gzip header 开销）。
 */
const MIN_GZIP_BYTES = 1024

export function jsonResponse(body: unknown, request: Request, init: ResponseInit = {}): Response {
  const text = JSON.stringify(body)
  const acceptEnc = request.headers.get('accept-encoding') ?? ''
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  if (text.length < MIN_GZIP_BYTES || !acceptEnc.toLowerCase().includes('gzip')) {
    return new Response(text, { ...init, headers })
  }
  headers.set('content-encoding', 'gzip')
  // vary 让中间代理按 accept-encoding 拆缓存键，避免给不支持 gzip 的下游回压缩
  headers.set('vary', 'accept-encoding')
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream, { ...init, headers })
}
