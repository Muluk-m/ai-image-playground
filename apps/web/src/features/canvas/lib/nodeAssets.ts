import { connectCanvasNodes, readCanvasDocument, updateCanvasNode } from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import { getImageDimensions } from '../../../lib/canvasImage'
import { blobDataUrl, resolveMediaSource } from '../../../lib/cloudMedia'
import { storeImage } from '../../../lib/db'
import { loadImageOriginal } from '../../../lib/imageSource'
import { ensureAssetImage } from '../../../lib/sync/assetImages'
import { useLibraryStore } from '../../library/store'
import { type AssetRecord, assetCoverImageId } from '../../library/types'
import type { CanvasEditor } from './editor'
import { createNode } from './nodeCanvasActions'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export const ASSET_DRAG_TYPE = 'application/x-muvloom-asset'

/** Resolve the selected view before inserting; an unavailable image leaves no half-created card. */
export async function insertAssetNode(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  asset: AssetRecord,
  point: { x: number; y: number },
  targetId?: string,
  imageId = assetCoverImageId(asset),
  targetPrompt?: string,
): Promise<string | null> {
  const sameAccount = accountScope()
  const originalTarget = targetId
    ? readCanvasDocument(canvas.doc).nodes.find((one) => one.id === targetId)
    : undefined
  const originalPrompt =
    originalTarget && 'meta' in originalTarget.data
      ? originalTarget.data.meta?.nodePrompt
      : undefined
  const originalMap = targetId ? canvas.doc.getMap('nodes').get(targetId) : undefined
  let source: string | null = null
  let dimensions: { width: number; height: number } | undefined
  if (imageId) {
    if (!asset.views.some((view) => view.imageId === imageId)) return null
    await ensureAssetImage(imageId)
    source = await loadImageOriginal(imageId)
    if (!source) throw new Error('Asset image unavailable')
    dimensions = await getImageDimensions(source)
  }
  if (!sameAccount() || canvas.doc.isDestroyed) return null
  const latest = useLibraryStore.getState().assets.find((one) => one.id === asset.id)
  if (!latest || (imageId && !latest.views.some((view) => view.imageId === imageId))) return null
  const target = targetId
    ? readCanvasDocument(canvas.doc).nodes.find((one) => one.id === targetId)
    : undefined
  if (targetId && (!target || canvas.doc.getMap('nodes').get(targetId) !== originalMap)) return null
  if (
    target &&
    targetPrompt !== undefined &&
    'meta' in target.data &&
    target.data.meta?.nodePrompt !== originalPrompt
  )
    return null
  const width = 320
  const height = dimensions ? Math.max(120, (width * dimensions.height) / dimensions.width) : 220
  const fileId = source ? editor.doc.cacheBitmap(source) : undefined
  let id = ''
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    id = createNode(canvas, 'image', point, '', {
      nodes: target ? [target] : [],
      side: 'left',
      size: { width, height },
    })
    updateCanvasNode(
      canvas.doc,
      id,
      {
        data: {
          name: latest.name,
          ...(fileId ? { fileId } : {}),
          ...(dimensions
            ? { naturalWidth: dimensions.width, naturalHeight: dimensions.height }
            : {}),
          meta: {
            nodeKind: 'asset',
            assetId: latest.id,
            assetKind: latest.kind ?? '',
            assetDescription: latest.description ?? '',
            assetVoiceId: latest.voiceId ?? '',
            assetImageId: imageId,
          },
        },
      },
      canvas.origin,
    )
    if (
      target &&
      target.type !== 'text' &&
      target.type !== 'timeline' &&
      targetPrompt !== undefined
    )
      updateCanvasNode(
        canvas.doc,
        target.id,
        { data: { ...target.data, meta: { ...target.data.meta, nodePrompt: targetPrompt } } },
        canvas.origin,
      )
    if (target) connectCanvasNodes(canvas.doc, { source: id, target: target.id }, canvas.origin)
  }, canvas.origin)
  canvas.undo.stopCapturing()
  void useLibraryStore.getState().noteAssetUsed(asset.id)
  return id
}

/** Copy actual original pixels into the library before asking for a name. */
export async function saveNodeAsAsset(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  nodeId: string,
): Promise<void> {
  const node = readCanvasDocument(canvas.doc).nodes.find((one) => one.id === nodeId)
  if (node?.type !== 'image' || !node.data.fileId) return
  const source = editor.doc.files[node.data.fileId]
  if (!source) throw new Error('Image unavailable')
  const sameAccount = accountScope()
  const response = await fetch(await resolveMediaSource(source, 'original', true), {
    credentials: 'include',
  })
  if (!response.ok) throw new Error('Image unavailable')
  const blob = await response.blob()
  if (!sameAccount() || canvas.doc.isDestroyed) return
  const dataUrl = await blobDataUrl(blob)
  if (!sameAccount()) return
  const imageId = await storeImage(dataUrl, 'upload')
  if (sameAccount()) useLibraryStore.getState().startNaming(imageId, node.data.name)
}
