import { describe, expect, it } from 'vitest'
import {
  actionLabel,
  jobActionLabels,
  type ProductShotAction,
} from '../../../../features/productShots/lib/actions'
import type { ProductShotJob, ProductShotVersion } from '../../../../features/productShots/types'

function version(id: string, mode?: ProductShotAction): ProductShotVersion {
  return {
    id,
    taskId: `task-${id}`,
    plan: '方案',
    prompt: '提示词',
    masked: true,
    ...(mode ? { mode } : {}),
    createdAt: 1,
  }
}

function job(versions: ProductShotVersion[][]): ProductShotJob {
  return {
    id: 'job-1',
    name: '折叠浴缸',
    images: versions.map((list, index) => ({ imageId: `img-${index}`, versions: list })),
    preference: '',
    versionsPerImage: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('summarising the actions a job ran', () => {
  it('has nothing to say about a job that is gone', () => {
    expect(jobActionLabels(undefined)).toEqual([])
  })

  it('lists each action once however many versions ran it', () => {
    expect(
      jobActionLabels(
        job([
          [version('a', 'background'), version('b', 'background')],
          [version('c', 'replace-product')],
        ]),
      ),
    ).toEqual(['换背景', '换产品'])
  })

  it('orders the labels by the action enum, not by when they ran', () => {
    expect(
      jobActionLabels(job([[version('a', 'replace-product')], [version('b', 'background')]])),
    ).toEqual(['换背景', '换产品'])
  })

  /** 老记录的版本没存动作，那时只能换背景。 */
  it('reads a version without an action as a background swap', () => {
    expect(jobActionLabels(job([[version('a')]]))).toEqual(['换背景'])
  })

  it('says nothing for a job that has not run a version yet', () => {
    expect(jobActionLabels(job([[]]))).toEqual([])
  })

  it('lists the creative remix alongside the swaps', () => {
    expect(jobActionLabels(job([[version('a', 'remix')], [version('b', 'background')]]))).toEqual([
      '换背景',
      '借创意重做',
    ])
  })
})

describe('labelling the action a version was run with', () => {
  it('names the action and, for a remix, how far it went from the competitor', () => {
    expect(actionLabel('remix', 'high')).toBe('借创意重做 · 不像')
    expect(actionLabel('remix', 'low')).toBe('借创意重做 · 像')
  })

  it('names the other actions on their own', () => {
    expect(actionLabel('replace-product', undefined)).toBe('换产品')
    expect(actionLabel('replace-and-background', undefined)).toBe('换产品并换背景')
  })

  it('reads a record from before the field as a background swap', () => {
    expect(actionLabel(undefined, undefined)).toBe('换背景')
  })
})
