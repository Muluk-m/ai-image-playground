import { type CanvasResult, canvasResults, readCanvasDocument } from '@image-playground/shared'
import { useEffect, useMemo, useState } from 'react'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { videoOutputUrl } from '../../../lib/channels/queueClient'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { videoOutputFrame } from '../../agent/lib/artifactSource'
import { assetFormat, type CanvasAssetItem } from './canvasAssets'
import type { CanvasEditor } from './editor'
import type { NodeCanvasDocument } from './nodeCanvasDocument'
import { imageSource } from './nodeCanvasResults'

function videoRef(result: CanvasResult) {
  const source = result.source
  if (result.display?.video) return result.display.video
  return source.type === 'queue' ? { taskId: source.taskId, outputIndex: source.outputIndex } : null
}

function extensionOf(blob: Blob, media: 'image' | 'video'): string {
  const subtype = blob.type.split('/')[1]?.split(';')[0]
  if (!subtype) return media === 'video' ? 'mp4' : 'png'
  return subtype === 'jpeg' ? 'jpg' : subtype
}

/**
 * 本画布节点跑出来的结果（含没选中的候选）。只列生成来源：导入、上传的图是用户自己的素材，不算作品；
 * 从对话或资产浮层放上来的成品由对话那一路列出，按来源去重。
 */
export function canvasAssetsFromResults(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  fallbackTitle: string,
): CanvasAssetItem[] {
  const doc = canvas.doc
  const nodes = new Map(readCanvasDocument(doc).nodes.map((node) => [node.id, node]))
  return canvasResults(doc).flatMap((result): CanvasAssetItem[] => {
    if (result.source.type !== 'queue' && result.source.type !== 'local') return []
    const node = nodes.get(result.nodeId)
    const data = node?.type === 'image' || node?.type === 'video' ? node.data : undefined
    const title = data?.name?.trim() || data?.meta?.nodePrompt?.trim() || fallbackTitle
    const media = result.kind
    const video = media === 'video' ? videoRef(result) : null
    if (media === 'video' && !video) return []
    const picture = async () =>
      resolveMediaSource(await imageSource(editor, doc, result), 'display')
    return [
      {
        id: `result:${result.id}`,
        title,
        media,
        format: assetFormat(undefined, media),
        createdAt: result.createdAt,
        conversationId: '',
        load: () =>
          video && !result.display?.fileId && !result.display?.mediaId
            ? videoOutputFrame(video)
            : picture(),
        insert: {
          kind: media,
          source: result.source,
          ...(title ? { name: title } : {}),
          ...(video ? { video } : {}),
        },
        download: {
          name: title,
          fetch: async () => {
            if (video) {
              const response = await authenticatedBffFetch(videoOutputUrl(video))
              if (!response.ok) return null
              const blob = await response.blob()
              return { blob, ext: extensionOf(blob, media) }
            }
            const blob = await dataUrlToBlob(await imageSource(editor, doc, result))
            return { blob, ext: extensionOf(blob, media) }
          },
        },
      },
    ]
  })
}

/** 浮层开着时跟着节点结果变化重算；关着不订阅。 */
export function useCanvasResultAssets(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  fallbackTitle: string,
  enabled: boolean,
): readonly CanvasAssetItem[] {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const results = canvas.doc.getMap('nodeResults')
    const bump = () => setVersion((one) => one + 1)
    results.observe(bump)
    return () => results.unobserve(bump)
  }, [canvas, enabled])
  return useMemo(
    () => (enabled ? canvasAssetsFromResults(editor, canvas, fallbackTitle) : []),
    [editor, canvas, fallbackTitle, enabled, version],
  )
}
