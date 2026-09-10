import type { SuggestionMenuGroup } from '../../../components/SuggestionMenu'
import { getImageMentionLabel, imageMentionMatches } from '../../../lib/promptImageMentions'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import AssetThumb from '../../library/components/AssetThumb'
import { matchAssetsByName } from '../../library/lib/assetMentions'
import type { AssetRecord } from '../../library/types'
import type { AgentReference } from './references'

/** `@` 候选选中后交还给输入框的身份。三条路最终都收敛成同一条引用。 */
export type AgentMentionValue =
  | { type: 'reference'; index: number }
  | { type: 'canvas'; imageId: string }
  | { type: 'asset'; id: string }

export interface CanvasImage {
  readonly imageId: string
  readonly dataUrl: string
  readonly label: string
}

/** 画布上的图片对象，最上层的排在最前——面板的图层页签也是这个次序。 */
export function canvasImages(doc: CanvasDoc): CanvasImage[] {
  const images: CanvasImage[] = []
  for (const element of doc.elements) {
    if (element.type !== 'image') continue
    const dataUrl = doc.files[element.fileId]
    if (dataUrl) images.push({ imageId: element.id, dataUrl, label: '' })
  }
  return images.reverse().map((image, at) => ({ ...image, label: `画布图${at + 1}` }))
}

function matchesLabel(query: string, label: string): boolean {
  const keyword = query.trim().toLowerCase()
  return !keyword || label.toLowerCase().includes(keyword)
}

export function buildAgentMentionGroups({
  query,
  references,
  canvas,
  assets,
}: {
  query: string
  references: readonly AgentReference[]
  canvas: readonly CanvasImage[]
  assets: AssetRecord[]
}): SuggestionMenuGroup<AgentMentionValue>[] {
  const attached = new Set(references.map((one) => one.id))
  const referenceOptions = references
    .map((reference, index) => ({
      key: `reference:${reference.id}`,
      label: reference.name ?? getImageMentionLabel(index),
      thumbnail: <img src={reference.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: { type: 'reference', index } as const,
    }))
    .filter(
      (option) =>
        imageMentionMatches(query, option.value.index) || matchesLabel(query, option.label),
    )

  const canvasOptions = canvas
    .filter((image) => !attached.has(image.imageId) && matchesLabel(query, image.label))
    .map((image) => ({
      key: `canvas:${image.imageId}`,
      label: image.label,
      thumbnail: <img src={image.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: { type: 'canvas', imageId: image.imageId } as const,
    }))

  const assetOptions = matchAssetsByName(assets, query)
    .filter((asset) => !attached.has(asset.imageId))
    .map((asset) => ({
      key: `asset:${asset.id}`,
      label: asset.name,
      thumbnail: <AssetThumb imageId={asset.imageId} alt="" />,
      value: { type: 'asset', id: asset.id } as const,
    }))

  return [
    { key: 'references', heading: '本次参考图', options: referenceOptions },
    { key: 'canvas', heading: '画布', options: canvasOptions },
    { key: 'assets', heading: '素材', options: assetOptions },
  ].filter((group) => group.options.length > 0)
}
