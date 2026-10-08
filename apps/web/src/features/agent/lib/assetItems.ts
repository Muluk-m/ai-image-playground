import type { AgentToolArtifact } from '@image-playground/shared'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import type { AgentPanelMessage, AgentTextMessage, AgentToolMessage } from '../types'
import { fetchedCanvasId } from './artifactDelivery'
import { artifactPreview, fetchedImagePreview } from './artifactPreview'

/** 资产库里的一张图。来源图点开就地预览；生成结果沿用原来的结果卡。 */
export interface AssetItem {
  readonly id: string
  readonly title: string
  readonly media: 'image' | 'video'
  readonly load: () => Promise<string | null>
  readonly open:
    | {
        readonly kind: 'source'
        readonly mediaId?: string
        readonly reference?: {
          readonly conversationId: string
          readonly messageId: string
          readonly index: number
        }
      }
    | { readonly kind: 'result'; readonly message: AgentToolMessage }
}

/** 历史消息里的对象快照没有像素，按会话、消息和下标去取。 */
export type StoredReferenceLoader = (
  conversationId: string,
  messageId: string,
  index: number,
  variant: 'preview' | 'original',
) => Promise<string | null>

/** 批次计划里能列进资产库的那一页。只要条目、进度和产物。 */
export interface BatchAssetPage {
  readonly items: readonly {
    readonly inputs: readonly {
      readonly imageId: string
      readonly mediaId: string
      readonly name?: string
    }[]
    readonly progress?: string
    readonly execution?: {
      readonly status: string
      readonly artifacts?: readonly AgentToolArtifact[]
    }
  }[]
}

function mediaSource(mediaId: string): AssetItem['load'] {
  return async () => resolveMediaSource(`aip-media:${mediaId}`, 'preview').catch(() => null)
}

/** 格子里用预览图；点开时取原图，原图失败再退回预览。 */
export function loadAssetOriginal(
  item: AssetItem,
  loadReference?: StoredReferenceLoader,
): Promise<string | null> {
  if (item.open.kind === 'source' && item.open.mediaId) {
    return resolveMediaSource(`aip-media:${item.open.mediaId}`, 'original', true).catch(() =>
      item.load(),
    )
  }
  const reference = item.open.kind === 'source' ? item.open.reference : undefined
  if (reference && loadReference) {
    return loadReference(
      reference.conversationId,
      reference.messageId,
      reference.index,
      'original',
    ).catch(() => item.load())
  }
  return item.load()
}

/**
 * 计划还在跑，或者暂停后仍有已提交的任务，资产库就要继续刷新。
 * 和计划卡片的 hasActiveWork 同一条：暂停本身不代表格子里的任务停了。
 */
export function batchNeedsRefresh(page: {
  readonly batch: { readonly status: string }
  readonly items: readonly {
    readonly progress?: string
    readonly execution?: { readonly status: string }
  }[]
}): boolean {
  return (
    page.batch.status === 'running' ||
    (page.batch.status === 'paused' &&
      page.items.some(
        (item) =>
          item.progress === 'reconciling' ||
          Boolean(
            item.execution &&
              ['queued', 'in_progress', 'reconciling'].includes(item.execution.status),
          ),
      ))
  )
}

function named(name: string | undefined): string {
  return name?.trim() ?? ''
}

/**
 * 这条对话里已经落在消息上的图：生成结果、抓回来的网图，以及用户附上的参考图。
 * 结果在前，新的在上；参考图按消息顺序补在后面，和结果重复的不再列一次。
 */
export function assetsFromMessages(
  messages: readonly AgentPanelMessage[],
  stored?: { readonly conversationId: string; readonly loadReference: StoredReferenceLoader },
): AssetItem[] {
  const results = messages
    .flatMap((message) => {
      if (message.kind !== 'tool' || message.status !== 'succeeded') return []
      return [
        ...(message.artifacts ?? []).map(
          (artifact): AssetItem => ({
            id: artifact.artifactId,
            title: message.title,
            media: artifact.media === 'video' ? 'video' : 'image',
            load: async () => (await artifactPreview(artifact)).source,
            open: { kind: 'result', message },
          }),
        ),
        ...(message.fetchedImages ?? []).map((image, index): AssetItem => {
          const id = fetchedCanvasId(message.toolCallId, index)
          return {
            id,
            title: message.title,
            media: 'image',
            load: async () => (await fetchedImagePreview(image, id)).source,
            open: { kind: 'result', message },
          }
        }),
      ]
    })
    .reverse()
  const seen = new Set(results.map((item) => item.id))
  const sources: AssetItem[] = []
  for (const message of messages) {
    if (message.kind !== 'text') continue
    message.references?.forEach((reference, index) => {
      const item = referenceAsset(message, reference, index, stored)
      if (!item || seen.has(item.id)) return
      seen.add(item.id)
      sources.push(item)
    })
  }
  return [...results, ...sources]
}

function referenceAsset(
  message: AgentTextMessage,
  reference: NonNullable<AgentTextMessage['references']>[number],
  index: number,
  stored?: { readonly conversationId: string; readonly loadReference: StoredReferenceLoader },
): AssetItem | null {
  const title = named('name' in reference ? reference.name : undefined)
  if ('mediaId' in reference && reference.mediaId) {
    return {
      id: `media:${reference.mediaId}`,
      title,
      media: 'image',
      load: mediaSource(reference.mediaId),
      open: { kind: 'source', mediaId: reference.mediaId },
    }
  }
  if ('dataUrl' in reference && reference.dataUrl.startsWith('data:')) {
    const source = reference.dataUrl
    return {
      id: `ref:${message.id}:${index}`,
      title,
      media: 'image',
      load: async () => source,
      open: { kind: 'source' },
    }
  }
  // 重新打开对话后，内联参考图只剩对象存储快照，像素要按消息下标再取。
  if ('image' in reference && stored) {
    const messageId = message.id
    const conversationId = stored.conversationId
    return {
      id: `ref:${messageId}:${index}`,
      title,
      media: 'image',
      load: () => stored.loadReference(conversationId, messageId, index, 'preview'),
      open: { kind: 'source', reference: { conversationId, messageId, index } },
    }
  }
  return null
}

function resultMessage(
  source: AgentToolMessage,
  artifact: AgentToolArtifact,
  title: string,
): AgentToolMessage {
  return {
    kind: 'tool',
    id: source.id,
    turnId: source.turnId,
    toolCallId: source.toolCallId,
    ...(source.toolName ? { toolName: source.toolName } : {}),
    ...(source.batchId ? { batchId: source.batchId } : {}),
    title,
    status: 'succeeded',
    artifacts: [artifact],
  }
}

/**
 * 一批计划里的图。原图按计划顺序；已完成的产物跟在各自的原图后面。
 * 工具消息本身只带 batchId，这些图不在消息上，资产库得自己来取。
 */
export function assetsFromBatch(message: AgentToolMessage, page: BatchAssetPage): AssetItem[] {
  const items: AssetItem[] = []
  const seen = new Set<string>()
  for (const item of page.items) {
    const label = named(item.inputs.find((input) => named(input.name))?.name)
    for (const input of item.inputs) {
      const id = `media:${input.mediaId}`
      if (seen.has(id)) continue
      seen.add(id)
      items.push({
        id,
        title: named(input.name) || label,
        media: 'image',
        load: mediaSource(input.mediaId),
        open: { kind: 'source', mediaId: input.mediaId },
      })
    }
    const status = item.progress ?? item.execution?.status
    if (status !== 'completed') continue
    for (const artifact of item.execution?.artifacts ?? []) {
      if (seen.has(artifact.artifactId)) continue
      seen.add(artifact.artifactId)
      const title = label || message.title
      items.push({
        id: artifact.artifactId,
        title,
        media: artifact.media === 'video' ? 'video' : 'image',
        load: async () => (await artifactPreview(artifact)).source,
        open: { kind: 'result', message: resultMessage(message, artifact, title) },
      })
    }
  }
  return items
}
