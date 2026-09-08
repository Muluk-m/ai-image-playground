import {
  type BackgroundPlan,
  type CompetitorBrief,
  DEFAULT_PROMPT_LANGUAGE,
  type ProductContext,
  type PromptLanguage,
  parseBackgroundPlan,
  parseCompetitorBrief,
  parseSceneScan,
  type SceneScan,
  SHOT_TYPES,
} from '@image-playground/shared'
import { config } from '../config'
import { askChatModel } from './chatCompletion'

const INSTRUCTIONS = `You analyse one competitor product photo so a different product can be shot the same way.
Answer with a single JSON object and nothing else. Keys:
"shotType": one of ${SHOT_TYPES.map((type) => `"${type}"`).join(', ')}
"composition": one sentence on layout and subject placement
"camera": one sentence on angle, height and lens feel
"lighting": one sentence on direction, quality and mood
"background": one sentence on setting and surfaces
"props": array of short strings, one per visible prop
"textZones": array of short strings, one per block of on-image text, saying where it sits
"palette": array of hex colours, most dominant first
"productBox": {"x","y","w","h"} normalised to 0-1 for the product's bounding box, or null when no product is visible
"suggestedTitle": optional short label for this shot`

function promptFor(product: ProductContext): string {
  const description = product.description.trim()
  return `${INSTRUCTIONS}\n\nThe product that will replace the one in the photo: ${product.name}${
    description ? `. ${description}` : ''
  }`
}

const SCENE_TYPE_KEY = `"sceneType": exactly one of "photo" (a plain product or lifestyle photo), "infographic" (headings, icons or comparison bars drawn onto the image), "callout" (a close-up carrying speech bubbles or pointer labels), "collage" (several panels tiled into one image). Answer with the English keyword itself.`

const SCAN_INSTRUCTIONS = `You look at one product photo and say what kind of image it is.
Answer with a single JSON object and nothing else. Keys:
${SCENE_TYPE_KEY}`

const PLAN_INSTRUCTIONS = `You look at one product photo and decide which real environment the product belongs in once its background is replaced. The product itself will not change.
Answer with a single JSON object and nothing else. Keys:
"category": the product category, a few words
"camera": one sentence on the angle and height the product is shot from
${SCENE_TYPE_KEY}
"productBox": {"x","y","w","h"} normalised to 0-1 for the product's bounding box, or null when no product is visible
"inventory": array of short strings naming everything in the photo that counts as the product: the product itself, plus every part that functionally belongs to this one item of merchandise and would have no reason to exist without it, whether or not it touches the main body. Anything that stands on its own and could be taken away without leaving the merchandise incomplete is staging, not product.
"plan": ONE sentence describing a real environment that suits this category, naming the wall, the floor, the light and one or two props. Every prop must be liftable on its own, must not appear in "inventory", and must not repeat the function of anything in "inventory". The sentence describes the new environment only: never restate what stays, never repeat the user's wording, no preamble`

const PLAN_LANGUAGE: Record<PromptLanguage, string> = {
  zh: 'Write all free-text values in Chinese.',
  en: 'Write all free-text values in English.',
}

function planPromptFor(preference: string | undefined, language: PromptLanguage): string {
  const wanted = preference?.trim()
  return [
    PLAN_INSTRUCTIONS,
    PLAN_LANGUAGE[language],
    // 偏好压过模型自己的判断，所以它进视觉提示，而不只是拼进最终提示词。
    ...(wanted
      ? [
          `The user asked for this direction, it outranks your own taste: ${wanted}`,
          'Whatever it names as must-keep belongs in "inventory", however you would have judged it.',
        ]
      : []),
  ].join('\n\n')
}

const VISION_ASK = { maxTokens: 1500, timeoutMs: 60_000 } as const

function ask<T>(image: string, prompt: string, parse: (value: unknown) => T | null): Promise<T> {
  return askChatModel(
    // 网关上的 claude 系列全部限流回 429，视觉模型别换成它们。
    { model: config.remix.visionModel, prompt, images: [image], ...VISION_ASK },
    parse,
  )
}

export function analyzeCompetitorImages(
  images: readonly string[],
  product: ProductContext,
): Promise<CompetitorBrief[]> {
  const prompt = promptFor(product)
  return Promise.all(images.map((image) => ask(image, prompt, parseCompetitorBrief)))
}

export interface BackgroundPlanRequest {
  readonly image: string
  readonly preference?: string
  readonly language?: PromptLanguage
}

export function planBackground({
  image,
  preference,
  language = DEFAULT_PROMPT_LANGUAGE,
}: BackgroundPlanRequest): Promise<BackgroundPlan> {
  return ask(image, planPromptFor(preference, language), parseBackgroundPlan)
}

/** 预检：只问画面类型。前端拉完图就要知道哪些是示意图，方案与偏好那一段留到点「换背景」时再问。 */
export function scanScene(image: string): Promise<SceneScan> {
  return ask(image, SCAN_INSTRUCTIONS, parseSceneScan)
}
