import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remixSetStore } from '../../../features/remix/lib/remixSetStore'
import { selectNeedsFrontAsset, useRemixStore } from '../../../features/remix/store'
import { useStore } from '../../../store'

const fetchListingImages = vi.hoisted(() => vi.fn())
const storeImageFromUrl = vi.hoisted(() => vi.fn())
const isClientCapabilityEnabled = vi.hoisted(() => vi.fn())

vi.mock('../../../features/remix/lib/listingClient', () => ({
  fetchListingImages,
  listingImageProxyUrl: (url: string) => `/api/remix/image?url=${encodeURIComponent(url)}`,
}))

vi.mock('../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled,
}))

vi.mock('../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store')>()),
  storeImageFromUrl,
}))

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useRemixStore.getState().startNewSet()
  useRemixStore.setState({ sets: [] })
  isClientCapabilityEnabled.mockReturnValue(true)
  storeImageFromUrl.mockImplementation(async (url: string) => ({ id: `img-${url}`, dataUrl: '' }))
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
      source: { listingUrl: 'https://www.amazon.com/dp/B0FVLNS696', competitorImageIds: ['i1'] },
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
