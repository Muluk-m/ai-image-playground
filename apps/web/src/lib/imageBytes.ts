/**
 * 这段字节到底是什么图，按文件头判，不看谁在旁边写了什么。
 *
 * 画布上的原图是 data URL，那行 `data:image/png` 只是写上去的一句话：产出它的那条路
 * 换过编码、复制粘贴串过标签，里头装的可能是 WebP。上云时申报的类型要与字节一致，
 * 否则服务端解出来的格式对不上申报，确认那一步整张打回（422 `media_invalid_image`）。
 *
 * 只认云媒体收的这三种；认不出的交回 undefined，由调用方决定退回什么。
 */
export function imageMimeFromBytes(bytes: ArrayBuffer): string | undefined {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16))
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg'
  // WebP 是 RIFF 容器：`RIFF` + 4 字节长度 + `WEBP`。
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return 'image/webp'
  return undefined
}

const PNG_IEND_WINDOW = 1024
const JPEG_EOI_WINDOW = 64 * 1024

/** base64 末尾 `bytes` 字节（对齐到 4 字符分组）、以及总字节数；只解码尾部，不碰整串。 */
function base64Tail(base64: string, bytes: number): { tail: Uint8Array; total: number } | null {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if (base64.length % 4 !== 0) return null
  const total = (base64.length / 4) * 3 - padding
  const start = Math.max(0, Math.floor((base64.length - Math.ceil(bytes / 3) * 4) / 4) * 4)
  const raw = atob(base64.slice(start))
  const tail = Uint8Array.from(raw, (c) => c.charCodeAt(0))
  return { tail, total }
}

/**
 * 文件头完整但正文被截断吗？浏览器对截断的 PNG / JPEG 会部分解码并照常触发 onload，
 * 光靠「能解码」放不住。这里只看容器结构是否收尾，不解像素：
 * - PNG：结尾附近要有 IEND 块；
 * - JPEG：结尾附近要有 EOI（FFD9），窗口放宽到 64 KiB 以容纳 MPF 等尾随数据；
 * - WebP：RIFF 声明的长度不能超过实际字节数。
 * 认不出格式、不是 base64 data URL 或解析异常时一律当作完整，不误拦。
 */
export function isImageTruncated(dataUrl: string): boolean {
  try {
    const comma = dataUrl.indexOf(',')
    if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return false
    const base64 = dataUrl.slice(comma + 1)
    const head = Uint8Array.from(atob(base64.slice(0, 24)), (c) => c.charCodeAt(0))
    const mime = imageMimeFromBytes(head.buffer)
    if (mime === 'image/webp') {
      const declared = new DataView(head.buffer).getUint32(4, true) + 8
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
      return (base64.length / 4) * 3 - padding < declared
    }
    if (mime === 'image/png') {
      const found = base64Tail(base64, PNG_IEND_WINDOW)
      if (!found) return false
      const { tail } = found
      for (let i = tail.length - 8; i >= 0; i -= 1) {
        if (tail[i] === 0x49 && tail[i + 1] === 0x45 && tail[i + 2] === 0x4e && tail[i + 3] === 0x44)
          return false
      }
      return true
    }
    if (mime === 'image/jpeg') {
      const found = base64Tail(base64, JPEG_EOI_WINDOW)
      if (!found) return false
      const { tail } = found
      for (let i = tail.length - 2; i >= 0; i -= 1) {
        if (tail[i] === 0xff && tail[i + 1] === 0xd9) return false
      }
      return true
    }
  } catch {
    return false
  }
  return false
}
