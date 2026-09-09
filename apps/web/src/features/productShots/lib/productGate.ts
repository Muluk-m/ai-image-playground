import type { ProductAsset } from '../../../lib/productAngle'
import type { AssetRecord } from '../../library/types'
import type { ProductShotAction } from './actions'

export const PRODUCT_MISSING_REASON = '产品素材已丢失'
export const PRODUCT_IS_SOURCE_REASON = '产品素材与原图相同'

/** 只换背景不带产品参考图，其余动作都要。 */
export function usesProductAsset(mode: ProductShotAction): boolean {
  return mode !== 'background'
}

export interface ProductReadiness {
  needsProduct: boolean
  productAssets: readonly ProductAsset[]
  /** 素材库；还没读出来时是空的，那会儿不能说素材丢了。 */
  assets: readonly Pick<AssetRecord, 'id' | 'imageId'>[]
  sourceImageId: string | null
}

/** 产品素材不能用时挡住动作的那一句；null = 可以跑。选都没选交给面板另说。 */
export function productGateReason({
  needsProduct,
  productAssets,
  assets,
  sourceImageId,
}: ProductReadiness): string | null {
  if (!needsProduct || productAssets.length === 0 || assets.length === 0) return null
  const imageIds = productAssets.map(
    (picked) => assets.find((asset) => asset.id === picked.assetId)?.imageId ?? null,
  )
  if (imageIds.every((imageId) => imageId === null)) return PRODUCT_MISSING_REASON
  // imageId 是内容哈希：产品与原图同 id 就是同一张，图1图2一模一样，模型只会把原图还回来。
  return imageIds.every((imageId) => imageId === null || imageId === sourceImageId)
    ? PRODUCT_IS_SOURCE_REASON
    : null
}
