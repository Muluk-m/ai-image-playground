import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProductShotsStore } from '../../../features/productShots/store'
import { useLibraryStore } from '../../../features/library/store'
import type { AssetRecord } from '../../../features/library/types'
import { ProductMatteError } from '../../../lib/productMatte'
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
const requestSceneScan = vi.hoisted(() => vi.fn())
const segmentProduct = vi.hoisted(() => vi.fn())
const assessMatte = vi.hoisted(() => vi.fn())
const alphaToInpaintMask = vi.hoisted(() => vi.fn())
const alphaToProductMask = vi.hoisted(() => vi.fn())
const eraseProductArea = vi.hoisted(() => vi.fn())
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

vi.mock('../../../features/productShots/lib/planClient', () => ({
  requestBackgroundPlan,
  requestSceneScan,
}))

vi.mock('../../../lib/productMatte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/productMatte')>()),
  segmentProduct,
  assessMatte,
  alphaToInpaintMask,
  alphaToProductMask,
}))

vi.mock('../../../lib/eraseProduct', () => ({ eraseProductArea }))

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
  camera: '略高的 3/4 侧视',
  sceneType: 'photo',
  productBox: null,
  plan: '放进有窗光的日式木质浴室',
  prompt: '锁住产品，只换背景',
}

function image(name: string): File {
  return new File(['x'], name, { type: 'image/png' })
}

function asset(id: string, name: string, imageId: string): AssetRecord {
  return { id, name, imageId, createdAt: 1, lastUsedAt: 1 }
}

/** 一张原图 + 一份可用蒙版的默认剧本，测试只覆盖它要变的那一段。 */
async function jobWithOneImage(): Promise<string> {
  await useProductShotsStore.getState().importFiles([image('主图.png')])
  return 'image-主图.png'
}

/** 确认对话框的按钮是同步的，点下去之后要等提交链跑完。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn(), confirmDialog: null })
  useProductShotsStore.setState({ jobs: [], swapStage: null, swapStartedAt: null })
  useProductShotsStore.getState().startNewJob()
  isClientCapabilityEnabled.mockReturnValue(true)
  ensureImageCached.mockImplementation(async (id: string) => `data:image/png;base64,${id}`)
  submitPrepared.mockImplementation(async () => [`task-${submitPrepared.mock.calls.length}`])
  requestBackgroundPlan.mockResolvedValue(PLAN)
  requestSceneScan.mockResolvedValue('photo')
  segmentProduct.mockResolvedValue({
    alpha: new Uint8ClampedArray(4),
    width: 2,
    height: 2,
    backend: 'wasm-u2netp',
    elapsedMs: 3200,
  })
  assessMatte.mockReturnValue({ ok: true, coverage: 0.4 })
  alphaToInpaintMask.mockReturnValue('data:image/png;base64,MASK')
  alphaToProductMask.mockReturnValue('data:image/png;base64,PRODUCT-MASK')
  eraseProductArea.mockResolvedValue('data:image/png;base64,ERASED')
  modelSupportsNativeMask.mockReturnValue(true)
  storeImage.mockResolvedValue('mask-1')
  useLibraryStore.setState({
    assets: [asset('a-front', '正面白底', 'asset-front'), asset('a-side', '侧面', 'asset-side')],
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('putting original images into a job', () => {
  it('stores an uploaded file and selects the first image', async () => {
    await useProductShotsStore.getState().importFiles([image('主图.png'), image('细节.png')])

    const { draft, selectedImageId } = useProductShotsStore.getState()
    expect(draft.images.map((item) => item.imageId)).toEqual(['image-主图.png', 'image-细节.png'])
    expect(selectedImageId).toBe('image-主图.png')
  })

  it('skips files that are not images', async () => {
    await useProductShotsStore.getState().importFiles([new File(['x'], 'a.pdf', { type: 'text/plain' })])

    expect(useProductShotsStore.getState().draft.images).toEqual([])
  })

  it('saves the job so a reload finds it again', async () => {
    await useProductShotsStore.getState().importFiles([image('主图.png')])

    useProductShotsStore.setState({ jobs: [] })
    await useProductShotsStore.getState().loadJobs()

    const [job] = useProductShotsStore.getState().jobs
    expect(job?.images.map((item) => item.imageId)).toEqual(['image-主图.png'])
  })

  it('drops an image and moves the selection off it', async () => {
    await useProductShotsStore.getState().importFiles([image('主图.png'), image('细节.png')])

    useProductShotsStore.getState().removeImage('image-主图.png')

    expect(useProductShotsStore.getState().draft.images.map((item) => item.imageId)).toEqual([
      'image-细节.png',
    ])
    expect(useProductShotsStore.getState().selectedImageId).toBe('image-细节.png')
  })

  it('writes nothing until there is an image to save', async () => {
    useProductShotsStore.getState().setPreference('北欧风')

    expect(useProductShotsStore.getState().jobs).toEqual([])
  })
})

describe('checking what kind of image each original is', () => {
  it('scans an uploaded image and keeps the answer with the job', async () => {
    requestSceneScan.mockResolvedValue('infographic')

    await useProductShotsStore.getState().importFiles([image('示意图.png')])

    expect(requestSceneScan).toHaveBeenCalledWith('data:image/png;base64,image-示意图.png')
    expect(useProductShotsStore.getState().draft.images[0].sceneType).toBe('infographic')

    useProductShotsStore.setState({ jobs: [] })
    await useProductShotsStore.getState().loadJobs()
    expect(useProductShotsStore.getState().jobs[0].images[0].sceneType).toBe('infographic')
  })

  it('scans each image once', async () => {
    await useProductShotsStore.getState().importFiles([image('主图.png'), image('细节.png')])
    await useProductShotsStore.getState().importFiles([image('场景.png')])

    expect(requestSceneScan).toHaveBeenCalledTimes(3)
  })

  /** 认不出画面类型不该拦住换背景，这张就当普通商品图。 */
  it('leaves the scene kind unknown when the scan fails', async () => {
    requestSceneScan.mockRejectedValue(new Error('没认出这张图的画面类型'))

    await useProductShotsStore.getState().importFiles([image('主图.png')])

    expect(useProductShotsStore.getState().draft.images[0].sceneType).toBeUndefined()
  })

  it('does not scan when image analysis is off', async () => {
    isClientCapabilityEnabled.mockReturnValue(false)

    await useProductShotsStore.getState().importFiles([image('主图.png')])

    expect(requestSceneScan).not.toHaveBeenCalled()
  })
})

describe('pulling a listing into a job', () => {
  it('stores every fetched image behind the proxy and keeps its source url', async () => {
    fetchListingImages.mockResolvedValue({
      asin: 'B0H8YGPK5Z',
      title: '折叠浴缸',
      images: ['https://img/1.jpg', 'https://img/2.jpg'],
    })
    useProductShotsStore.getState().setListingUrl('https://www.amazon.com/dp/B0H8YGPK5Z')

    await useProductShotsStore.getState().fetchListing()

    expect(storeImageFromUrl).toHaveBeenCalledWith('proxy:https://img/1.jpg')
    expect(useProductShotsStore.getState().draft.images).toEqual([
      {
        imageId: 'image-proxy:https://img/1.jpg',
        sourceUrl: 'https://img/1.jpg',
        versions: [],
        sceneType: 'photo',
      },
      {
        imageId: 'image-proxy:https://img/2.jpg',
        sourceUrl: 'https://img/2.jpg',
        versions: [],
        sceneType: 'photo',
      },
    ])
    expect(useProductShotsStore.getState().draft.name).toBe('折叠浴缸')
  })

  it('explains the fallback when link fetching is off', async () => {
    isClientCapabilityEnabled.mockReturnValue(false)
    useProductShotsStore.getState().setListingUrl('https://www.amazon.com/dp/B0H8YGPK5Z')

    await useProductShotsStore.getState().fetchListing()

    expect(fetchListingImages).not.toHaveBeenCalled()
    expect(useProductShotsStore.getState().listingNotice).toContain('请直接上传原图')
  })

  it('keeps the fallback notice when the listing cannot be reached', async () => {
    fetchListingImages.mockRejectedValue(new Error('抓不到这条链接的图集'))
    useProductShotsStore.getState().setListingUrl('https://www.amazon.com/dp/B0H8YGPK5Z')

    await useProductShotsStore.getState().fetchListing()

    expect(useProductShotsStore.getState().listingNotice).toContain('抓不到这条链接的图集')
    expect(useProductShotsStore.getState().listingLoading).toBe(false)
  })
})

describe('reopening a saved job', () => {
  it('restores its images, preference and version count', async () => {
    await useProductShotsStore.getState().importFiles([image('主图.png')])
    useProductShotsStore.getState().setPreference('北欧风')
    useProductShotsStore.getState().setVersionsPerImage(3)
    const savedId = useProductShotsStore.getState().draft.id

    useProductShotsStore.getState().startNewJob()
    await useProductShotsStore.getState().loadJobs()
    if (!savedId) throw new Error('the job was never saved')
    useProductShotsStore.getState().selectJob(savedId)

    const { draft, selectedImageId } = useProductShotsStore.getState()
    expect(draft.preference).toBe('北欧风')
    expect(draft.versionsPerImage).toBe(3)
    expect(selectedImageId).toBe('image-主图.png')
  })
})

describe('swapping the background of one image', () => {
  it('plans, mattes and submits the masked generation', async () => {
    const imageId = await jobWithOneImage()
    useProductShotsStore.getState().setPreference('北欧风')

    await useProductShotsStore.getState().swapBackground()

    expect(requestBackgroundPlan).toHaveBeenCalledWith({
      image: `data:image/png;base64,${imageId}`,
      preference: '北欧风',
      mode: 'background',
    })
    const jobId = useProductShotsStore.getState().draft.id
    const [version] = useProductShotsStore.getState().draft.images[0].versions
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
      matte: { ok: true, backend: 'wasm-u2netp', elapsedMs: 3200 },
    })
    expect(version.createdAt).toBeGreaterThan(0)
  })

  it('walks the three stages and lands back on none', async () => {
    await jobWithOneImage()
    const stages: (string | null)[] = []
    requestBackgroundPlan.mockImplementation(async () => {
      stages.push(useProductShotsStore.getState().swapStage)
      return PLAN
    })
    segmentProduct.mockImplementation(async () => {
      stages.push(useProductShotsStore.getState().swapStage)
      return { alpha: new Uint8ClampedArray(4), width: 2, height: 2 }
    })
    submitPrepared.mockImplementation(async () => {
      stages.push(useProductShotsStore.getState().swapStage)
      return ['task-1']
    })

    await useProductShotsStore.getState().swapBackground()

    expect(stages).toEqual(['plan', 'matte', 'generate'])
    expect(useProductShotsStore.getState().swapStage).toBeNull()
  })

  it('keeps every click as its own version, newest last', async () => {
    await jobWithOneImage()

    await useProductShotsStore.getState().swapBackground()
    await useProductShotsStore.getState().swapBackground()

    expect(useProductShotsStore.getState().draft.images[0].versions.map((v) => v.taskId)).toEqual([
      'task-1',
      'task-2',
    ])
  })

  it('falls back to a prompt-only version when the matte fails', async () => {
    await jobWithOneImage()
    segmentProduct.mockRejectedValue(new Error('抠图超时'))

    await useProductShotsStore.getState().swapBackground()

    expect(submitPrepared.mock.calls[0][0].mask).toBeNull()
    expect(useProductShotsStore.getState().draft.images[0].versions[0]).toMatchObject({
      masked: false,
      matte: { ok: false, reason: 'failed' },
    })
    expect(useProductShotsStore.getState().swapNotice).toContain('未抠图')
  })

  it('keeps the matte failure reason on the version', async () => {
    await jobWithOneImage()
    segmentProduct.mockRejectedValue(new ProductMatteError('timeout', '抠图超时'))

    await useProductShotsStore.getState().swapBackground()

    expect(useProductShotsStore.getState().draft.images[0].versions[0].matte).toEqual({
      ok: false,
      reason: 'timeout',
    })
  })

  it('falls back when the product covers too little of the image', async () => {
    await jobWithOneImage()
    assessMatte.mockReturnValue({ ok: false, coverage: 0.001, reason: 'too-small' })

    await useProductShotsStore.getState().swapBackground()

    expect(alphaToInpaintMask).not.toHaveBeenCalled()
    expect(useProductShotsStore.getState().draft.images[0].versions[0].masked).toBe(false)
  })

  it('falls back when the model declares no mask support', async () => {
    await jobWithOneImage()
    modelSupportsNativeMask.mockReturnValue(false)

    await useProductShotsStore.getState().swapBackground()

    expect(segmentProduct).not.toHaveBeenCalled()
    expect(submitPrepared.mock.calls[0][0].mask).toBeNull()
    expect(useProductShotsStore.getState().swapNotice).toContain('不支持遮罩')
  })

  it('records nothing when the plan cannot be had', async () => {
    await jobWithOneImage()
    requestBackgroundPlan.mockRejectedValue(new Error('没拿到可用的背景方案'))

    await useProductShotsStore.getState().swapBackground()

    expect(submitPrepared).not.toHaveBeenCalled()
    expect(useProductShotsStore.getState().draft.images[0].versions).toEqual([])
    expect(useProductShotsStore.getState().swapNotice).toContain('没拿到可用的背景方案')
    expect(useProductShotsStore.getState().swapStage).toBeNull()
  })

  it('records nothing when the submission gate turns the click away', async () => {
    await jobWithOneImage()
    submitPrepared.mockResolvedValue([])

    await useProductShotsStore.getState().swapBackground()

    expect(useProductShotsStore.getState().draft.images[0].versions).toEqual([])
  })

  it('refuses a second click while one is still running', async () => {
    await jobWithOneImage()
    useProductShotsStore.setState({ swapStage: 'generate' })

    await useProductShotsStore.getState().swapBackground()

    expect(requestBackgroundPlan).not.toHaveBeenCalled()
  })

  it('survives a reload with its versions', async () => {
    await jobWithOneImage()
    await useProductShotsStore.getState().swapBackground()
    const savedId = useProductShotsStore.getState().draft.id
    if (!savedId) throw new Error('the job was never saved')

    useProductShotsStore.getState().startNewJob()
    useProductShotsStore.setState({ jobs: [] })
    await useProductShotsStore.getState().loadJobs()
    useProductShotsStore.getState().selectJob(savedId)

    expect(useProductShotsStore.getState().draft.images[0].versions[0].taskId).toBe('task-1')
  })
})

describe('swapping the background of a diagram', () => {
  async function jobWithADiagram(): Promise<void> {
    requestSceneScan.mockResolvedValue('collage')
    await useProductShotsStore.getState().importFiles([image('卖点图.png')])
  }

  it('asks before touching an image that carries explanatory text', async () => {
    await jobWithADiagram()

    await useProductShotsStore.getState().swapBackground()

    expect(requestBackgroundPlan).not.toHaveBeenCalled()
    expect(useStore.getState().confirmDialog?.message).toContain('含说明文字，换背景会丢失')
  })

  it('goes ahead once the user confirms', async () => {
    await jobWithADiagram()
    await useProductShotsStore.getState().swapBackground()

    useStore.getState().confirmDialog?.action()
    await settle()

    expect(useProductShotsStore.getState().draft.images[0].versions).toHaveLength(1)
  })

  /** 对话框摆在中间，用户思考的时候批量可能已经开跑了。 */
  it('turns the confirmation down when something else started meanwhile', async () => {
    await jobWithADiagram()
    await useProductShotsStore.getState().swapBackground()
    useProductShotsStore.setState({
      batch: { items: [], running: true, stopRequested: false, startedAt: 1, stage: null },
    })

    useStore.getState().confirmDialog?.action()
    await settle()

    expect(requestBackgroundPlan).not.toHaveBeenCalled()
  })

  it('asks nothing for a plain product photo', async () => {
    await jobWithOneImage()

    await useProductShotsStore.getState().swapBackground()

    expect(useStore.getState().confirmDialog).toBeNull()
    expect(useProductShotsStore.getState().draft.images[0].versions).toHaveLength(1)
  })
})

describe('checking the matte against the product box', () => {
  /** 全白 alpha 的外接框是整张图，跟一个小小的产品框几乎不重叠。 */
  function matteCoveringEverything() {
    return {
      alpha: new Uint8ClampedArray([255, 255, 255, 255]),
      width: 2,
      height: 2,
      backend: 'wasm-u2netp',
      elapsedMs: 3200,
    }
  }

  it('drops a matte that sits somewhere else and says so on the version', async () => {
    await jobWithOneImage()
    requestBackgroundPlan.mockResolvedValue({
      ...PLAN,
      productBox: { x: 0, y: 0, w: 0.1, h: 0.1 },
    })
    segmentProduct.mockResolvedValue(matteCoveringEverything())

    await useProductShotsStore.getState().swapBackground()

    expect(alphaToInpaintMask).not.toHaveBeenCalled()
    expect(submitPrepared.mock.calls[0][0].mask).toBeNull()
    expect(useProductShotsStore.getState().draft.images[0].versions[0]).toMatchObject({
      masked: false,
      matte: { ok: false, reason: 'box-mismatch' },
    })
    expect(useProductShotsStore.getState().swapNotice).toContain('蒙版与产品框不符')
  })

  it('keeps the matte when it lands on the box the plan reported', async () => {
    await jobWithOneImage()
    requestBackgroundPlan.mockResolvedValue({ ...PLAN, productBox: { x: 0, y: 0, w: 1, h: 1 } })
    segmentProduct.mockResolvedValue(matteCoveringEverything())

    await useProductShotsStore.getState().swapBackground()

    expect(useProductShotsStore.getState().draft.images[0].versions[0].masked).toBe(true)
  })
})

describe('keeping a matte preview beside the version', () => {
  it('stores the overlay in the image library and records it on the version', async () => {
    storeImage.mockImplementation(async (dataUrl: string) =>
      dataUrl === 'data:image/png;base64,MASK' ? 'mask-1' : 'preview-1',
    )
    await jobWithOneImage()

    await useProductShotsStore.getState().swapBackground()

    expect(useProductShotsStore.getState().draft.images[0].versions[0].mattePreviewImageId).toBe(
      'preview-1',
    )
  })

  /** 抠错了的那次尤其要留预览，用户就是靠它看出抠到了别的东西。 */
  it('keeps the overlay even when the matte is turned down', async () => {
    storeImage.mockImplementation(async (dataUrl: string) =>
      dataUrl === 'data:image/png;base64,MASK' ? 'mask-1' : 'preview-1',
    )
    await jobWithOneImage()
    assessMatte.mockReturnValue({ ok: false, coverage: 0.001, reason: 'too-small' })

    await useProductShotsStore.getState().swapBackground()

    const [version] = useProductShotsStore.getState().draft.images[0].versions
    expect(version.masked).toBe(false)
    expect(version.mattePreviewImageId).toBe('preview-1')
  })

  it('has no overlay when the matte never ran', async () => {
    await jobWithOneImage()
    segmentProduct.mockRejectedValue(new ProductMatteError('timeout', '抠图超时'))

    await useProductShotsStore.getState().swapBackground()

    expect(
      useProductShotsStore.getState().draft.images[0].versions[0].mattePreviewImageId,
    ).toBeUndefined()
  })

  it('shows and hides the overlay for one version at a time', async () => {
    await jobWithOneImage()
    await useProductShotsStore.getState().swapBackground()
    const [version] = useProductShotsStore.getState().draft.images[0].versions

    useProductShotsStore.getState().toggleMatteOverlay(version.id)
    expect(useProductShotsStore.getState().matteOverlayVersionId).toBe(version.id)

    useProductShotsStore.getState().toggleMatteOverlay(version.id)
    expect(useProductShotsStore.getState().matteOverlayVersionId).toBeNull()
  })
})

describe('picking among the versions', () => {
  it('marks the chosen version and keeps it after a reload', async () => {
    await jobWithOneImage()
    await useProductShotsStore.getState().swapBackground()
    const [version] = useProductShotsStore.getState().draft.images[0].versions
    const savedId = useProductShotsStore.getState().draft.id
    if (!savedId) throw new Error('the job was never saved')

    useProductShotsStore.getState().chooseVersion(version.id)
    await useProductShotsStore.getState().loadJobs()

    expect(useProductShotsStore.getState().draft.images[0].chosenVersionId).toBe(version.id)
    expect(
      useProductShotsStore.getState().jobs.find((job) => job.id === savedId)?.images[0].chosenVersionId,
    ).toBe(version.id)
  })

  it('previews the newest version and drops back to the original', async () => {
    await jobWithOneImage()
    await useProductShotsStore.getState().swapBackground()
    const [version] = useProductShotsStore.getState().draft.images[0].versions

    expect(useProductShotsStore.getState().previewVersionId).toBe(version.id)

    useProductShotsStore.getState().previewVersion(null)
    expect(useProductShotsStore.getState().previewVersionId).toBeNull()
  })

  it('shows the original again after switching to another image', async () => {
    await useProductShotsStore.getState().importFiles([image('主图.png'), image('细节.png')])
    await useProductShotsStore.getState().swapBackground()

    useProductShotsStore.getState().selectImage('image-细节.png')

    expect(useProductShotsStore.getState().previewVersionId).toBeNull()
  })
})

describe('swapping the product for one of my assets', () => {
  /** 右栏选了两张标好角度的素材，产品来源切到素材。 */
  async function jobWithAssets(target: 'product-only' | 'product-and-background'): Promise<string> {
    const imageId = await jobWithOneImage()
    const store = useProductShotsStore.getState()
    store.setProductSource('asset')
    store.setSwapTarget(target)
    store.toggleProductAsset('a-front')
    store.setProductAngle('a-front', 'front')
    store.toggleProductAsset('a-side')
    store.setProductAngle('a-side', 'three-quarter')
    return imageId
  }

  it('repaints the product area and keeps the background pixels', async () => {
    const imageId = await jobWithAssets('product-only')

    await useProductShotsStore.getState().swapBackground()

    expect(requestBackgroundPlan.mock.calls[0][0].mode).toBe('replace-product')
    expect(alphaToProductMask).toHaveBeenCalledTimes(1)
    expect(alphaToInpaintMask).not.toHaveBeenCalled()
    expect(storeImage).toHaveBeenCalledWith('data:image/png;base64,PRODUCT-MASK', 'mask')
    expect(submitPrepared.mock.calls[0][0].mask).toEqual({
      imageId: 'mask-1',
      targetImageId: imageId,
    })
  })

  it('sends the original first and the angle-matched asset second', async () => {
    const imageId = await jobWithAssets('product-only')

    await useProductShotsStore.getState().swapBackground()

    // 方案说机位是 3/4 侧，所以拿标了 three-quarter 的那张，不是正面那张。
    expect(submitPrepared.mock.calls[0][0].inputImages).toEqual([
      { id: imageId, dataUrl: `data:image/png;base64,${imageId}` },
      { id: 'asset-side', dataUrl: 'data:image/png;base64,asset-side' },
    ])
  })

  it('records the asset and the mode on the version', async () => {
    await jobWithAssets('product-only')

    await useProductShotsStore.getState().swapBackground()

    expect(useProductShotsStore.getState().draft.images[0].versions[0]).toMatchObject({
      mode: 'replace-product',
      productAssetId: 'a-side',
      masked: true,
    })
  })

  it('holds the swap until an asset is picked', async () => {
    await jobWithOneImage()
    useProductShotsStore.getState().setProductSource('asset')

    await useProductShotsStore.getState().swapBackground()

    expect(submitPrepared).not.toHaveBeenCalled()
    expect(useProductShotsStore.getState().swapNotice).toContain('素材')
  })

  it('falls back to the first asset when no angle matches', async () => {
    await jobWithAssets('product-only')
    useProductShotsStore.getState().setProductAngle('a-side', 'top-down')

    await useProductShotsStore.getState().swapBackground()

    expect(submitPrepared.mock.calls[0][0].inputImages[1].id).toBe('asset-front')
    expect(useProductShotsStore.getState().swapNotice).toContain('机位')
  })

  it('keeps the product settings for every image of the batch', async () => {
    await jobWithAssets('product-only')
    await useProductShotsStore.getState().importFiles([image('细节.png')])

    await useProductShotsStore.getState().runBatch()

    const [version] = useProductShotsStore.getState().draft.images[1].versions
    expect(version).toMatchObject({ mode: 'replace-product', productAssetId: 'a-side' })
  })

  it('reopens a saved job with the product settings it was saved with', async () => {
    await jobWithAssets('product-and-background')
    const jobId = useProductShotsStore.getState().draft.id

    useProductShotsStore.getState().startNewJob()
    await useProductShotsStore.getState().loadJobs()
    useProductShotsStore.getState().selectJob(jobId as string)

    const { draft } = useProductShotsStore.getState()
    expect(draft.productSource).toBe('asset')
    expect(draft.target).toBe('product-and-background')
    expect(draft.productAssets).toEqual([
      { assetId: 'a-front', angle: 'front' },
      { assetId: 'a-side', angle: 'three-quarter' },
    ])
  })
})

describe('swapping the product and the background at once', () => {
  async function jobWithBoth(): Promise<string> {
    const imageId = await jobWithOneImage()
    const store = useProductShotsStore.getState()
    store.setProductSource('asset')
    store.setSwapTarget('product-and-background')
    store.toggleProductAsset('a-front')
    store.setProductAngle('a-front', 'three-quarter')
    return imageId
  }

  it('redraws the whole picture: no mask, the erased original as framing', async () => {
    requestBackgroundPlan.mockResolvedValue({
      ...PLAN,
      productBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    })
    const imageId = await jobWithBoth()

    await useProductShotsStore.getState().swapBackground()

    expect(requestBackgroundPlan.mock.calls[0][0].mode).toBe('replace-and-background')
    expect(eraseProductArea).toHaveBeenCalledWith(`data:image/png;base64,${imageId}`, {
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    })
    const [submission] = submitPrepared.mock.calls[0]
    expect(submission.mask).toBeNull()
    expect(submission.inputImages).toEqual([
      { id: 'image-data:image/png;base64,ERASED', dataUrl: 'data:image/png;base64,ERASED' },
      { id: 'asset-front', dataUrl: 'data:image/png;base64,asset-front' },
    ])
  })

  it('never runs the matte: nothing in the picture is being kept', async () => {
    await jobWithBoth()

    await useProductShotsStore.getState().swapBackground()

    expect(segmentProduct).not.toHaveBeenCalled()
    expect(useProductShotsStore.getState().draft.images[0].versions[0]).toMatchObject({
      mode: 'replace-and-background',
      productAssetId: 'a-front',
      masked: false,
    })
  })

  it('sends the untouched original when the plan found no product box', async () => {
    const imageId = await jobWithBoth()

    await useProductShotsStore.getState().swapBackground()

    expect(eraseProductArea).not.toHaveBeenCalled()
    expect(submitPrepared.mock.calls[0][0].inputImages[0].id).toBe(imageId)
  })
})

describe('retrying a failed version', () => {
  it('resubmits the same plan and replaces the task', async () => {
    await jobWithOneImage()
    await useProductShotsStore.getState().swapBackground()
    const [version] = useProductShotsStore.getState().draft.images[0].versions

    await useProductShotsStore.getState().retryVersion(version.id)

    expect(requestBackgroundPlan).toHaveBeenCalledTimes(1)
    expect(submitPrepared).toHaveBeenCalledTimes(2)
    expect(submitPrepared.mock.calls[1][0].prompt).toBe(PLAN.prompt)
    const versions = useProductShotsStore.getState().draft.images[0].versions
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ id: version.id, taskId: 'task-2', plan: PLAN.plan })
  })
})

describe('running the batch over the remaining images', () => {
  /** 三张图，样张是第一张；批量只该动后两张。 */
  async function jobWithThreeImages(): Promise<void> {
    await useProductShotsStore
      .getState()
      .importFiles([image('主图.png'), image('细节.png'), image('场景.png')])
  }

  it('covers every image but the sample, one image at a time', async () => {
    await jobWithThreeImages()
    let inFlight = 0
    let peak = 0
    requestBackgroundPlan.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return PLAN
    })

    await useProductShotsStore.getState().runBatch()

    expect(requestBackgroundPlan).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
    const [main, detail, scene] = useProductShotsStore.getState().draft.images
    expect(main.versions).toEqual([])
    expect(detail.versions).toHaveLength(1)
    expect(scene.versions).toHaveLength(1)
  })

  it('leaves the diagrams alone but still runs one when asked by hand', async () => {
    requestSceneScan.mockResolvedValueOnce('photo')
    requestSceneScan.mockResolvedValueOnce('infographic')
    requestSceneScan.mockResolvedValueOnce('photo')
    await jobWithThreeImages()

    await useProductShotsStore.getState().runBatch()

    expect(useProductShotsStore.getState().draft.images[1].versions).toEqual([])
    expect(useProductShotsStore.getState().draft.images[2].versions).toHaveLength(1)

    await useProductShotsStore.getState().runBatchImage('image-细节.png')

    expect(useProductShotsStore.getState().draft.images[1].versions).toHaveLength(1)
  })

  it('submits one plan and matte per image but every version of it at once', async () => {
    await jobWithThreeImages()
    useProductShotsStore.getState().setVersionsPerImage(3)

    await useProductShotsStore.getState().runBatch()

    expect(requestBackgroundPlan).toHaveBeenCalledTimes(2)
    expect(segmentProduct).toHaveBeenCalledTimes(2)
    expect(submitPrepared).toHaveBeenCalledTimes(6)
    expect(useProductShotsStore.getState().draft.images[1].versions).toHaveLength(3)
  })

  it('walks the progress bar to the end and clears the running flag', async () => {
    await jobWithThreeImages()

    await useProductShotsStore.getState().runBatch()

    const batch = useProductShotsStore.getState().batch
    expect(batch?.running).toBe(false)
    expect(batch?.items.map((item) => item.state)).toEqual(['done', 'done'])
  })

  it('stops after the image in flight when asked to', async () => {
    await jobWithThreeImages()
    requestBackgroundPlan.mockImplementation(async () => {
      useProductShotsStore.getState().stopBatch()
      return PLAN
    })

    await useProductShotsStore.getState().runBatch()

    expect(requestBackgroundPlan).toHaveBeenCalledTimes(1)
    expect(useProductShotsStore.getState().batch?.items.map((item) => item.state)).toEqual([
      'done',
      'pending',
    ])
  })

  it('keeps the failure reason on the image that failed and carries on', async () => {
    await jobWithThreeImages()
    requestBackgroundPlan.mockRejectedValueOnce(new Error('没拿到可用的背景方案'))

    await useProductShotsStore.getState().runBatch()

    const [failed, second] = useProductShotsStore.getState().batch?.items ?? []
    expect(failed).toMatchObject({ state: 'error', error: '没拿到可用的背景方案' })
    expect(second?.state).toBe('done')
  })

  it('reruns one failed image on its own', async () => {
    await jobWithThreeImages()
    requestBackgroundPlan.mockRejectedValueOnce(new Error('没拿到可用的背景方案'))
    await useProductShotsStore.getState().runBatch()
    const failedImageId = useProductShotsStore.getState().batch?.items[0].imageId
    if (!failedImageId) throw new Error('nothing failed')

    await useProductShotsStore.getState().runBatchImage(failedImageId)

    expect(useProductShotsStore.getState().batch?.items[0]).toMatchObject({ state: 'done', error: null })
    expect(
      useProductShotsStore.getState().draft.images.find((item) => item.imageId === failedImageId)
        ?.versions,
    ).toHaveLength(1)
  })

  it('refuses to start a second run while one is going', async () => {
    await jobWithThreeImages()
    useProductShotsStore.setState({
      batch: { items: [], running: true, stopRequested: false, startedAt: 1, stage: null },
    })

    await useProductShotsStore.getState().runBatch()

    expect(requestBackgroundPlan).not.toHaveBeenCalled()
  })

  it('leaves the images it already covered out of the next run after a reload', async () => {
    await jobWithThreeImages()
    await useProductShotsStore.getState().runBatch()
    const savedId = useProductShotsStore.getState().draft.id
    if (!savedId) throw new Error('the job was never saved')

    useProductShotsStore.getState().startNewJob()
    useProductShotsStore.setState({ jobs: [] })
    await useProductShotsStore.getState().loadJobs()
    useProductShotsStore.getState().selectJob(savedId)

    expect(useProductShotsStore.getState().batch).toBeNull()
    expect(useProductShotsStore.getState().draft.images[1].versions).toHaveLength(1)
    await useProductShotsStore.getState().runBatch()
    expect(requestBackgroundPlan).toHaveBeenCalledTimes(2)
  })

  it('holds the single swap button while the batch is going', async () => {
    await jobWithThreeImages()
    useProductShotsStore.setState({
      batch: { items: [], running: true, stopRequested: false, startedAt: 1, stage: null },
    })

    await useProductShotsStore.getState().swapBackground()

    expect(requestBackgroundPlan).not.toHaveBeenCalled()
  })
})
