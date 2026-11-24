import MediaImage from '../../../components/MediaImage'
import type { SuggestionMenuGroup, SuggestionMenuOption } from '../../../components/SuggestionMenu'
import { Icon } from '../../../components/ui/icon'
import { i18next } from '../../../i18n'
import { getImageMentionLabel, imageMentionMatches } from '../../../lib/promptImageMentions'
import type { InputImage } from '../../../types'
import AssetThumb from '../components/AssetThumb'
import { type AssetRecord, assetCoverImageId } from '../types'

/** `@` 候选选中后交还给 composer 的身份：本次参考图按序号，素材按记录 id，批量模式支持当前图与提升左图。 */
export type AtMentionValue =
  | { type: 'image'; index: number }
  | { type: 'asset'; id: string }
  | { type: 'batchCurrent' }
  | { type: 'batchShared'; index: number }
  | { type: 'batchPromoteLoop'; index: number }

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
  const isTouch =
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)
  const assetsEmptyNote =
    canAttachAssets && assets.length === 0
      ? i18next.t(isTouch ? 'mention.assetsEmptyNoteTouch' : 'mention.assetsEmptyNote', {
          ns: 'library',
        })
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

/**
 * 批量生图模式下的 `@` 菜单：
 * 1. `@当前图`（正在逐张遍历的那一张）
 * 2. 共用参考（`@参考1..k`）
 * 3. 从遍历原图引用（选中自动转为共用参考并插入 `@参考`）
 */
export function buildBatchAtMentionGroups({
  query,
  loopImages,
  sharedImages,
  canPromote,
}: {
  query: string
  loopImages: readonly InputImage[]
  sharedImages: readonly InputImage[]
  canPromote: boolean
}): SuggestionMenuGroup<AtMentionValue>[] {
  const currentLabel = i18next.t('batch.currentMention', { ns: 'composer' })
  const currentOption: SuggestionMenuOption<AtMentionValue>[] =
    labelMatches(query, currentLabel) ||
    labelMatches(query, 'current') ||
    labelMatches(query, '当前')
      ? [
          {
            key: 'batch:current',
            label: currentLabel,
            description: i18next.t('batch.currentMentionDesc', { ns: 'composer' }),
            icon: <Icon name="layers" />,
            value: { type: 'batchCurrent' },
          },
        ]
      : []

  const sharedOptions: SuggestionMenuOption<AtMentionValue>[] = sharedImages
    .map((image, index) => ({
      key: `batch:shared:${image.id}`,
      label: i18next.t('batch.sharedMention', { ns: 'composer', n: index + 1 }),
      thumbnail: <MediaImage src={image.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: { type: 'batchShared', index } as AtMentionValue,
      index,
    }))
    .filter(
      (option) => imageMentionMatches(query, option.index) || labelMatches(query, option.label),
    )

  const promoteOptions: SuggestionMenuOption<AtMentionValue>[] = canPromote
    ? loopImages
        .map((image, index) => ({
          key: `batch:promote:${image.id}`,
          label: i18next.t('batch.loopThumbAria', { ns: 'composer', index: index + 1 }),
          description: i18next.t('batch.promoteOptionDesc', {
            ns: 'composer',
            n: sharedImages.length + 1,
          }),
          thumbnail: (
            <MediaImage src={image.dataUrl} className="h-full w-full object-cover" alt="" />
          ),
          value: { type: 'batchPromoteLoop', index } as AtMentionValue,
          index,
        }))
        .filter(
          (option) => imageMentionMatches(query, option.index) || labelMatches(query, option.label),
        )
    : []

  return [
    {
      key: 'batch-current',
      heading: i18next.t('batch.loopTitle', { ns: 'composer' }),
      options: currentOption,
    },
    {
      key: 'batch-shared',
      heading: i18next.t('batch.sharedTitle', { ns: 'composer' }),
      options: sharedOptions,
    },
    {
      key: 'batch-promote',
      heading: i18next.t('batch.promoteHeading', { ns: 'composer' }),
      options: promoteOptions,
    },
  ].filter((group) => group.options.length > 0)
}
