import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectImage } from '../../lib/imagePreprocessing/header'
import { IMAGE_PREPROCESSING, preparedDimensions } from '../../lib/imagePreprocessing/policy'
import { prepareImage } from '../../lib/imagePreprocessing/prepare'

function png(width = 3000, height = 2700, size = 1200000) {
  const bytes = new Uint8Array(size)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  view.setUint32(33, size - 57)
  bytes.set([73, 68, 65, 84], 37)
  bytes.set([73, 69, 78, 68], size - 8)
  return bytes.buffer
}
const limits = { maxBytes: IMAGE_PREPROCESSING.maxBytes, maxPixels: IMAGE_PREPROCESSING.maxPixels }
afterEach(() => vi.unstubAllGlobals())

describe('image admission before decoding', () => {
  it('reads PNG, JPEG and WebP dimensions from bytes, independently of labels', () => {
    expect(inspectImage(png())).toMatchObject({
      width: 3000,
      height: 2700,
      contentType: 'image/png',
    })
    const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 8, 8, 0, 100, 0, 200, 1, 255, 217]).buffer
    expect(inspectImage(jpeg)).toMatchObject({ width: 200, height: 100 })
    const webp = new Uint8Array(30)
    webp.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0])
    webp[24] = 199
    webp[27] = 99
    expect(inspectImage(webp.buffer)).toMatchObject({ width: 200, height: 100 })
  })
  it('blocks huge bitmaps, corrupt containers and animations before invoking a decoder', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    await expect(prepareImage(png(32768, 32768), limits)).rejects.toThrow('attachment_decode_limit')
    await expect(prepareImage(png().slice(0, 50), limits)).rejects.toThrow('media_invalid_image')
    const animated = png()
    new Uint8Array(animated).set([97, 99, 84, 76], 37)
    await expect(prepareImage(animated, limits)).rejects.toThrow('attachment_animated_image')
    expect(decode).not.toHaveBeenCalled()
  })
  it('keeps thin images within a strict area cap even when the short side is pinned to one pixel', () => {
    expect(preparedDimensions(32768, 1, { ...limits, maxPixels: 1024 })).toEqual({
      width: 1024,
      height: 1,
    })
    expect(preparedDimensions(1, 32768, { ...limits, maxPixels: 1024 })).toEqual({
      width: 1,
      height: 1024,
    })
  })
  it('fits area and side budgets without upscaling or distorting the aspect ratio', () => {
    expect(preparedDimensions(3000, 2700, limits)).toEqual({ width: 2048, height: 1843 })
    expect(preparedDimensions(100, 80, limits)).toEqual({ width: 100, height: 80 })
    const fit = preparedDimensions(4000, 3000, { ...limits, maxPixels: 1000000 })
    expect(fit.width * fit.height).toBeLessThanOrEqual(1000000)
    expect(fit.width / fit.height).toBeCloseTo(4 / 3, 2)
  })
})

function codec(
  options: {
    alpha?: boolean
    width?: number
    height?: number
    encode?: (type: string, width: number, quality?: number) => number
  } = {},
) {
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', async () => ({
    width: options.width ?? 3000,
    height: options.height ?? 2700,
    close,
  }))
  const encoded: { type: string; quality?: number; width: number }[] = []
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage() {},
          getImageData: () => ({ data: new Uint8Array([1, 2, 3, options.alpha ? 0 : 255]) }),
        }
      }
      async convertToBlob({ type, quality }: { type: string; quality?: number }) {
        encoded.push({ type, quality, width: this.width })
        return new Blob(
          [
            new Uint8Array(
              options.encode?.(type, this.width, quality) ??
                (type === 'image/png' ? 800000 : 200000),
            ),
          ],
          { type },
        )
      }
    },
  )
  return { close, encoded }
}
it('compresses the reported 3000×2700 image and releases its decoded bitmap', async () => {
  const { close } = codec()
  const output = await prepareImage(png(), limits)
  expect(output).toMatchObject({
    width: 2048,
    height: 1843,
    contentType: 'image/jpeg',
    originalBytes: 1200000,
  })
  expect(output.data.byteLength).toBe(200000)
  expect(close).toHaveBeenCalled()
})
it('preserves transparency and uses oriented dimensions', async () => {
  const { encoded } = codec({ alpha: true, width: 2700, height: 3000 })
  const output = await prepareImage(png(), limits)
  expect(output).toMatchObject({ width: 1843, height: 2048, contentType: 'image/webp' })
  expect(encoded.every((item) => item.type !== 'image/jpeg')).toBe(true)
})
it('tries quality steps before reducing dimensions when the output cannot fit', async () => {
  const { encoded } = codec({
    encode: (_type, width, quality) =>
      width > 1600 ? 3000000 : quality === 0.9 ? 2500000 : 1000000,
  })
  const output = await prepareImage(png(), limits)
  expect(output.width).toBe(1536)
  expect(output.data.byteLength).toBeLessThanOrEqual(limits.maxBytes)
  expect(
    encoded
      .filter((item) => item.width === 2048 && item.type === 'image/jpeg')
      .map((item) => item.quality),
  ).toEqual([0.9, 0.82, 0.74])
})
it('does not inflate a small validated original', async () => {
  codec({ width: 100, height: 80 })
  const input = png(100, 80, 200)
  const output = await prepareImage(input, limits)
  expect(output.data).toBe(input)
  expect(output.contentType).toBe('image/png')
})
it('fails explicitly when no encoder can meet the budget; never returns the original', async () => {
  codec({ encode: () => 3000000 })
  await expect(prepareImage(png(), limits)).rejects.toThrow('attachment_compression_failed')
})
it('never hides decode errors behind an original-image fallback', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      throw new Error('bad image')
    }),
  )
  await expect(prepareImage(png(), limits)).rejects.toThrow('media_invalid_image')
})
