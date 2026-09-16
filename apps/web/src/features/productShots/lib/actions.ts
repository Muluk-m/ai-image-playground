import {
  BG_SWAP_MODES,
  type BgSwapMode,
  DEFAULT_BG_SWAP_MODE,
  type PromptLanguage,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import type { RemixLevel } from '../../../lib/shotTypes'
import type { ProductShotJob } from '../types'

// `getFixedT(null, ns)` 把命名空间钉死、语言不钉：key 受 productShots 的类型约束，
// 每次调用仍取当前语言。手写 `Parameters<typeof i18next.t>[0]` 拿到的是全部命名空间的
// 并集，配上 `ns` 反而对不上，key 也就失去了编译期检查。
const t = i18next.getFixedT(null, 'productShots')

/** 右栏能点的动作。`remix` 走竞品分析与六段提示词，其余走换背景方案。 */
export type ProductShotAction = BgSwapMode | 'remix'

export const PRODUCT_SHOT_ACTIONS: readonly ProductShotAction[] = [...BG_SWAP_MODES, 'remix']

export function actionLabels(): Record<ProductShotAction, string> {
  return {
    background: t('mode.background'),
    'replace-product': t('mode.replaceProduct'),
    'replace-and-background': t('mode.replaceAndBackground'),
    remix: t('mode.remix'),
  }
}

/** 借创意重做与竞品的距离。 */
export function remixLevelLabels(): Record<RemixLevel, string> {
  return { low: t('remixLevel.low'), high: t('remixLevel.high') }
}

/** 图上文案的语言。这是提示词语言，与界面语言无关。 */
export function promptLanguageLabels(): Record<PromptLanguage, string> {
  return { zh: t('promptLanguage.zh'), en: t('promptLanguage.en') }
}

/** 版本条上的动作标签；旧记录没记动作，按只换背景读。 */
export function actionLabel(
  mode: ProductShotAction | undefined,
  level: RemixLevel | undefined,
): string {
  const action = mode ?? DEFAULT_BG_SWAP_MODE
  const label = actionLabels()[action]
  return action === 'remix' && level ? `${label} · ${remixLevelLabels()[level]}` : label
}

/** 历史卡上的动作标签：任务里每一版跑过的动作去重，按动作枚举排。 */
export function jobActionLabels(job: ProductShotJob | undefined): string[] {
  if (!job) return []
  const used = new Set(
    job.images.flatMap((image) =>
      image.versions.map((version) => version.mode ?? DEFAULT_BG_SWAP_MODE),
    ),
  )
  const labels = actionLabels()
  return PRODUCT_SHOT_ACTIONS.filter((mode) => used.has(mode)).map((mode) => labels[mode])
}
