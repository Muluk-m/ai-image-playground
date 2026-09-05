import { zlibSync } from 'fflate'
import type { MaskPixels } from './types'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const BASE64_CHUNK = 0x8000

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)))
  return out
}

/** 每行前置一个 filter 字节（0 = None），PNG 的 IDAT 就是这样一条 zlib 流。 */
function toScanlines(pixels: MaskPixels): Uint8Array {
  const stride = pixels.width * 4
  const raw = new Uint8Array((stride + 1) * pixels.height)
  for (let y = 0; y < pixels.height; y++) {
    raw.set(pixels.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return raw
}

export function encodeRgbaPng(pixels: MaskPixels): Uint8Array {
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, pixels.width)
  headerView.setUint32(4, pixels.height)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: truecolour with alpha

  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(toScanlines(pixels))),
    chunk('IEND', new Uint8Array(0)),
  ]

  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

export function toPngDataUrl(png: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < png.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...png.subarray(i, i + BASE64_CHUNK))
  }
  return `data:image/png;base64,${btoa(binary)}`
}
