import { imageMimeFromBytes } from '../imageBytes'
import { IMAGE_PREPROCESSING } from './policy'

/** Read dimensions before any decoder can allocate a full bitmap. Never trust a MIME label. */
export function inspectImage(bytes: ArrayBuffer) {
  const type = imageMimeFromBytes(bytes)
  if (!type) throw new Error('media_unsupported_image')
  const view = new DataView(bytes)
  const b = new Uint8Array(bytes)
  let width = 0
  let height = 0
  const tag = (at: number) => String.fromCharCode(...b.subarray(at, at + 4))
  try {
    if (type === 'image/png') {
      if (tag(12) !== 'IHDR' || view.getUint32(8) !== 13 || tag(bytes.byteLength - 8) !== 'IEND')
        throw new Error()
      width = view.getUint32(16)
      height = view.getUint32(20)
      for (let p = 8; p + 12 <= b.length; ) {
        const length = view.getUint32(p)
        if (p + length + 12 > b.length) throw new Error()
        if (tag(p + 4) === 'acTL') throw new Error('attachment_animated_image')
        p += length + 12
      }
    } else if (type === 'image/jpeg') {
      if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) throw new Error()
      let p = 2
      while (p < b.length) {
        if (b[p++] !== 0xff) throw new Error()
        while (b[p] === 0xff) p++
        const marker = b[p++]!
        if (marker === 0xda || marker === 0xd9) break
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
        const length = view.getUint16(p)
        if (length < 2 || p + length > b.length) throw new Error()
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          if (length < 8) throw new Error()
          height = view.getUint16(p + 3)
          width = view.getUint16(p + 5)
          break
        }
        p += length
      }
    } else {
      if (view.getUint32(4, true) + 8 !== b.length) throw new Error()
      for (let p = 12; p + 8 <= b.length; ) {
        const length = view.getUint32(p + 4, true)
        const start = p + 8
        if (start + length > b.length) throw new Error()
        const chunk = tag(p)
        if (chunk === 'ANIM' || (chunk === 'VP8X' && b[start]! & 2))
          throw new Error('attachment_animated_image')
        if (chunk === 'VP8X' && length >= 10) {
          width = 1 + b[start + 4]! + (b[start + 5]! << 8) + (b[start + 6]! << 16)
          height = 1 + b[start + 7]! + (b[start + 8]! << 8) + (b[start + 9]! << 16)
        } else if (chunk === 'VP8 ' && length >= 10 && !width) {
          if (b[start + 3] !== 0x9d || b[start + 4] !== 1 || b[start + 5] !== 0x2a)
            throw new Error()
          width = view.getUint16(start + 6, true) & 0x3fff
          height = view.getUint16(start + 8, true) & 0x3fff
        } else if (chunk === 'VP8L' && length >= 5 && !width) {
          if (b[start] !== 0x2f) throw new Error()
          const bits = view.getUint32(start + 1, true)
          width = (bits & 0x3fff) + 1
          height = ((bits >>> 14) & 0x3fff) + 1
        }
        p = start + length + (length % 2)
      }
    }
    if (!width || !height) throw new Error()
  } catch (error) {
    if (error instanceof Error && error.message === 'attachment_animated_image') throw error
    throw new Error('media_invalid_image')
  }
  if (
    width * height > IMAGE_PREPROCESSING.maxDecodePixels ||
    Math.max(width, height) > IMAGE_PREPROCESSING.maxDecodeSide
  )
    throw new Error('attachment_decode_limit')
  return { contentType: type, width, height }
}
