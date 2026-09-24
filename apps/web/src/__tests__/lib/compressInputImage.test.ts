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
