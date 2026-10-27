import {
  type AgentFetchedImage,
  type AgentToolArtifact,
  isVideoGenerationRecord,
} from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { queueOutputUrl, videoOutputUrl } from '../../../lib/channels/queueClient'
import type { AgentConversationState } from '../../agent/lib/agentClient'
import { fetchedCanvasId } from '../../agent/lib/artifactDelivery'
import {
  artifactPreview,
  fetchedImagePreview,
  INLINE_RESULT_THUMBNAIL_SCALE,
} from '../../agent/lib/artifactPreview'
import type { BatchAssetPage } from '../../agent/lib/assetItems'
import type { AgentPanelMessage, AgentToolMessage } from '../../agent/types'
import type { MediaBundleEntry } from './exportImages'
import type { CanvasResultInsert } from './nodeCanvasResults'

/** 画布资产浮层里的一件生成作品。 */
export interface CanvasAssetItem {
  readonly id: string
  readonly title: string
  readonly media: 'image' | 'video'
  /** 列表视图右侧的格式，取自 mime。 */
  readonly format: string
  readonly createdAt: number
  readonly conversationId: string
  readonly load: () => Promise<string | null>
  /** 放上画布时新节点的来源。 */
  readonly insert: CanvasResultInsert
  /** 下载时取原件字节。 */
  readonly download: MediaBundleEntry
}

/** 消息落库时间：面板消息 id 与历史消息同 id，工具卡按所在轮次兜底。 */
export type MessageTime = (message: AgentPanelMessage) => number

export function messageTimes(
  history: AgentConversationState | null,
  fallback = Date.now(),
): MessageTime {
  const byId = new Map<string, number>()
  const byTurn = new Map<string, number>()
  for (const message of history?.messages ?? []) {
    byId.set(message.id, message.createdAt)
    const turn = byTurn.get(message.turnId)
    if (turn === undefined || message.createdAt > turn)
      byTurn.set(message.turnId, message.createdAt)
  }
  return (message) => byId.get(message.id) ?? byTurn.get(message.turnId) ?? fallback
}

const FORMATS: Record<string, string> = { jpeg: 'JPG', 'svg+xml': 'SVG', quicktime: 'MOV' }

export function assetFormat(mime: string | undefined, media: 'image' | 'video'): string {
  const subtype = mime?.split('/')[1]?.split(';')[0]?.trim().toLowerCase()
  if (!subtype) return media === 'video' ? 'MP4' : 'PNG'
  return FORMATS[subtype] ?? subtype.toUpperCase()
}

function extensionOf(blob: Blob, media: 'image' | 'video'): string {
  const subtype = blob.type.split('/')[1]?.split(';')[0]
  if (!subtype) return media === 'video' ? 'mp4' : 'png'
  return subtype === 'jpeg' ? 'jpg' : subtype
}

async function bffBlob(url: string): Promise<Blob | null> {
  const response = await authenticatedBffFetch(url)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  return response.blob()
}

function artifactItem(
  artifact: AgentToolArtifact,
  title: string,
  conversationId: string,
  createdAt: number,
): CanvasAssetItem {
  const media = artifact.media === 'video' ? 'video' : 'image'
  const generation = isVideoGenerationRecord(artifact.video) ? artifact.video : undefined
  const video =
    media === 'video'
      ? {
          taskId: artifact.taskId,
          outputIndex: artifact.outputIndex,
          ...(artifact.mediaId ? { mediaId: artifact.mediaId } : {}),
          ...(generation ? { generation } : {}),
        }
      : undefined
  const insert: CanvasResultInsert = video
    ? {
        kind: 'video',
        source: { type: 'queue', taskId: artifact.taskId, outputIndex: artifact.outputIndex },
        video,
        ...(title ? { name: title } : {}),
      }
    : {
        kind: 'image',
        source: artifact.mediaId
          ? { type: 'media', mediaId: artifact.mediaId }
          : { type: 'queue', taskId: artifact.taskId, outputIndex: artifact.outputIndex },
        ...(title ? { name: title } : {}),
      }
  return {
    id: artifact.artifactId,
    title,
    media,
    format: assetFormat(artifact.mime, media),
    createdAt,
    conversationId,
    load: async () => (await artifactPreview(artifact, INLINE_RESULT_THUMBNAIL_SCALE)).source,
    insert,
    download: {
      name: title,
      fetch: async () => {
        const blob = video
          ? await bffBlob(videoOutputUrl(video))
          : artifact.mediaId
            ? await dataUrlToBlob(`aip-media:${artifact.mediaId}`)
            : await bffBlob(queueOutputUrl(artifact.taskId, artifact.outputIndex))
        return blob ? { blob, ext: extensionOf(blob, media) } : null
      },
    },
  }
}

function fetchedItem(
  image: AgentFetchedImage,
  id: string,
  title: string,
  conversationId: string,
  createdAt: number,
): CanvasAssetItem {
  const name = image.name?.trim() || title
  return {
    id,
    title: name,
    media: 'image',
    format: assetFormat(image.mime, 'image'),
    createdAt,
    conversationId,
    load: async () => (await fetchedImagePreview(image, id, INLINE_RESULT_THUMBNAIL_SCALE)).source,
    insert: {
      kind: 'image',
      source: { type: 'media', mediaId: image.imageId },
      ...(name ? { name } : {}),
    },
    download: {
      name,
      fetch: async () => {
        const blob = await dataUrlToBlob(`aip-media:${image.imageId}`)
        return { blob, ext: extensionOf(blob, 'image') }
      },
    },
  }
}

/** 这段对话里生成成功的图和视频；用户自己上传的参考图不算生成作品。 */
export function canvasAssetsFromMessages(
  messages: readonly AgentPanelMessage[],
  conversationId: string,
  time: MessageTime,
): CanvasAssetItem[] {
  return messages.flatMap((message) => {
    if (message.kind !== 'tool' || message.status !== 'succeeded') return []
    const createdAt = time(message)
    return [
      ...(message.artifacts ?? []).map((artifact) =>
        artifactItem(artifact, message.title, conversationId, createdAt),
      ),
      ...(message.fetchedImages ?? []).map((image, index) =>
        fetchedItem(
          image,
          fetchedCanvasId(message.toolCallId, index),
          message.title,
          conversationId,
          createdAt,
        ),
      ),
    ]
  })
}

/** 批量计划里已经完成的产物；原图是用户的输入，不列。 */
export function canvasAssetsFromBatch(
  message: AgentToolMessage,
  page: BatchAssetPage,
  conversationId: string,
  createdAt: number,
): CanvasAssetItem[] {
  return page.items.flatMap((item) => {
    if ((item.progress ?? item.execution?.status) !== 'completed') return []
    const label = item.inputs.find((input) => input.name?.trim())?.name?.trim() || message.title
    return (item.execution?.artifacts ?? []).map((artifact) =>
      artifactItem(artifact, label, conversationId, createdAt),
    )
  })
}

/** 新的在前；同一时间按出现顺序倒排，去掉重复的产物。 */
export function sortCanvasAssets(items: readonly CanvasAssetItem[]): CanvasAssetItem[] {
  const seen = new Set<string>()
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt || b.index - a.index)
    .map(({ item }) => item)
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
}

export type AssetDay =
  | { readonly kind: 'today' }
  | { readonly kind: 'yesterday' }
  | { readonly kind: 'date'; readonly month: number; readonly day: number; readonly year: number }

export interface AssetDayGroup {
  readonly key: string
  readonly day: AssetDay
  readonly items: readonly CanvasAssetItem[]
}

function dayStart(time: number): number {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 按本地日期分组：今天、昨天，其余写月日。输入须已按时间倒序。 */
export function groupAssetsByDay(
  items: readonly CanvasAssetItem[],
  now = Date.now(),
): AssetDayGroup[] {
  const today = dayStart(now)
  const yesterday = dayStart(today - 1)
  const groups: { key: string; day: AssetDay; items: CanvasAssetItem[] }[] = []
  for (const item of items) {
    const start = dayStart(item.createdAt)
    const key = String(start)
    const last = groups[groups.length - 1]
    if (last?.key === key) {
      last.items.push(item)
      continue
    }
    const date = new Date(start)
    const day: AssetDay =
      start >= today
        ? { kind: 'today' }
        : start === yesterday
          ? { kind: 'yesterday' }
          : {
              kind: 'date',
              month: date.getMonth() + 1,
              day: date.getDate(),
              year: date.getFullYear(),
            }
    groups.push({ key, day, items: [item] })
  }
  return groups
}
