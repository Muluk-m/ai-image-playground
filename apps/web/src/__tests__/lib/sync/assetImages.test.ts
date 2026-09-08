// @vitest-environment jsdom
import type { SyncRequestBody, SyncResponseBody } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetStore } from '../../../features/library/lib/assetStore'
import { templateStore } from '../../../features/library/lib/templateStore'
import { useLibraryStore } from '../../../features/library/store'
import type { AssetRecord } from '../../../features/library/types'
import { setClientStorageScope } from '../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../lib/clientCapabilities'
import { getImage, putImage } from '../../../lib/db'
import { ensureAssetImage } from '../../../lib/sync/assetImages'
import { startSyncEngine, syncNow } from '../../../lib/sync/engine'
import { readPendingChanges } from '../../../lib/sync/pending'
import { useSyncStatus } from '../../../lib/sync/status'
import { getAssetImage, postSync, putAssetImage } from '../../../lib/sync/syncClient'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'

vi.mock('../../../lib/sync/syncClient', () => ({
  postSync: vi.fn(),
  putAssetImage: vi.fn(),
  getAssetImage: vi.fn(),
  SyncRequestError: class extends Error {},
}))

const postSyncMock = vi.mocked(postSync)
const putAssetImageMock = vi.mocked(putAssetImage)
const getAssetImageMock = vi.mocked(getAssetImage)

const PIXEL = 'data:image/png;base64,AAAA'
const LOCAL_IMAGE = 'image-local'

/** jsdom 里 `storeImage` 会卡在缩略图那一步（Image 永远不触发 onload），直接写图片表。 */
function storeLocalImage(): Promise<unknown> {
  return putImage({ id: LOCAL_IMAGE, dataUrl: PIXEL, createdAt: 1 })
}

function response(overrides: Partial<SyncResponseBody> = {}): SyncResponseBody {
  return { version: 1, templates: [], assets: [], settings: null, rejected: [], ...overrides }
}

function asset(id: string, imageId: string): AssetRecord {
  return { id, name: id, imageId, createdAt: 1, updatedAt: 1, lastUsedAt: 1 }
}

function pushedAssetIds(call: number): string[] {
  const body = postSyncMock.mock.calls[call]?.[0] as SyncRequestBody
  return (body.assets ?? []).map((change) => change.id)
}

async function enableSync(sync: boolean): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        'accounts:login': true,
        'accounts:self-register': false,
        'accounts:sync': sync,
        'billing:credits': false,
        'generation:byok': true,
        'generation:video': false,
        'matte:server': false,
        'quota:daily': false,
        'remix:analyze': false,
        'remix:listing': false,
      }),
    ),
  )
  await bootstrapClientCapabilities(true, 'https://bff.example.com')
}

let stopEngine: (() => void) | null = null

beforeEach(async () => {
  await enableSync(true)
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  setClientStorageScope('alice')
  postSyncMock.mockReset()
  postSyncMock.mockResolvedValue(response())
  putAssetImageMock.mockReset()
  putAssetImageMock.mockResolvedValue('uploaded')
  getAssetImageMock.mockReset()
  getAssetImageMock.mockResolvedValue(null)
  useStore.setState({
    inputImages: [],
    prompt: '',
    params: { ...DEFAULT_PARAMS },
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  })
  useLibraryStore.setState({ assets: [], templates: [], panelOpen: false })
})

afterEach(async () => {
  stopEngine?.()
  stopEngine = null
  setClientStorageScope(null)
  vi.unstubAllGlobals()
  useSyncStatus.setState({ enabled: false, unsyncedImages: [], uploads: null })
  await bootstrapClientCapabilities(false, '')
})

async function startEngine(): Promise<void> {
  stopEngine = startSyncEngine()
  await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
}

describe('uploading an asset image', () => {
  it('sends the image the moment the asset is created, before the record goes up', async () => {
    await storeLocalImage()
    await startEngine()

    await assetStore.put(asset('a1', LOCAL_IMAGE))

    // 图先走：元数据的 debounce 还没到，图片本体已经在传了。
    await vi.waitFor(() => expect(putAssetImageMock).toHaveBeenCalledTimes(1))
    expect(postSyncMock).toHaveBeenCalledTimes(1)
    expect(putAssetImageMock.mock.calls[0]?.[0]).toBe(LOCAL_IMAGE)
    expect(putAssetImageMock.mock.calls[0]?.[1]?.type).toBe('image/png')

    await syncNow()

    expect(pushedAssetIds(1)).toEqual(['a1'])
    expect(readPendingChanges().assets).toEqual([])
  })

  it('sends the same image once however many assets name it', async () => {
    await storeLocalImage()
    await startEngine()

    await assetStore.put(asset('a1', LOCAL_IMAGE))
    await assetStore.put(asset('a2', LOCAL_IMAGE))
    await syncNow()

    expect(putAssetImageMock).toHaveBeenCalledTimes(1)
    expect(pushedAssetIds(1)).toEqual(['a1', 'a2'])
  })

  it('marks the asset unsynced and leaves it usable when the server refuses the image', async () => {
    await storeLocalImage()
    putAssetImageMock.mockResolvedValue('refused')
    await startEngine()

    await assetStore.put(asset('a1', LOCAL_IMAGE))
    await syncNow()

    expect(pushedAssetIds(1)).toEqual([])
    expect(useSyncStatus.getState().unsyncedImages).toEqual([LOCAL_IMAGE])
    expect(readPendingChanges().assets).toEqual([])
    expect(await assetStore.list()).toHaveLength(1)
  })

  it('counts the batch up as it sends the images one at a time', async () => {
    const gates: Array<() => void> = []
    putAssetImageMock.mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve('uploaded'))),
    )
    const ids = ['i1', 'i2', 'i3']
    for (const id of ids) await putImage({ id, dataUrl: PIXEL, createdAt: 1 })
    // 首次同步的形状：素材记录已经在本机，图一张都还没上去，待推集合由引擎自己铺开。
    await assetStore.applyRemote(ids.map((imageId, index) => asset(`a${index + 1}`, imageId)))

    stopEngine = startSyncEngine()

    for (let done = 0; done < ids.length; done += 1) {
      await vi.waitFor(() => expect(useSyncStatus.getState().uploads).toEqual({ done, total: 3 }))
      await vi.waitFor(() => expect(gates).toHaveLength(done + 1))
      gates[done]?.()
    }
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    expect(pushedAssetIds(0)).toEqual(['a1', 'a2', 'a3'])
    await vi.waitFor(() => expect(useSyncStatus.getState().uploads).toBeNull())
  })

  it('keeps the record pending when the upload fails on the network', async () => {
    await storeLocalImage()
    putAssetImageMock.mockRejectedValue(new Error('offline'))
    await startEngine()

    await assetStore.put(asset('a1', LOCAL_IMAGE))
    await syncNow()

    expect(pushedAssetIds(1)).toEqual([])
    expect(readPendingChanges().assets).toEqual(['a1'])
    expect(useSyncStatus.getState().unsyncedImages).toEqual([])
  })
})

describe('fetching an asset image another device uploaded', () => {
  it('downloads nothing while the app starts up', async () => {
    postSyncMock.mockResolvedValue(response({ assets: [asset('a1', 'image-remote')] }))

    await startEngine()
    await vi.waitFor(async () => expect(await assetStore.list()).toHaveLength(1))

    expect(getAssetImageMock).not.toHaveBeenCalled()
  })

  it('goes to the server once, then reads the image from this device', async () => {
    getAssetImageMock.mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )
    useSyncStatus.setState({ enabled: true })
    await assetStore.applyRemote([asset('a1', 'image-remote')])

    expect(await ensureAssetImage('image-remote')).toBe(true)
    expect(await ensureAssetImage('image-remote')).toBe(true)

    expect(getAssetImageMock).toHaveBeenCalledTimes(1)
    expect((await getImage('image-remote'))?.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('leaves an image no asset names alone', async () => {
    useSyncStatus.setState({ enabled: true })

    expect(await ensureAssetImage('image-of-a-generated-result')).toBe(false)

    expect(getAssetImageMock).not.toHaveBeenCalled()
  })

  it('stays off the network while the engine is not running', async () => {
    useSyncStatus.setState({ enabled: false })

    expect(await ensureAssetImage('image-remote')).toBe(false)

    expect(getAssetImageMock).not.toHaveBeenCalled()
  })

  it('fills in the image a template from another device references', async () => {
    getAssetImageMock.mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )
    useSyncStatus.setState({ enabled: true })
    await assetStore.applyRemote([asset('a1', 'image-remote')])
    await templateStore.applyRemote([
      {
        id: 't1',
        name: '海报',
        prompt: '用 {img:0} 出图',
        assetIds: ['a1'],
        params: { size: 'auto', quality: 'auto', n: 1 },
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      },
    ])
    await useLibraryStore.getState().loadAssets()
    await useLibraryStore.getState().loadTemplates()

    await useLibraryStore.getState().applyTemplate('t1')

    expect(useStore.getState().inputImages.map((image) => image.id)).toEqual(['image-remote'])
  })
})

describe('an asset whose image body is not on this device', () => {
  it('stays out of the first-sync push and out of the pending count', async () => {
    await storeLocalImage()
    await assetStore.applyRemote([asset('a1', 'image-remote'), asset('a2', LOCAL_IMAGE)])

    await startEngine()

    expect(pushedAssetIds(0)).toEqual(['a2'])
    expect(putAssetImageMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(readPendingChanges().assets).toEqual([]))
    expect(useSyncStatus.getState().pending).toBe(0)
  })

  it('leaves the pending set when the server rejects it as missing its image', async () => {
    postSyncMock.mockResolvedValueOnce(response({ assets: [asset('a1', 'image-remote')] }))
    await startEngine()
    postSyncMock.mockResolvedValue(
      response({ rejected: [{ collection: 'assets', id: 'a1', reason: 'asset_image_missing' }] }),
    )

    await assetStore.put({ ...asset('a1', 'image-remote'), name: '改过的名字' })
    await syncNow()

    expect(pushedAssetIds(1)).toEqual(['a1'])
    expect(readPendingChanges().assets).toEqual([])
    expect(useSyncStatus.getState().pending).toBe(0)
  })

  it('goes up on the next round once this device fetches the image', async () => {
    getAssetImageMock.mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )
    await assetStore.applyRemote([asset('a1', 'image-remote')])
    await startEngine()
    expect(pushedAssetIds(0)).toEqual([])

    expect(await ensureAssetImage('image-remote')).toBe(true)
    await syncNow()

    expect(pushedAssetIds(1)).toEqual(['a1'])
    await vi.waitFor(() => expect(readPendingChanges().assets).toEqual([]))
  })

  it('goes up on the next round when the image lands mid-push', async () => {
    await storeLocalImage()
    getAssetImageMock.mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )
    // 传 a2 的图这段时间里用户打开素材库，a1 的图被取回本机。
    putAssetImageMock.mockImplementation(async () => {
      await ensureAssetImage('image-remote')
      return 'uploaded'
    })
    await assetStore.applyRemote([asset('a1', 'image-remote'), asset('a2', LOCAL_IMAGE)])

    await startEngine()
    await vi.waitFor(() => expect(readPendingChanges().lastSyncedAt).not.toBeNull())

    expect(pushedAssetIds(0)).toEqual(['a2'])
    await syncNow()
    expect(pushedAssetIds(1)).toEqual(['a1'])
  })

  it('still pushes the tombstone when it is deleted while withheld', async () => {
    await assetStore.applyRemote([asset('a1', 'image-remote')])
    await startEngine()
    await vi.waitFor(() => expect(readPendingChanges().imagelessAssets).toEqual(['a1']))

    await assetStore.remove('a1')
    await syncNow()

    expect(pushedAssetIds(1)).toEqual(['a1'])
    expect(readPendingChanges().assets).toEqual([])
  })
})

describe('flushing on the way out', () => {
  it('pushes the metadata without waiting for an image upload', async () => {
    await storeLocalImage()
    putAssetImageMock.mockReturnValue(new Promise(() => {}))
    await startEngine()

    await assetStore.put(asset('a1', LOCAL_IMAGE))
    await templateStore.put({
      id: 't1',
      name: '海报',
      prompt: '出图',
      assetIds: [],
      params: { size: 'auto', quality: 'auto', n: 1 },
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))
    const body = postSyncMock.mock.calls[1]?.[0] as SyncRequestBody
    expect(body.templates?.map((change) => change.id)).toEqual(['t1'])
    expect(pushedAssetIds(1)).toEqual([])
  })
})
