import { unzlibSync } from 'fflate'
import { expect } from 'vitest'

/** 解读本项目编码的 RGBA PNG，让测试观察真实像素而不是编码器调用。 */
export function decodeRgbaPng(dataUrl: string): {
  data: Uint8Array
  width: number
  height: number
} {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      expect(body[8]).toBe(8)
      expect(body[9]).toBe(6)
    }
    if (type === 'IDAT') idat.push(body)
    offset += 12 + length
  }
  const merged = new Uint8Array(idat.reduce((total, part) => total + part.length, 0))
  let cursor = 0
  for (const part of idat) {
    merged.set(part, cursor)
    cursor += part.length
  }
  const raw = unzlibSync(merged)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    expect(raw[rowStart]).toBe(0)
    data.set(raw.subarray(rowStart + 1, rowStart + 1 + width * 4), y * width * 4)
  }
  return { data, width, height }
}
