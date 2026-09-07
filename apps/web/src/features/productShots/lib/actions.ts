import { BG_SWAP_MODES, type BgSwapMode, DEFAULT_BG_SWAP_MODE } from '@image-playground/shared'
import type { ProductShotJob } from '../types'

export const ACTION_LABELS: Record<BgSwapMode, string> = {
  background: '换背景',
  'replace-product': '换产品',
  'replace-and-background': '换产品并换背景',
}

/** 历史卡上的动作标签：任务里每一版跑过的动作去重，按动作枚举排。 */
export function jobActionLabels(job: ProductShotJob | undefined): string[] {
  if (!job) return []
  const used = new Set(
    job.images.flatMap((image) =>
      image.versions.map((version) => version.mode ?? DEFAULT_BG_SWAP_MODE),
    ),
  )
  return BG_SWAP_MODES.filter((mode) => used.has(mode)).map((mode) => ACTION_LABELS[mode])
}
