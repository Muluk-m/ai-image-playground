export interface ImageSize {
  width: number
  height: number
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function size(width: number, height: number): ImageSize | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  return size(u32be(bytes, 16), u32be(bytes, 20))
}

function gifSize(bytes: Uint8Array): ImageSize | null {
  const header = ascii(bytes, 0, 6)
  if (bytes.length < 10 || (header !== 'GIF87a' && header !== 'GIF89a')) return null
  return size(u16le(bytes, 6), u16le(bytes, 8))
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset] ?? 0
    offset += 1
    if (marker === 0xd8 || marker === 0xd9) continue
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 1 >= bytes.length) return null
    const length = u16be(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return null
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame) return size(u16be(bytes, offset + 5), u16be(bytes, offset + 3))
    offset += length
  }
  return null
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null
  }
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1)
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && ascii(bytes, 23, 3) === '\u009d\u0001\u002a') {
    return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff)
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = u32le(bytes, 21)
    return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  return null
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  )
}

/** 从 PNG / GIF / JPEG / WEBP 文件头读像素宽高。认不出就返回 null。 */
export function imageDimensions(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes)
}
