// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { fitUploadImageFile, UPLOAD_COMPRESSION_THRESHOLD_BYTES } from '../../lib/fitUploadImage'
import { compressUploadFiles, prepareAcceptedImageFiles } from '../../lib/imageFiles'
import { useStore } from '../../store'

function image(name: string, size: number, type = 'image/png'): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function stubEncoder(bytes = 1024, type = 'image/jpeg') {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({
      width: 4000,
      height: 3000,
      close: vi.fn(),
    })),
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, mime) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: (mime as string) || type })
    callback(blob)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('does not flatten an oversized GIF into a still image', async () => {
  const bitmap = vi.fn()
  vi.stubGlobal('createImageBitmap', bitmap)
  const gif = image('anim.gif', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1, 'image/gif')
  await expect(fitUploadImageFile(gif)).resolves.toEqual({ file: gif, compressed: false })
  expect(bitmap).not.toHaveBeenCalled()
})

it('leaves an image at or under 50 MB untouched', async () => {
  const file = image('ok.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES)
  const bitmap = vi.fn()
  vi.stubGlobal('createImageBitmap', bitmap)
  await expect(fitUploadImageFile(file)).resolves.toEqual({ file, compressed: false })
  expect(bitmap).not.toHaveBeenCalled()
})

it('compresses one oversized image down to the upload limit and keeps a reasonable long edge first', async () => {
  stubEncoder()
  const huge = image('huge.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1)
  expect(huge.size).toBe(UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1)
  const fitted = await fitUploadImageFile(huge)
  expect(fitted.compressed).toBe(true)
  expect(fitted.file.size).toBeLessThanOrEqual(UPLOAD_COMPRESSION_THRESHOLD_BYTES)
  expect(fitted.file.type).toBe('image/jpeg')
  expect(fitted.file.name).toBe('huge.jpg')
  const draw = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results[0]?.value as {
    drawImage: ReturnType<typeof vi.fn>
  }
  expect(draw.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 4000, 3000)
})

it('keeps a transparent image as PNG when that already fits', async () => {
  stubEncoder(2048, 'image/png')
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
  } as unknown as CanvasRenderingContext2D)
  const huge = image('alpha.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 8)
  const fitted = await fitUploadImageFile(huge)
  expect(fitted.compressed).toBe(true)
  expect(fitted.file.type).toBe('image/png')
})

it('returns the original file when the image cannot be decoded, so the old error still applies', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      throw new Error('decode failed')
    }),
  )
  class BrokenImage {
    naturalWidth = 0
    naturalHeight = 0
    decode() {
      return Promise.reject(new Error('decode failed'))
    }
    set src(_value: string) {}
  }
  vi.stubGlobal('Image', BrokenImage)
  const huge = image('broken.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1)
  await expect(fitUploadImageFile(huge)).resolves.toEqual({ file: huge, compressed: false })
})

it('returns the original file when every encode is still over the target', async () => {
  stubEncoder(4096)
  const huge = image('still-big.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1)
  const fitted = await fitUploadImageFile(huge, 100)
  expect(fitted).toEqual({ file: huge, compressed: false })
})

it('toasts once for a batch and keeps a fitted file that acceptImageFiles used to drop', async () => {
  stubEncoder()
  useStore.setState({ showToast: vi.fn() })
  const huge = image('huge.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1)
  const ok = image('ok.png', 100)
  const accepted = await prepareAcceptedImageFiles([huge, ok, new File(['x'], 'a.txt')])
  expect(accepted.map((file) => file.name)).toEqual(['huge.jpg', 'ok.png'])
  expect(useStore.getState().showToast).toHaveBeenCalledTimes(2)
  expect(useStore.getState().showToast).toHaveBeenCalledWith('已压缩 1 张过大的图片', 'info')
  expect(useStore.getState().showToast).toHaveBeenCalledWith('已跳过 1 个非图片文件', 'error')
})

it('shares one compressor across the batch helper', async () => {
  stubEncoder()
  useStore.setState({ showToast: vi.fn() })
  const files = await compressUploadFiles([
    image('a.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 1),
    image('b.png', UPLOAD_COMPRESSION_THRESHOLD_BYTES + 2),
  ])
  expect(files.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg'])
  expect(useStore.getState().showToast).toHaveBeenCalledTimes(1)
  expect(useStore.getState().showToast).toHaveBeenCalledWith('已压缩 2 张过大的图片', 'info')
})
