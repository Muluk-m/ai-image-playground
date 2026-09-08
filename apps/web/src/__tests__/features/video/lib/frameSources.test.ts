import { describe, expect, it } from 'vitest'
import type { AssetRecord } from '../../../../features/library/types'
import { mergeFrameSources } from '../../../../features/video/lib/frameSources'
import type { TaskRecord } from '../../../../types'

function asset(imageId: string, name: string, lastUsedAt: number): AssetRecord {
  return { id: `asset-${imageId}`, name, imageId, createdAt: 0, updatedAt: 0, lastUsedAt }
}

function task(createdAt: number, outputImages: string[]): TaskRecord {
  return {
    id: `task-${createdAt}`,
    prompt: '',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages,
    status: 'done',
    error: null,
    createdAt,
    finishedAt: createdAt,
    elapsed: 0,
  }
}

describe('the frame source strip', () => {
  it('puts the library first by last use, then the newest outputs', () => {
    const sources = mergeFrameSources(
      [asset('img-a', '旧图', 100), asset('img-b', '新图', 200)],
      [task(10, ['img-c']), task(20, ['img-d'])],
      8,
    )

    expect(sources).toEqual([
      { imageId: 'img-b', name: '新图' },
      { imageId: 'img-a', name: '旧图' },
      { imageId: 'img-d', name: '' },
      { imageId: 'img-c', name: '' },
    ])
  })

  it('keeps a saved image once, under its library name', () => {
    const sources = mergeFrameSources([asset('img-a', '白底图', 1)], [task(10, ['img-a'])], 8)

    expect(sources).toEqual([{ imageId: 'img-a', name: '白底图' }])
  })

  it('stops at the limit', () => {
    const sources = mergeFrameSources(
      [],
      [task(10, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])],
      8,
    )

    expect(sources).toHaveLength(8)
  })
})
