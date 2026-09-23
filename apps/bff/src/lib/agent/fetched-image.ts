import type { AgentFetchedImage } from '@image-playground/shared'
import sharp from 'sharp'
import { detectMediaMime } from '../imageArchive'
import { MediaError, storeMedia } from '../projectMedia'
import { safeFetch } from '../safeFetch'
import { assetImageByteLimit } from '../sync-assets'
import { addConversationMediaClaims } from './images'
import { AgentToolError } from './tools/errors'
import { safeFetchToolError } from './tools/webError'

/**
 * 「把一张网图收进这个人的媒体库」这条路只此一份：取网图与抓商品图都走它。
 *
 * 落库之后再由本会话认领，那一步是这张图**能被当成普通图片 id 用**的全部条件——
 * `images.ts` 的画布 media 分支照认领读字节，所以 editImage / viewImage 不必再认识
 * 一套新的 id，压缩掉历史之后也照样读得回来。
 */

/** 网图不该拖着一轮不放：取不回来就让模型换一张，别把对话卡在一个慢服务器上。 */
export const FETCH_IMAGE_TIMEOUT_MS = 20_000

/** 媒体库能原样收下的三种位图。其余（AVIF、SVG、TIFF、动图…）先转成 PNG。 */
const STORABLE_MIMES: Record<string, true | undefined> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
}

/**
 * 网图什么格式都有：媒体库收得下的按原样存，其余交给 sharp 转成 PNG（AVIF、SVG、TIFF、
 * 动图都从这条路进来）。sharp 都解不开的就不是图片——地址多半指向网页或视频，那是模型
 * 自己能改的事，交回去让它换一个。
 */
async function toStorableImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: string }> {
  const sniffed = detectMediaMime(bytes)
  if (sniffed && STORABLE_MIMES[sniffed]) return { bytes, mime: sniffed }
  try {
    const png = await sharp(bytes, { limitInputPixels: 40_000_000 }).png().toBuffer()
    return { bytes: png, mime: 'image/png' }
  } catch {
    throw new AgentToolError(
      'invalid_params',
      '这个地址取回来的不是图片。换一个能直接取到图片字节的地址再试。',
    )
  }
}

/** 落库被拒的那几种结局各归哪一类：太大、超配额是额度问题，其余是这张图本身不成立。 */
function storeFailure(error: MediaError): AgentToolError {
  if (error.message === 'media_too_large')
    return new AgentToolError(
      'invalid_params',
      `这张图超过单张上限（${Math.floor(assetImageByteLimit() / (1024 * 1024))} MB），换一张小一点的。`,
    )
  if (error.message === 'media_quota_exceeded')
    return new AgentToolError('quota_exceeded', '这个账号的媒体空间满了，取不下新的图。')
  if (error.status === 422)
    return new AgentToolError(
      'invalid_params',
      '这张图存不下来（动图或文件已损坏）。换一张静态图片再试。',
    )
  return new AgentToolError('upstream_error', '存这张图时存储出了问题，稍后再试。')
}

export interface FetchImageInput {
  readonly url: string
  readonly userId: string
  readonly conversationId: string
  readonly name?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** 取一张网图、存进媒体库、由本会话认领，交回可以直接当图片 id 用的那一条。 */
export async function fetchAndClaimImage(input: FetchImageInput): Promise<AgentFetchedImage> {
  const fetched = await safeFetch(input.url, {
    maxBytes: assetImageByteLimit(),
    timeoutMs: FETCH_IMAGE_TIMEOUT_MS,
    accept: 'image/*',
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }).catch((error) => {
    throw safeFetchToolError(error)
  })
  // 响应头的 content-type 是对方随口说的，按字节认。
  const image = await toStorableImage(fetched.bytes)
  const stored = await storeMedia(input.userId, image.bytes, image.mime).catch((error) => {
    throw error instanceof MediaError ? storeFailure(error) : error
  })
  await addConversationMediaClaims(input.conversationId, input.userId, [stored.id])
  const name = input.name?.trim()
  return {
    imageId: stored.id,
    sourceUrl: fetched.finalUrl,
    mime: stored.contentType,
    ...(stored.width ? { width: stored.width } : {}),
    ...(stored.height ? { height: stored.height } : {}),
    ...(name ? { name } : {}),
  }
}

/** 一张取回来的图在回执里怎么写尺寸。 */
export function fetchedImageSize(image: AgentFetchedImage): string {
  return image.width && image.height ? `，${image.width}×${image.height}` : ''
}
