import MediaImage from '../../../components/MediaImage'
import type { SuggestionMenuGroup, SuggestionMenuOption } from '../../../components/SuggestionMenu'
import { Icon } from '../../../components/ui/icon'
import { i18next } from '../../../i18n'
import { getImageMentionLabel, imageMentionMatches } from '../../../lib/promptImageMentions'
import type { InputImage } from '../../../types'
import AssetThumb from '../components/AssetThumb'
import { type AssetRecord, assetCoverImageId } from '../types'

/** `@` 候选选中后交还给 composer 的身份：本次参考图按序号，素材按记录 id。 */
export type AtMentionValue = { type: 'image'; index: number } | { type: 'asset'; id: string }

/**
 * 每张视角图指向它所属的素材：胶囊的显示标签由这张图属于哪条素材决定。
 * 同一张图被几条素材用到时取最近用过的那条，并列时取列表里的第一条。
 */
export function getAssetsByImageId(assets: AssetRecord[]): Record<string, AssetRecord> {
  const byImageId: Record<string, AssetRecord> = {}

  for (const asset of assets) {
    for (const view of asset.views) {
      const chosen = byImageId[view.imageId]
      if (chosen && chosen.lastUsedAt >= asset.lastUsedAt) continue
      byImageId[view.imageId] = asset
    }
  }
  return byImageId
}

export function getAssetNamesByImageId(assets: AssetRecord[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(getAssetsByImageId(assets)).map(([imageId, asset]) => [imageId, asset.name]),
  )
}

export function labelMatches(query: string, label: string): boolean {
  const keyword = query.trim().toLowerCase()
  return !keyword || label.toLowerCase().includes(keyword)
}

export function matchAssetsByName(assets: AssetRecord[], query: string): AssetRecord[] {
  return assets
    .filter((asset) => labelMatches(query, asset.name))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** 参考图候选：`value` 由调用方给，两个 composer 的候选身份各自不同。 */
export function inputImageOptions<T>(
  images: readonly InputImage[],
  query: string,
  label: (image: InputImage, index: number) => string,
  value: (index: number) => T,
): SuggestionMenuOption<T>[] {
  return images
    .map((image, index) => ({
      key: `image:${image.id}`,
      label: label(image, index),
      thumbnail: <MediaImage src={image.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: value(index),
      index,
    }))
    .filter(
      (option) => imageMentionMatches(query, option.index) || labelMatches(query, option.label),
    )
}

export function assetOptions<T>(
  assets: AssetRecord[],
  query: string,
  value: (asset: AssetRecord) => T,
  exclude: ReadonlySet<string> = new Set(),
): SuggestionMenuOption<T>[] {
  return matchAssetsByName(assets, query)
    .filter((asset) => !exclude.has(assetCoverImageId(asset)))
    .map((asset) => ({
      key: `asset:${asset.id}`,
      label: asset.name,
      thumbnail: <AssetThumb imageId={assetCoverImageId(asset)} alt="" />,
      value: value(asset),
    }))
}

/**
 * 逐张生成时 `@` 列的是每个任务里的图：@图1 是各自的目标图，@图2… 依次是共享参考。
 * 不列素材：附加进来的素材会成为又一张目标图，没有固定的序号可引用。
 */
function perTaskMentionGroups(
  query: string,
  shared: readonly InputImage[],
  labelByImageId: Record<string, string>,
): SuggestionMenuGroup<AtMentionValue>[] {
  const target: SuggestionMenuOption<AtMentionValue> & { index: number } = {
    key: 'image:per-task-target',
    label: getImageMentionLabel(0),
    description: i18next.t('mention.perTaskTarget', { ns: 'library' }),
    icon: <Icon name="images" />,
    value: { type: 'image', index: 0 },
    index: 0,
  }
  const sharedOptions = shared.map((image, i) => {
    const name = labelByImageId[image.id]
    return {
      key: `image:${image.id}`,
      label: getImageMentionLabel(i + 1),
      description: name
        ? i18next.t('mention.perTaskSharedNamed', { ns: 'library', name })
        : i18next.t('mention.perTaskShared', { ns: 'library' }),
      thumbnail: <MediaImage src={image.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: { type: 'image', index: i + 1 } as AtMentionValue,
      index: i + 1,
    }
  })
  const options = [target, ...sharedOptions].filter(
    (option) =>
      imageMentionMatches(query, option.index) ||
      labelMatches(query, option.label) ||
      labelMatches(query, option.description ?? ''),
  )
  if (options.length === 0) return []
  return [
    {
      key: 'images',
      heading: i18next.t('mention.headingPerTask', { ns: 'library' }),
      options,
    },
  ]
}

export function buildAtMentionGroups({
  query,
  inputImages,
  assets,
  canAttachAssets = true,
  perTaskShared,
  labelByImageId = {},
}: {
  query: string
  inputImages: InputImage[]
  assets: AssetRecord[]
  canAttachAssets?: boolean
  /** 逐张生成：传入共享参考（可为空），候选改按每个任务里的序号列。 */
  perTaskShared?: readonly InputImage[]
  labelByImageId?: Record<string, string>
}): SuggestionMenuGroup<AtMentionValue>[] {
  if (perTaskShared) return perTaskMentionGroups(query, perTaskShared, labelByImageId)
  const imageOptions = inputImageOptions<AtMentionValue>(
    inputImages,
    query,
    (_image, index) => getImageMentionLabel(index),
    (index) => ({ type: 'image', index }),
  )

  const pickedAssets = canAttachAssets
    ? assetOptions<AtMentionValue>(assets, query, (asset) => ({ type: 'asset', id: asset.id }))
    : []

  // 一条素材都没有时留住空组当引导；有素材只是被查询过滤光则照旧收起。
  const assetsEmptyNote =
    canAttachAssets && assets.length === 0
      ? i18next.t('mention.assetsEmptyNote', { ns: 'library' })
      : undefined

  return [
    {
      key: 'images',
      heading: i18next.t('mention.headingImages', { ns: 'library' }),
      options: imageOptions,
    },
    {
      key: 'assets',
      heading: i18next.t('mention.headingAssets', { ns: 'library' }),
      options: pickedAssets,
      emptyNote: assetsEmptyNote,
    },
  ].filter((group) => group.options.length > 0 || group.emptyNote)
}
