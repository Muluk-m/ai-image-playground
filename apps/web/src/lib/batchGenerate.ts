import { i18next } from '../i18n'
import type { InputImage } from '../types'
import { API_MAX_IMAGES, MAX_IMAGE_BYTES, MAX_IMAGE_MB } from './inputImageLimit'
import { remapImageMentions } from './promptImageMentions'
import type { ReferenceAdmission } from './referenceDraft'

/** 逐张生成一次最多带几张图。 */
export const BATCH_GENERATE_MAX = 50
/** 逐张生成同时在途的张数，其余排队。 */
export const BATCH_GENERATE_CONCURRENCY = 5

/**
 * 快速生成输入框的参考图准入：放得下逐张生成的上限，合并参考仍按模型的上限（见 batchMergeLocked）。
 * 遮罩与模板只按模型的上限，调用方自己传那一份。
 */
export function quickGenerateAdmission(base: ReferenceAdmission): ReferenceAdmission {
  return base.acceptsReferences
    ? { ...base, limit: Math.max(base.limit, BATCH_GENERATE_MAX) }
    : base
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
 * 快速生成的参考图随请求一起发，服务端按单张上限归档（与 `sync:asset-image-bytes` 的默认档同值）。
 * 超限的图在选图时就标出来、拦住发送，不让它发出去再失败。
 */
export function oversizedReferenceIndexes(
  images: readonly InputImage[],
  limit = MAX_IMAGE_BYTES,
): number[] {
  return images.flatMap((image, index) => (dataUrlBytes(image.dataUrl) > limit ? [index] : []))
}

/** 「第 2、5 张超过 50 MB，请移除或换一张更小的图」。序号从 1 起，与条上的顺序一致。 */
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

/**
 * 逐张生成时参考区的两组：没设共享的是目标图（每张各出一张），设成共享参考的每个任务都带上。
 * 目标图按条上的顺序，共享参考按 `sharedIds` 的顺序（先设的在前），条上不存在的 id 忽略。
 */
export function partitionSharedReferences<T extends { readonly id: string }>(
  images: readonly T[],
  sharedIds: readonly string[],
): { targets: T[]; shared: T[] } {
  const byId = new Map(images.map((image) => [image.id, image]))
  const shared = sharedIds.flatMap((id) => {
    const image = byId.get(id)
    return image ? [image] : []
  })
  const sharedSet = new Set(shared.map((image) => image.id))
  return { targets: images.filter((image) => !sharedSet.has(image.id)), shared }
}

/** 逐张生成的每个任务带的图：自己那张目标图在第一位（@图1），共享参考跟在后面（@图2…）。 */
export function sharedReferenceGroups<T extends { readonly id: string }>(
  images: readonly T[],
  sharedIds: readonly string[],
): T[][] {
  const { targets, shared } = partitionSharedReferences(images, sharedIds)
  return targets.map((target) => [target, ...shared])
}

/**
 * 逐张生成时一个任务最多带几张图（1 张目标 + 共享参考）：队列上限，模型自己声明得更少就按模型
 * （Vertex / Nano Banana 14 张、Grok 5 张）。
 */
export function sharedReferenceTaskLimit(
  modelMax: number | null | undefined,
  queueMax = API_MAX_IMAGES,
): number {
  if (modelMax == null || !Number.isFinite(modelMax) || modelMax < 1) return queueMax
  return Math.min(queueMax, Math.floor(modelMax))
}

/** 这张图为什么不能设成共享：设了就没有目标图了，或者每个任务的图已经满了。可以设就是 null。 */
export type SharedPinBlock = 'lastTarget' | 'full'

export function sharedPinBlock(
  images: readonly { readonly id: string }[],
  sharedIds: readonly string[],
  imageId: string,
  taskLimit: number,
): SharedPinBlock | null {
  const { targets, shared } = partitionSharedReferences(images, sharedIds)
  if (shared.some((image) => image.id === imageId)) return null
  if (targets.length <= 1) return 'lastTarget'
  if (1 + shared.length + 1 > taskLimit) return 'full'
  return null
}

/**
 * 逐张生成时提示词里的序号按「每个任务里的图」算：@图1 是目标图，@图(k+1) 是第 k 张共享参考。
 * 共享参考增删、换顺序之后按 id 把这些引用挪到新序号上；不再共享的那张降级成「已移除图片」文字，
 * @图1 与超出范围的序号原样不动。
 */
export function remapSharedMentions(
  prompt: string,
  previousSharedIds: readonly string[],
  nextSharedIds: readonly string[],
): string {
  return remapImageMentions(prompt, (index) => {
    if (index < 1 || index > previousSharedIds.length) return null
    const next = nextSharedIds.indexOf(previousSharedIds[index - 1]!)
    return next < 0 ? -1 : next + 1
  })
}
