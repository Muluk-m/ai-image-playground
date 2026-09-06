import { type ProductBox, parseProductBox } from './remix'

export const PROMPT_LANGUAGES = ['zh', 'en'] as const

export type PromptLanguage = (typeof PROMPT_LANGUAGES)[number]

export const DEFAULT_PROMPT_LANGUAGE: PromptLanguage = 'zh'

export const BG_SCENE_TYPES = ['photo', 'infographic', 'callout', 'collage'] as const

/** 画面类型。非 `photo` 的图带说明文字，换背景会毁掉内容，前端默认跳过它们。 */
export type BgSceneType = (typeof BG_SCENE_TYPES)[number]

export interface SceneScan {
  readonly sceneType: BgSceneType
}

/** 视觉模型对一张商品图的判断：品类、原场景与它给出的一句新背景方案。 */
export interface BackgroundPlan {
  readonly category: string
  readonly sceneType: BgSceneType
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
  const scene = parseSceneType(sceneType)
  if (box === undefined || !scene) return null
  if (typeof category !== 'string' || typeof plan !== 'string') return null
  // 方案句既当版本标签又进提示词，两处必须是同一串，所以在这里定型。
  if (!plan.trim()) return null
  return {
    category: category.trim(),
    sceneType: scene,
    productBox: box,
    plan: plan.trim(),
  }
}

/** 画面类型是枚举不是自由文本：答不上枚举就当没答，交给上层重试。 */
function parseSceneType(value: unknown): BgSceneType | null {
  if (typeof value !== 'string') return null
  const wanted = value.trim().toLowerCase()
  return BG_SCENE_TYPES.find((candidate) => candidate === wanted) ?? null
}

export function parseSceneScan(value: unknown): SceneScan | null {
  if (typeof value !== 'object' || value === null) return null
  const sceneType = parseSceneType((value as Record<string, unknown>).sceneType)
  return sceneType ? { sceneType } : null
}
