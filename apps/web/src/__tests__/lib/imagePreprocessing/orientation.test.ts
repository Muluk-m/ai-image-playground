import { describe, expect, it } from 'vitest'
import { jpegOrientation } from '../../../lib/imagePreprocessing/orientation'

/** 拼一张只有 SOI、可选 APP0、APP1(EXIF) 与 SOS 头的 JPEG，方向写在 IFD0 的第二项。 */
function jpeg(orientation: number | null, little: boolean, withApp0 = false): ArrayBuffer {
  const parts: number[] = [0xff, 0xd8]
  if (withApp0) parts.push(0xff, 0xe0, 0x00, 0x07, 0x4a, 0x46, 0x49, 0x46, 0x00)
  if (orientation !== null) {
    const tiff = new DataView(new ArrayBuffer(8 + 2 + 24 + 4))
    tiff.setUint16(0, little ? 0x4949 : 0x4d4d)
    tiff.setUint16(2, 42, little)
    tiff.setUint32(4, 8, little)
    tiff.setUint16(8, 2, little)
    // 第一项：ImageWidth，不是方向。
    tiff.setUint16(10, 0x0100, little)
    tiff.setUint16(12, 3, little)
    tiff.setUint32(14, 1, little)
    tiff.setUint16(18, 640, little)
    tiff.setUint16(22, 0x0112, little)
    tiff.setUint16(24, 3, little)
    tiff.setUint32(26, 1, little)
    tiff.setUint16(30, orientation, little)
    const body = [...'Exif\0\0']
      .map((c) => c.charCodeAt(0))
      .concat([...new Uint8Array(tiff.buffer)])
    const length = body.length + 2
    parts.push(0xff, 0xe1, length >> 8, length & 0xff, ...body)
  }
  parts.push(0xff, 0xda, 0x00, 0x02, 0xff, 0xd9)
  return new Uint8Array(parts).buffer
}

describe('JPEG EXIF 方向', () => {
  it('读出 Intel 与 Motorola 字节序里的方向', () => {
    expect(jpegOrientation(jpeg(6, true))).toBe(6)
    expect(jpegOrientation(jpeg(8, false))).toBe(8)
    expect(jpegOrientation(jpeg(3, false, true))).toBe(3)
  })

  it('正向、没有 EXIF、非法值和不是 JPEG 的都按 1', () => {
    expect(jpegOrientation(jpeg(1, true))).toBe(1)
    expect(jpegOrientation(jpeg(null, true, true))).toBe(1)
    expect(jpegOrientation(jpeg(42, true))).toBe(1)
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBe(1)
    // 截断的 APP1 不越界。
    expect(jpegOrientation(jpeg(6, true).slice(0, 20))).toBe(1)
  })
})
