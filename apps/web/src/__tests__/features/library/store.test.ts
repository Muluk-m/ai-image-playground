import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectVisibleAssets, useLibraryStore } from '../../../features/library/store'
import { storeImage } from '../../../lib/db'
import { useStore } from '../../../store'

const IMAGE_A = 'data:image/png;base64,AAAA'
const IMAGE_B = 'data:image/png;base64,BBBB'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ inputImages: [], prompt: '' })
  useLibraryStore.setState({ assets: [], searchKeyword: '', panelOpen: false, tab: 'assets' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saving an asset', () => {
  it('keeps the name and image id, and survives a reload', async () => {
    const imageId = await storeImage(IMAGE_A)

    await useLibraryStore.getState().saveAsset(imageId, '产品白底图')

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    const [asset] = useLibraryStore.getState().assets
    expect(asset.name).toBe('产品白底图')
    expect(asset.imageId).toBe(imageId)
  })

  it('refuses a blank name', async () => {
    const imageId = await storeImage(IMAGE_A)

    await useLibraryStore.getState().saveAsset(imageId, '   ')

    expect(useLibraryStore.getState().assets).toEqual([])
  })

  it('lets one image carry several names', async () => {
    const imageId = await storeImage(IMAGE_A)

    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    await useLibraryStore.getState().saveAsset(imageId, '主图')

    const assets = useLibraryStore.getState().assets
    expect(assets.map((asset) => asset.name).sort()).toEqual(['主图', '白底图'])
    expect(assets.every((asset) => asset.imageId === imageId)).toBe(true)
  })
})

describe('attaching an asset', () => {
  it('adds the image to the reference strip', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().attachAsset(asset.id)

    expect(useStore.getState().inputImages).toEqual([{ id: imageId, dataUrl: IMAGE_A }])
  })

  it('does not add the same image twice and reuses its position', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    await useLibraryStore.getState().saveAsset(imageId, '主图')
    const [first, second] = useLibraryStore.getState().assets

    expect(await useLibraryStore.getState().attachAsset(first.id)).toBe(0)
    expect(await useLibraryStore.getState().attachAsset(second.id)).toBe(0)
    expect(useStore.getState().inputImages).toHaveLength(1)
  })

  it('returns the position it landed at behind existing reference images', async () => {
    const idA = await storeImage(IMAGE_A)
    const idB = await storeImage(IMAGE_B)
    useStore.getState().addInputImage({ id: idA, dataUrl: IMAGE_A })
    await useLibraryStore.getState().saveAsset(idB, '场景图')

    expect(
      await useLibraryStore.getState().attachAsset(useLibraryStore.getState().assets[0].id),
    ).toBe(1)
  })

  it('records the last use', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')

    now.mockReturnValue(5000)
    await useLibraryStore.getState().attachAsset(useLibraryStore.getState().assets[0].id)

    expect(useLibraryStore.getState().assets[0].lastUsedAt).toBe(5000)
  })
})

describe('managing assets', () => {
  it('renames one', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '旧名字')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().renameAsset(asset.id, '新名字')

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    expect(useLibraryStore.getState().assets[0].name).toBe('新名字')
  })

  it('keeps the old name when the new one is blank', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '旧名字')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().renameAsset(asset.id, '  ')

    expect(useLibraryStore.getState().assets[0].name).toBe('旧名字')
  })

  it('deletes one without touching the image', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().deleteAsset(asset.id)

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    expect(useLibraryStore.getState().assets).toEqual([])
    await expect(useLibraryStore.getState().attachAsset(asset.id)).resolves.toBeNull()
    expect(useStore.getState().inputImages).toEqual([])
  })
})

describe('browsing assets', () => {
  it('lists the most recently used first and filters by name', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    const idA = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(idA, '白底图')
    now.mockReturnValue(2000)
    const idB = await storeImage(IMAGE_B)
    await useLibraryStore.getState().saveAsset(idB, '场景图')

    expect(selectVisibleAssets(useLibraryStore.getState()).map((asset) => asset.name)).toEqual([
      '场景图',
      '白底图',
    ])

    useLibraryStore.getState().setSearch('白底')
    expect(selectVisibleAssets(useLibraryStore.getState()).map((asset) => asset.name)).toEqual([
      '白底图',
    ])
  })
})
