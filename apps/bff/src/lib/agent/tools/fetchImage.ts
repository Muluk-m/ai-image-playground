import type { AgentFetchedImage } from '@image-playground/shared'
import sharp from 'sharp'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { detectMediaMime } from '../../imageArchive'
import { MediaError, storeMedia } from '../../projectMedia'
import { safeFetch } from '../../safeFetch'
import { assetImageByteLimit } from '../../sync-assets'
import { addConversationMediaClaims } from '../images'
import { agentSaveToolsAvailable } from '../saves'
import { referenceEvidence } from '../selection-preview'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { safeFetchToolError } from './webError'

/** 网图不该拖着一轮不放：取不回来就让模型换一张，别把对话卡在一个慢服务器上。 */
const TIMEOUT_MS = 20_000

/** 媒体库能原样收下的三种位图。其余（AVIF、SVG、TIFF、动图…）先转成 PNG。 */
const STORABLE_MIMES: Record<string, true | undefined> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
}

const parameters = Type.Object({
  url: Type.String({
    description: '图片本身的直链地址（http/https，取回来就是图片字节），不是承载它的那个网页地址。',
  }),
  name: Type.Optional(
    Type.String({ maxLength: 60, description: '给这张图起的短名字，方便后面指认它。' }),
  ),
})

/** 起跑那一行标签只想说「在取哪个站的图」，地址本身太长也没信息量。 */
function hostOf(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) return '网图'
  try {
    return new URL(url.trim()).host || '网图'
  } catch {
    return '网图'
  }
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

/**
 * 取网图：把一个公网地址上的图片字节收进这个人的媒体库，并让这一轮的会话认领它。
 *
 * 认领落下之后它就是一个普通的图片 id（`images.ts` 的画布 media 分支读得到），editImage
 * 与 viewImage 拿着它直接用，不必再另立一套登记；压缩掉历史之后照样读得回来。
 */
export const fetchImage = defineAgentTool({
  name: 'fetchImage',
  // 视频轮同样要参考图：首帧先画出来，参考真实物件比凭空描述准。
  modes: ['image', 'video'],
  label: '获取图片',
  description:
    '按地址把一张网图取进来，存成这个人媒体库里的一张图并交回它的图片 id。那个 id 和别的图片 id 一样用：直接交给 editImage 当参考图或目标图，交给 viewImage 看内容。地址要是图片直链（取回来就是图片字节），网页地址取不到图；取回来会连同缩略图一起给你看一眼。',
  guidance:
    '用户给了图片地址、或者要照着真实存在的东西做（具体商品、地标、包装）时用取网图工具：地址可以是用户给的，也可以是搜索或抓网页找到的，取回来的图片 id 当参考图交给 editImage；只为配图不要取。网图多半有版权，只当参考，不作交付物。',
  parameters,
  // 地址写错、对方 404、取回来不是图片，模型换一个地址就能继续，不该把整轮停下。
  onError: 'continue',
  available: (_mode, audience) =>
    isCapabilityEnabled('agent:web') && agentSaveToolsAvailable(audience),
  // 取图不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ url }) => ({ title: `获取图片：${hostOf(url)}` }),
  execute: (context) => async (_toolCallId, params, signal) => {
    const { userId, conversationId } = context
    // 清单已经按登录状态筛过；真走到这里没有用户，就是没有可写的媒体库。
    if (!userId) throw new AgentToolError('authentication_required', '取网图要先登录。')
    const fetched = await safeFetch(params.url, {
      maxBytes: assetImageByteLimit(),
      timeoutMs: TIMEOUT_MS,
      accept: 'image/*',
      ...(signal ? { signal } : {}),
    }).catch((error) => {
      throw safeFetchToolError(error)
    })
    // 响应头的 content-type 是对方随口说的，按字节认。
    const image = await toStorableImage(fetched.bytes)
    const stored = await storeMedia(userId, image.bytes, image.mime).catch((error) => {
      throw error instanceof MediaError ? storeFailure(error) : error
    })
    // 认领是这张图能被当成图片 id 用的全部条件，也是它的读路径。
    await addConversationMediaClaims(conversationId, userId, [stored.id])
    const name = params.name?.trim()
    const fetchedImage: AgentFetchedImage = {
      imageId: stored.id,
      sourceUrl: fetched.finalUrl,
      mime: stored.contentType,
      ...(stored.width ? { width: stored.width } : {}),
      ...(stored.height ? { height: stored.height } : {}),
      ...(name ? { name } : {}),
    }
    const resolved = await context.images.resolve(stored.id, 'preview')
    const evidence = resolved ? await referenceEvidence([resolved]) : { content: [], manifest: '' }
    const size = stored.width && stored.height ? `，${stored.width}×${stored.height}` : ''
    return {
      content: [
        {
          type: 'text' as const,
          text: `已取到图片，图片 id ${stored.id}（来源 ${fetched.finalUrl}${size}）。可以直接交给 editImage 当参考图或目标图。网图多半有版权，只拿它当参考，别把它本身当成交付物。${evidence.manifest}`,
        },
        ...evidence.content,
      ],
      details: { fetchedImages: [fetchedImage] },
    }
  },
})
