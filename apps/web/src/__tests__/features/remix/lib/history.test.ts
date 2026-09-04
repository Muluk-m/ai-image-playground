import { describe, expect, it } from 'vitest'
import { groupTasksBySet } from '../../../../features/remix/lib/history'
import type { TaskOrigin, TaskRecord } from '../../../../types'

function task(id: string, createdAt: number, origin?: TaskOrigin): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt,
    finishedAt: null,
    elapsed: null,
    ...(origin ? { origin } : {}),
  }
}

describe('folding the history into sets', () => {
  it('leaves tasks without an origin on their own', () => {
    const tasks = [task('t2', 2), task('t1', 1)]

    expect(groupTasksBySet(tasks)).toEqual([
      { kind: 'task', task: tasks[0] },
      { kind: 'task', task: tasks[1] },
    ])
  })

  it('folds every task of one set into a single entry', () => {
    const a1 = task('a1', 5, { setId: 'set-a', shotId: 's1' })
    const a2 = task('a2', 3, { setId: 'set-a', shotId: 's2' })
    const loose = task('x', 4)

    const items = groupTasksBySet([a1, loose, a2])

    expect(items).toEqual([
      { kind: 'set', setId: 'set-a', tasks: [a1, a2] },
      { kind: 'task', task: loose },
    ])
  })

  it('keeps two sets apart', () => {
    const a = task('a', 5, { setId: 'set-a', shotId: 's1' })
    const b = task('b', 6, { setId: 'set-b', shotId: 's1' })

    expect(groupTasksBySet([b, a]).map((item) => item.kind === 'set' && item.setId)).toEqual([
      'set-b',
      'set-a',
    ])
  })

  it('places a set where its newest task sits', () => {
    const older = task('a1', 1, { setId: 'set-a', shotId: 's1' })
    const newer = task('a2', 9, { setId: 'set-a', shotId: 's2' })
    const loose = task('x', 5)

    const items = groupTasksBySet([newer, loose, older])

    expect(items[0]).toMatchObject({ kind: 'set', setId: 'set-a' })
    expect(items[1]).toMatchObject({ kind: 'task' })
  })
})
