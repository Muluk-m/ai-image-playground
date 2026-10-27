// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadImages } from '../../../../features/toolbox/lib/deliver'
import { rotateImage } from '../../../../features/toolbox/lib/rotation'
import { useToolboxStore } from '../../../../features/toolbox/store'
import RotateTool from '../../../../features/toolbox/tools/rotate'
import { stubPointerApis } from '../../../helpers/radix'

vi.mock('../../../../features/toolbox/lib/deliver', () => ({
  downloadImages: vi.fn(),
  sendImagesToComposer: vi.fn(),
}))
vi.mock('../../../../features/toolbox/lib/rotation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../features/toolbox/lib/rotation')>()),
  renderRotation: vi.fn(() => document.createElement('canvas')),
  rotateImage: vi.fn(async () => ({
    blob: new Blob(['lossless'], { type: 'image/png' }),
    type: 'image/png',
    width: 8,
    height: 16,
    fellBack: false,
  })),
}))

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.clearAllMocks()
  stubPointerApis()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 16, height: 8, close: vi.fn() })),
  )
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ drawImage: vi.fn() }),
  })
  await useToolboxStore
    .getState()
    .add([
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
    ])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<RotateTool />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useToolboxStore.getState().clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent === label || element.getAttribute('aria-label') === label,
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function click(label: string) {
  await act(async () => button(label).click())
}
async function finish() {
  await act(async () => vi.advanceTimersByTimeAsync(300))
}
it('starts unchanged, shows original and adjusted previews, and exports PNG without compression metrics', async () => {
  expect(host.querySelector('img[alt="原图"]')).not.toBeNull()
  expect(host.querySelector('canvas[aria-label="调整后"]')).not.toBeNull()
  expect(host.textContent).not.toMatch(/KB|MB|%/)
  await finish()
  expect(rotateImage).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'one.jpg' }), {
    angle: 0,
    flipH: false,
    flipV: false,
    expand: true,
  })
  await click('导出图片')
  expect(downloadImages).toHaveBeenCalledWith(
    [{ name: 'one.png', blob: expect.objectContaining({ type: 'image/png' }) }],
    expect.any(String),
  )
})
it('blocks stale export while adjusting, remembers each image, and resets to the original', async () => {
  await finish()
  await click('右转 90°')
  await click('水平')
  expect(button('导出图片').disabled).toBe(true)
  await finish()
  expect(rotateImage).toHaveBeenLastCalledWith(expect.anything(), {
    angle: 90,
    flipH: true,
    flipV: false,
    expand: true,
  })
  await click('two.jpg')
  expect(button('水平').getAttribute('aria-pressed')).toBe('false')
  await click('one.jpg')
  expect(button('水平').getAttribute('aria-pressed')).toBe('true')
  await click('重置调整')
  await finish()
  expect(rotateImage).toHaveBeenLastCalledWith(expect.anything(), {
    angle: 0,
    flipH: false,
    flipV: false,
    expand: true,
  })
  await click('清空全部')
  expect(host.querySelector('canvas')).toBeNull()
  expect(host.textContent).toContain('选择图片')
})
it('combines fine angle changes, vertical mirror, and a fixed output frame', async () => {
  await click('+0.1°')
  await click('+0.1°')
  await click('垂直')
  const label = [...host.querySelectorAll('label')].find((el) => el.textContent === '保留完整画面')
  if (!label) throw new Error('Missing frame checkbox')
  const checkbox = document.getElementById(label.htmlFor)
  if (!checkbox) throw new Error('Missing frame control')
  await act(async () => checkbox.click())
  await finish()
  expect(rotateImage).toHaveBeenLastCalledWith(expect.anything(), {
    angle: 0.2,
    flipH: false,
    flipV: true,
    expand: false,
  })
})
