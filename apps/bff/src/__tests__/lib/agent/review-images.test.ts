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
      return {
        imageId,
        dataUrl: 'x'.repeat(length),
        visualVariant: variant === 'preview' ? 'preview' : 'original',
      }
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
          visualVariant: variant === 'preview' ? 'preview' : 'original',
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

it('几张复核图共享读取并发上限，required 与 optional 会同时启动', async () => {
  setLimit(1000)
  let inFlight = 0
  let peak = 0
  let requiredFinished = false
  let optionalStartedBeforeRequiredFinished = false
  const source: Source = {
    async resolve(imageId) {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      if (imageId === 'd') optionalStartedBeforeRequiredFinished = !requiredFinished
      await Promise.resolve()
      if (imageId === 'a') requiredFinished = true
      inFlight -= 1
      return { imageId, dataUrl: 'x'.repeat(100), visualVariant: 'preview' }
    },
  }
  const result = await prepareReviewImages(source, [], ['a', 'b', 'c'], ['d', 'e'])
  expect(optionalStartedBeforeRequiredFinished).toBe(true)
  expect(peak).toBeLessThanOrEqual(4)
  expect(result.reviewed.map((image) => image.imageId)).toEqual(['a', 'b', 'c', 'd', 'e'])
})

it('必需复核图失败时等待其它读取结束后再释放准备流程', async () => {
  setLimit(1000)
  let finished = false
  const otherGate = Promise.withResolvers<void>()
  const otherStarted = Promise.withResolvers<void>()
  const source: Source = {
    async resolve(imageId) {
      if (imageId === 'a') throw new Error('broken')
      otherStarted.resolve()
      await otherGate.promise
      finished = true
      return { imageId, dataUrl: 'x'.repeat(100), visualVariant: 'preview' }
    },
  }
  const pending = prepareReviewImages(source, [], ['a', 'b'])
  let settled = false
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await otherStarted.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  otherGate.resolve()
  await expect(pending).rejects.toThrow('broken')
  expect(finished).toBe(true)
})

it('批内并行读取仍各自受全局图片准备名额约束，不会绕过 agent:visual-prepare-concurrency', async () => {
  const { withVisualPreparation } = await import('../../../lib/agent/visual-resources')
  config.operator = {
    ...operator,
    quotas: {
      ...operator.quotas,
      'agent:request-max-bytes': 1000,
      'agent:visual-prepare-concurrency': 1,
    },
  }
  let inFlight = 0
  let peak = 0
  const source: Source = {
    // 真实图源每次读取都在自己的准备名额里进行。
    resolve: (imageId) =>
      withVisualPreparation(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { imageId, dataUrl: 'x'.repeat(100), visualVariant: 'preview' as const }
      }),
  }
  const result = await prepareReviewImages(source, [], ['a', 'b'], ['c', 'd'])
  expect(peak).toBe(1)
  expect(result.reviewed.map((image) => image.imageId)).toEqual(['a', 'b', 'c', 'd'])
})
