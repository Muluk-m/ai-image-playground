import type { SuggestionMenuGroup } from '../../../components/SuggestionMenu'
import { getImageMentionLabel, imageMentionMatches } from '../../../lib/promptImageMentions'
import type { InputImage } from '../../../types'
import AssetThumb from '../components/AssetThumb'
import type { AssetRecord } from '../types'

/** `@` 候选选中后交还给 composer 的身份：本次参考图按序号，素材按记录 id。 */
export type AtMentionValue = { type: 'image'; index: number } | { type: 'asset'; id: string }

/** 同一张图有多条素材记录时取最近用过的那条，并列时取列表里的第一条。 */
export function getAssetsByImageId(assets: AssetRecord[]): Record<string, AssetRecord> {
  const byImageId: Record<string, AssetRecord> = {}

  for (const asset of assets) {
    const chosen = byImageId[asset.imageId]
    if (chosen && chosen.lastUsedAt >= asset.lastUsedAt) continue
    byImageId[asset.imageId] = asset
  }
  return byImageId
}

export function getAssetNamesByImageId(assets: AssetRecord[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(getAssetsByImageId(assets)).map(([imageId, asset]) => [imageId, asset.name]),
  )
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

  // 一条素材都没有时留住空组当引导；有素材只是被查询过滤光则照旧收起。
  const assetsEmptyNote =
    canAttachAssets && assets.length === 0 ? '还没有素材，右键参考图可保存' : undefined

  return [
    { key: 'images', heading: '本次参考图', options: imageOptions },
    { key: 'assets', heading: '素材', options: assetOptions, emptyNote: assetsEmptyNote },
  ].filter((group) => group.options.length > 0 || group.emptyNote)
}
