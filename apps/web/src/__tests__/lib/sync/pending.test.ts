// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetStore } from '../../../features/library/lib/assetStore'
import { templateStore } from '../../../features/library/lib/templateStore'
import type { AssetRecord } from '../../../features/library/types'
import { setClientStorageScope } from '../../../lib/authScope'
import {
  markSettingsDirty,
  readPendingChanges,
  trackLocalChanges,
  writePendingChanges,
} from '../../../lib/sync/pending'

function asset(id: string): AssetRecord {
  return { id, name: id, imageId: `image-${id}`, createdAt: 1, updatedAt: 1, lastUsedAt: 1 }
}

let stopTracking: (() => void) | null = null

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  setClientStorageScope('alice')
})

afterEach(() => {
  stopTracking?.()
  stopTracking = null
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})

describe('pending changes while the engine runs', () => {
  it('marks a saved asset and a deleted template, and survives a restart', async () => {
    stopTracking = trackLocalChanges(() => {})

    await assetStore.put(asset('asset-1'))
    await templateStore.remove('template-1')

    expect(readPendingChanges().assets).toEqual(['asset-1'])
    expect(readPendingChanges().templates).toEqual(['template-1'])

    // 「重启」：进程内状态全丢，只剩 localStorage。
    expect(
      JSON.parse(localStorage.getItem('image-playground-sync:user-alice') ?? '{}'),
    ).toMatchObject({ assets: ['asset-1'], templates: ['template-1'] })
  })

  it('notifies the engine on every local write, repeats included', async () => {
    const notify = vi.fn()
    stopTracking = trackLocalChanges(notify)

    await assetStore.put(asset('asset-1'))
    await assetStore.put({ ...asset('asset-1'), name: '改过名' })

    expect(notify).toHaveBeenCalledTimes(2)
    expect(readPendingChanges().assets).toEqual(['asset-1'])
  })

  it('stamps the settings document when it changes locally', () => {
    stopTracking = trackLocalChanges(() => {})

    markSettingsDirty(1_700_000_000_000)

    expect(readPendingChanges().settingsUpdatedAt).toBe(1_700_000_000_000)
  })

  it('leaves records the server sent back unmarked', async () => {
    stopTracking = trackLocalChanges(() => {})

    await assetStore.applyRemote([asset('from-server')])

    expect(readPendingChanges().assets).toEqual([])
    expect(await assetStore.list()).toHaveLength(1)
  })
})

describe('pending changes while the engine is off', () => {
  it('writes nothing at all', async () => {
    await assetStore.put(asset('asset-1'))
    await templateStore.remove('template-1')
    markSettingsDirty(1_700_000_000_000)

    expect(localStorage.getItem('image-playground-sync:user-alice')).toBeNull()
    expect(readPendingChanges().assets).toEqual([])
  })
})

describe('the checkpoint', () => {
  it('keeps each scope apart', () => {
    writePendingChanges({ ...readPendingChanges(), version: 7 })

    setClientStorageScope('bob')
    expect(readPendingChanges().version).toBe(0)

    setClientStorageScope('alice')
    expect(readPendingChanges().version).toBe(7)
  })

  it('falls back to an empty checkpoint on corrupted storage', () => {
    localStorage.setItem('image-playground-sync:user-alice', '{not json')

    expect(readPendingChanges()).toEqual({
      version: 0,
      templates: [],
      assets: [],
      settingsUpdatedAt: null,
      lastSyncedAt: null,
      unsyncedImages: [],
      imagelessAssets: [],
    })
  })
})
