import { describe, expect, it } from 'vitest'
import {
  PRODUCT_IS_SOURCE_REASON,
  PRODUCT_MISSING_REASON,
  type ProductReadiness,
  productGateReason,
  usesProductAsset,
} from '../../../../features/productShots/lib/productGate'

function readiness(over: Partial<ProductReadiness> = {}): ProductReadiness {
  return {
    needsProduct: true,
    productAssets: [{ assetId: 'a-front', angle: 'front' }],
    assets: [{ id: 'a-front', imageId: 'asset-front' }],
    sourceImageId: 'image-1',
    ...over,
  }
}

describe('usesProductAsset', () => {
  it('只有换背景不吃产品参考图', () => {
    expect(usesProductAsset('background')).toBe(false)
    expect(usesProductAsset('replace-product')).toBe(true)
    expect(usesProductAsset('replace-and-background')).toBe(true)
    expect(usesProductAsset('remix')).toBe(true)
  })
})

describe('productGateReason', () => {
  it('挡住产品素材就是原图那一张', () => {
    expect(productGateReason(readiness({ sourceImageId: 'asset-front' }))).toBe(
      PRODUCT_IS_SOURCE_REASON,
    )
  })

  it('挡住素材记录已经不在库里的', () => {
    expect(
      productGateReason(readiness({ assets: [{ id: 'a-other', imageId: 'asset-other' }] })),
    ).toBe(PRODUCT_MISSING_REASON)
  })

  it('素材与原图是两张就放行', () => {
    expect(productGateReason(readiness())).toBeNull()
  })

  it('还有一张别的角度可用就放行', () => {
    expect(
      productGateReason(
        readiness({
          productAssets: [
            { assetId: 'a-front', angle: 'front' },
            { assetId: 'a-side', angle: 'side' },
          ],
          assets: [
            { id: 'a-front', imageId: 'asset-front' },
            { id: 'a-side', imageId: 'asset-side' },
          ],
          sourceImageId: 'asset-front',
        }),
      ),
    ).toBeNull()
  })

  it('不吃产品参考图的动作不挡', () => {
    expect(
      productGateReason(readiness({ needsProduct: false, sourceImageId: 'asset-front' })),
    ).toBeNull()
  })

  it('一张素材都没选交给面板另说，素材库还没读出来时也不挡', () => {
    expect(productGateReason(readiness({ productAssets: [] }))).toBeNull()
    expect(productGateReason(readiness({ assets: [] }))).toBeNull()
  })
})
