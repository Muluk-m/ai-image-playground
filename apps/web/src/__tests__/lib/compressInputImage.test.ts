// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { compressInputImageDataUrls } from '../../lib/compressInputImage'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='
const PNG_URL = `data:image/png;base64,${PNG_BASE64}`

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('compresses a multi-megabyte reference without overflowing the signature check', async () => {
  const largePng = `data:image/png;base64,${PNG_BASE64.slice(0, 32)}${'A'.repeat(8 * 1024 * 1024)}`
  class LoadedImage {
    naturalWidth = 4096
    naturalHeight = 4096
    onload: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', LoadedImage)
  const draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  } as unknown as CanvasRenderingContext2D)
  const compressed = 'data:image/jpeg;base64,/9j/'
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(compressed)

  await expect(compressInputImageDataUrls([largePng])).resolves.toEqual([compressed])
  expect(draw).toHaveBeenCalledWith(expect.any(LoadedImage), 0, 0, 2048, 2048)
})

it('reencodes a mislabeled image and keeps transparent pixels', async () => {
  class LoadedImage {
    naturalWidth = 1
    naturalHeight = 1
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', LoadedImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
  } as unknown as CanvasRenderingContext2D)
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockImplementation((type) => (type === 'image/png' ? PNG_URL : 'data:image/jpeg;base64,/9j/'))

  const mislabeled = `data:image/jpeg;base64,${PNG_BASE64}`
  expect(await compressInputImageDataUrls([mislabeled])).toEqual([PNG_URL])
  expect(encode).toHaveBeenCalledWith('image/png')
})

it('leaves cloud media identities for the server to compress', async () => {
  const media = 'aip-media:6f1c2c55-0a43-4c1b-9d4f-2f3e9c1d7a10'
  expect(await compressInputImageDataUrls([media, PNG_URL])).toEqual([media, PNG_URL])
})
