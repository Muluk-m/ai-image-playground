import type { BgSwapMode } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { jobActionLabels } from '../../../../features/productShots/lib/actions'
import type { ProductShotJob, ProductShotVersion } from '../../../../features/productShots/types'

function version(id: string, mode?: BgSwapMode): ProductShotVersion {
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
})
