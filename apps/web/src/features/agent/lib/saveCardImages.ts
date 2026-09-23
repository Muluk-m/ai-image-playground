import type { AgentToolArtifact } from '@image-playground/shared'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { hasImage, storeImage } from '../../../lib/db'
import { blobToDataUrl, ensureImageCached, ensureImageThumbnailCached } from '../../../store'
import type { AgentPanelMessage } from '../types'
import { fetchMessageReference } from './agentClient'
import { artifactBitmap, previewArtifactBitmap } from './artifactSource'

/**
 * 保存卡片上的图片从哪来。
 *
 * 模型说的是**它这一轮的图片 id**：本轮附图、工具产出、或者用户从素材库 @ 进来的那一张。
 * 存进素材库要的却是**本机图片 id**（内容哈希），两者不是一回事——所以每张图都要先取回字节，
 * 再按内容存一次，拿到的那个 id 才是记录里该写的。同一份字节存两次仍是同一个 id。
 *
 * 卡上看的缩略图与真正存下去的字节走同一条查找、两种规格：看一眼用缩略图，存下去一律用原图
 * ——存进素材库的那一张之后还要拿去出图。
 */

type AgentImageLocation =
  /** 本机图片库里已经有：id 本身就是本机图片 id（素材库 @ 进来的那一张）。 */
  | { readonly kind: 'local'; readonly imageId: string }
  /** 这一轮某次工具调用的产出。 */
  | { readonly kind: 'artifact'; readonly artifact: AgentToolArtifact }
  /** 取网图存下来的那一张：模型说的图片 id 就是这个人媒体库里的媒体 id。 */
  | { readonly kind: 'media'; readonly mediaId: string }
  /** 用户某条消息附的参考图；`dataUrl` 只有直播那一轮的手上还有。 */
  | {
      readonly kind: 'reference'
      readonly messageId: string
      readonly index: number
      readonly dataUrl?: string
    }

export interface AgentSaveImageContext {
  readonly messages: readonly AgentPanelMessage[]
  readonly conversationId: string | null
  /** 卡片卸下时把还在途的取图掐掉。 */
  readonly signal: AbortSignal
}

/** 要存下来的一张图：模型那边的 id，加上它是用户给的还是这轮出的。 */
export interface AgentSaveImage {
  readonly agentImageId: string
  readonly source: 'upload' | 'generated'
}

/** 存好之后：模型那边的 id 对到本机图片 id。 */
export interface StoredAgentImage {
  readonly agentImageId: string
  readonly imageId: string
}

/** 卡上有图取不回来了（产物被清了、归档没了）。界面据此说「让助手重新出一版」。 */
export class AgentImageUnavailableError extends Error {
  constructor(readonly imageId: string) {
    super(`agent image ${imageId} is unavailable`)
    this.name = 'AgentImageUnavailableError'
  }
}

async function locate(
  imageId: string,
  messages: readonly AgentPanelMessage[],
): Promise<AgentImageLocation | null> {
  if (await hasImage(imageId)) return { kind: 'local', imageId }
  for (const message of messages) {
    if (message.kind === 'tool') {
      const artifact = message.artifacts?.find((one) => one.artifactId === imageId)
      // 视频产物取不出可编辑的位图，素材与模板都只收图片。
      if (artifact) return artifact.media === 'video' ? null : { kind: 'artifact', artifact }
      // 取回来的网图已经在这个人的媒体库里，媒体 id 就是模型说的那个图片 id。
      if (message.fetchedImages?.some((one) => one.imageId === imageId))
        return { kind: 'media', mediaId: imageId }
      continue
    }
    if (message.kind !== 'text' || message.role !== 'user') continue
    const index = message.references?.findIndex((one) => one.imageId === imageId) ?? -1
    if (index < 0) continue
    const reference = message.references![index]!
    return {
      kind: 'reference',
      messageId: message.id,
      index,
      ...('dataUrl' in reference ? { dataUrl: reference.dataUrl } : {}),
    }
  }
  return null
}

/** 卡上那张缩略图。取不到就是 null：卡照样存得下去，只是那一格空着。 */
export async function agentImagePreview(
  imageId: string,
  context: AgentSaveImageContext,
): Promise<string | null> {
  const found = await locate(imageId, context.messages)
  if (!found) return null
  if (found.kind === 'local') {
    const thumbnail = await ensureImageThumbnailCached(imageId)
    return thumbnail?.dataUrl ?? (await ensureImageCached(imageId)) ?? null
  }
  if (found.kind === 'artifact') return previewArtifactBitmap(found.artifact)
  if (found.kind === 'media')
    return resolveMediaSource(`aip-media:${found.mediaId}`, 'preview').catch(() => null)
  if (found.dataUrl) return found.dataUrl
  if (!context.conversationId) return null
  const blob = await fetchMessageReference(context.conversationId, found.messageId, found.index, {
    signal: context.signal,
    variant: 'thumbnail',
  })
  return blobToDataUrl(blob)
}

async function originalDataUrl(
  found: AgentImageLocation,
  context: AgentSaveImageContext,
): Promise<string | null> {
  if (found.kind === 'local') return (await ensureImageCached(found.imageId)) ?? null
  if (found.kind === 'artifact') return artifactBitmap(found.artifact)
  if (found.kind === 'media')
    return resolveMediaSource(`aip-media:${found.mediaId}`, 'original', true)
  if (found.dataUrl) return found.dataUrl
  if (!context.conversationId) return null
  const blob = await fetchMessageReference(context.conversationId, found.messageId, found.index, {
    signal: context.signal,
    variant: 'original',
  })
  return blobToDataUrl(blob)
}

/**
 * 把卡上这几张图取回来存进本机图片库，交回本机 id。
 *
 * 任何一张取不到就整体失败：素材少一张视角、模板少一张参考图都不是「存得不全」，是存错了。
 */
export async function storeAgentImages(
  images: readonly AgentSaveImage[],
  context: AgentSaveImageContext,
): Promise<StoredAgentImage[]> {
  const stored: StoredAgentImage[] = []
  for (const image of images) {
    const found = await locate(image.agentImageId, context.messages)
    const dataUrl = found && (await originalDataUrl(found, context))
    if (!found || !dataUrl) throw new AgentImageUnavailableError(image.agentImageId)
    // 本机已有的那一张 id 就是它的内容哈希，再存一次只会拿回同一个 id，白算一遍。
    stored.push({
      agentImageId: image.agentImageId,
      imageId: found.kind === 'local' ? found.imageId : await storeImage(dataUrl, image.source),
    })
  }
  return stored
}
