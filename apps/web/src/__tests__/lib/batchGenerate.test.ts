import { describe, expect, it } from 'vitest'
import { i18next } from '../../i18n'
import {
  batchCredits,
  batchPerImage,
  oversizedReferenceIndexes,
  oversizedReferenceMessage,
  partitionSharedReferences,
  remapSharedMentions,
  sharedPinBlock,
  sharedReferenceGroups,
  sharedReferenceTaskLimit,
} from '../../lib/batchGenerate'
import { getSelectedImageMentionLabel } from '../../lib/promptImageMentions'

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

describe('逐张生成的共享参考', () => {
  const imgs = ['a', 'b', 'c', 'd'].map((id) => ({ id }))

  it('每个任务 = 自己的目标图 + 全部共享参考，张数按目标图算', () => {
    expect(partitionSharedReferences(imgs, ['c', 'missing'])).toEqual({
      targets: [{ id: 'a' }, { id: 'b' }, { id: 'd' }],
      shared: [{ id: 'c' }],
    })
    expect(sharedReferenceGroups(imgs, ['d', 'c']).map((g) => g.map((one) => one.id))).toEqual([
      ['a', 'd', 'c'],
      ['b', 'd', 'c'],
    ])
    expect(sharedReferenceGroups(imgs, [])).toHaveLength(4)
  })

  it('每个任务的上限取队列 16 与模型声明里更小的那个', () => {
    expect(sharedReferenceTaskLimit(undefined)).toBe(16)
    expect(sharedReferenceTaskLimit(Number.NaN)).toBe(16)
    expect(sharedReferenceTaskLimit(14)).toBe(14)
    expect(sharedReferenceTaskLimit(5)).toBe(5)
    expect(sharedReferenceTaskLimit(50)).toBe(16)
  })

  it('最后一张目标图不能设共享；1 + 共享到上限后再设就满了；已共享的总能取消', () => {
    expect(sharedPinBlock(imgs, ['a', 'b', 'c'], 'd', 16)).toBe('lastTarget')
    expect(sharedPinBlock(imgs, ['a'], 'b', 2)).toBe('full')
    expect(sharedPinBlock(imgs, ['a'], 'b', 3)).toBeNull()
    expect(sharedPinBlock(imgs, ['a', 'b', 'c'], 'a', 2)).toBeNull()
  })

  it('共享参考变了，提示词里的共享序号按 id 跟着挪，@图1 不动', () => {
    const m = getSelectedImageMentionLabel
    const prompt = `把 ${m(0)} 换上 ${m(1)} 和 ${m(2)}`
    expect(remapSharedMentions(prompt, ['x', 'y'], ['y', 'x'])).toBe(
      `把 ${m(0)} 换上 ${m(2)} 和 ${m(1)}`,
    )
    const dropped = remapSharedMentions(prompt, ['x', 'y'], ['y'])
    expect(dropped.startsWith(`把 ${m(0)} 换上 `)).toBe(true)
    expect(dropped).not.toContain(m(2))
    expect(dropped).toContain(m(1))
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
