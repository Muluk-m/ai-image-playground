import type { ProductAngle, RemixProductAsset } from '../types'

/** 先匹配的先赢：`top-down` 的词必须排在 `high-angle` 前，否则「俯」把正顶也吃掉。 */
const ANGLE_KEYWORDS: Array<[ProductAngle, string[]]> = [
  ['top-down', ['top-down', 'top down', 'overhead', 'directly above', 'flat lay', 'birds', '正顶', '顶视', '正上方']],
  ['high-angle', ['high angle', 'high-angle', 'elevated', 'looking down', 'from above', '俯拍', '俯视', '高机位']],
  ['three-quarter', ['three-quarter', 'three quarter', '3/4', '45', 'angled view', '斜侧', '斜角', '3/4 侧']],
  ['side', ['side profile', 'profile', 'side view', 'from the side', 'lateral', '侧面', '正侧']],
  ['front', ['straight on', 'straight-on', 'head-on', 'front view', 'frontal', 'eye level', '正面', '平视']],
]

const DEFAULT_ANGLE: ProductAngle = 'three-quarter'

export function cameraToAngle(camera: string): ProductAngle {
  const text = camera.toLowerCase()
  for (const [angle, keywords] of ANGLE_KEYWORDS) {
    if (keywords.some((keyword) => text.includes(keyword))) return angle
  }
  return DEFAULT_ANGLE
}

/** 角度不匹配时模型会改产品，所以宁可返回 null 让这一镜标「缺底图」。 */
export function matchProductAsset(
  angle: ProductAngle,
  assets: readonly RemixProductAsset[],
): RemixProductAsset | null {
  return assets.find((asset) => asset.angle === angle) ?? null
}
