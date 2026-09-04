import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bgSwapJobStore } from '../../../../features/bgswap/lib/bgSwapJobStore'
import type { BgSwapJobRecord } from '../../../../features/bgswap/types'

function makeJob(overrides: Partial<BgSwapJobRecord> = {}): BgSwapJobRecord {
  return {
    id: 'job1',
    name: '春季主图',
    images: [
      { imageId: 'image-1', versions: [] },
      { imageId: 'image-2', sourceUrl: 'https://m.media-amazon.com/images/I/1.jpg', versions: [] },
    ],
    preference: '北欧风，浅木色',
    versionsPerImage: 2,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('background swap job storage', () => {
  it('reads back what it wrote', async () => {
    await bgSwapJobStore.put(makeJob())

    expect(await bgSwapJobStore.list()).toEqual([makeJob()])
  })

  it('keeps the versions and the chosen one of an image', async () => {
    const version = { id: 'v1', taskId: 't1', plan: '浅木地面，左侧窗光', prompt: 'p', masked: true }
    await bgSwapJobStore.put(
      makeJob({ images: [{ imageId: 'image-1', versions: [version], chosenVersionId: 'v1' }] }),
    )

    const [job] = await bgSwapJobStore.list()
    expect(job?.images[0]?.versions).toEqual([version])
    expect(job?.images[0]?.chosenVersionId).toBe('v1')
  })

  it('replaces a job saved under the same id', async () => {
    await bgSwapJobStore.put(makeJob())
    await bgSwapJobStore.put(makeJob({ name: '春季主图 v2', updatedAt: 2000 }))

    const jobs = await bgSwapJobStore.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.name).toBe('春季主图 v2')
  })

  it('removes a job', async () => {
    await bgSwapJobStore.put(makeJob({ id: 'job1' }))
    await bgSwapJobStore.put(makeJob({ id: 'job2' }))

    await bgSwapJobStore.remove('job1')

    expect((await bgSwapJobStore.list()).map((job) => job.id)).toEqual(['job2'])
  })
})
