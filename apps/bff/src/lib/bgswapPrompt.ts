import {
  type BgSceneType,
  type BgSwapMode,
  DEFAULT_BG_SWAP_MODE,
  DEFAULT_PROMPT_LANGUAGE,
  type PromptLanguage,
} from '@image-playground/shared'

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

/** 前端不再拼提示词：模板固定在服务端，方案句是唯一的可变段（偏好可选）。 */
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
