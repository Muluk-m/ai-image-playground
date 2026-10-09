import { afterEach, expect, it, vi } from 'vitest'
import { taskExportSources } from '../../../features/image-export/sources'
import type { TaskRecord } from '../../../types'

const loadImageOriginal = vi.hoisted(() => vi.fn(async (ref: string) => `blob:${ref}`))
vi.mock('../../../lib/imageSource', () => ({ loadImageOriginal }))

afterEach(() => vi.unstubAllGlobals())

const task = (id: string, outputImages: string[]) =>
  ({ id, outputImages, createdAt: new Date(2026, 9, 9, 8, 5, 3).getTime() }) as TaskRecord

it('exports every output image of the selected tasks under a timestamped name', async () => {
  const fetchMock = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' })))
  vi.stubGlobal('fetch', fetchMock)
  const sources = taskExportSources([task('a', ['img-1', 'img-2']), task('b', ['img-3'])])
  expect(sources.map((one) => [one.id, one.name, one.media])).toEqual([
    ['a:img-1', 'image-20261009-080503-1', 'image'],
    ['a:img-2', 'image-20261009-080503-2', 'image'],
    ['b:img-3', 'image-20261009-080503', 'image'],
  ])
  const blob = await sources[1]!.load()
  expect(blob.size).toBe(1)
  expect(loadImageOriginal).toHaveBeenCalledWith('img-2')
  expect(fetchMock).toHaveBeenCalledWith('blob:img-2', { signal: undefined })
})

it('fails the item when the original is missing', async () => {
  loadImageOriginal.mockResolvedValueOnce(null as never)
  await expect(taskExportSources([task('a', ['gone'])])[0]!.load()).rejects.toThrow(
    'Original image unavailable',
  )
})
