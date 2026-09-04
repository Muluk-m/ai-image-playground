/** 产品素材的拍摄角度。镜头按机位挑同角度的底图，角度不匹配时模型会改产品。 */
export const PRODUCT_ANGLES = ['front', 'three-quarter', 'high-angle', 'top-down', 'side'] as const
export type ProductAngle = (typeof PRODUCT_ANGLES)[number]

export const PRODUCT_ANGLE_LABELS: Record<ProductAngle, string> = {
  front: '正面',
  'three-quarter': '3/4 侧',
  'high-angle': '俯拍',
  'top-down': '正顶',
  side: '侧面',
}

export const REMIX_PLATFORMS = ['amazon', 'alibaba', 'pinduoduo', 'site'] as const
export type RemixPlatform = (typeof REMIX_PLATFORMS)[number]

export const REMIX_PLATFORM_LABELS: Record<RemixPlatform, string> = {
  amazon: '亚马逊',
  alibaba: '阿里巴巴',
  pinduoduo: '拼多多',
  site: '独立站',
}

export const REMIX_LANGUAGES = ['zh', 'en'] as const
export type RemixLanguage = (typeof REMIX_LANGUAGES)[number]

export const REMIX_LANGUAGE_LABELS: Record<RemixLanguage, string> = { zh: '中文', en: '英文' }

export const REMIX_LEVELS = ['low', 'high'] as const
export type RemixLevel = (typeof REMIX_LEVELS)[number]

export const REMIX_LEVEL_LABELS: Record<RemixLevel, string> = { low: '低', high: '高' }

export interface RemixProductAsset {
  assetId: string
  angle: ProductAngle
}

export interface RemixSetSource {
  listingUrl?: string
  competitorImageIds: string[]
}

export interface RemixSetSettings {
  platform: RemixPlatform
  language: RemixLanguage
  level: RemixLevel
}

/** 一镜。简报与提示词由步骤②填充，本步保存的套 `shots` 为空。 */
export interface RemixShot {
  id: string
  type: string
  brief: Record<string, string>
  prompt: string
  enabled: boolean
  referenceImageId?: string
  productImageId?: string
  taskId?: string
  status: 'pending' | 'running' | 'done' | 'error'
}

/** 套：一条竞品链接（或一组竞品图）加一组产品素材，产出的一组图作为整体。 */
export interface RemixSetRecord {
  id: string
  name: string
  source: RemixSetSource
  productAssets: RemixProductAsset[]
  settings: RemixSetSettings
  shots: RemixShot[]
  createdAt: number
  updatedAt: number
}
