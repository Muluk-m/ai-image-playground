import { afterEach, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

const { config } = await import('../../../config')
const { omittedReviewNote, prepareReviewImages } = await import('../../../lib/agent/review-images')
type Source = Parameters<typeof prepareReviewImages>[0]
const operator = config.operator

afterEach(() => {
  config.operator = operator
})

const setLimit = (limit: number) => {
  config.operator = {
    ...operator,
    quotas: { ...operator.quotas, 'agent:request-max-bytes': limit },
  }
}

/** 原件 5000 字节（4K 无损产物的缩影），预览按给定大小。 */
function source(previews: Record<string, number | null>, calls: string[] = []): Source {
  return {
    async resolve(imageId, variant = 'original') {
      calls.push(`${variant}:${imageId}`)
      const size = previews[imageId]
      if (size === null || size === undefined) return null
      const length = variant === 'preview' ? size : 5000
      return { imageId, dataUrl: 'x'.repeat(length), visualVariant: variant }
    },
  }
}

it('复核附的是预览而不是原件，原件超预算也不会让这一轮失败', async () => {
  setLimit(1000)
  const calls: string[] = []
  const { reviewed, omitted } = await prepareReviewImages(
    source({ a: 300, b: 300 }, calls),
    [],
    ['a', 'b'],
  )
  expect(calls).toEqual(['preview:a', 'preview:b'])
  expect(reviewed.map((image) => image.imageId)).toEqual(['a', 'b'])
  expect(omitted).toEqual([])
  expect(omittedReviewNote(omitted)).toBe('')
})

it('预览也装不下时降级：已附上的照常复核，没附上的列出来让模型如实说明', async () => {
  setLimit(1000)
  const { reviewed, omitted } = await prepareReviewImages(
    source({ a: 600, b: 600, c: 300 }),
    [],
    ['a', 'b', 'c'],
  )
  expect(reviewed.map((image) => image.imageId)).toEqual(['a', 'c'])
  expect(omitted).toEqual(['b'])
  expect(omittedReviewNote(omitted)).toContain('b')
  expect(omittedReviewNote(omitted)).toContain('不要声称已复核')
})

it('批次唤醒的尽力复核图也走预览，装不下或读不到的跳过', async () => {
  setLimit(1000)
  const calls: string[] = []
  const { reviewed, omitted } = await prepareReviewImages(
    source({ a: 400, b: 700, c: null, d: 500 }, calls),
    [],
    ['a'],
    ['b', 'c', 'd'],
  )
  expect(calls).toEqual(['preview:a', 'preview:b', 'preview:c', 'preview:d'])
  expect(reviewed.map((image) => image.imageId)).toEqual(['a', 'd'])
  expect(omitted).toEqual([])
})

it('读不出来的必需复核图仍然报错：缺图不能算复核过', async () => {
  setLimit(1000)
  await expect(prepareReviewImages(source({ a: null }), [], ['a'])).rejects.toThrow('复核图片 a')
})

it('shrinks a real 4K PNG larger than the request budget before preparing review evidence', async () => {
  setLimit(16 * 1024 * 1024)
  const { toPreviewDataUrl } = await import('../../../lib/agent/modelImage')
  const png = await sharp(randomBytes(3840 * 2160 * 3), {
    raw: { width: 3840, height: 2160, channels: 3 },
  })
    .png()
    .toBuffer()
  const original = `data:image/png;base64,${png.toString('base64')}`
  expect(Buffer.byteLength(original)).toBeGreaterThan(16 * 1024 * 1024)
  const { reviewed, omitted } = await prepareReviewImages(
    {
      async resolve(imageId, variant) {
        return {
          imageId,
          dataUrl: variant === 'preview' ? await toPreviewDataUrl(original) : original,
          visualVariant: variant,
        }
      },
    },
    [],
    ['4k-result'],
  )
  expect(omitted).toEqual([])
  expect(reviewed).toHaveLength(1)
  expect(Buffer.byteLength(reviewed[0]!.dataUrl)).toBeLessThan(16 * 1024 * 1024)
  const metadata = await sharp(
    Buffer.from(reviewed[0]!.dataUrl.split(',')[1]!, 'base64'),
  ).metadata()
  expect(metadata.format).toBe('webp')
  expect(metadata.width).toBe(1024)
  expect(metadata.height).toBe(576)
})
