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

/** 生成来源过期后，图片还能靠留存的 media / 文件放回画布；视频的 display 只是封面，仍按任务放。 */
function insertSource(result: CanvasResult): CanvasResult['source'] {
  if (result.kind === 'image' && result.display?.mediaId)
    return { type: 'media', mediaId: result.display.mediaId }
  if (result.kind === 'image' && result.display?.fileId)
    return { type: 'file', fileId: result.display.fileId }
  return result.source
}

function resultItem(
  editor: CanvasEditor,
  doc: NodeCanvasDocument['doc'],
  result: CanvasResult,
  title: string,
): CanvasAssetItem | null {
  const media = result.kind
  const video = media === 'video' ? videoRef(result) : null
  if (media === 'video' && !video) return null
  const picture = async () => resolveMediaSource(await imageSource(editor, doc, result), 'display')
  return {
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
      source: insertSource(result),
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
  }
}

type ResultItemCache = Map<string, { key: string; item: CanvasAssetItem }>

/**
 * 本画布节点跑出来的结果（含没选中的候选）。只列生成来源：导入、上传的图是用户自己的素材，不算作品；
 * 从对话或资产浮层放上来的成品由对话那一路列出，按来源去重。
 */
export function canvasAssetsFromResults(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  fallbackTitle: string,
  cache: ResultItemCache = new Map(),
): CanvasAssetItem[] {
  const doc = canvas.doc
  const nodes = new Map(readCanvasDocument(doc).nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const items = canvasResults(doc).flatMap((result): CanvasAssetItem[] => {
    if (result.source.type !== 'queue' && result.source.type !== 'local') return []
    const node = nodes.get(result.nodeId)
    const data = node?.type === 'image' || node?.type === 'video' ? node.data : undefined
    const title = data?.name?.trim() || data?.meta?.nodePrompt?.trim() || fallbackTitle
    // 拖动节点也会触发重算：结果和标题都没变就沿用上次的对象，缩略图不重新加载。
    const key = JSON.stringify([result, title])
    seen.add(result.id)
    const cached = cache.get(result.id)
    if (cached?.key === key) return [cached.item]
    const item = resultItem(editor, doc, result, title)
    if (!item) return []
    cache.set(result.id, { key, item })
    return [item]
  })
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id)
  return items
}

/** 浮层开着时跟着节点结果和节点数据（标题取自节点名、提示词）重算；关着不订阅。 */
export function useCanvasResultAssets(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  fallbackTitle: string,
  enabled: boolean,
): readonly CanvasAssetItem[] {
  const [version, setVersion] = useState(0)
  const [cache] = useState<ResultItemCache>(() => new Map())
  useEffect(() => {
    if (!enabled) return
    const results = canvas.doc.getMap('nodeResults')
    const nodes = canvas.doc.getMap('nodes')
    const bump = () => setVersion((one) => one + 1)
    results.observe(bump)
    nodes.observeDeep(bump)
    return () => {
      results.unobserve(bump)
      nodes.unobserveDeep(bump)
    }
  }, [canvas, enabled])
  return useMemo(
    () => (enabled ? canvasAssetsFromResults(editor, canvas, fallbackTitle, cache) : []),
    [editor, canvas, fallbackTitle, enabled, cache, version],
  )
}
