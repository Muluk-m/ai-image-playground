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
  useSyncStatus.setState({ enabled: false, unsyncedImages: [] })
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

    expect(await ensureAssetImage('image-remote')).toBe(true)
    expect(await ensureAssetImage('image-remote')).toBe(true)

    expect(getAssetImageMock).toHaveBeenCalledTimes(1)
    expect((await getImage('image-remote'))?.dataUrl).toMatch(/^data:image\/png;base64,/)
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
