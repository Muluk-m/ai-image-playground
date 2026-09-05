import { describe, expect, it } from 'vitest'
import { versionProgress } from '../../../../features/bgswap/lib/versionProgress'
import type { TaskRecord } from '../../../../types'

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    prompt: '换背景',
    params: { size: '1024x1024', quality: 'high', n: 1, output_format: 'png' } as never,
    inputImageIds: ['image-1'],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1_000,
    finishedAt: null,
    elapsed: null,
    ...patch,
  }
}

describe('reading a version state off the task record', () => {
  it('reports a running task with the moment it started', () => {
    expect(versionProgress(task())).toEqual({
      state: 'running',
      error: null,
      outputImageIds: [],
      startedAt: 1_000,
      elapsed: null,
    })
  })

  it('reports a finished task with its outputs and how long it took', () => {
    expect(
      versionProgress(
        task({ status: 'done', outputImages: ['out-1'], finishedAt: 4_000, elapsed: 3_000 }),
      ),
    ).toEqual({
      state: 'done',
      error: null,
      outputImageIds: ['out-1'],
      startedAt: null,
      elapsed: 3_000,
    })
  })

  it('carries the reason of a failed task', () => {
    expect(versionProgress(task({ status: 'error', error: '上游 429' }))).toMatchObject({
      state: 'error',
      error: '上游 429',
    })
  })

  it('reads a task that never recorded an elapsed time', () => {
    expect(versionProgress(task({ status: 'done', finishedAt: 5_500 })).elapsed).toBe(4_500)
  })

  it('queues a version whose task record is not around', () => {
    expect(versionProgress(undefined)).toMatchObject({ state: 'queued', elapsed: null })
  })
})
