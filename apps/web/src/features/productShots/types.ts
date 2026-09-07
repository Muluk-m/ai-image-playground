import type { BgSceneType, ProductBox } from '@image-playground/shared'
import type { ProductAsset } from '../../lib/productAngle'
import type { MatteBackendId, SegmentFailureReason } from '../../lib/productMatte'
import type { RemixBrief, RemixLevel, RemixProductDescription } from '../../lib/shotTypes'
import type { ProductShotAction } from './lib/actions'

/** 旧任务记录里的两组分段，只用来把老记录读成一个动作。 */
export type LegacyProductSource = 'original' | 'asset'
export type LegacyTarget = 'product-only' | 'product-and-background'

export const SOURCE_MODES = ['upload', 'listing', 'library'] as const

/** 原图从哪来：自己上传、贴商品链接抓、还是从素材库里挑。 */
export type SourceMode = (typeof SOURCE_MODES)[number]

export const SOURCE_MODE_LABELS: Record<SourceMode, string> = {
  upload: '上传',
  listing: '亚马逊链接',
  library: '素材库',
}

/** 抠图没用上的原因：跑不出来（前三种），或抠出来的框跟方案给的产品框对不上。 */
export type MatteFailureCause = SegmentFailureReason | 'box-mismatch'

/** 抠图这一段的结果：成功记实际用到的后端与耗时，失败记原因。 */
export type MatteOutcome =
  | { ok: true; backend: MatteBackendId; elapsedMs: number }
  | { ok: false; reason: MatteFailureCause }

/** 一次动作的产出。`masked` 为假是蒙版失败的提示词版，产品像素没被锁住。 */
export interface ProductShotVersion {
  id: string
  taskId: string
  plan: string
  prompt: string
  /** 方案给的产品框，重跑时拿它再校一次蒙版；旧记录没有这个字段。 */
  productBox?: ProductBox | null
  masked: boolean
  /** 这一版跑的是哪个动作；旧记录没有这个字段，按只换背景读。 */
  mode?: ProductShotAction
  /** 与竞品的距离，只有借创意重做有。 */
  level?: RemixLevel
  /** 借创意重做那一版的简报，重跑与「查看方案」拿它；其余动作没有。 */
  brief?: RemixBrief
  /** 换产品与借创意重做时用掉的那条素材；只换背景时没有。 */
  productAssetId?: string
  /** 这一版落盘时还没有这个字段的旧记录为 undefined。 */
  matte?: MatteOutcome
  /** 抠出来的蒙版叠在原图上的预览图；抠图没跑出结果时没有。 */
  mattePreviewImageId?: string
  createdAt: number
}

/** 出一版要走的三段，读秒按段切换。 */
export type ProductShotStage = 'plan' | 'matte' | 'generate'

export const PRODUCT_SHOT_STAGE_LABELS: Record<ProductShotStage, string> = {
  plan: '方案中',
  matte: '抠图中',
  generate: '生成中',
}

export interface ProductShotImage {
  imageId: string
  /** 链接拉图时的原始图片地址，上传的图没有。 */
  sourceUrl?: string
  /** 预检认出的画面类型；还没预检或预检失败时为 undefined。 */
  sceneType?: BgSceneType
  versions: ProductShotVersion[]
  chosenVersionId?: string
}

/** 商品图任务：一组原图连同偏好与版数，作为一个整体跑完。 */
export interface ProductShotJob {
  id: string
  name: string
  images: ProductShotImage[]
  preference: string
  versionsPerImage: number
  /** 最近一次跑的动作，批量沿用；旧记录没有它，由下面两个旧字段读出来。 */
  mode?: ProductShotAction
  /** 最近一次借创意重做的档位，批量沿用。 */
  level?: RemixLevel
  productSource?: LegacyProductSource
  target?: LegacyTarget
  /** 产品素材整任务生效，换产品与借创意重做共用。 */
  productAssets?: ProductAsset[]
  /** 产品说明整任务生效，借创意重做的锁产品段从这里取。 */
  product?: RemixProductDescription
  createdAt: number
  updatedAt: number
}

export const VERSIONS_PER_IMAGE_CHOICES = [1, 2, 3] as const

export type ProductShotBatchItemState = 'pending' | 'running' | 'done' | 'error'

export const PRODUCT_SHOT_BATCH_STATE_LABELS: Record<ProductShotBatchItemState, string> = {
  pending: '待跑',
  running: '进行中',
  done: '完成',
  error: '失败',
}

export interface ProductShotBatchItem {
  imageId: string
  state: ProductShotBatchItemState
  error: string | null
}

/** 一轮批量的进度。只活在内存里，刷新后由任务记录里的版本重新算出剩下哪些图。 */
export interface ProductShotBatchProgress {
  items: ProductShotBatchItem[]
  running: boolean
  stopRequested: boolean
  startedAt: number | null
  /** 当前这张走到的那一段，两张之间为 null。 */
  stage: ProductShotStage | null
}
