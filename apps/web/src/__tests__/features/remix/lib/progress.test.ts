import { describe, expect, it } from 'vitest'
import { indexTasksById, setProgress, shotProgress } from '../../../../features/remix/lib/progress'
import type { TaskRecord } from '../../../../types'

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
    ...patch,
  }
}

const NO_QUEUE: string[] = []

describe('deriving one shot state from the task records', () => {
  it('reports a shot that was never submitted as idle', () => {
    expect(shotProgress({ id: 'shot-1', taskIds: [] }, new Map(), NO_QUEUE)).toMatchObject({
      state: 'idle',
    })
  })

  it('reports a shot that is waiting for its turn as queued', () => {
    expect(shotProgress({ id: 'shot-1', taskIds: [] }, new Map(), ['shot-1'])).toMatchObject({
      state: 'queued',
    })
  })

  it('reports a running task as running', () => {
    const tasks = indexTasksById([task('t1')])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1'] }, tasks, NO_QUEUE)).toMatchObject({
      state: 'running',
    })
  })

  it('collects the output images of a finished shot', () => {
    const tasks = indexTasksById([task('t1', { status: 'done', outputImages: ['o1', 'o2'] })])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1'] }, tasks, NO_QUEUE)).toMatchObject({
      state: 'done',
      error: null,
      outputImageIds: ['o1', 'o2'],
    })
  })

  it('carries the reason a shot failed', () => {
    const tasks = indexTasksById([task('t1', { status: 'error', error: '上游 429' })])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1'] }, tasks, NO_QUEUE)).toMatchObject({
      state: 'error',
      error: '上游 429',
    })
  })

  it('stays running while one of several tasks is still going', () => {
    const tasks = indexTasksById([task('t1', { status: 'error', error: 'x' }), task('t2')])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1', 't2'] }, tasks, NO_QUEUE)).toMatchObject({
      state: 'running',
    })
  })

  it('times a running shot from the earliest submission', () => {
    const tasks = indexTasksById([
      task('t1', { createdAt: 3_000 }),
      task('t2', { createdAt: 1_000 }),
    ])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1', 't2'] }, tasks, NO_QUEUE)).toMatchObject({
      startedAt: 1_000,
      elapsed: null,
    })
  })

  it('reports the total span of a finished shot', () => {
    const tasks = indexTasksById([
      task('t1', { status: 'done', createdAt: 1_000, finishedAt: 9_000, elapsed: 8_000 }),
      task('t2', { status: 'done', createdAt: 2_000, finishedAt: 5_000, elapsed: 3_000 }),
    ])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1', 't2'] }, tasks, NO_QUEUE)).toMatchObject({
      startedAt: null,
      elapsed: 8_000,
    })
  })

  it('leaves the span unknown when no task ever finished', () => {
    const tasks = indexTasksById([task('t1', { status: 'done', createdAt: 1_000 })])

    expect(shotProgress({ id: 'shot-1', taskIds: ['t1'] }, tasks, NO_QUEUE)).toMatchObject({
      elapsed: null,
    })
  })

  it('leaves an untouched shot without any timing', () => {
    expect(shotProgress({ id: 'shot-1', taskIds: [] }, new Map(), ['shot-1'])).toMatchObject({
      startedAt: null,
      elapsed: null,
    })
  })

  it('falls back to idle when the task record was deleted', () => {
    expect(shotProgress({ id: 'shot-1', taskIds: ['gone'] }, new Map(), NO_QUEUE)).toMatchObject({
      state: 'idle',
    })
  })
})

describe('summarising a whole set', () => {
  it('counts the shots that finished out of the ones that will run', () => {
    const tasks = indexTasksById([
      task('t1', { status: 'done', outputImages: ['o1'] }),
      task('t2', { status: 'error', error: 'x' }),
      task('t3'),
    ])
    const shots = [
      { id: 's1', enabled: true, taskIds: ['t1'] },
      { id: 's2', enabled: true, taskIds: ['t2'] },
      { id: 's3', enabled: true, taskIds: ['t3'] },
      { id: 's4', enabled: false, taskIds: [] },
    ]

    expect(setProgress(shots, tasks, NO_QUEUE)).toEqual({ total: 3, done: 1, error: 1, running: 1 })
  })
})
