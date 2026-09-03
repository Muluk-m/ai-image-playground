import type { SuggestionMenuGroup } from '../../../components/SuggestionMenu'
import {
  createMentionLabels,
  getMentionedImageIndexes,
  getPromptMentionParts,
  getVisiblePrompt,
  type MentionLabelResolver,
  remapImageMentions,
} from '../../../lib/promptImageMentions'
import { type PromptSlotPart, splitTextIntoSlotParts } from '../../../lib/promptSlots'
import type { InputImage, TaskParams } from '../../../types'
import type { AssetRecord, TemplateParams, TemplateRecord } from '../types'
import { getAssetsByImageId } from './assetMentions'

/** 引用到的参考图不是素材时该位记 null，序号仍要占住，否则套用后引用会整体错位。 */
export function collectTemplateAssetIds(
  prompt: string,
  inputImages: InputImage[],
  assets: AssetRecord[],
): Array<string | null> {
  const indexes = getMentionedImageIndexes(prompt)
  if (indexes.length === 0) return []

  const assetByImageId = getAssetsByImageId(assets)
  return Array.from({ length: Math.max(...indexes) + 1 }, (_, index) => {
    if (!indexes.includes(index)) return null
    const imageId = inputImages[index]?.id
    return (imageId && assetByImageId[imageId]?.id) ?? null
  })
}

export function remapTemplateMentions(
  prompt: string,
  imageIdsByOldIndex: Array<string | null>,
  nextImages: InputImage[],
): string {
  return remapImageMentions(prompt, (imageIndex) => {
    const imageId = imageIdsByOldIndex[imageIndex]
    return imageId ? nextImages.findIndex((image) => image.id === imageId) : -1
  })
}

/** 引用显示素材名，素材已删的位退回 `@图N`。 */
function createTemplateMentionLabels(
  template: TemplateRecord,
  assets: AssetRecord[],
): MentionLabelResolver {
  const namesByAssetId = Object.fromEntries(assets.map((asset) => [asset.id, asset.name]))
  const assetsAsImages = template.assetIds.map((assetId) => ({ id: assetId ?? '', dataUrl: '' }))
  return createMentionLabels(assetsAsImages, namesByAssetId)
}

/** 卡片里的一行模板预览。 */
export function getTemplatePreviewText(template: TemplateRecord, assets: AssetRecord[]): string {
  return getVisiblePrompt(template.prompt, createTemplateMentionLabels(template, assets))
}

export type TemplatePromptPart = PromptSlotPart | { type: 'mention'; text: string }

/** 详情里的完整提示词：引用与槽位各成一段，其余是纯文本。 */
export function getTemplatePromptParts(
  template: TemplateRecord,
  assets: AssetRecord[],
): TemplatePromptPart[] {
  return getPromptMentionParts(
    template.prompt,
    createTemplateMentionLabels(template, assets),
  ).flatMap((part) =>
    part.type === 'mention'
      ? [{ type: 'mention' as const, text: part.text }]
      : splitTextIntoSlotParts(part.text),
  )
}

/** 模板引用的素材，按引用序号；`asset` 为 null 表示该素材已被删除。 */
export interface TemplateAssetRef {
  assetId: string
  asset: AssetRecord | null
}

export function getTemplateAssetRefs(
  template: TemplateRecord,
  assets: AssetRecord[],
): TemplateAssetRef[] {
  return template.assetIds
    .filter((assetId): assetId is string => Boolean(assetId))
    .map((assetId) => ({ assetId, asset: assets.find((asset) => asset.id === assetId) ?? null }))
}

/** 参数一律带标签写出来，auto 也不省。 */
export function getTemplateParamEntries(
  params: TemplateParams,
): Array<{ label: string; value: string }> {
  return [
    { label: '尺寸', value: params.size },
    { label: '质量', value: params.quality },
    { label: '数量', value: `${params.n} 张` },
  ]
}

export function pickTemplateParams(params: TaskParams): TemplateParams {
  return { size: params.size, quality: params.quality, n: params.n }
}

export function matchTemplatesByName(templates: TemplateRecord[], query: string): TemplateRecord[] {
  const keyword = query.trim().toLowerCase()
  return templates
    .filter((template) => !keyword || template.name.toLowerCase().includes(keyword))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** 仅在 `/` 位于行首或空白之后时成立，避免误伤路径类文本。 */
export function getSlashTemplateQuery(
  prompt: string,
  cursor: number,
): { start: number; query: string } | null {
  const beforeCursor = prompt.slice(0, cursor)
  const slashIndex = beforeCursor.lastIndexOf('/')
  if (slashIndex < 0) return null
  if (slashIndex > 0 && !/\s/.test(beforeCursor[slashIndex - 1])) return null

  const query = beforeCursor.slice(slashIndex + 1)
  if (/\s/.test(query)) return null
  return { start: slashIndex, query }
}

export function buildTemplateMenuGroups({
  query,
  templates,
}: {
  query: string
  templates: TemplateRecord[]
}): SuggestionMenuGroup<string>[] {
  const options = matchTemplatesByName(templates, query).map((template) => ({
    key: template.id,
    label: template.name,
    value: template.id,
  }))
  return options.length > 0 ? [{ key: 'templates', heading: '模板', options }] : []
}
