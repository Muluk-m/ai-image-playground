// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../features/library/store'
import { useStore } from '../../../store'

function imageFile(name: string, type = 'image/png'): File {
  return new File(['x'], name, { type })
}

/** jsdom 不去解码 data URL，`new Image()` 既不 onload 也不 onerror，缩略图那步会永远挂住。 */
class NeverDecodingImage {
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.())
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Image', NeverDecodingImage)
  useStore.setState({ inputImages: [], showToast: vi.fn() })
  useLibraryStore.setState({ assets: [], pendingAssetNames: [], onLibraryPage: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('importing local image files as assets', () => {
  it('queues one naming per image, defaulting to the file name without its extension', async () => {
    await useLibraryStore
      .getState()
      .importAssetFiles([imageFile('产品白底图.png'), imageFile('场景.a.jpeg', 'image/jpeg')])

    expect(useLibraryStore.getState().pendingAssetNames.map((p) => p.defaultName)).toEqual([
      '产品白底图',
      '场景.a',
    ])
  })

  it('skips files that are not images', async () => {
    await useLibraryStore.getState().importAssetFiles([imageFile('说明.txt', 'text/plain')])

    expect(useLibraryStore.getState().pendingAssetNames).toEqual([])
  })

  it('stores the image so the named asset survives a reload', async () => {
    await useLibraryStore.getState().importAssetFiles([imageFile('白底图.png')])
    const [pending] = useLibraryStore.getState().pendingAssetNames

    await useLibraryStore.getState().saveAsset(pending.imageId, pending.defaultName)

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    expect(useLibraryStore.getState().assets).toEqual([
      expect.objectContaining({
        name: '白底图',
        views: [{ imageId: pending.imageId, label: 'none', source: 'upload' }],
      }),
    ])
  })

  it('hands the saved asset back to whoever asked for the import', async () => {
    const onSaved = vi.fn()
    await useLibraryStore.getState().importAssetFiles([imageFile('白底图.png')], { onSaved })
    const [pending] = useLibraryStore.getState().pendingAssetNames

    await useLibraryStore.getState().saveAsset(pending.imageId, '白底图')

    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: '白底图' }))
  })

  it('moves on to the next image once one is named', async () => {
    await useLibraryStore
      .getState()
      .importAssetFiles([imageFile('第一张.png'), imageFile('第二张.png')])
    const [first] = useLibraryStore.getState().pendingAssetNames

    await useLibraryStore.getState().saveAsset(first.imageId, '白底图')

    expect(useLibraryStore.getState().pendingAssetNames.map((p) => p.defaultName)).toEqual([
      '第二张',
    ])
  })

  it('makes one multi-view asset out of a grouped import instead of a naming queue', async () => {
    await useLibraryStore
      .getState()
      .importAssetFiles([imageFile('正面.png'), imageFile('侧面.png')], {
        group: true,
        kind: 'product',
        name: '橘猫玩偶',
      })

    expect(useLibraryStore.getState().pendingAssetNames).toEqual([])
    const [asset] = useLibraryStore.getState().assets
    expect(asset).toMatchObject({ name: '橘猫玩偶', kind: 'product' })
    expect(asset?.views).toHaveLength(2)
    expect(asset?.views.every((view) => view.label === 'none' && view.source === 'upload')).toBe(
      true,
    )
  })

  it('falls back to the first file name when a grouped import has no name', async () => {
    await useLibraryStore
      .getState()
      .importAssetFiles([imageFile('第一张.png'), imageFile('第二张.png')], { group: true })

    expect(useLibraryStore.getState().assets[0]?.name).toBe('第一张')
  })
})
