import { describe, expect, it } from 'vitest'
import { i18next } from '../../i18n'
import {
  batchCredits,
  batchPerImage,
  oversizedReferenceIndexes,
  oversizedReferenceMessage,
} from '../../lib/batchGenerate'

describe('per-image batch generation', () => {
  it('needs at least two images and runs per image once over the merge limit', () => {
    expect(batchPerImage(1, true, 16)).toBe(false)
    expect(batchPerImage(3, true, 16)).toBe(true)
    expect(batchPerImage(3, false, 16)).toBe(false)
    expect(batchPerImage(17, false, 16)).toBe(true)
  })

  it('flags references over the per-image limit by their position', () => {
    const small = { id: 'a', dataUrl: `data:image/png;base64,${'A'.repeat(8)}` }
    const big = { id: 'b', dataUrl: `data:image/png;base64,${'A'.repeat(400)}` }
    const remote = { id: 'c', dataUrl: 'aip-media:abc' }

    expect(oversizedReferenceIndexes([small, big, remote], 100)).toEqual([1])
  })

  it('prices the batch as images × the single-image price', () => {
    expect(batchCredits(3, 100)).toBe(300)
    expect(batchCredits(3, undefined)).toBeUndefined()
  })
})

describe('超限原因句', () => {
  it('两种语言都以句号收尾，与同一行里的其他原因一致（第 16 轮）', () => {
    for (const lng of ['zh-CN', 'en']) {
      for (const key of ['batch.oversized', 'image.referenceTooLarge'] as const) {
        const text = i18next.t(key, { ns: 'composer', lng, index: 2, mb: 50, maxSize: '50 MB' })
        expect(text).toMatch(/[。.]$/)
      }
    }
    expect(oversizedReferenceMessage([1, 4])).toMatch(/[。.]$/)
  })

  it('快速生成与智能创作两条路径的 50 MB 提示是同一句话（BUG-58）', () => {
    for (const lng of ['zh-CN', 'en']) {
      const quick = i18next.t('batch.oversized', { ns: 'composer', lng, index: 3, mb: 50 })
      const canvas = i18next.t('image.referenceTooLarge', {
        ns: 'composer',
        lng,
        index: 3,
        maxSize: '50 MB',
      })
      expect(canvas).toBe(quick)
    }
    expect(
      i18next.t('image.referenceTooLarge', {
        ns: 'composer',
        lng: 'zh-CN',
        index: 3,
        maxSize: '50 MB',
      }),
    ).toBe('第 3 张超过 50 MB，请移除或换一张更小的图。')
  })
})
