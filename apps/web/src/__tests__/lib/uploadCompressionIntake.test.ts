// @vitest-environment jsdom

import { expect, it, vi } from 'vitest'

const fitUploadImageFile = vi.hoisted(() =>
  vi.fn(async (file: File) => ({
    file:
      file.size > 50 * 1024 * 1024
        ? new File([new Uint8Array([1])], 'fitted.jpg', { type: 'image/jpeg' })
        : file,
    compressed: file.size > 50 * 1024 * 1024,
  })),
)

vi.mock('../../lib/fitUploadImage', () => ({
  fitUploadImageFile,
  UPLOAD_COMPRESSION_THRESHOLD_BYTES: 50 * 1024 * 1024,
}))

import { fileToDataUrl } from '../../features/canvas/lib/importImages'
import { compressUploadFiles, prepareAcceptedImageFiles } from '../../lib/imageFiles'
import { useStore } from '../../store'

it('canvas import, the batch helper, and the size gate all call the same fitter', async () => {
  useStore.setState({ showToast: vi.fn() })
  const huge = new File([new Uint8Array([9])], 'huge.png', { type: 'image/png' })
  Object.defineProperty(huge, 'size', { value: 60 * 1024 * 1024 })
  fitUploadImageFile.mockClear()

  const [fromBatch] = await compressUploadFiles([huge])
  const accepted = await prepareAcceptedImageFiles([huge])
  const dataUrl = await fileToDataUrl(huge)

  expect(fitUploadImageFile).toHaveBeenCalledTimes(3)
  expect(fromBatch?.type).toBe('image/jpeg')
  expect(accepted.map((file) => file.type)).toEqual(['image/jpeg'])
  expect(dataUrl.startsWith('data:image/jpeg')).toBe(true)
  expect(useStore.getState().showToast).toHaveBeenCalledWith('已压缩 1 张过大的图片', 'info')
})
