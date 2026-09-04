import { DEFAULT_PROMPT_LANGUAGE, type PromptLanguage } from '@image-playground/shared'

export interface BackgroundPromptInput {
  readonly plan: string
  readonly preference?: string
  readonly language?: PromptLanguage
}

interface Template {
  readonly lock: string
  readonly realism: string
  readonly preference: (value: string) => string
  readonly quality: string
}

const TEMPLATES: Record<PromptLanguage, Template> = {
  zh: {
    lock: '严格保留图中产品本身：款式、位置、大小、角度、颜色、材质、边缘厚度、阴影接地关系全部不变，不得移动或缩放产品。只替换产品以外的背景环境。',
    realism:
      '背景要像真实房屋实拍而不是效果图：真实的墙面材质细节与轻微不均匀、自然的窗光与柔和阴影、轻微的镜头透视与景深、真实家居配件自然摆放、没有过度光滑的 CG 感，色调克制。',
    preference: (value) => `用户偏好：${value}。`,
    quality: '商业产品摄影，无文字无水印。',
  },
  en: {
    lock: 'Keep the product in the image exactly as it is: style, position, size, angle, colour, material, edge thickness and contact shadows all unchanged; never move or rescale it. Replace only the background environment around the product.',
    realism:
      'The background must look like a real home photographed on location, not a render: real wall texture with slight unevenness, natural window light with soft shadows, slight lens perspective and depth of field, real household props placed naturally, no over-smooth CG feel, restrained colour.',
    preference: (value) => `User preference: ${value}.`,
    quality: 'Commercial product photography, no text, no watermark.',
  },
}

/** 前端不再拼提示词：模板固定在服务端，方案句是唯一的可变段（偏好可选）。 */
export function buildBackgroundPrompt({
  plan,
  preference,
  language = DEFAULT_PROMPT_LANGUAGE,
}: BackgroundPromptInput): string {
  const template = TEMPLATES[language]
  const wanted = preference?.trim()
  return [
    template.lock,
    plan.trim(),
    template.realism,
    ...(wanted ? [template.preference(wanted)] : []),
    template.quality,
  ].join('\n')
}
