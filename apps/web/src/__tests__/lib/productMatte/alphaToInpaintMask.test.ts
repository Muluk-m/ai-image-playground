import { unzlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  alphaToInpaintMask,
  alphaToMaskPixels,
  alphaToProductMask,
  alphaToProductMaskPixels,
} from '../../../lib/productMatte/alphaToInpaintMask'
import type { ProductAlpha } from '../../../lib/productMatte/types'

function matte(
  width: number,
  height: number,
  fill: (x: number, y: number) => number,
): ProductAlpha {
  const alpha = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) alpha[y * width + x] = fill(x, y)
  }
  return { alpha, width, height }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 逆着编码器解回像素，证明产出的确是一张可读的 RGBA PNG。 */
function decodeRgbaPng(bytes: Uint8Array): { data: Uint8Array; width: number; height: number } {
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

describe('alphaToMaskPixels', () => {
  it('产品不透明保留、其余透明重绘', () => {
    const pixels = alphaToMaskPixels(
      matte(4, 4, (x) => (x < 2 ? 255 : 0)),
      { feather: 0 },
    )

    expect(pixels.width).toBe(4)
    expect(pixels.height).toBe(4)
    expect(pixels.data[3]).toBe(255)
    expect(pixels.data[2 * 4 + 3]).toBe(0)
  })

  it('遮罩 RGB 恒为白，只有 alpha 承载语义', () => {
    const pixels = alphaToMaskPixels(
      matte(2, 2, () => 0),
      { feather: 0 },
    )

    for (let i = 0; i < pixels.data.length; i += 4) {
      expect([pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]]).toEqual([255, 255, 255])
    }
  })

  it('阈值把中间灰推向两端', () => {
    const pixels = alphaToMaskPixels(
      matte(2, 1, (x) => (x === 0 ? 100 : 200)),
      {
        feather: 0,
        threshold: 0.6,
      },
    )

    expect(pixels.data[3]).toBe(0)
    expect(pixels.data[7]).toBe(255)
  })

  it('羽化让边界出现中间 alpha，内部与外部仍是纯值', () => {
    const pixels = alphaToMaskPixels(
      matte(16, 1, (x) => (x < 8 ? 255 : 0)),
      { feather: 2 },
    )
    const alphaAt = (x: number) => pixels.data[x * 4 + 3]

    expect(alphaAt(0)).toBe(255)
    expect(alphaAt(15)).toBe(0)
    expect(alphaAt(8)).toBeGreaterThan(0)
    expect(alphaAt(8)).toBeLessThan(255)
  })

  it('羽化不改变尺寸', () => {
    const pixels = alphaToMaskPixels(
      matte(5, 3, () => 255),
      { feather: 3 },
    )

    expect(pixels.width).toBe(5)
    expect(pixels.height).toBe(3)
    expect(pixels.data.length).toBe(5 * 3 * 4)
  })
})

describe('alphaToProductMaskPixels', () => {
  it('产品透明重绘、背景不透明保留，与换背景的遮罩正好相反', () => {
    const product = matte(4, 4, (x) => (x < 2 ? 255 : 0))
    const pixels = alphaToProductMaskPixels(product, { feather: 0, grow: 0 })
    const background = alphaToMaskPixels(product, { feather: 0 })

    expect(pixels.width).toBe(4)
    expect(pixels.height).toBe(4)
    expect(pixels.data[3]).toBe(0)
    expect(pixels.data[2 * 4 + 3]).toBe(255)
    for (let i = 3; i < pixels.data.length; i += 4) {
      expect(pixels.data[i]).toBe(255 - background.data[i])
    }
  })

  it('遮罩 RGB 恒为白，只有 alpha 承载语义', () => {
    const pixels = alphaToProductMaskPixels(
      matte(2, 2, () => 255),
      { feather: 0, grow: 0 },
    )

    for (let i = 0; i < pixels.data.length; i += 4) {
      expect([pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]]).toEqual([255, 255, 255])
    }
  })

  /** 边缘与阴影接地要一起重画，重绘区必须盖过产品轮廓一圈。 */
  it('外扩把重绘区推到产品轮廓之外', () => {
    const product = matte(16, 1, (x) => (x < 8 ? 255 : 0))
    const alphaAt = (pixels: { data: Uint8ClampedArray }, x: number) => pixels.data[x * 4 + 3]

    const tight = alphaToProductMaskPixels(product, { feather: 0, grow: 0 })
    const grown = alphaToProductMaskPixels(product, { feather: 0, grow: 3 })

    expect(alphaAt(tight, 8)).toBe(255)
    expect(alphaAt(grown, 8)).toBe(0)
    expect(alphaAt(grown, 10)).toBe(0)
    expect(alphaAt(grown, 15)).toBe(255)
  })

  it('外扩与羽化都不改变尺寸', () => {
    const pixels = alphaToProductMaskPixels(matte(5, 3, (x) => (x < 2 ? 255 : 0)))

    expect(pixels.width).toBe(5)
    expect(pixels.height).toBe(3)
    expect(pixels.data.length).toBe(5 * 3 * 4)
  })
})

describe('alphaToProductMask', () => {
  it('产出与原图同尺寸的 PNG data URL', () => {
    const dataUrl = alphaToProductMask(
      matte(6, 4, (x) => (x < 3 ? 255 : 0)),
      { feather: 0, grow: 0 },
    )
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)

    const decoded = decodeRgbaPng(dataUrlToBytes(dataUrl))
    expect(decoded.width).toBe(6)
    expect(decoded.height).toBe(4)
    expect(decoded.data[3]).toBe(0)
    expect(decoded.data[3 * 4 + 3]).toBe(255)
  })
})

describe('alphaToInpaintMask', () => {
  it('产出与原图同尺寸的 PNG data URL', () => {
    const dataUrl = alphaToInpaintMask(
      matte(6, 4, (x) => (x < 3 ? 255 : 0)),
      { feather: 0 },
    )
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)

    const decoded = decodeRgbaPng(dataUrlToBytes(dataUrl))
    expect(decoded.width).toBe(6)
    expect(decoded.height).toBe(4)
    expect(decoded.data[3]).toBe(255)
    expect(decoded.data[3 * 4 + 3]).toBe(0)
  })
})
