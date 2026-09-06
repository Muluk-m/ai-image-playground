import { describe, expect, it } from 'vitest'
import {
  batchDoneCount,
  pendingBatchImageIds,
  skippedDiagramImageIds,
} from '../../../../features/bgswap/lib/batch'
import type { BgSwapImage, BgSwapVersion } from '../../../../features/bgswap/types'

function version(id: string): BgSwapVersion {
  return { id, taskId: `task-${id}`, plan: '木质浴室', prompt: 'p', masked: true, createdAt: 1 }
}

function image(imageId: string, patch: Partial<BgSwapImage> = {}): BgSwapImage {
  return { imageId, versions: [], ...patch }
}

describe('picking the images a batch run should cover', () => {
  it('leaves out the sample the user is tuning on', () => {
    const images = [image('a'), image('b'), image('c')]

    expect(pendingBatchImageIds(images, 'a')).toEqual(['b', 'c'])
  })

  it('leaves out an image that already has a chosen version', () => {
    const images = [image('a'), image('b', { versions: [version('v1')], chosenVersionId: 'v1' })]

    expect(pendingBatchImageIds(images, 'a')).toEqual([])
  })

  /** 刷新会丢掉内存里的批量进度，靠版本判断跑没跑过，否则再点一次会给它们叠版本。 */
  it('leaves out an image the last run already produced versions for', () => {
    const images = [image('a'), image('b', { versions: [version('v1')] }), image('c')]

    expect(pendingBatchImageIds(images, 'a')).toEqual(['c'])
  })

  it('covers every image when no sample is selected', () => {
    expect(pendingBatchImageIds([image('a'), image('b')], null)).toEqual(['a', 'b'])
  })

  /** 试点里示意图与卖点拼图被换背景毁掉了内容，所以批量默认放过它们。 */
  it('leaves out the images that carry explanatory text', () => {
    const images = [
      image('a'),
      image('b', { sceneType: 'infographic' }),
      image('c', { sceneType: 'callout' }),
      image('d', { sceneType: 'collage' }),
      image('e', { sceneType: 'photo' }),
      image('f'),
    ]

    expect(pendingBatchImageIds(images, 'a')).toEqual(['e', 'f'])
    expect(skippedDiagramImageIds(images, 'a')).toEqual(['b', 'c', 'd'])
  })

  it('counts no skips among images the batch would not touch anyway', () => {
    const images = [
      image('a', { sceneType: 'infographic' }),
      image('b', { sceneType: 'collage', versions: [version('v1')] }),
    ]

    expect(skippedDiagramImageIds(images, 'a')).toEqual([])
  })
})

describe('reading the batch progress', () => {
  it('counts the images that are past running', () => {
    expect(
      batchDoneCount([
        { imageId: 'a', state: 'done', error: null },
        { imageId: 'b', state: 'error', error: '抠图超时' },
        { imageId: 'c', state: 'running', error: null },
        { imageId: 'd', state: 'pending', error: null },
      ]),
    ).toBe(2)
  })
})
