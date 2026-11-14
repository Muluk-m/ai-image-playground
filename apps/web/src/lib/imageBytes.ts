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

function decodeBase64(base64: string): Uint8Array {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** 沿 chunk 的长度字段跳到 IEND（不解像素、不校验 CRC）；走到数据尽头还没遇到 IEND 就是截断。 */
function pngEndsCleanly(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  while (pos + 12 <= bytes.length) {
    const length = view.getUint32(pos)
    const isEnd =
      bytes[pos + 4] === 0x49 &&
      bytes[pos + 5] === 0x45 &&
      bytes[pos + 6] === 0x4e &&
      bytes[pos + 7] === 0x44
    if (isEnd) return true
    pos += 12 + length
  }
  return false
}

/**
 * 沿 JPEG marker 走到 EOI（FFD9），熵编码段内扫描到下一个真正的 marker（跳过 FF00 与 RSTn）。
 * 只有「一路合法地走到数据尽头仍没见到 EOI」才算截断；结构本身对不上（非标准写法）时当作无法判断、放行。
 */
function jpegEndsCleanly(bytes: Uint8Array): boolean {
  const n = bytes.length
  let pos = 2
  while (pos < n) {
    if (bytes[pos] !== 0xff) return true
    while (pos < n && bytes[pos] === 0xff) pos += 1
    if (pos >= n) return false
    const marker = bytes[pos] as number
    pos += 1
    if (marker === 0xd9) return true
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (pos + 2 > n) return false
    pos += ((bytes[pos] as number) << 8) | (bytes[pos + 1] as number)
    if (marker === 0xda) {
      // 熵编码数据：直到下一个不是 FF00 / RSTn 的 marker。
      while (pos < n) {
        if (bytes[pos] === 0xff) {
          const next = bytes[pos + 1]
          if (next === undefined) return false
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break
          pos += 2
        } else pos += 1
      }
    }
  }
  return false
}

/**
 * 文件头完整但正文被截断吗？浏览器对截断的 PNG / JPEG 会部分解码并照常触发 onload，
 * 光靠「能解码」放不住。这里按容器结构判断是否收尾，不解像素：
 * - PNG：沿 chunk 长度走到 IEND；
 * - JPEG：沿 marker 走到 EOI，EOI 之后的尾随数据不影响；
 * - WebP：RIFF 声明的长度不能超过实际字节数。
 * 认不出格式、不是 base64 data URL 或解析异常时一律当作完整，不误拦。
 */
export function isImageTruncated(dataUrl: string): boolean {
  try {
    const comma = dataUrl.indexOf(',')
    if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return false
    const bytes = decodeBase64(dataUrl.slice(comma + 1))
    const mime = imageMimeFromBytes(bytes.buffer as ArrayBuffer)
    if (mime === 'image/png') return !pngEndsCleanly(bytes)
    if (mime === 'image/jpeg') return !jpegEndsCleanly(bytes)
    if (mime === 'image/webp') {
      return new DataView(bytes.buffer).getUint32(4, true) + 8 > bytes.length
    }
  } catch {
    return false
  }
  return false
}
