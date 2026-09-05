import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBgSwapStore } from '../../../features/bgswap/store'
import { useStore } from '../../../store'

const fetchListingImages = vi.hoisted(() => vi.fn())
const isClientCapabilityEnabled = vi.hoisted(() => vi.fn(() => true))
const storeImageFromUrl = vi.hoisted(() =>
  vi.fn(async (src: string) => ({ id: `image-${src}`, dataUrl: src })),
)
const storeImageFromFile = vi.hoisted(() =>
  vi.fn(async (file: File) => ({ id: `image-${file.name}`, dataUrl: `data:,${file.name}` })),
)
const ensureImageCached = vi.hoisted(() => vi.fn())
const submitPrepared = vi.hoisted(() => vi.fn())
const requestBackgroundPlan = vi.hoisted(() => vi.fn())
const segmentProduct = vi.hoisted(() => vi.fn())
const assessMatte = vi.hoisted(() => vi.fn())
const alphaToInpaintMask = vi.hoisted(() => vi.fn())
const modelSupportsNativeMask = vi.hoisted(() => vi.fn())
const storeImage = vi.hoisted(() => vi.fn())

vi.mock('../../../lib/listingClient', () => ({
  fetchListingImages,
  listingImageProxyUrl: (url: string) => `proxy:${url}`,
}))

vi.mock('../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

vi.mock('../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store')>()),
  storeImageFromUrl,
  storeImageFromFile,
  ensureImageCached,
  submitPrepared,
}))

vi.mock('../../../features/bgswap/lib/planClient', () => ({ requestBackgroundPlan }))

vi.mock('../../../lib/productMatte', () => ({ segmentProduct, assessMatte, alphaToInpaintMask }))

vi.mock('../../../lib/channels/profileSelectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/channels/profileSelectors')>()),
  modelSupportsNativeMask,
}))

vi.mock('../../../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/db')>()),
  storeImage,
}))

const PLAN = {
  category: '折叠浴缸',
  sceneType: '纯白背景',
  productBox: null,
  plan: '放进有窗光的日式木质浴室',
  prompt: '锁住产品，只换背景',
}

function image(name: string): File {
  return new File(['x'], name, { type: 'image/png' })
}

/** 一张原图 + 一份可用蒙版的默认剧本，测试只覆盖它要变的那一段。 */
async function jobWithOneImage(): Promise<string> {
  await useBgSwapStore.getState().importFiles([image('主图.png')])
  return 'image-主图.png'
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useBgSwapStore.setState({ jobs: [], swapStage: null, swapStartedAt: null })
  useBgSwapStore.getState().startNewJob()
  isClientCapabilityEnabled.mockReturnValue(true)
  ensureImageCached.mockImplementation(async (id: string) => `data:image/png;base64,${id}`)
  submitPrepared.mockImplementation(async () => [`task-${submitPrepared.mock.calls.length}`])
  requestBackgroundPlan.mockResolvedValue(PLAN)
  segmentProduct.mockResolvedValue({ alpha: new Uint8ClampedArray(4), width: 2, height: 2 })
  assessMatte.mockReturnValue({ ok: true, coverage: 0.4 })
  alphaToInpaintMask.mockReturnValue('data:image/png;base64,MASK')
  modelSupportsNativeMask.mockReturnValue(true)
  storeImage.mockResolvedValue('mask-1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('putting original images into a job', () => {
  it('stores an uploaded file and selects the first image', async () => {
    await useBgSwapStore.getState().importFiles([image('主图.png'), image('细节.png')])

    const { draft, selectedImageId } = useBgSwapStore.getState()
    expect(draft.images.map((item) => item.imageId)).toEqual(['image-主图.png', 'image-细节.png'])
    expect(selectedImageId).toBe('image-主图.png')
  })

  it('skips files that are not images', async () => {
    await useBgSwapStore.getState().importFiles([new File(['x'], 'a.pdf', { type: 'text/plain' })])

    expect(useBgSwapStore.getState().draft.images).toEqual([])
  })

  it('saves the job so a reload finds it again', async () => {
    await useBgSwapStore.getState().importFiles([image('主图.png')])

    useBgSwapStore.setState({ jobs: [] })
    await useBgSwapStore.getState().loadJobs()

    const [job] = useBgSwapStore.getState().jobs
    expect(job?.images.map((item) => item.imageId)).toEqual(['image-主图.png'])
  })

  it('drops an image and moves the selection off it', async () => {
    await useBgSwapStore.getState().importFiles([image('主图.png'), image('细节.png')])

    useBgSwapStore.getState().removeImage('image-主图.png')

    expect(useBgSwapStore.getState().draft.images.map((item) => item.imageId)).toEqual([
      'image-细节.png',
    ])
    expect(useBgSwapStore.getState().selectedImageId).toBe('image-细节.png')
  })

  it('writes nothing until there is an image to save', async () => {
    useBgSwapStore.getState().setPreference('北欧风')

    expect(useBgSwapStore.getState().jobs).toEqual([])
  })
})

describe('pulling a listing into a job', () => {
  it('stores every fetched image behind the proxy and keeps its source url', async () => {
    fetchListingImages.mockResolvedValue({
      asin: 'B0H8YGPK5Z',
      title: '折叠浴缸',
      images: ['https://img/1.jpg', 'https://img/2.jpg'],
    })
    useBgSwapStore.getState().setListingUrl('https://www.amazon.com/dp/B0H8YGPK5Z')

    await useBgSwapStore.getState().fetchListing()

    expect(storeImageFromUrl).toHaveBeenCalledWith('proxy:https://img/1.jpg')
    expect(useBgSwapStore.getState().draft.images).toEqual([
      { imageId: 'image-proxy:https://img/1.jpg', sourceUrl: 'https://img/1.jpg', versions: [] },
      { imageId: 'image-proxy:https://img/2.jpg', sourceUrl: 'https://img/2.jpg', versions: [] },
    ])
    expect(useBgSwapStore.getState().draft.name).toBe('折叠浴缸')
  })

  it('explains the fallback when link fetching is off', async () => {
    isClientCapabilityEnabled.mockReturnValue(false)
    useBgSwapStore.getState().setListingUrl('https://www.amazon.com/dp/B0H8YGPK5Z')

    await useBgSwapStore.getState().fetchListing()

    expect(fetchListingImages).not.toHaveBeenCalled()
    expect(useBgSwapStore.getState().listingNotice).toContain('请直接上传原图')
  })

  it('keeps the fallback notice when the listing cannot be reached', async () => {
    fetchListingImages.mockRejectedValue(new Error('抓不到这条链接的图集'))
    useBgSwapStore.getState().setListingUrl('https://www.amazon.com/dp/B0H8YGPK5Z')

    await useBgSwapStore.getState().fetchListing()

    expect(useBgSwapStore.getState().listingNotice).toContain('抓不到这条链接的图集')
    expect(useBgSwapStore.getState().listingLoading).toBe(false)
  })
})

describe('reopening a saved job', () => {
  it('restores its images, preference and version count', async () => {
    await useBgSwapStore.getState().importFiles([image('主图.png')])
    useBgSwapStore.getState().setPreference('北欧风')
    useBgSwapStore.getState().setVersionsPerImage(3)
    const savedId = useBgSwapStore.getState().draft.id

    useBgSwapStore.getState().startNewJob()
    await useBgSwapStore.getState().loadJobs()
    if (!savedId) throw new Error('the job was never saved')
    useBgSwapStore.getState().selectJob(savedId)

    const { draft, selectedImageId } = useBgSwapStore.getState()
    expect(draft.preference).toBe('北欧风')
    expect(draft.versionsPerImage).toBe(3)
    expect(selectedImageId).toBe('image-主图.png')
  })
})

describe('swapping the background of one image', () => {
  it('plans, mattes and submits the masked generation', async () => {
    const imageId = await jobWithOneImage()
    useBgSwapStore.getState().setPreference('北欧风')

    await useBgSwapStore.getState().swapBackground()

    expect(requestBackgroundPlan).toHaveBeenCalledWith({
      image: `data:image/png;base64,${imageId}`,
      preference: '北欧风',
    })
    const jobId = useBgSwapStore.getState().draft.id
    const [version] = useBgSwapStore.getState().draft.images[0].versions
    expect(submitPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: PLAN.prompt,
        inputImages: [{ id: imageId, dataUrl: `data:image/png;base64,${imageId}` }],
        mask: { imageId: 'mask-1', targetImageId: imageId },
        origin: { setId: jobId, shotId: `${imageId}:${version.id}` },
      }),
    )
    expect(submitPrepared.mock.calls[0][0].params.n).toBe(1)
    expect(version).toMatchObject({
      taskId: 'task-1',
      plan: PLAN.plan,
      prompt: PLAN.prompt,
      masked: true,
    })
    expect(version.createdAt).toBeGreaterThan(0)
  })

  it('walks the three stages and lands back on none', async () => {
    await jobWithOneImage()
    const stages: (string | null)[] = []
    requestBackgroundPlan.mockImplementation(async () => {
      stages.push(useBgSwapStore.getState().swapStage)
      return PLAN
    })
    segmentProduct.mockImplementation(async () => {
      stages.push(useBgSwapStore.getState().swapStage)
      return { alpha: new Uint8ClampedArray(4), width: 2, height: 2 }
    })
    submitPrepared.mockImplementation(async () => {
      stages.push(useBgSwapStore.getState().swapStage)
      return ['task-1']
    })

    await useBgSwapStore.getState().swapBackground()

    expect(stages).toEqual(['plan', 'matte', 'generate'])
    expect(useBgSwapStore.getState().swapStage).toBeNull()
  })

  it('keeps every click as its own version, newest last', async () => {
    await jobWithOneImage()

    await useBgSwapStore.getState().swapBackground()
    await useBgSwapStore.getState().swapBackground()

    expect(useBgSwapStore.getState().draft.images[0].versions.map((v) => v.taskId)).toEqual([
      'task-1',
      'task-2',
    ])
  })

  it('falls back to a prompt-only version when the matte fails', async () => {
    await jobWithOneImage()
    segmentProduct.mockRejectedValue(new Error('抠图超时'))

    await useBgSwapStore.getState().swapBackground()

    expect(submitPrepared.mock.calls[0][0].mask).toBeNull()
    expect(useBgSwapStore.getState().draft.images[0].versions[0].masked).toBe(false)
    expect(useBgSwapStore.getState().swapNotice).toContain('未抠图')
  })

  it('falls back when the product covers too little of the image', async () => {
    await jobWithOneImage()
    assessMatte.mockReturnValue({ ok: false, coverage: 0.001, reason: 'too-small' })

    await useBgSwapStore.getState().swapBackground()

    expect(alphaToInpaintMask).not.toHaveBeenCalled()
    expect(useBgSwapStore.getState().draft.images[0].versions[0].masked).toBe(false)
  })

  it('falls back when the model declares no mask support', async () => {
    await jobWithOneImage()
    modelSupportsNativeMask.mockReturnValue(false)

    await useBgSwapStore.getState().swapBackground()

    expect(segmentProduct).not.toHaveBeenCalled()
    expect(submitPrepared.mock.calls[0][0].mask).toBeNull()
    expect(useBgSwapStore.getState().swapNotice).toContain('不支持遮罩')
  })

  it('records nothing when the plan cannot be had', async () => {
    await jobWithOneImage()
    requestBackgroundPlan.mockRejectedValue(new Error('没拿到可用的背景方案'))

    await useBgSwapStore.getState().swapBackground()

    expect(submitPrepared).not.toHaveBeenCalled()
    expect(useBgSwapStore.getState().draft.images[0].versions).toEqual([])
    expect(useBgSwapStore.getState().swapNotice).toContain('没拿到可用的背景方案')
    expect(useBgSwapStore.getState().swapStage).toBeNull()
  })

  it('records nothing when the submission gate turns the click away', async () => {
    await jobWithOneImage()
    submitPrepared.mockResolvedValue([])

    await useBgSwapStore.getState().swapBackground()

    expect(useBgSwapStore.getState().draft.images[0].versions).toEqual([])
  })

  it('refuses a second click while one is still running', async () => {
    await jobWithOneImage()
    useBgSwapStore.setState({ swapStage: 'generate' })

    await useBgSwapStore.getState().swapBackground()

    expect(requestBackgroundPlan).not.toHaveBeenCalled()
  })

  it('survives a reload with its versions', async () => {
    await jobWithOneImage()
    await useBgSwapStore.getState().swapBackground()
    const savedId = useBgSwapStore.getState().draft.id
    if (!savedId) throw new Error('the job was never saved')

    useBgSwapStore.getState().startNewJob()
    useBgSwapStore.setState({ jobs: [] })
    await useBgSwapStore.getState().loadJobs()
    useBgSwapStore.getState().selectJob(savedId)

    expect(useBgSwapStore.getState().draft.images[0].versions[0].taskId).toBe('task-1')
  })
})

describe('picking among the versions', () => {
  it('marks the chosen version and keeps it after a reload', async () => {
    await jobWithOneImage()
    await useBgSwapStore.getState().swapBackground()
    const [version] = useBgSwapStore.getState().draft.images[0].versions
    const savedId = useBgSwapStore.getState().draft.id
    if (!savedId) throw new Error('the job was never saved')

    useBgSwapStore.getState().chooseVersion(version.id)
    await useBgSwapStore.getState().loadJobs()

    expect(useBgSwapStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(
      useBgSwapStore.getState().jobs.find((job) => job.id === savedId)?.images[0].chosenVersionId,
    ).toBe(version.id)
  })

  it('previews the newest version and drops back to the original', async () => {
    await jobWithOneImage()
    await useBgSwapStore.getState().swapBackground()
    const [version] = useBgSwapStore.getState().draft.images[0].versions

    expect(useBgSwapStore.getState().previewVersionId).toBe(version.id)

    useBgSwapStore.getState().previewVersion(null)
    expect(useBgSwapStore.getState().previewVersionId).toBeNull()
  })

  it('shows the original again after switching to another image', async () => {
    await useBgSwapStore.getState().importFiles([image('主图.png'), image('细节.png')])
    await useBgSwapStore.getState().swapBackground()

    useBgSwapStore.getState().selectImage('image-细节.png')

    expect(useBgSwapStore.getState().previewVersionId).toBeNull()
  })
})

describe('retrying a failed version', () => {
  it('resubmits the same plan and replaces the task', async () => {
    await jobWithOneImage()
    await useBgSwapStore.getState().swapBackground()
    const [version] = useBgSwapStore.getState().draft.images[0].versions

    await useBgSwapStore.getState().retryVersion(version.id)

    expect(requestBackgroundPlan).toHaveBeenCalledTimes(1)
    expect(submitPrepared).toHaveBeenCalledTimes(2)
    expect(submitPrepared.mock.calls[1][0].prompt).toBe(PLAN.prompt)
    const versions = useBgSwapStore.getState().draft.images[0].versions
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ id: version.id, taskId: 'task-2', plan: PLAN.plan })
  })
})
