import type { BgSwapBatchItem, BgSwapImage } from '../types'
import { isDiagram } from './scene'

function isBatchCandidate(image: BgSwapImage, sampleImageId: string | null): boolean {
  return image.imageId !== sampleImageId && !image.chosenVersionId && image.versions.length === 0
}

/**
 * 批量要跑的图：样张之外、还没定稿、也还没出过版本的普通商品图。
 * 已经出过版本的排除在外，否则刷新之后再点一次批量会给它们叠版本。
 */
export function pendingBatchImageIds(
  images: readonly BgSwapImage[],
  sampleImageId: string | null,
): string[] {
  return images
    .filter((image) => isBatchCandidate(image, sampleImageId) && !isDiagram(image.sceneType))
    .map((image) => image.imageId)
}

/** 批量默认放过的示意图：换背景会丢掉它们的说明文字，要跑得用户单张点。 */
export function skippedDiagramImageIds(
  images: readonly BgSwapImage[],
  sampleImageId: string | null,
): string[] {
  return images
    .filter((image) => isBatchCandidate(image, sampleImageId) && isDiagram(image.sceneType))
    .map((image) => image.imageId)
}

export function batchDoneCount(items: readonly BgSwapBatchItem[]): number {
  return items.filter((item) => item.state === 'done' || item.state === 'error').length
}
