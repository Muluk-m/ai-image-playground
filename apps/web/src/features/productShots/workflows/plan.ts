import type { ProductBox, PromptLanguage } from '@image-playground/shared'
import type { TaskParams } from '../../../types'

export const KIT_FORMATS = {
  square: { label: '方形主图', size: '1024x1024', ratio: '1:1' },
  portrait: { label: '竖版海报', size: '1024x1536', ratio: '2:3' },
  wide: { label: '横版广告', size: '1536x1024', ratio: '3:2' },
} as const
export type KitFormat = keyof typeof KIT_FORMATS
export type WorkflowSpec =
  | { kind: 'edit'; instruction: string; box: ProductBox }
  | { kind: 'kit'; format: KitFormat; language: PromptLanguage; title: string }
  | { kind: 'draft'; direction: string; instruction: string }
  | { kind: 'refine'; instruction: string; size: string }

export interface WorkflowRecipe {
  spec: WorkflowSpec
  sourceImageId: string
  sourceVersionId?: string
  inputImageIds: string[]
  params: TaskParams
  profileId: string
  modelId: string
  groupId: string
}

export function kitSpecs(
  formats: KitFormat[],
  languages: PromptLanguage[],
  titles: Record<PromptLanguage, string>,
): Extract<WorkflowSpec, { kind: 'kit' }>[] {
  return [...new Set(formats)].flatMap((format) =>
    [...new Set(languages)].map((language) => ({
      kind: 'kit' as const,
      format,
      language,
      title: titles[language].trim(),
    })),
  )
}

export function buildWorkflowPrompt(spec: WorkflowSpec): string {
  const preserve =
    '图 1 是本次编辑的主图。保留商品的形状、材质、颜色、Logo、文字和配件。其余参考图仅用于核对商品细节，不要照搬背景。'
  switch (spec.kind) {
    case 'edit': {
      const { x, y, w, h } = spec.box
      if (
        ![x, y, w, h].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        w <= 0 ||
        h <= 0 ||
        x + w > 1.001 ||
        y + h > 1.001 ||
        !spec.instruction.trim()
      )
        throw new Error('请圈选修改区域并填写要求')
      return `${preserve}\n只修改主图中左 ${Math.round(x * 100)}%、上 ${Math.round(y * 100)}%、宽 ${Math.round(w * 100)}%、高 ${Math.round(h * 100)}% 的区域，区域外尽量保持一致。不要画出圈选框。\n修改要求：${spec.instruction.trim()}`
    }
    case 'kit':
      return `${preserve}\n将主图重新构图为${KIT_FORMATS[spec.format].label}，画幅 ${KIT_FORMATS[spec.format].ratio}，${KIT_FORMATS[spec.format].size}。沿用主图的色调与风格，商品完整可见。画面上方留出约四分之一的干净空间供后续排字，不生成标题、宣传语或额外标识。`
    case 'draft':
      return `${preserve}\n为商品制作一张商业摄影方案。方向：${spec.direction}。完整呈现商品，不生成拼图，不增加文字。\n用户偏好：${spec.instruction.trim() || '自然、干净，突出商品'}`
    case 'refine':
      return `${preserve}\n以图 1 已选方案为基础精修一张成品，保持构图、机位、背景和商品位置，改善边缘、材质细节和光影。画幅 ${spec.size}。不要另起设计方向。\n补充要求：${spec.instruction.trim() || '保持现有设计'}`
  }
}

export function workflowParams(params: TaskParams, spec: WorkflowSpec): TaskParams {
  const size =
    spec.kind === 'kit'
      ? KIT_FORMATS[spec.format].size
      : spec.kind === 'refine'
        ? spec.size
        : spec.kind === 'draft'
          ? '1024x1024'
          : params.size
  const ratio =
    spec.kind === 'kit'
      ? KIT_FORMATS[spec.format].ratio
      : size === '1024x1536'
        ? '2:3'
        : size === '1536x1024'
          ? '3:2'
          : size === '1024x1024'
            ? '1:1'
            : params.gemini_aspect_ratio
  return {
    ...params,
    n: 1,
    size,
    gemini_aspect_ratio: ratio,
    quality: spec.kind === 'draft' ? 'medium' : 'high',
    transparent_output: false,
    output_format: 'png',
  }
}

export function workflowLabel(recipe: WorkflowRecipe): string {
  const spec = recipe.spec
  return spec.kind === 'kit'
    ? `${KIT_FORMATS[spec.format].label} · ${spec.language === 'zh' ? '中文' : '英文'}`
    : spec.kind === 'draft'
      ? `方案 · ${spec.direction}`
      : spec.kind === 'edit'
        ? '局部修改'
        : '精修成品'
}
