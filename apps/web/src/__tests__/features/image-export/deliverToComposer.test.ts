// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverResizedToComposer } from '../../../features/image-export/deliverToComposer'

const attachInputImages = vi.fn(() => true)
const setAppMode = vi.fn()
const showToast = vi.fn()
const storeImageFromFile = vi.fn()

vi.mock('../../../lib/apiProfiles', () => ({
  getActiveApiProfile: () => ({ id: 'default' }),
}))
vi.mock('../../../lib/referenceDraft', () => ({
  referenceAdmission: () => ({ maxImages: 10 }),
  referenceTally: () => ({ total: 0 }),
  referenceRefusal: () => null,
  referenceRefusalMessage: () => '',
}))
vi.mock('../../../store', () => ({
  storeImageFromFile: (...args: unknown[]) => storeImageFromFile(...args),
  useStore: {
    getState: () => ({
      inputImages: [],
      settings: {},
      attachInputImages,
      setAppMode,
      showToast,
    }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('deliverResizedToComposer', () => {
  it('stops without attaching images or switching mode when aborted mid-store', async () => {
    const controller = new AbortController()
    let resolveStore!: (value: { id: string }) => void
    storeImageFromFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStore = resolve
        }),
    )

    const task = deliverResizedToComposer(
      [{ name: 'one.png', blob: new Blob(['a'], { type: 'image/png' }) }],
      controller.signal,
    )
    await Promise.resolve()
    controller.abort()
    resolveStore({ id: 'stored-1' })

    await expect(task).rejects.toThrow()
    expect(attachInputImages).not.toHaveBeenCalled()
    expect(setAppMode).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('attaches images and switches to image mode when not aborted', async () => {
    const controller = new AbortController()
    storeImageFromFile.mockResolvedValueOnce({ id: 'stored-1' })

    await deliverResizedToComposer(
      [{ name: 'one.png', blob: new Blob(['a'], { type: 'image/png' }) }],
      controller.signal,
    )

    expect(attachInputImages).toHaveBeenCalledWith([{ id: 'stored-1' }], { maxImages: 10 })
    expect(setAppMode).toHaveBeenCalledWith('image')
    expect(showToast).toHaveBeenCalledTimes(1)
  })
})
