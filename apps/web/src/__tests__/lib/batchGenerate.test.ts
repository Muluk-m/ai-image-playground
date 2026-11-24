import { describe, expect, it } from 'vitest'
import { i18next } from '../../i18n'
import {
  batchCredits,
  batchPerImage,
  batchSharedMax,
  clearBatchSharedImagesFromDraft,
  createBatchMentionLabels,
  demoteSharedImageToLoop,
  mergeDraftFromBatchMode,
  oversizedReferenceIndexes,
  oversizedReferenceMessage,
  promoteLoopImageToShared,
  removeBatchSharedImageFromDraft,
  splitDraftForBatchMode,
} from '../../lib/batchGenerate'
import {
  getSelectedImageMentionLabel,
  replaceImageMentionsForApi,
} from '../../lib/promptImageMentions'

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

describe('批量生图双分区（遍历原图 + 共用参考）', () => {
  const img = (id: string) => ({ id, dataUrl: `data:image/png;base64,${id}` })

  it('切入批量生图时，提示词里被引用的图自动移入共用参考并重映射到 @参考1', () => {
    const poster = img('poster')
    const tub = img('tub')
    const prompt = `把图中文字优化一下，把商品主图换成 ${getSelectedImageMentionLabel(1)}`

    const split = splitDraftForBatchMode({
      prompt,
      inputImages: [poster, tub],
      batchSharedImages: [],
      mergeLimit: 16,
    })

    expect(split.inputImages).toEqual([poster])
    expect(split.batchSharedImages).toEqual([tub])
    expect(split.promotedImages).toEqual([tub])
    // 批量坐标系里 index 0 是 @当前图（[image 1]），index 1 是 @参考1（[image 2]）
    const labels = createBatchMentionLabels(split.batchSharedImages)
    expect(labels(0)).toBe('@当前图')
    expect(labels(1)).toBe('@参考1')
    expect(replaceImageMentionsForApi(split.prompt, 2)).toBe(
      '把图中文字优化一下，把商品主图换成 [image 2]',
    )
  })

  it('离开批量生图时把共用参考合并回普通参考条，保留引用语义', () => {
    const poster = img('poster')
    const tub = img('tub')
    const prompt = `把 ${getSelectedImageMentionLabel(0)} 换成 ${getSelectedImageMentionLabel(1)}`

    const merged = mergeDraftFromBatchMode({
      prompt,
      inputImages: [poster],
      batchSharedImages: [tub],
    })

    expect(merged.inputImages).toEqual([poster, tub])
    expect(merged.batchSharedImages).toEqual([])
    expect(replaceImageMentionsForApi(merged.prompt, 2)).toBe('把 [image 1] 换成 [image 2]')
  })

  it('左区图片提升为共用参考后返回新引用下标，并在超过 15 张时拦截', () => {
    const loop = [img('a'), img('b')]
    const promoted = promoteLoopImageToShared({
      inputImages: loop,
      batchSharedImages: [],
      loopIndex: 1,
      mergeLimit: 16,
    })
    expect(promoted.ok).toBe(true)
    if (promoted.ok) {
      expect(promoted.inputImages.map((x) => x.id)).toEqual(['a'])
      expect(promoted.batchSharedImages.map((x) => x.id)).toEqual(['b'])
      expect(promoted.sharedIndex).toBe(0)
      expect(promoted.mentionIndex).toBe(1)
    }

    expect(batchSharedMax(16)).toBe(15)
    const fullShared = Array.from({ length: 15 }, (_, i) => img(`s${i}`))
    const overflow = promoteLoopImageToShared({
      inputImages: [img('extra')],
      batchSharedImages: fullShared,
      loopIndex: 0,
      mergeLimit: 16,
    })
    expect(overflow).toEqual({ ok: false, reason: 'overflow' })
  })

  it('共用参考移回遍历原图或删除时，保留 @当前图 并重排后续 @参考', () => {
    const s1 = img('s1')
    const s2 = img('s2')
    const prompt = `${getSelectedImageMentionLabel(0)} ${getSelectedImageMentionLabel(1)} ${getSelectedImageMentionLabel(2)}`

    const demoted = demoteSharedImageToLoop({
      prompt,
      inputImages: [img('l1')],
      batchSharedImages: [s1, s2],
      sharedIndex: 0,
    })
    expect(demoted.ok).toBe(true)
    if (demoted.ok) {
      expect(demoted.hadCitation).toBe(true)
      expect(demoted.inputImages.map((x) => x.id)).toEqual(['l1', 's1'])
      expect(demoted.batchSharedImages.map((x) => x.id)).toEqual(['s2'])
      // s2 从 @参考2 (index 2) 前移为 @参考1 (index 1)，@当前图 (index 0) 不变
      expect(replaceImageMentionsForApi(demoted.prompt, 2)).toContain('[image 1]')
      expect(replaceImageMentionsForApi(demoted.prompt, 2)).toContain('[image 2]')
    }

    const removed = removeBatchSharedImageFromDraft({
      prompt,
      batchSharedImages: [s1, s2],
      sharedIndex: 0,
    })
    expect(removed.batchSharedImages.map((x) => x.id)).toEqual(['s2'])

    const cleared = clearBatchSharedImagesFromDraft(prompt)
    expect(replaceImageMentionsForApi(cleared, 1)).toContain('[image 1]')
  })
})
