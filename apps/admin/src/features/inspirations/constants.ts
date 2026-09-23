import type {
  InspirationAdminItem,
  InspirationKind,
  InspirationStatus,
  InspirationWriteInput,
} from '@image-playground/shared'

export const KIND_LABEL: Record<InspirationKind, string> = {
  showcase: '效果图',
  template: '模板',
  skill: '技能示例',
}

export const STATUS_LABEL: Record<InspirationStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已下架',
}

/** 状态只用语义色：已发布=成功，草稿=中性，已下架=描边。芽绿留给主要操作与选中态。 */
export const STATUS_BADGE: Record<InspirationStatus, 'success' | 'secondary' | 'outline'> = {
  published: 'success',
  draft: 'secondary',
  archived: 'outline',
}

/**
 * provider 的取值必须落在 BFF 发布校验认得的两个里（openai-compat → openai-queue、
 * gemini → gemini-queue），否则发布时一律 invalid_model。
 */
export const PROVIDER_OPTIONS = [
  { value: 'openai-compat', label: 'OpenAI 兼容' },
  { value: 'gemini', label: 'Gemini' },
] as const

export const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const

export const MAX_REFERENCE_IMAGES = 8

/** 跟 BFF `slotsOf` 同一条正则：后台看到的槽位必须和发布校验数的是同一批。 */
export function promptSlots(prompt: string): string[] {
  const slots = [...prompt.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
  return [...new Set(slots)]
}

/**
 * 条目存的是「公开桶里那张图的绝对地址」：导入脚本写的就是 thumbnailUrl，上传接口
 * 回的 publicUrl 也是绝对地址，BFF 的 publicAssetUrl 对 http(s) 原样放行。
 * 万一库里是一条裸 key（没有 base 可拼），这里返回空串，调用方渲染占位而不是坏图。
 */
export function assetUrl(keyOrUrl: string): string {
  return /^https?:\/\//.test(keyOrUrl) ? keyOrUrl : ''
}

export function emptyDraft(categoryId: string): InspirationWriteInput {
  return {
    id: '',
    kind: 'showcase',
    featured: false,
    title: '',
    description: null,
    categoryId,
    prompt: '',
    recommendedProvider: 'openai-compat',
    recommendedModel: '',
    params: { size: '1024x1024' },
    tags: [],
    coverKey: '',
    imageKey: null,
    referenceImages: [],
    skillName: null,
    sourceUrl: null,
    author: null,
    sort: 0,
  }
}

export function toWriteInput(item: InspirationAdminItem): InspirationWriteInput {
  return {
    id: item.id,
    kind: item.kind,
    featured: item.featured,
    title: item.title,
    description: item.description,
    categoryId: item.categoryId,
    prompt: item.prompt,
    recommendedProvider: item.recommendedProvider,
    recommendedModel: item.recommendedModel,
    params: { ...item.params },
    tags: [...item.tags],
    coverKey: item.coverKey,
    imageKey: item.imageKey,
    referenceImages: item.referenceImages.map((reference) => ({ ...reference })),
    skillName: item.skillName,
    sourceUrl: item.sourceUrl,
    author: item.author,
    sort: item.sort,
  }
}
