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
}))

function image(name: string): File {
  return new File(['x'], name, { type: 'image/png' })
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ showToast: vi.fn() })
  useBgSwapStore.setState({ jobs: [] })
  useBgSwapStore.getState().startNewJob()
  isClientCapabilityEnabled.mockReturnValue(true)
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
