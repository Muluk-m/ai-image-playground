import type { BgSwapBatchItem, BgSwapImage } from '../types'

/**
 * 批量要跑的图：样张之外、还没定稿、也还没出过版本的。
 * 已经出过版本的排除在外，否则刷新之后再点一次批量会给它们叠版本。
 */
export function pendingBatchImageIds(
  images: readonly BgSwapImage[],
  sampleImageId: string | null,
): string[] {
  return images
    .filter(
      (image) =>
        image.imageId !== sampleImageId && !image.chosenVersionId && image.versions.length === 0,
    )
    .map((image) => image.imageId)
}

export function batchDoneCount(items: readonly BgSwapBatchItem[]): number {
  return items.filter((item) => item.state === 'done' || item.state === 'error').length
}
