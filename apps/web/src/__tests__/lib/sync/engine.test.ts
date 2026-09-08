// @vitest-environment jsdom
import {
  SYNC_MAX_CHANGES_PER_COLLECTION,
  type SyncRequestBody,
  type SyncResponseBody,
} from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetStore } from '../../../features/library/lib/assetStore'
import { templateStore } from '../../../features/library/lib/templateStore'
import { useLibraryStore } from '../../../features/library/store'
import { setClientStorageScope } from '../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../lib/clientCapabilities'
import { putImage } from '../../../lib/db'
import { startSyncEngine } from '../../../lib/sync/engine'
import { readPendingChanges, writePendingChanges } from '../../../lib/sync/pending'
import { postSync } from '../../../lib/sync/syncClient'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'
import { allCapabilitiesOff } from '../../fixtures/capabilities'

vi.mock('../../../lib/sync/syncClient', () => ({
  postSync: vi.fn(),
  putAssetImage: vi.fn(async () => 'uploaded'),
  getAssetImage: vi.fn(async () => null),
  SyncRequestError: class extends Error {},
}))

const postSyncMock = vi.mocked(postSync)

// 显式标注成 TemplateRecord 会丢掉 params 的隐式索引签名，协议侧就收不下它。
function template(id: string, name: string, updatedAt = 10) {
  return {
    id,
    name,
    prompt: '一只猫',
    assetIds: [] as Array<string | null>,
    params: { size: 'auto', quality: 'auto' as const, n: 1 },
    createdAt: 1,
    updatedAt,
    lastUsedAt: 1,
  }
}

function asset(id: string, updatedAt = 10) {
  return { id, name: id, imageId: `image-${id}`, createdAt: 1, updatedAt, lastUsedAt: 1 }
}

function response(overrides: Partial<SyncResponseBody> = {}): SyncResponseBody {
  return { version: 1, templates: [], assets: [], settings: null, rejected: [], ...overrides }
}

async function setCapabilities(sync: boolean): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...allCapabilitiesOff(),
        'accounts:login': true,
        'accounts:sync': sync,
        'generation:byok': true,
      }),
    ),
  )
  await bootstrapClientCapabilities(true, 'https://bff.example.com')
}

let stopEngine: (() => void) | null = null

beforeEach(async () => {
  await setCapabilities(true)
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  setClientStorageScope('alice')
  postSyncMock.mockReset()
  postSyncMock.mockResolvedValue(response())
  useStore.setState({ params: { ...DEFAULT_PARAMS }, appMode: 'browse' })
  useStore.getState().setSettings({ enterSubmit: false })
  useLibraryStore.setState({ templates: [], assets: [] })
})

afterEach(async () => {
  stopEngine?.()
  stopEngine = null
  vi.useRealTimers()
  setClientStorageScope(null)
  vi.unstubAllGlobals()
  await bootstrapClientCapabilities(false, '')
})

describe('pulling on startup', () => {
  it('takes in a template another device created', async () => {
    postSyncMock.mockResolvedValue(response({ version: 4, templates: [template('t1', '海报')] }))

    stopEngine = startSyncEngine()

    await vi.waitFor(async () => {
      expect(await templateStore.list()).toHaveLength(1)
    })
    expect(useLibraryStore.getState().templates[0]?.name).toBe('海报')
    expect(readPendingChanges().version).toBe(4)
  })

  it('takes in the user settings another device changed', async () => {
    postSyncMock.mockResolvedValue(
      response({
        settings: {
          updatedAt: 20,
          document: { enterSubmit: true, appMode: 'product' },
        },
      }),
    )

    stopEngine = startSyncEngine()

    await vi.waitFor(() => {
      expect(useStore.getState().settings.enterSubmit).toBe(true)
    })
    expect(useStore.getState().appMode).toBe('product')
    // 回传的设置不算本机改动，不能再被推回去。
    expect(readPendingChanges().settingsUpdatedAt).toBeNull()
  })

  it('makes a record the server deleted disappear from the read path', async () => {
    await templateStore.applyRemote([template('t1', '海报')])
    postSyncMock.mockResolvedValue(
      response({ templates: [{ id: 't1', updatedAt: 30, deletedAt: 30 }] }),
    )

    stopEngine = startSyncEngine()

    await vi.waitFor(async () => {
      expect(await templateStore.list()).toEqual([])
    })
    expect(useLibraryStore.getState().templates).toEqual([])
  })

  it('sends the version it holds so an unchanged server returns nothing', async () => {
    postSyncMock.mockResolvedValue(response({ version: 9 }))
    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    stopEngine()

    stopEngine = startSyncEngine()

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))
    expect(postSyncMock.mock.calls[1]?.[0]).toMatchObject({ version: 9 })
  })
})

describe('pushing local changes', () => {
  it('pushes a saved template after the debounce and clears it from the pending set', async () => {
    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    // fake-indexeddb 靠 setImmediate 推进自己的事件循环，只能假掉 debounce 用的那个定时器。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await templateStore.put(template('t1', '海报'))
    expect(readPendingChanges().templates).toEqual(['t1'])

    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))

    const pushed = postSyncMock.mock.calls[1]?.[0] as SyncRequestBody
    expect(pushed.templates).toEqual([template('t1', '海报')])
    expect(readPendingChanges().templates).toEqual([])
  })

  it('pushes the user settings document after a local switch flips', async () => {
    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    useStore.getState().setSettings({ enterSubmit: true })
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))

    const pushed = postSyncMock.mock.calls[1]?.[0] as SyncRequestBody
    expect(pushed.settings?.document).toMatchObject({ enterSubmit: true })
    expect(readPendingChanges().settingsUpdatedAt).toBeNull()
  })

  it('flushes what is pending when the page hides', async () => {
    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))

    await templateStore.put(template('t1', '海报'))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))
    expect(postSyncMock.mock.calls[1]?.[1]).toEqual({ keepalive: true })
  })

  it('pushes what offline left pending as soon as the network comes back', async () => {
    postSyncMock.mockRejectedValue(new Error('offline'))
    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await templateStore.put(template('t1', '离线建的'))
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))

    postSyncMock.mockResolvedValue(response({ version: 3 }))
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(3))
    const pushed = postSyncMock.mock.calls[2]?.[0] as SyncRequestBody
    expect(pushed.templates?.map((change) => change.id)).toEqual(['t1'])
    await vi.waitFor(() => expect(readPendingChanges().templates).toEqual([]))
  })

  it('carries what one request could not hold in the next round', async () => {
    const ids = Array.from({ length: SYNC_MAX_CHANGES_PER_COLLECTION + 1 }, (_, i) => `t${i}`)
    await templateStore.applyRemote(ids.map((id) => template(id, id)))
    writePendingChanges({
      version: 0,
      templates: ids,
      assets: [],
      settingsUpdatedAt: null,
      lastSyncedAt: null,
      unsyncedImages: [],
      imagelessAssets: [],
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    expect((postSyncMock.mock.calls[0]?.[0] as SyncRequestBody).templates).toHaveLength(
      SYNC_MAX_CHANGES_PER_COLLECTION,
    )

    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))
    expect((postSyncMock.mock.calls[1]?.[0] as SyncRequestBody).templates).toHaveLength(1)
    await vi.waitFor(() => expect(readPendingChanges().templates).toEqual([]))
  })

  it('keeps offline changes pending and pushes them on the next run', async () => {
    postSyncMock.mockRejectedValue(new Error('offline'))
    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))

    await templateStore.put(template('t1', '离线建的'))
    expect(await templateStore.list()).toHaveLength(1)
    expect(readPendingChanges().templates).toEqual(['t1'])

    // 「重启」：引擎停掉再起，待推集合从 localStorage 读回来。
    stopEngine()
    postSyncMock.mockResolvedValue(response({ version: 2 }))
    stopEngine = startSyncEngine()

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))
    const pushed = postSyncMock.mock.calls[1]?.[0] as SyncRequestBody
    expect(pushed.templates?.map((change) => change.id)).toEqual(['t1'])
  })
})

describe('with the capability off', () => {
  it('never starts: no request, no dirty marks, no storage', async () => {
    const indexed = globalThis.indexedDB
    await setCapabilities(false)
    vi.stubGlobal('indexedDB', indexed)

    stopEngine = startSyncEngine()
    await templateStore.put(template('t1', '海报'))
    useStore.getState().setSettings({ enterSubmit: true })

    expect(postSyncMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('image-playground-sync:user-alice')).toBeNull()
  })
})

describe('first start on a scope that has never synced', () => {
  it('pushes the library and the user settings this device already had', async () => {
    // applyRemote 不标脏，正好摆出「引擎跑起来之前就已经在本机」的库。
    await templateStore.applyRemote([template('t1', '海报'), template('t2', '横幅')])
    await assetStore.applyRemote([asset('a1')])
    await putImage({ id: 'image-a1', dataUrl: 'data:image/png;base64,AAAA', createdAt: 1 })
    useStore.getState().setSettings({ enterSubmit: true })

    stopEngine = startSyncEngine()

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    const pushed = postSyncMock.mock.calls[0]?.[0] as SyncRequestBody
    expect(pushed.templates?.map((change) => change.id)).toEqual(['t1', 't2'])
    expect(pushed.assets?.map((change) => change.id)).toEqual(['a1'])
    expect(pushed.settings?.document).toMatchObject({ enterSubmit: true })
    // 这份设置从没有过时间戳，推上去也要输给服务端已有的那份。
    expect(pushed.settings?.updatedAt).toBe(1)
  })

  it('leaves a scope that already synced alone, whatever version it holds', async () => {
    await templateStore.applyRemote([template('t1', '海报')])
    writePendingChanges({ ...readPendingChanges(), lastSyncedAt: 1_700_000_000_000 })

    stopEngine = startSyncEngine()

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    const pushed = postSyncMock.mock.calls[0]?.[0] as SyncRequestBody
    expect(pushed.templates).toEqual([])
    expect(pushed.settings).toBeNull()
  })

  it('does not run again after the first push, logging out and back in included', async () => {
    await templateStore.applyRemote([template('t1', '海报')])

    stopEngine = startSyncEngine()
    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(readPendingChanges().templates).toEqual([]))
    stopEngine()

    // 退出登录保留本机这个 scope 的缓存，再登录回来引擎读到的是同一份检查点。
    setClientStorageScope(null)
    setClientStorageScope('alice')
    stopEngine = startSyncEngine()

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(2))
    const pushed = postSyncMock.mock.calls[1]?.[0] as SyncRequestBody
    expect(pushed.templates).toEqual([])
    expect(pushed.settings).toBeNull()
  })

  it('leaves records deleted before the first sync out of the push', async () => {
    await templateStore.applyRemote([
      template('t1', '海报'),
      { id: 't2', updatedAt: 5, deletedAt: 5 },
    ])

    stopEngine = startSyncEngine()

    await vi.waitFor(() => expect(postSyncMock).toHaveBeenCalledTimes(1))
    const pushed = postSyncMock.mock.calls[0]?.[0] as SyncRequestBody
    expect(pushed.templates?.map((change) => change.id)).toEqual(['t1'])
  })
})
