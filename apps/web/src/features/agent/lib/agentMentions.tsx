import type { SuggestionMenuGroup } from '../../../components/SuggestionMenu'
import { getImageMentionLabel } from '../../../lib/promptImageMentions'
import type { CanvasDoc, ImageEl } from '../../canvas/lib/canvasDoc'
import { assetOptions, inputImageOptions, labelMatches } from '../../library/lib/assetMentions'
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
  const images = doc.elements.filter((element): element is ImageEl => element.type === 'image')
  return images.reverse().flatMap((element, at) => {
    const dataUrl = doc.files[element.fileId]
    return dataUrl ? [{ imageId: element.id, dataUrl, label: `画布图${at + 1}` }] : []
  })
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
  const referenceOptions = inputImageOptions<AgentMentionValue>(
    references,
    query,
    (_image, index) => references[index]?.name ?? getImageMentionLabel(index),
    (index) => ({ type: 'reference', index }),
  )

  const canvasOptions = canvas
    .filter((image) => !attached.has(image.imageId) && labelMatches(query, image.label))
    .map((image) => ({
      key: `canvas:${image.imageId}`,
      label: image.label,
      thumbnail: <img src={image.dataUrl} className="h-full w-full object-cover" alt="" />,
      value: { type: 'canvas', imageId: image.imageId } as const,
    }))

  return [
    { key: 'references', heading: '本次参考图', options: referenceOptions },
    { key: 'canvas', heading: '画布', options: canvasOptions },
    {
      key: 'assets',
      heading: '素材',
      options: assetOptions<AgentMentionValue>(
        assets,
        query,
        (asset) => ({ type: 'asset', id: asset.id }),
        attached,
      ),
    },
  ].filter((group) => group.options.length > 0)
}
