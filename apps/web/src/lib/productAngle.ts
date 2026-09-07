/** 产品素材的拍摄角度。按机位挑同角度的底图，角度不匹配时模型会改产品。 */
export const PRODUCT_ANGLES = ['front', 'three-quarter', 'high-angle', 'top-down', 'side'] as const

export type ProductAngle = (typeof PRODUCT_ANGLES)[number]

export const PRODUCT_ANGLE_LABELS: Record<ProductAngle, string> = {
  front: '正面',
  'three-quarter': '3/4 侧',
  'high-angle': '俯拍',
  'top-down': '正顶',
  side: '侧面',
}

/** 一张标了角度的素材。 */
export interface ProductAsset {
  assetId: string
  angle: ProductAngle
}

export const DEFAULT_PRODUCT_ANGLE: ProductAngle = 'three-quarter'

/** 上传的产品图按正面登记：正面白底图是最常要、也最常缺的那一张。 */
export const UPLOAD_PRODUCT_ANGLE: ProductAngle = 'front'

/** 先匹配的先赢：`top-down` 的词必须排在 `high-angle` 前，否则「俯」把正顶也吃掉。 */
const ANGLE_KEYWORDS: Array<[ProductAngle, string[]]> = [
  [
    'top-down',
    [
      'top-down',
      'top down',
      'overhead',
      'directly above',
      'flat lay',
      'birds',
      '正顶',
      '顶视',
      '正上方',
    ],
  ],
  [
    'high-angle',
    [
      'high angle',
      'high-angle',
      'elevated',
      'looking down',
      'from above',
      '俯拍',
      '俯视',
      '高机位',
    ],
  ],
  [
    'three-quarter',
    ['three-quarter', 'three quarter', '3/4', '45', 'angled view', '斜侧', '斜角', '3/4 侧'],
  ],
  ['side', ['side profile', 'profile', 'side view', 'from the side', 'lateral', '侧面', '正侧']],
  [
    'front',
    ['straight on', 'straight-on', 'head-on', 'front view', 'frontal', 'eye level', '正面', '平视'],
  ],
]

const DEFAULT_ANGLE: ProductAngle = 'three-quarter'

/** 没写角度就返回 null：机位回落 3/4 侧，素材名回落正面，两处口径不同。 */
export function angleFromText(text: string): ProductAngle | null {
  const lower = text.toLowerCase()
  for (const [angle, keywords] of ANGLE_KEYWORDS) {
    if (keywords.some((keyword) => lower.includes(keyword))) return angle
  }
  return null
}

export function cameraToAngle(camera: string): ProductAngle {
  return angleFromText(camera) ?? DEFAULT_ANGLE
}

/** 角度不匹配时模型会改产品，所以宁可返回 null 让调用方决定怎么退。 */
export function matchProductAsset(
  angle: ProductAngle,
  assets: readonly ProductAsset[],
): ProductAsset | null {
  return assets.find((asset) => asset.angle === angle) ?? null
}

export function toggleProductAsset(
  assets: readonly ProductAsset[],
  assetId: string,
  angle: ProductAngle,
): ProductAsset[] {
  return assets.some((asset) => asset.assetId === assetId)
    ? assets.filter((asset) => asset.assetId !== assetId)
    : [...assets, { assetId, angle }]
}

export function setProductAssetAngle(
  assets: readonly ProductAsset[],
  assetId: string,
  angle: ProductAngle,
): ProductAsset[] {
  return assets.map((asset) => (asset.assetId === assetId ? { ...asset, angle } : asset))
}
