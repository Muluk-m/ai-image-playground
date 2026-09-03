import type { SuggestionMenuGroup } from '../../../components/SuggestionMenu'
import { getImageMentionLabel, imageMentionMatches } from '../../../lib/promptImageMentions'
import type { InputImage } from '../../../types'
import AssetThumb from '../components/AssetThumb'
import type { AssetRecord } from '../types'

/** `@` 候选选中后交还给 composer 的身份：本次参考图按序号，素材按记录 id。 */
export type AtMentionValue = { type: 'image'; index: number } | { type: 'asset'; id: string }

/** 同一张图有多个素材名时取最近用过的那个，并列时取列表里的第一个。 */
export function getAssetNamesByImageId(assets: AssetRecord[]): Record<string, string> {
  const names: Record<string, string> = {}
  const usedAt: Record<string, number> = {}

  for (const asset of assets) {
    if (asset.imageId in usedAt && usedAt[asset.imageId] >= asset.lastUsedAt) continue
    names[asset.imageId] = asset.name
    usedAt[asset.imageId] = asset.lastUsedAt
  }
  return names
}

export function matchAssetsByName(assets: AssetRecord[], query: string): AssetRecord[] {
  const keyword = query.trim().toLowerCase()
  return assets
    .filter((asset) => !keyword || asset.name.toLowerCase().includes(keyword))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function buildAtMentionGroups({
  query,
  inputImages,
  assets,
  canAttachAssets = true,
}: {
  query: string
  inputImages: InputImage[]
  assets: AssetRecord[]
  canAttachAssets?: boolean
}): SuggestionMenuGroup<AtMentionValue>[] {
  const imageOptions = inputImages
    .map((image, index) => ({
      key: `image:${image.id}`,
      label: getImageMentionLabel(index),
      thumbnail: <img src={image.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: { type: 'image', index } as const,
    }))
    .filter((option) => imageMentionMatches(query, option.value.index))

  const assetOptions = canAttachAssets
    ? matchAssetsByName(assets, query).map((asset) => ({
        key: `asset:${asset.id}`,
        label: asset.name,
        thumbnail: <AssetThumb imageId={asset.imageId} alt="" />,
        value: { type: 'asset', id: asset.id } as const,
      }))
    : []

  return [
    { key: 'images', heading: '本次参考图', options: imageOptions },
    { key: 'assets', heading: '素材', options: assetOptions },
  ].filter((group) => group.options.length > 0)
}
