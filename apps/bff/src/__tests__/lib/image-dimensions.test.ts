import { describe, expect, it } from 'bun:test'
import { imageDimensions } from '../../lib/image-dimensions'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
  bytes.set([73, 72, 68, 82], 12)
  bytes[16] = (width >>> 24) & 0xff
  bytes[17] = (width >>> 16) & 0xff
  bytes[18] = (width >>> 8) & 0xff
  bytes[19] = width & 0xff
  bytes[20] = (height >>> 24) & 0xff
  bytes[21] = (height >>> 16) & 0xff
  bytes[22] = (height >>> 8) & 0xff
  bytes[23] = height & 0xff
  return bytes
}

describe('imageDimensions', () => {
  it('reads png, gif, jpeg and webp headers', () => {
    expect(imageDimensions(png(800, 1200))).toEqual({ width: 800, height: 1200 })

    const gif = new Uint8Array(10)
    gif.set([71, 73, 70, 56, 57, 97, 0x2c, 0x01, 0x90, 0x01])
    expect(imageDimensions(gif)).toEqual({ width: 300, height: 400 })

    const jpeg = new Uint8Array(21)
    jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x06, 0x40])
    expect(imageDimensions(jpeg)).toEqual({ width: 1600, height: 1200 })

    const webp = new Uint8Array(30)
    webp.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88])
    webp[24] = 0x1f
    webp[25] = 0x03
    webp[27] = 0x57
    webp[28] = 0x02
    expect(imageDimensions(webp)).toEqual({ width: 800, height: 600 })
  })

  it('returns null for an unknown payload', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})
