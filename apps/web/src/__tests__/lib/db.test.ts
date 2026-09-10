import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BASE_DB_NAME,
  openNamedDb,
  STORE_ASSETS,
  STORE_STORYBOARDS,
  STORE_TEMPLATES,
} from '../../lib/db'

/** updatedAt 之前的库：只有 assets / templates 两张表，记录不带 updatedAt。 */
function seedLegacyDb(records: Record<string, Array<Record<string, unknown>>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BASE_DB_NAME, 7)
    request.onupgradeneeded = () => {
      for (const store of [STORE_ASSETS, STORE_TEMPLATES]) {
        request.result.createObjectStore(store, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction([STORE_ASSETS, STORE_TEMPLATES], 'readwrite')
      for (const [store, rows] of Object.entries(records)) {
        for (const row of rows) tx.objectStore(store).put(row)
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  })
}

/** version 之前的分镜：默认播到整条视频之前那一版。 */
function seedLegacyStoryboard(record: Record<string, unknown>, version = 9): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BASE_DB_NAME, version)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_STORYBOARDS, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(STORE_STORYBOARDS, 'readwrite')
      tx.objectStore(STORE_STORYBOARDS).put(record)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  })
}

async function readAll(store: string): Promise<Array<Record<string, unknown>>> {
  const db = await openNamedDb(BASE_DB_NAME)
  const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('upgrading a database written before updatedAt existed', () => {
  it('backfills updatedAt from createdAt on assets and templates', async () => {
    await seedLegacyDb({
      [STORE_ASSETS]: [
        { id: 'a1', name: '白底图', imageId: 'i1', createdAt: 1000, lastUsedAt: 2000 },
      ],
      [STORE_TEMPLATES]: [
        { id: 't1', name: '锁产品前缀', prompt: '换背景', assetIds: [], createdAt: 3000 },
      ],
    })

    expect(await readAll(STORE_ASSETS)).toEqual([
      {
        id: 'a1',
        name: '白底图',
        imageId: 'i1',
        createdAt: 1000,
        updatedAt: 1000,
        lastUsedAt: 2000,
      },
    ])
    expect(await readAll(STORE_TEMPLATES)).toEqual([
      {
        id: 't1',
        name: '锁产品前缀',
        prompt: '换背景',
        assetIds: [],
        createdAt: 3000,
        updatedAt: 3000,
      },
    ])
  })

  it('leaves records that already carry updatedAt alone', async () => {
    await seedLegacyDb({
      [STORE_ASSETS]: [{ id: 'a1', createdAt: 1000, updatedAt: 5000, lastUsedAt: 2000 }],
    })

    expect((await readAll(STORE_ASSETS))[0].updatedAt).toBe(5000)
  })
})

describe('upgrading a storyboard written before whole-video generation', () => {
  it('lays a timeline over the shots and writes one whole-video prompt', async () => {
    await seedLegacyStoryboard({
      id: 'board-1',
      summary: '两镜讲清一杯冰饮',
      shots: [
        { no: 1, description: '空杯静置', camera: '缓慢推进', seconds: 5 },
        { no: 2, description: '气泡水注入', camera: '手持跟拍', seconds: 5 },
      ],
    })

    expect((await readAll(STORE_STORYBOARDS))[0]).toEqual({
      id: 'board-1',
      summary: '两镜讲清一杯冰饮',
      totalSeconds: 10,
      videoPrompt:
        '两镜讲清一杯冰饮\n镜头1（0-5秒）：空杯静置，缓慢推进\n镜头2（5-10秒）：气泡水注入，手持跟拍',
      shotImagesRequested: true,
      videoTaskId: null,
      referenceImageIds: [],
      shots: [
        { no: 1, description: '空杯静置', camera: '缓慢推进', seconds: 5, startSeconds: 0 },
        { no: 2, description: '气泡水注入', camera: '手持跟拍', seconds: 5, startSeconds: 5 },
      ],
    })
  })

  it('leaves the shots of a storyboard that already carries a whole-video prompt alone', async () => {
    await seedLegacyStoryboard({ id: 'board-1', videoPrompt: '写好的整条提示词', shots: [] })

    expect((await readAll(STORE_STORYBOARDS))[0]).toEqual({
      id: 'board-1',
      videoPrompt: '写好的整条提示词',
      referenceImageIds: [],
      shots: [],
    })
  })
})

describe('upgrading a storyboard written when there was one reference image', () => {
  it('turns the single reference into a one-element list', async () => {
    await seedLegacyStoryboard(
      { id: 'board-1', videoPrompt: '写好的整条提示词', referenceImageId: 'ref-1', shots: [] },
      10,
    )

    expect((await readAll(STORE_STORYBOARDS))[0]).toEqual({
      id: 'board-1',
      videoPrompt: '写好的整条提示词',
      referenceImageIds: ['ref-1'],
      shots: [],
    })
  })

  it('turns a storyboard that had no reference into an empty list', async () => {
    await seedLegacyStoryboard(
      { id: 'board-1', videoPrompt: '写好的整条提示词', referenceImageId: null, shots: [] },
      10,
    )

    expect((await readAll(STORE_STORYBOARDS))[0]!.referenceImageIds).toEqual([])
  })

  it('carries a pre-timeline storyboard through both upgrades in one pass', async () => {
    await seedLegacyStoryboard({
      id: 'board-1',
      summary: '两镜讲清一杯冰饮',
      referenceImageId: 'ref-1',
      shots: [{ no: 1, description: '空杯静置', camera: '缓慢推进', seconds: 5 }],
    })

    expect((await readAll(STORE_STORYBOARDS))[0]).toMatchObject({
      referenceImageIds: ['ref-1'],
      totalSeconds: 5,
      videoPrompt: '两镜讲清一杯冰饮\n镜头1（0-5秒）：空杯静置，缓慢推进',
    })
  })
})
