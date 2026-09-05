/** 一次「换背景」的产出。`masked` 为假是蒙版失败的提示词版，产品像素没被锁住。 */
export interface BgSwapVersion {
  id: string
  taskId: string
  plan: string
  prompt: string
  masked: boolean
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
