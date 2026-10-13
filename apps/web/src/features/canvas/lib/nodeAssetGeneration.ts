import {
  type CanvasNode,
  canvasMainResult,
  canvasOrigin,
  type ImageNodeData,
  readCanvasDocument,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { accountScope } from '../../../lib/authScope'
import { blobDataUrl, resolveMediaSource } from '../../../lib/cloudMedia'
import { storeImage } from '../../../lib/db'
import { appendGeneratedAssetView } from '../../library/lib/assetStore'
import { useLibraryStore } from '../../library/store'
import type { CanvasEditor } from './editor'

export function assetNodeContext(node: CanvasNode): string {
  return node.type === 'image' && node.data.meta?.nodeKind === 'asset'
    ? [node.data.name, node.data.meta.assetDescription].filter(Boolean).join('：')
    : ''
}

export function assetDerivationPrompt(node: CanvasNode): string | null {
  if (node.type !== 'image' || node.data.meta?.nodeKind !== 'asset') return null
  const kind = node.data.meta.assetKind
  const instruction =
    kind === 'person'
      ? '生成人物三视图：同一人物的正面、侧面、背面全身视图并排在一张图里。保持身份、服装、比例一致，干净中性背景，无文字。'
      : kind === 'location'
        ? '生成这个地点的空场景参考图。保持建筑、布局、光线与场景设定，不出现人物、动物、文字。'
        : null
  return instruction ? [assetNodeContext(node), instruction].join('\n\n') : null
}

/** Candidate remains available if library persistence fails, so retry never calls the model. */
export async function saveAssetNodeResult(
  editor: CanvasEditor,
  doc: Y.Doc,
  nodeId: string,
): Promise<boolean> {
  const node = readCanvasDocument(doc).nodes.find((one) => one.id === nodeId)
  const resultId = canvasMainResult(doc, nodeId)?.id
  if (node?.type !== 'image' || node.data.meta?.nodeKind !== 'asset' || !resultId) return false
  const assetId = node.data.meta.assetId
  const source = node.data.fileId && editor.doc.files[node.data.fileId]
  if (!assetId || !source) return false
  const current = accountScope()
  const map = doc.getMap('nodes').get(nodeId)
  const stillCurrent = () =>
    current() &&
    !doc.isDestroyed &&
    doc.getMap('nodes').get(nodeId) === map &&
    canvasMainResult(doc, nodeId)?.id === resultId
  const response = await fetch(await resolveMediaSource(source, 'original', true), {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('asset_image_unavailable')
  const dataUrl = await blobDataUrl(await response.blob())
  if (!stillCurrent()) return false
  const imageId = await storeImage(dataUrl, 'generated')
  if (!stillCurrent()) return false
  const asset = await appendGeneratedAssetView(
    assetId,
    {
      imageId,
      label: canvasMainResult(doc, nodeId)?.assetViewLabel ?? 'none',
      source: 'generated',
    },
    stillCurrent,
  )
  if (!current() || !asset) return false
  await useLibraryStore.getState().loadAssets()
  if (!stillCurrent()) return false
  const raw = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)?.get('data') as
    | ImageNodeData
    | undefined
  if (!raw) return false
  updateCanvasNode(
    doc,
    nodeId,
    {
      data: {
        ...raw,
        meta: { ...raw.meta, assetImageId: imageId, assetSavedResultId: resultId },
      },
    },
    canvasOrigin('system', 'asset-result'),
  )
  return true
}
