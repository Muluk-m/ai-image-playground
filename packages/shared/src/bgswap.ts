import { type ProductBox, parseProductBox } from './remix'

export const PROMPT_LANGUAGES = ['zh', 'en'] as const

export type PromptLanguage = (typeof PROMPT_LANGUAGES)[number]

export const DEFAULT_PROMPT_LANGUAGE: PromptLanguage = 'zh'

/** 视觉模型对一张商品图的判断：品类、原场景与它给出的一句新背景方案。 */
export interface BackgroundPlan {
  readonly category: string
  readonly sceneType: string
  readonly productBox: ProductBox | null
  readonly plan: string
}

export interface BackgroundPlanResult extends BackgroundPlan {
  readonly prompt: string
}

/** 视觉模型的输出与 BFF 应答的方案部分是同一个形状，两侧共用这一个解析器。 */
export function parseBackgroundPlan(value: unknown): BackgroundPlan | null {
  if (typeof value !== 'object' || value === null) return null
  const { category, sceneType, productBox, plan } = value as Record<string, unknown>
  const box = parseProductBox(productBox)
  if (box === undefined) return null
  if (typeof category !== 'string' || typeof sceneType !== 'string' || typeof plan !== 'string') {
    return null
  }
  // 方案句既当版本标签又进提示词，两处必须是同一串，所以在这里定型。
  if (!plan.trim()) return null
  return {
    category: category.trim(),
    sceneType: sceneType.trim(),
    productBox: box,
    plan: plan.trim(),
  }
}
