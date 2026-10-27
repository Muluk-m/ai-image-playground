import type { AgentFetchedImage } from '@image-playground/shared'
import sharp, { type Metadata } from 'sharp'
import { detectMediaMime } from '../imageArchive'
import { assertMediaImageProcessingBudget, MEDIA_UPLOAD_MAX_PIXELS } from '../media-image-limits'
import { MediaError, storeMedia } from '../projectMedia'
import { SafeFetchError, safeFetch } from '../safeFetch'
import { assetImageByteLimit } from '../sync-assets'
import { addConversationMediaClaims } from './images'
import { editInputSize } from './modelImage'
import { AgentToolError } from './tools/errors'
import { safeFetchToolError } from './tools/webError'
import {
  visualByteLimit,
  visualMetadata,
  visualPixelLimit,
  withVisualPreparation,
} from './visual-resources'

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

/** 不是图片（多半是网页或视频）：模型换个图片地址就行，详情里不提像素预算（BUG-48）。 */
function notAnImage(): AgentToolError {
  return new AgentToolError(
    'invalid_params',
    '这个地址不是图片（取回来的是网页或其他内容）。换一个能直接取到图片的地址；要读网页内容就用 webFetch。',
  )
}

/** 缩也缩不动的图（解码预算之外）：说图本身太大，不说成来源网站的问题（BUG-47）。 */
function tooLarge(width: number, height: number): AgentToolError {
  return new AgentToolError(
    'invalid_params',
    `这张图 ${width}×${height} 太大，超出能处理的范围，没有取进来。请换一张尺寸小一些的图片地址。`,
  )
}

/**
 * 超出读取预算（像素或字节）的网图按 EXIF 方向摆正后等比缩到最长边 ≤ 4000（BUG-47，与上传
 * 改图的 BUG-35 同一条规则，Nain 2026-10-28 定：超大图自动缩小，不拒绝）。不透明的存 JPEG，
 * 带透明的存 PNG（放不下再存 WebP）；动图只取第一帧。
 */
async function downscaled(
  bytes: Uint8Array,
  metadata: Metadata,
  width: number,
  height: number,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const target = editInputSize(width, height)
  try {
    const resized = sharp(bytes, { limitInputPixels: MEDIA_UPLOAD_MAX_PIXELS })
      .timeout({ seconds: 30 })
      .rotate()
      .resize({ width: target.width, height: target.height, fit: 'fill' })
    const limit = visualByteLimit()
    if (metadata.hasAlpha) {
      const png = await resized.clone().png().toBuffer()
      if (png.byteLength <= limit) return { bytes: png, mime: 'image/png' }
    }
    const opaque = metadata.hasAlpha ? resized : resized.flatten({ background: '#ffffff' })
    // 噪点多的图缩到 4000 也可能仍超读取预算：逐级降质量，直到放得下。
    for (const quality of [90, 80, 70, 60]) {
      const encoded = metadata.hasAlpha
        ? await opaque.clone().webp({ quality }).toBuffer()
        : await opaque.clone().jpeg({ quality }).toBuffer()
      if (encoded.byteLength <= limit)
        return { bytes: encoded, mime: metadata.hasAlpha ? 'image/webp' : 'image/jpeg' }
    }
  } catch {
    throw tooLarge(width, height)
  }
  throw tooLarge(width, height)
}

/**
 * 网图什么格式都有：媒体库收得下的按原样存，其余交给 sharp 转成 PNG（AVIF、SVG、TIFF、
 * 动图都从这条路进来）。sharp 都解不开的就不是图片——地址多半指向网页或视频，那是模型
 * 自己能改的事，交回去让它换一个。超出读取预算的先缩小再存，见 {@link downscaled}。
 */
async function toStorableImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: string }> {
  let metadata: Metadata
  try {
    // 只读文件头，不解码：这里不设像素上限，免得超大的真图在这一步被当成「不是图片」。
    metadata = await sharp(bytes, { limitInputPixels: false }).metadata()
  } catch {
    throw notAnImage()
  }
  if (!metadata.width || !metadata.height) throw notAnImage()
  if (metadata.width * metadata.height * (metadata.pages ?? 1) > MEDIA_UPLOAD_MAX_PIXELS)
    throw tooLarge(metadata.width, metadata.height)
  // 方向 5–8 存的是转置后的宽高，按显示方向算长边。
  const turned = (metadata.orientation ?? 1) >= 5
  const width = turned ? metadata.height : metadata.width
  const height = turned ? metadata.width : metadata.height
  try {
    assertMediaImageProcessingBudget({
      ...metadata,
      width: metadata.width,
      height: metadata.height,
    })
  } catch {
    throw tooLarge(width, height)
  }
  const oversized =
    width * height * (metadata.pages ?? 1) > visualPixelLimit() ||
    bytes.byteLength > visualByteLimit()
  if (oversized) return downscaled(bytes, metadata, width, height)
  await visualMetadata(bytes).catch(() => {
    throw notAnImage()
  })
  const sniffed = detectMediaMime(bytes)
  if (sniffed && STORABLE_MIMES[sniffed]) return { bytes, mime: sniffed }
  try {
    const png = await sharp(bytes, { limitInputPixels: visualPixelLimit() }).png().toBuffer()
    return { bytes: png, mime: 'image/png' }
  } catch {
    throw notAnImage()
  }
}

/** 落库被拒的那几种结局各归哪一类：太大是图本身的问题（不说成来源网站拒绝），超配额是额度问题，其余是这张图本身不成立。 */
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
async function fetchClaimedImage(input: FetchImageInput): Promise<AgentFetchedImage> {
  const fetched = await safeFetch(input.url, {
    // 读取预算以上、媒体库单张上限以内的图先取回来再缩（BUG-47），不在下载这一步就拒。
    maxBytes: assetImageByteLimit(),
    timeoutMs: FETCH_IMAGE_TIMEOUT_MS,
    accept: 'image/*',
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }).catch((error) => {
    if (error instanceof SafeFetchError && error.code === 'too_large')
      throw new AgentToolError(
        'invalid_params',
        `这张图超过单张上限（${Math.floor(assetImageByteLimit() / (1024 * 1024))} MB），太大了，没有取进来。请换一张小一些的图片地址。`,
      )
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

export const fetchAndClaimImage = (input: FetchImageInput): Promise<AgentFetchedImage> =>
  withVisualPreparation(() => fetchClaimedImage(input))
