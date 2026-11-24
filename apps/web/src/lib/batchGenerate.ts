import { i18next } from '../i18n'
import type { InputImage } from '../types'
import { MAX_IMAGE_BYTES, MAX_IMAGE_MB } from './inputImageLimit'
import {
  getMentionedImageIndexes,
  type MentionLabelResolver,
  remapImageMentions,
} from './promptImageMentions'
import type { ReferenceAdmission } from './referenceDraft'

/** 逐张生成一次最多带几张遍历原图。 */
export const BATCH_GENERATE_MAX = 50
/** 逐张生成同时在途的张数，其余排队。 */
export const BATCH_GENERATE_CONCURRENCY = 5
/** 批量模式里 `@当前图` 在引用身份表中的哨兵 id（对应 0 号位 / `[image 1]`）。 */
export const BATCH_CURRENT_REFERENCE_ID = '__batch_current__'

/** 批量模式每条任务携带 `1 张遍历原图 + 共用参考图`，共用参考上限为单次上限减 1。 */
export function batchSharedMax(mergeLimit: number): number {
  return Math.max(0, mergeLimit - 1)
}

/**
 * 快速生成输入框的参考图准入：放得下逐张生成的上限，合并参考仍按模型的上限（见 batchMergeLocked）。
 * 遮罩与模板只按模型的上限，调用方自己传那一份。
 */
export function quickGenerateAdmission(base: ReferenceAdmission): ReferenceAdmission {
  return base.acceptsReferences
    ? { ...base, limit: Math.max(base.limit, BATCH_GENERATE_MAX) }
    : base
}

/** 批量模式「共用参考」分区的准入：总张数留出 1 个位置给每次遍历的当前原图。 */
export function batchSharedAdmission(base: ReferenceAdmission): ReferenceAdmission {
  return base.acceptsReferences ? { ...base, limit: batchSharedMax(base.limit) } : base
}

/** 至少两张图才有「逐张」可言；一张图就是普通的图生图。 */
export function batchGenerateAvailable(imageCount: number): boolean {
  return imageCount >= 2
}

/** 超过模型一次能带的参考图数（合并参考的上限）就只能逐张生成。 */
export function batchMergeLocked(imageCount: number, mergeLimit: number): boolean {
  return imageCount > mergeLimit
}

/** 这一次提交是不是逐张生成：用户选了，或图多到只能逐张。 */
export function batchPerImage(imageCount: number, chosen: boolean, mergeLimit: number): boolean {
  return batchGenerateAvailable(imageCount) && (chosen || batchMergeLocked(imageCount, mergeLimit))
}

/**
 * 批量模式下的提示词引用标签：
 * - index 0（存储为 `@图1` → 发送 `[image 1]`）固定表示正在遍历的 `@当前图`
 * - index >= 1（存储为 `@图(k+1)` → 发送 `[image (k+1)]`）对应第 k 张共用参考 `@参考k`
 */
export function createBatchMentionLabels(
  sharedImages: readonly InputImage[],
): MentionLabelResolver {
  return (index) => {
    if (index === 0) return i18next.t('batch.currentMention', { ns: 'composer' })
    const shared = sharedImages[index - 1]
    if (!shared) return null
    return i18next.t('batch.sharedMention', { ns: 'composer', n: index })
  }
}

export function batchMentionReferenceIds(sharedImages: readonly InputImage[]): string[] {
  return [BATCH_CURRENT_REFERENCE_ID, ...sharedImages.map((img) => img.id)]
}

/**
 * 从「图片生成」等单区模式切入「批量生图」时：
 * 提示词里已被 `@图N` 引用的图片自动归入「共用参考」区（在单次上限内），
 * 未被引用的图片留在「遍历原图」队列，并同步把提示词里的引用重映射到批量坐标系（`@参考1..k`）。
 */
export function splitDraftForBatchMode({
  prompt,
  inputImages,
  batchSharedImages,
  mergeLimit,
}: {
  prompt: string
  inputImages: readonly InputImage[]
  batchSharedImages: readonly InputImage[]
  mergeLimit: number
}): {
  readonly prompt: string
  readonly inputImages: InputImage[]
  readonly batchSharedImages: InputImage[]
  readonly promotedImages: InputImage[]
} {
  const mentioned = getMentionedImageIndexes(prompt)
  if (mentioned.length === 0) {
    return {
      prompt,
      inputImages: [...inputImages],
      batchSharedImages: [...batchSharedImages],
      promotedImages: [],
    }
  }

  const maxShared = batchSharedMax(mergeLimit)
  const existingSharedIds = new Set(batchSharedImages.map((img) => img.id))
  const nextShared = [...batchSharedImages]
  const promotedIndexes = new Set<number>()
  const promotedImages: InputImage[] = []
  const oldIndexToMentionIndex = new Map<number, number>()

  for (const oldIndex of mentioned) {
    const img = inputImages[oldIndex]
    if (!img) continue
    if (existingSharedIds.has(img.id)) {
      const existingAt = nextShared.findIndex((item) => item.id === img.id)
      if (existingAt >= 0) {
        oldIndexToMentionIndex.set(oldIndex, existingAt + 1)
        promotedIndexes.add(oldIndex)
      }
      continue
    }
    if (nextShared.length >= maxShared) continue
    nextShared.push(img)
    existingSharedIds.add(img.id)
    promotedIndexes.add(oldIndex)
    promotedImages.push(img)
    oldIndexToMentionIndex.set(oldIndex, nextShared.length)
  }

  const nextLoop = inputImages.filter((_, index) => !promotedIndexes.has(index))
  const nextPrompt = remapImageMentions(prompt, (imageIndex) => {
    const mapped = oldIndexToMentionIndex.get(imageIndex)
    if (mapped !== undefined) return mapped
    if (imageIndex >= 0 && imageIndex < inputImages.length) return -1
    return null
  })

  return {
    prompt: nextPrompt,
    inputImages: nextLoop,
    batchSharedImages: nextShared,
    promotedImages,
  }
}

/**
 * 离开「批量生图」切回其他模式时：把共用参考合并回普通参考图条，
 * 提示词中的 `@当前图` 与 `@参考k` 无缝重映射到合并后的普通序号，不丢图也不丢引用。
 */
export function mergeDraftFromBatchMode({
  prompt,
  inputImages,
  batchSharedImages,
}: {
  prompt: string
  inputImages: readonly InputImage[]
  batchSharedImages: readonly InputImage[]
}): {
  readonly prompt: string
  readonly inputImages: InputImage[]
  readonly batchSharedImages: InputImage[]
} {
  if (batchSharedImages.length === 0 && !getMentionedImageIndexes(prompt).length) {
    return {
      prompt,
      inputImages: [...inputImages],
      batchSharedImages: [],
    }
  }
  const seen = new Set(inputImages.map((img) => img.id))
  const merged = [...inputImages]
  for (const shared of batchSharedImages) {
    if (seen.has(shared.id)) continue
    seen.add(shared.id)
    merged.push(shared)
  }
  const nextPrompt = remapImageMentions(prompt, (imageIndex) => {
    if (imageIndex === 0) return inputImages.length > 0 ? 0 : -1
    const shared = batchSharedImages[imageIndex - 1]
    if (!shared) return null
    return merged.findIndex((item) => item.id === shared.id)
  })
  return {
    prompt: nextPrompt,
    inputImages: merged,
    batchSharedImages: [],
  }
}

/** 把左区第 `loopIndex` 张遍历原图移入右区「共用参考」（拖入或被 `@` 引用触发）。 */
export function promoteLoopImageToShared({
  inputImages,
  batchSharedImages,
  loopIndex,
  mergeLimit,
}: {
  inputImages: readonly InputImage[]
  batchSharedImages: readonly InputImage[]
  loopIndex: number
  mergeLimit: number
}):
  | {
      readonly ok: true
      readonly inputImages: InputImage[]
      readonly batchSharedImages: InputImage[]
      readonly sharedIndex: number
      readonly mentionIndex: number
      readonly movedImage: InputImage
    }
  | { readonly ok: false; readonly reason: 'invalid' | 'overflow' } {
  const movedImage = inputImages[loopIndex]
  if (!movedImage) return { ok: false, reason: 'invalid' }

  const existingIndex = batchSharedImages.findIndex((item) => item.id === movedImage.id)
  const nextLoop = inputImages.filter((_, i) => i !== loopIndex)
  if (existingIndex >= 0) {
    return {
      ok: true,
      inputImages: nextLoop,
      batchSharedImages: [...batchSharedImages],
      sharedIndex: existingIndex,
      mentionIndex: existingIndex + 1,
      movedImage,
    }
  }

  if (batchSharedImages.length >= batchSharedMax(mergeLimit)) {
    return { ok: false, reason: 'overflow' }
  }

  const nextShared = [...batchSharedImages, movedImage]
  const sharedIndex = nextShared.length - 1
  return {
    ok: true,
    inputImages: nextLoop,
    batchSharedImages: nextShared,
    sharedIndex,
    mentionIndex: sharedIndex + 1,
    movedImage,
  }
}

/** 把右区第 `sharedIndex` 张共用参考移回左区「遍历原图」，并同步清理/重排提示词里的 `@参考`。 */
export function demoteSharedImageToLoop({
  prompt,
  inputImages,
  batchSharedImages,
  sharedIndex,
}: {
  prompt: string
  inputImages: readonly InputImage[]
  batchSharedImages: readonly InputImage[]
  sharedIndex: number
}):
  | {
      readonly ok: true
      readonly prompt: string
      readonly inputImages: InputImage[]
      readonly batchSharedImages: InputImage[]
      readonly movedImage: InputImage
      readonly hadCitation: boolean
    }
  | { readonly ok: false; readonly reason: 'invalid' | 'overflow' } {
  const movedImage = batchSharedImages[sharedIndex]
  if (!movedImage) return { ok: false, reason: 'invalid' }
  const alreadyInLoop = inputImages.some((item) => item.id === movedImage.id)
  if (!alreadyInLoop && inputImages.length >= BATCH_GENERATE_MAX) {
    return { ok: false, reason: 'overflow' }
  }

  const nextShared = batchSharedImages.filter((_, i) => i !== sharedIndex)
  const nextLoop = alreadyInLoop ? [...inputImages] : [...inputImages, movedImage]
  const targetMentionIndex = sharedIndex + 1
  const hadCitation = getMentionedImageIndexes(prompt).includes(targetMentionIndex)
  const nextPrompt = remapImageMentions(prompt, (imageIndex) => {
    if (imageIndex === 0) return 0
    if (imageIndex === targetMentionIndex) return -1
    if (imageIndex > targetMentionIndex) return imageIndex - 1
    return imageIndex
  })
  return {
    ok: true,
    prompt: nextPrompt,
    inputImages: nextLoop,
    batchSharedImages: nextShared,
    movedImage,
    hadCitation,
  }
}

/** 移除右区第 `sharedIndex` 张共用参考，保持 `@当前图` 不受影响，后续 `@参考` 自动前移。 */
export function removeBatchSharedImageFromDraft({
  prompt,
  batchSharedImages,
  sharedIndex,
}: {
  prompt: string
  batchSharedImages: readonly InputImage[]
  sharedIndex: number
}): { readonly prompt: string; readonly batchSharedImages: InputImage[] } {
  if (sharedIndex < 0 || sharedIndex >= batchSharedImages.length) {
    return { prompt, batchSharedImages: [...batchSharedImages] }
  }
  const nextShared = batchSharedImages.filter((_, i) => i !== sharedIndex)
  const removedMentionIndex = sharedIndex + 1
  const nextPrompt = remapImageMentions(prompt, (imageIndex) => {
    if (imageIndex === 0) return 0
    if (imageIndex === removedMentionIndex) return -1
    if (imageIndex > removedMentionIndex) return imageIndex - 1
    return imageIndex
  })
  return { prompt: nextPrompt, batchSharedImages: nextShared }
}

/** 清空右区全部共用参考，保留 `@当前图`，将所有 `@参考k` 降级。 */
export function clearBatchSharedImagesFromDraft(prompt: string): string {
  return remapImageMentions(prompt, (imageIndex) => (imageIndex === 0 ? 0 : -1))
}

/**
 * 快速生成的参考图随请求一起发，服务端按单张上限归档（与 `sync:asset-image-bytes` 的默认档同值）。
 * 超限的图在选图时就标出来、拦住发送，不让它发出去再失败。
 */
export function oversizedReferenceIndexes(
  images: readonly InputImage[],
  limit = MAX_IMAGE_BYTES,
): number[] {
  return images.flatMap((image, index) => (dataUrlBytes(image.dataUrl) > limit ? [index] : []))
}

/** 「第 2、5 张超过 50 MB，请移除或换一张更小的图。」。序号从 1 起，与条上的顺序一致。 */
export function oversizedReferenceMessage(indexes: readonly number[]): string {
  return i18next.t('batch.oversized', {
    ns: 'composer',
    index: indexes.map((index) => index + 1).join('、'),
    mb: MAX_IMAGE_MB,
  })
}

/** base64 data URL 解出来大约多少字节；不解码、不复制整串。按身份引用的云媒体不在本机，记 0。 */
function dataUrlBytes(dataUrl: string): number {
  if (!dataUrl.startsWith('data:')) return 0
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return dataUrl.length
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}

/** 整批积分：单张报价 × 张数，与逐张扣费同一口径。估不出单价时不写数字。 */
export function batchCredits(
  imageCount: number,
  perImageCredits: number | undefined,
): number | undefined {
  if (perImageCredits === undefined || !Number.isFinite(perImageCredits)) return undefined
  return imageCount * perImageCredits
}
