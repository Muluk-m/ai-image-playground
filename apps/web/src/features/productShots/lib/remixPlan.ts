import {
  type CompetitorBrief,
  DEFAULT_PROMPT_LANGUAGE,
  type PromptLanguage,
  type ShotType,
} from '@image-playground/shared'
import { buildShotPrompt, isRenderableShotType } from '../../../lib/shotPrompt'
import {
  type RemixBrief,
  type RemixLevel,
  type RemixProductDescription,
  type RemixShotCopy,
  SHOT_TYPE_LABELS,
} from '../../../lib/shotTypes'

const GENERIC_PRODUCT_NAME = '本产品'

/** 默认走「不像」：借创意重做的用处是借竞品的档次，不是复制它的画面。 */
export const DEFAULT_REMIX_LEVEL: RemixLevel = 'high'

const COLOR_SEPARATORS = /[、,，;；\s]+/

export function emptyProductDescription(): RemixProductDescription {
  return { name: '', features: '', mainColor: '', forbiddenColors: [] }
}

/** 借创意重做的一版方案：版本条上的那句、提交用的提示词，以及重跑与抽屉要沿用的简报。 */
export interface RemixPlanned {
  plan: string
  prompt: string
  brief: RemixBrief
  shotType: ShotType
  copy: RemixShotCopy
}

export interface RemixPromptInput {
  shotType: ShotType
  brief: RemixBrief
  copy: RemixShotCopy
  product: RemixProductDescription
  level: RemixLevel
  language?: PromptLanguage
}

/** 六段提示词。分析出来的一版与抽屉里改过的一版共用它。 */
export function buildRemixPrompt({
  shotType,
  brief,
  copy,
  product,
  level,
  language = DEFAULT_PROMPT_LANGUAGE,
}: RemixPromptInput): string {
  return buildShotPrompt({ type: shotType, product, brief, copy, level, language })
}

export interface RemixPlanInput {
  brief: CompetitorBrief
  product: RemixProductDescription
  level: RemixLevel
  language?: PromptLanguage
}

export function buildRemixPlan({
  brief,
  product,
  level,
  language = DEFAULT_PROMPT_LANGUAGE,
}: RemixPlanInput): RemixPlanned {
  const { shotType, suggestedTitle, ...rest } = brief
  if (!isRenderableShotType(shotType)) {
    throw new Error(`${SHOT_TYPE_LABELS[shotType]}生不出来，换一张图`)
  }

  const copy = { title: suggestedTitle ?? '', subtitle: rest.textZones[0] ?? '' }
  return {
    plan: rest.composition.trim() || SHOT_TYPE_LABELS[shotType],
    prompt: buildRemixPrompt({ shotType, brief: rest, copy, product, level, language }),
    brief: rest,
    shotType,
    copy,
  }
}

/** 产品说明：用户填了就用他填的，产品名空着时退到素材名与任务名。 */
export function remixProductDescription(
  product: RemixProductDescription,
  assetName: string,
  jobName: string,
): RemixProductDescription {
  return {
    ...product,
    name: product.name.trim() || assetName.trim() || jobName.trim() || GENERIC_PRODUCT_NAME,
  }
}

export function parseColorList(text: string): string[] {
  return text.split(COLOR_SEPARATORS).filter(Boolean)
}

export function formatColorList(colors: readonly string[]): string {
  return colors.join('、')
}
