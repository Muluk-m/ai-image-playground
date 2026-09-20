// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { acceptImageFiles } from '../../lib/imageFiles'
import { MAX_IMAGE_BYTES } from '../../lib/inputImageLimit'
import { useStore } from '../../store'

function image(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

beforeEach(() => {
  useStore.setState({ showToast: vi.fn() })
})

it('太大的图在进输入框之前就拦下来，其余照收', () => {
  const ok = image('ok.png', MAX_IMAGE_BYTES)
  const huge = image('huge.png', MAX_IMAGE_BYTES + 1)

  expect(acceptImageFiles([ok, huge])).toEqual([ok])
  expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.any(String), 'error')
})

it('非图片与超大图各提示一次', () => {
  const text = new File(['x'], 'a.txt', { type: 'text/plain' })

  expect(acceptImageFiles([text, image('huge.png', MAX_IMAGE_BYTES + 1)])).toEqual([])
  expect(useStore.getState().showToast).toHaveBeenCalledTimes(2)
})
