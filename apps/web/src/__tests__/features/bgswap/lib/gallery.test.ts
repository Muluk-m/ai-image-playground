import { describe, expect, it } from 'vitest'
import {
  bgSwapEntryName,
  exportEntries,
  flatVersions,
  galleryRows,
} from '../../../../features/bgswap/lib/gallery'
import type { BgSwapImage, BgSwapVersion } from '../../../../features/bgswap/types'
import type { TaskRecord } from '../../../../types'

function version(id: string): BgSwapVersion {
  return { id, taskId: `task-${id}`, plan: '木质浴室', prompt: 'p', masked: true, createdAt: 1 }
}

function image(imageId: string, patch: Partial<BgSwapImage> = {}): BgSwapImage {
  return { imageId, versions: [], ...patch }
}

function doneTask(id: string, outputImages: string[]): TaskRecord {
  return {
    id,
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages,
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
  }
}

const IMAGES: BgSwapImage[] = [
  image('a', { versions: [version('v1'), version('v2')], chosenVersionId: 'v2' }),
  image('b'),
  image('c', { versions: [version('v3')] }),
]

const TASKS = new Map([
  ['task-v1', doneTask('task-v1', ['out-1'])],
  ['task-v2', doneTask('task-v2', ['out-2'])],
  ['task-v3', doneTask('task-v3', ['out-3'])],
])

describe('laying the results out by original image', () => {
  it('keeps only the images that produced something, in their original order', () => {
    const rows = galleryRows(IMAGES, TASKS)

    expect(rows.map((row) => row.imageId)).toEqual(['a', 'c'])
    expect(rows.map((row) => row.imageIndex)).toEqual([0, 2])
  })

  it('numbers the versions of one image and marks the chosen one', () => {
    const [first] = galleryRows(IMAGES, TASKS)

    expect(first.versions.map((item) => item.versionIndex)).toEqual([0, 1])
    expect(first.versions.map((item) => item.chosen)).toEqual([false, true])
    expect(first.versions[0].outputImageIds).toEqual(['out-1'])
  })

  it('flattens every version of every image for the tiled view', () => {
    expect(flatVersions(galleryRows(IMAGES, TASKS)).map((item) => item.version.id)).toEqual([
      'v1',
      'v2',
      'v3',
    ])
  })
})

describe('naming the exported files', () => {
  it('puts the original order and the version number under the job name', () => {
    expect(bgSwapEntryName('折叠浴缸', 0, 0)).toBe('折叠浴缸/01-v1.png')
    expect(bgSwapEntryName('折叠浴缸', 11, 2)).toBe('折叠浴缸/12-v3.png')
  })

  it('numbers the extra images one version returned', () => {
    expect(bgSwapEntryName('折叠浴缸', 0, 0, 1)).toBe('折叠浴缸/01-v1-2.png')
  })
})

describe('picking what goes into the package', () => {
  it('packs only the chosen version of each image', () => {
    const entries = exportEntries('折叠浴缸', galleryRows(IMAGES, TASKS), 'chosen', 'crop')

    expect(entries).toEqual([{ path: '折叠浴缸/01-v2.png', imageId: 'out-2', fit: 'crop' }])
  })

  it('packs every version when asked for all of them', () => {
    const entries = exportEntries('折叠浴缸', galleryRows(IMAGES, TASKS), 'all', 'letterbox')

    expect(entries.map((entry) => entry.path)).toEqual([
      '折叠浴缸/01-v1.png',
      '折叠浴缸/01-v2.png',
      '折叠浴缸/03-v1.png',
    ])
    expect(entries.every((entry) => entry.fit === 'letterbox')).toBe(true)
  })
})
