import type { CompetitorBrief } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../features/library/store'
import { remixSetStore } from '../../../features/remix/lib/remixSetStore'
import { selectNeedsFrontAsset, useRemixStore } from '../../../features/remix/store'
import { useStore } from '../../../store'

const fetchListingImages = vi.hoisted(() => vi.fn())
const storeImageFromUrl = vi.hoisted(() => vi.fn())
const ensureImageCached = vi.hoisted(() => vi.fn())
const isClientCapabilityEnabled = vi.hoisted(() => vi.fn())
const analyzeCompetitorImages = vi.hoisted(() => vi.fn())
const eraseProductArea = vi.hoisted(() => vi.fn())

vi.mock('../../../features/remix/lib/listingClient', () => ({
  fetchListingImages,
  listingImageProxyUrl: (url: string) => `/api/remix/image?url=${encodeURIComponent(url)}`,
}))

vi.mock('../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

vi.mock('../../../features/remix/lib/analyzeClient', () => ({ analyzeCompetitorImages }))

vi.mock('../../../features/remix/lib/eraseProduct', () => ({ eraseProductArea }))

vi.mock('../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store')>()),
  storeImageFromUrl,
  ensureImageCached,
}))

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useRemixStore.getState().startNewSet()
  useRemixStore.setState({ sets: [] })
  isClientCapabilityEnabled.mockReturnValue(true)
  storeImageFromUrl.mockImplementation(async (url: string) => ({ id: `img-${url}`, dataUrl: '' }))
  ensureImageCached.mockImplementation(async (id: string) => `data:image/png;base64,${id}`)
  eraseProductArea.mockResolvedValue('data:image/png;base64,erased')
  useLibraryStore.setState({
    assets: [
      { id: 'a-front', name: '正面白底', imageId: 'p-front', createdAt: 1, lastUsedAt: 1 },
      { id: 'a-top', name: '正顶白底', imageId: 'p-top', createdAt: 1, lastUsedAt: 1 },
    ],
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('fetching the competitor image set from a listing url', () => {
  it('falls back to uploading when the listing capability is off', async () => {
    isClientCapabilityEnabled.mockReturnValue(false)
    useRemixStore.getState().setListingUrl('https://www.amazon.com/dp/B0FVLNS696')

    await useRemixStore.getState().fetchListing()

    expect(fetchListingImages).not.toHaveBeenCalled()
    expect(useRemixStore.getState().listingNotice).toContain('上传')
  })

  it('stores every fetched image as a competitor image', async () => {
    fetchListingImages.mockResolvedValue({
      asin: 'B0FVLNS696',
      title: 'Abruzzo Bathtub',
      images: ['https://img/a.jpg', 'https://img/b.jpg'],
    })
    useRemixStore.getState().setListingUrl('https://www.amazon.com/dp/B0FVLNS696')

    await useRemixStore.getState().fetchListing()

    const state = useRemixStore.getState()
    expect(state.draft.competitorImageIds).toHaveLength(2)
    expect(state.listingNotice).toBeNull()
    expect(state.draft.name).toBe('Abruzzo Bathtub')
  })

  it('keeps the fallback notice when the listing cannot be reached', async () => {
    fetchListingImages.mockRejectedValue(new Error('抓不到这条链接的图集'))
    useRemixStore.getState().setListingUrl('https://www.amazon.com/dp/B0FVLNS696')

    await useRemixStore.getState().fetchListing()

    expect(useRemixStore.getState().listingNotice).toContain('抓不到这条链接的图集')
    expect(useRemixStore.getState().listingLoading).toBe(false)
  })
})

describe('picking product assets', () => {
  it('drops an asset that is selected twice', () => {
    const remix = useRemixStore.getState()
    remix.toggleProductAsset('a1')
    remix.toggleProductAsset('a2')
    remix.toggleProductAsset('a1')

    expect(useRemixStore.getState().draft.productAssets.map((p) => p.assetId)).toEqual(['a2'])
  })

  it('records the angle chosen for one asset', () => {
    useRemixStore.getState().toggleProductAsset('a1')
    useRemixStore.getState().setProductAngle('a1', 'top-down')

    expect(useRemixStore.getState().draft.productAssets).toEqual([
      { assetId: 'a1', angle: 'top-down' },
    ])
  })

  it('asks for a front shot only while one is missing', () => {
    expect(selectNeedsFrontAsset(useRemixStore.getState())).toBe(false)

    useRemixStore.getState().toggleProductAsset('a1')
    expect(selectNeedsFrontAsset(useRemixStore.getState())).toBe(true)

    useRemixStore.getState().setProductAngle('a1', 'front')
    expect(selectNeedsFrontAsset(useRemixStore.getState())).toBe(false)
  })
})

describe('saving a set', () => {
  it('persists the draft and moves on to the briefs step', async () => {
    const remix = useRemixStore.getState()
    remix.setListingUrl('https://www.amazon.com/dp/B0FVLNS696')
    remix.addCompetitorImages(['i1'])
    remix.toggleProductAsset('a1')
    remix.setProductAngle('a1', 'front')
    remix.updateSettings({ platform: 'alibaba', language: 'en', level: 'low' })
    remix.setName('奶油浴缸')

    await useRemixStore.getState().saveAndContinue()

    const [stored] = await remixSetStore.list()
    expect(stored).toMatchObject({
      name: '奶油浴缸',
      source: {
        kind: 'competitor',
        listingUrl: 'https://www.amazon.com/dp/B0FVLNS696',
        competitorImageIds: ['i1'],
      },
      productAssets: [{ assetId: 'a1', angle: 'front' }],
      settings: { platform: 'alibaba', language: 'en', level: 'low' },
      shots: [],
    })
    expect(useRemixStore.getState().step).toBe(2)
    expect(useRemixStore.getState().activeSetId).toBe(stored?.id)
    expect(useRemixStore.getState().sets).toHaveLength(1)
  })

  it('refuses to save without a competitor image', async () => {
    await useRemixStore.getState().saveAndContinue()

    expect(await remixSetStore.list()).toEqual([])
    expect(useRemixStore.getState().step).toBe(1)
  })

  it('updates the set in place when it is saved again', async () => {
    useRemixStore.getState().addCompetitorImages(['i1'])
    await useRemixStore.getState().saveAndContinue()
    const savedId = useRemixStore.getState().activeSetId

    useRemixStore.getState().setName('改过名字')
    await useRemixStore.getState().saveAndContinue()

    const stored = await remixSetStore.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).toBe(savedId)
    expect(stored[0]?.name).toBe('改过名字')
  })

  it('reopens a saved set from the set list', async () => {
    useRemixStore.getState().addCompetitorImages(['i1'])
    useRemixStore.getState().setName('第一套')
    await useRemixStore.getState().saveAndContinue()
    const savedId = useRemixStore.getState().activeSetId ?? ''

    useRemixStore.getState().startNewSet()
    expect(useRemixStore.getState().draft.competitorImageIds).toEqual([])

    useRemixStore.getState().selectSet(savedId)
    expect(useRemixStore.getState().draft.name).toBe('第一套')
    expect(useRemixStore.getState().draft.competitorImageIds).toEqual(['i1'])
  })

  it('loads the saved sets from IndexedDB', async () => {
    useRemixStore.getState().addCompetitorImages(['i1'])
    await useRemixStore.getState().saveAndContinue()
    useRemixStore.setState({ sets: [] })

    await useRemixStore.getState().loadSets()

    expect(useRemixStore.getState().sets).toHaveLength(1)
  })
})

const SCENE_BRIEF: CompetitorBrief = {
  shotType: 'scene',
  composition: '浴缸居中偏左',
  camera: 'eye level, straight on',
  lighting: '窗口侧逆光',
  background: '奶油色微水泥浴室',
  props: ['地毯'],
  textZones: [],
  palette: ['#e8e0d4'],
  productBox: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 },
}

async function startSet(briefs: CompetitorBrief[] = [SCENE_BRIEF]) {
  const remix = useRemixStore.getState()
  remix.addCompetitorImages(['i1'])
  remix.toggleProductAsset('a-front')
  remix.setProductAngle('a-front', 'front')
  remix.updateProduct({
    name: 'W2753 浴缸',
    features: '蛋形单边斜背',
    mainColor: '哑光灰棕',
    forbiddenColors: ['米白', '浅灰'],
  })
  await useRemixStore.getState().saveAndContinue()
  analyzeCompetitorImages.mockResolvedValue(briefs)
}

function shots() {
  return useRemixStore.getState().draft.shots
}

describe('analysing the competitor images into shots', () => {
  it('writes one shot per competitor image with its brief and prompt', async () => {
    await startSet()

    await useRemixStore.getState().analyzeShots()

    expect(analyzeCompetitorImages).toHaveBeenCalledWith(['data:image/png;base64,i1'], {
      name: 'W2753 浴缸',
      description: '蛋形单边斜背。主色：哑光灰棕。不得出现的颜色：米白 / 浅灰',
    })
    expect(shots()).toHaveLength(1)
    expect(shots()[0]).toMatchObject({
      type: 'scene',
      competitorImageId: 'i1',
      brief: { composition: '浴缸居中偏左' },
      promptEdited: false,
      enabled: true,
      productImageId: 'p-front',
    })
    expect(shots()[0]?.prompt).toContain('必须保持哑光灰棕')
  })

  it('stores the erased competitor image as the reference and keeps the original', async () => {
    await startSet()

    await useRemixStore.getState().analyzeShots()

    expect(eraseProductArea).toHaveBeenCalledWith(
      'data:image/png;base64,i1',
      SCENE_BRIEF.productBox,
    )
    expect(shots()[0]?.referenceImageId).toBe('img-data:image/png;base64,erased')
    expect(shots()[0]?.competitorImageId).toBe('i1')
  })

  it('keeps the original as the reference when no product box came back', async () => {
    await startSet([{ ...SCENE_BRIEF, productBox: null }])

    await useRemixStore.getState().analyzeShots()

    expect(eraseProductArea).not.toHaveBeenCalled()
    expect(shots()[0]?.referenceImageId).toBe('i1')
  })

  it('refuses to enable a shot with no base image at that angle', async () => {
    await startSet([{ ...SCENE_BRIEF, camera: 'Top-down directly above' }])

    await useRemixStore.getState().analyzeShots()

    expect(shots()[0]?.productImageId).toBeUndefined()
    expect(shots()[0]?.enabled).toBe(false)

    useRemixStore.getState().updateShot(shots()[0]?.id ?? '', { enabled: true })
    expect(shots()[0]?.enabled).toBe(false)
  })

  it('leaves a spec diagram unchecked and without a prompt', async () => {
    await startSet([{ ...SCENE_BRIEF, shotType: 'spec-diagram' }])

    await useRemixStore.getState().analyzeShots()

    expect(shots()[0]).toMatchObject({ type: 'spec-diagram', enabled: false, prompt: '' })
  })

  it('explains the fallback and opens blank shots when the capability is off', async () => {
    await startSet()
    isClientCapabilityEnabled.mockReturnValue(false)

    await useRemixStore.getState().analyzeShots()

    expect(analyzeCompetitorImages).not.toHaveBeenCalled()
    expect(useRemixStore.getState().analyzeNotice).toContain('手写')
    expect(shots()).toHaveLength(1)
    expect(shots()[0]?.competitorImageId).toBe('i1')
  })

  it('keeps the shots it already has when the analysis fails', async () => {
    await startSet()
    await useRemixStore.getState().analyzeShots()
    const before = shots()[0]?.id

    analyzeCompetitorImages.mockRejectedValue(new Error('竞品图分析没有返回可用的简报'))
    await useRemixStore.getState().analyzeShots()

    expect(useRemixStore.getState().analyzeNotice).toContain('竞品图分析没有返回可用的简报')
    expect(shots()[0]?.id).toBe(before)
    expect(useRemixStore.getState().analyzing).toBe(false)
  })

  it('keeps the shots in the set record', async () => {
    await startSet()

    await useRemixStore.getState().analyzeShots()

    const [stored] = await remixSetStore.list()
    expect(stored?.shots).toHaveLength(1)
    expect(stored?.shots[0]?.prompt).toContain('必须保持哑光灰棕')
  })
})

describe('editing one shot', () => {
  it('rebuilds the prompt when a brief field changes', async () => {
    await startSet()
    await useRemixStore.getState().analyzeShots()
    const shotId = shots()[0]?.id ?? ''

    useRemixStore.getState().updateShot(shotId, { brief: { background: '木质日式汤屋' } })

    expect(shots()[0]?.prompt).toContain('木质日式汤屋')
    expect(shots()[0]?.promptEdited).toBe(false)
  })

  it('re-matches the base image when the camera field changes', async () => {
    await startSet()
    await useRemixStore.getState().analyzeShots()
    const shotId = shots()[0]?.id ?? ''

    useRemixStore.getState().updateShot(shotId, { brief: { camera: 'Top-down directly above' } })
    expect(shots()[0]?.productImageId).toBeUndefined()
    expect(shots()[0]?.enabled).toBe(false)
  })

  it('stops rebuilding the prompt once it was edited by hand', async () => {
    await startSet()
    await useRemixStore.getState().analyzeShots()
    const shotId = shots()[0]?.id ?? ''

    useRemixStore.getState().updateShot(shotId, { prompt: '我自己写的提示词' })
    useRemixStore.getState().updateShot(shotId, { brief: { background: '木质日式汤屋' } })

    expect(shots()[0]?.promptEdited).toBe(true)
    expect(shots()[0]?.prompt).toBe('我自己写的提示词')
  })

  it('takes the hand edit back when the prompt is regenerated', async () => {
    await startSet()
    await useRemixStore.getState().analyzeShots()
    const shotId = shots()[0]?.id ?? ''
    useRemixStore.getState().updateShot(shotId, { prompt: '我自己写的提示词' })

    useRemixStore.getState().resetShotPrompt(shotId)

    expect(shots()[0]?.promptEdited).toBe(false)
    expect(shots()[0]?.prompt).toContain('必须保持哑光灰棕')
  })

  it('adds the selling point copy to the prompt', async () => {
    await startSet([{ ...SCENE_BRIEF, shotType: 'selling-point' }])
    await useRemixStore.getState().analyzeShots()
    const shotId = shots()[0]?.id ?? ''

    useRemixStore.getState().updateShot(shotId, { copy: { title: '防滑底' } })

    expect(shots()[0]?.prompt).toContain('标题「防滑底」')
    expect(shots()[0]?.prompt).toContain('图上文案用中文')
  })

  it('saves the shots on the way to the generation step', async () => {
    await startSet()
    await useRemixStore.getState().analyzeShots()
    useRemixStore.getState().updateShot(shots()[0]?.id ?? '', { prompt: '我自己写的提示词' })

    await useRemixStore.getState().saveShotsAndContinue()

    const [stored] = await remixSetStore.list()
    expect(stored?.shots[0]?.prompt).toBe('我自己写的提示词')
    expect(useRemixStore.getState().step).toBe(3)
  })
})
