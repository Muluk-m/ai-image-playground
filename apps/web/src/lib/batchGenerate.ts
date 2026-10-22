import { i18next } from '../i18n'
import type { InputImage } from '../types'
import { MAX_IMAGE_BYTES, MAX_IMAGE_MB } from './inputImageLimit'

/** 逐张生成一次最多带几张图。 */
export const BATCH_GENERATE_MAX = 50

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
