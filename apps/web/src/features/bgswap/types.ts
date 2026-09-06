import type { BgSceneType, ProductBox } from '@image-playground/shared'
import type { MatteBackendId, SegmentFailureReason } from '../../lib/productMatte'

/** 抠图没用上的原因：跑不出来（前三种），或抠出来的框跟方案给的产品框对不上。 */
export type MatteFailureCause = SegmentFailureReason | 'box-mismatch'

/** 抠图这一段的结果：成功记实际用到的后端与耗时，失败记原因。 */
export type MatteOutcome =
  | { ok: true; backend: MatteBackendId; elapsedMs: number }
  | { ok: false; reason: MatteFailureCause }

/** 一次「换背景」的产出。`masked` 为假是蒙版失败的提示词版，产品像素没被锁住。 */
export interface BgSwapVersion {
  id: string
  taskId: string
  plan: string
  prompt: string
  /** 方案给的产品框，重跑时拿它再校一次蒙版；旧记录没有这个字段。 */
  productBox?: ProductBox | null
  masked: boolean
  /** 这一版落盘时还没有这个字段的旧记录为 undefined。 */
  matte?: MatteOutcome
  /** 抠出来的蒙版叠在原图上的预览图；抠图没跑出结果时没有。 */
  mattePreviewImageId?: string
  createdAt: number
}

/** 出一版要走的三段，读秒按段切换。 */
export type BgSwapStage = 'plan' | 'matte' | 'generate'

export const BG_SWAP_STAGE_LABELS: Record<BgSwapStage, string> = {
  plan: '方案中',
  matte: '抠图中',
  generate: '生成中',
}

export interface BgSwapImage {
  imageId: string
  /** 链接拉图时的原始图片地址，上传的图没有。 */
  sourceUrl?: string
  /** 预检认出的画面类型；还没预检或预检失败时为 undefined。 */
  sceneType?: BgSceneType
  versions: BgSwapVersion[]
  chosenVersionId?: string
}

/** 换背景任务：一组原图连同偏好与版数，作为一个整体跑完。 */
export interface BgSwapJobRecord {
  id: string
  name: string
  images: BgSwapImage[]
  preference: string
  versionsPerImage: number
  createdAt: number
  updatedAt: number
}

export const VERSIONS_PER_IMAGE_CHOICES = [1, 2, 3] as const

export type BgSwapBatchItemState = 'pending' | 'running' | 'done' | 'error'

export const BG_SWAP_BATCH_STATE_LABELS: Record<BgSwapBatchItemState, string> = {
  pending: '待跑',
  running: '进行中',
  done: '完成',
  error: '失败',
}

export interface BgSwapBatchItem {
  imageId: string
  state: BgSwapBatchItemState
  error: string | null
}

/** 一轮批量的进度。只活在内存里，刷新后由任务记录里的版本重新算出剩下哪些图。 */
export interface BgSwapBatchProgress {
  items: BgSwapBatchItem[]
  running: boolean
  stopRequested: boolean
  startedAt: number | null
  /** 当前这张走到的那一段，两张之间为 null。 */
  stage: BgSwapStage | null
}
