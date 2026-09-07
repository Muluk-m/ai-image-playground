import { type ProductBox, parseProductBox } from './remix'

export const PROMPT_LANGUAGES = ['zh', 'en'] as const

export type PromptLanguage = (typeof PROMPT_LANGUAGES)[number]

export const DEFAULT_PROMPT_LANGUAGE: PromptLanguage = 'zh'

export const BG_SWAP_MODES = ['background', 'replace-product', 'replace-and-background'] as const

/** 一次换背景要做什么：只换背景、只换产品、或两样都换。 */
export type BgSwapMode = (typeof BG_SWAP_MODES)[number]

export const DEFAULT_BG_SWAP_MODE: BgSwapMode = 'background'

export const BG_SCENE_TYPES = ['photo', 'infographic', 'callout', 'collage'] as const

/** 画面类型。非 `photo` 的图带说明文字，换背景会毁掉内容，前端默认跳过它们。 */
export type BgSceneType = (typeof BG_SCENE_TYPES)[number]

export interface SceneScan {
  readonly sceneType: BgSceneType
}

/** 视觉模型对一张商品图的判断：品类、原场景与它给出的一句新背景方案。 */
export interface BackgroundPlan {
  readonly category: string
  /** 原图机位的一句话描述，换产品时拿它挑同角度的素材；模型没答上来为空串。 */
  readonly camera: string
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
  const { category, camera, sceneType, productBox, plan } = value as Record<string, unknown>
  const box = parseProductBox(productBox)
  const scene = parseSceneType(sceneType)
  if (box === undefined || !scene) return null
  if (typeof category !== 'string' || typeof plan !== 'string') return null
  // 方案句既当版本标签又进提示词，两处必须是同一串，所以在这里定型。
  if (!plan.trim()) return null
  return {
    category: category.trim(),
    // 机位只用来挑素材，答不上来就走默认角度，不该让整个方案作废。
    camera: typeof camera === 'string' ? camera.trim() : '',
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
export interface BackgroundPromptInput {
  readonly plan: string
  readonly sceneType: BgSceneType
  readonly preference?: string
  readonly language?: PromptLanguage
  readonly mode?: BgSwapMode
}

interface Template {
  readonly lock: string
  readonly surfaces: string
  readonly realism: string
  readonly preference: (value: string) => string
  readonly quality: string
  readonly swapInMask: string
  readonly keepScene: string
  readonly swapIntoFraming: string
}

const TEMPLATES: Record<PromptLanguage, Template> = {
  zh: {
    lock: '严格保留图中产品本身：款式、位置、大小、角度、颜色、材质、边缘厚度、阴影接地关系全部不变，不得移动或缩放产品。只替换产品以外的背景环境。',
    surfaces:
      '原图里的墙面、半墙、台面与地面都属于背景，一并替换成新环境的对应表面，不要保留任何一块原有饰面。',
    realism:
      '背景要像真实房屋实拍而不是效果图：真实的墙面材质细节与轻微不均匀、自然的窗光与柔和阴影、轻微的镜头透视与景深、真实家居配件自然摆放、没有过度光滑的 CG 感，色调克制。',
    preference: (value) => `用户偏好：${value}。`,
    quality: '商业产品摄影，无文字无水印。',
    swapInMask:
      '把图1遮罩区域内的产品替换为图2里的产品：沿用图1原有的角度、透视与画面比例，光线方向、明暗与阴影接地关系照图1，产品的颜色、材质与外形细节以图2为准。',
    keepScene:
      '图1遮罩以外的画面一律不变：背景、地面、道具、前景遮挡与整体色调保持原样，不得移动或缩放画面。',
    swapIntoFraming:
      '图1是构图参考，原产品所在的位置已被抹成灰块：把图2里的产品按同样的角度、透视、大小与位置画回那个位置，产品的颜色、材质与外形细节以图2为准。',
  },
  en: {
    lock: 'Keep the product in the image exactly as it is: style, position, size, angle, colour, material, edge thickness and contact shadows all unchanged; never move or rescale it. Replace only the background environment around the product.',
    surfaces:
      'The walls, half walls, counters and floor of the original photo are background as well: replace all of them with the surfaces of the new environment and keep none of the original finishes.',
    realism:
      'The background must look like a real home photographed on location, not a render: real wall texture with slight unevenness, natural window light with soft shadows, slight lens perspective and depth of field, real household props placed naturally, no over-smooth CG feel, restrained colour.',
    preference: (value) => `User preference: ${value}.`,
    quality: 'Commercial product photography, no text, no watermark.',
    swapInMask:
      'Replace the product inside the masked area of image 1 with the product from image 2: keep the angle, perspective and scale of image 1, keep its light direction, tonality and contact shadows, and take colour, material and shape detail from image 2.',
    keepScene:
      'Everything outside the mask of image 1 stays as it is: background, floor, props, foreground occlusion and overall colour are unchanged, and the framing is never moved or rescaled.',
    swapIntoFraming:
      'Image 1 is a framing reference and the original product has been painted over with a grey block: draw the product from image 2 back into that spot at the same angle, perspective, size and position, taking colour, material and shape detail from image 2.',
  },
}

/** 方案句是唯一的可变段（偏好可选）：抽屉里改了方案句，前端拿这里重算同一串提示词。 */
export function buildBackgroundPrompt({
  plan,
  sceneType,
  preference,
  language = DEFAULT_PROMPT_LANGUAGE,
  mode = DEFAULT_BG_SWAP_MODE,
}: BackgroundPromptInput): string {
  const template = TEMPLATES[language]
  const wanted = preference?.trim()
  // 示意图与拼图上的「墙面」多半是版面而不是背景，整片换掉会把说明一起吃了。
  const surfaces = sceneType === 'photo' ? [template.surfaces] : []
  const background = [...surfaces, plan.trim(), template.realism]
  const wish = wanted ? [template.preference(wanted)] : []

  // 只换产品时背景一个像素都不动，方案句与偏好都是背景的事，带上只会诱导模型改景。
  const body =
    mode === 'replace-product'
      ? [template.swapInMask, template.keepScene]
      : mode === 'replace-and-background'
        ? [template.swapIntoFraming, ...background, ...wish]
        : [template.lock, ...background, ...wish]

  return [...body, template.quality].join('\n')
}
