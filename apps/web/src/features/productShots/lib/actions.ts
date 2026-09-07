import { BG_SWAP_MODES, type BgSwapMode, DEFAULT_BG_SWAP_MODE } from '@image-playground/shared'
import type { RemixLevel } from '../../../lib/shotTypes'
import type { ProductShotJob } from '../types'

/** 右栏能点的动作。`remix` 走竞品分析与六段提示词，其余走换背景方案。 */
export type ProductShotAction = BgSwapMode | 'remix'

export const PRODUCT_SHOT_ACTIONS: readonly ProductShotAction[] = [...BG_SWAP_MODES, 'remix']

export const ACTION_LABELS: Record<ProductShotAction, string> = {
  background: '换背景',
  'replace-product': '换产品',
  'replace-and-background': '换产品并换背景',
  remix: '借创意重做',
}

/** 借创意重做与竞品的距离。 */
export const REMIX_LEVEL_LABELS: Record<RemixLevel, string> = { low: '像', high: '不像' }

/** 版本条上的动作标签；旧记录没记动作，按只换背景读。 */
export function actionLabel(
  mode: ProductShotAction | undefined,
  level: RemixLevel | undefined,
): string {
  const action = mode ?? DEFAULT_BG_SWAP_MODE
  const label = ACTION_LABELS[action]
  return action === 'remix' && level ? `${label} · ${REMIX_LEVEL_LABELS[level]}` : label
}

/** 历史卡上的动作标签：任务里每一版跑过的动作去重，按动作枚举排。 */
export function jobActionLabels(job: ProductShotJob | undefined): string[] {
  if (!job) return []
  const used = new Set(
    job.images.flatMap((image) =>
      image.versions.map((version) => version.mode ?? DEFAULT_BG_SWAP_MODE),
    ),
  )
  return PRODUCT_SHOT_ACTIONS.filter((mode) => used.has(mode)).map((mode) => ACTION_LABELS[mode])
}
