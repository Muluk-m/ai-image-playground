import { Type } from 'typebox'
import { fetchAndClaimImage, fetchedImageSize } from '../fetched-image'
import { agentSaveToolsAvailable } from '../saves'
import { referenceEvidence } from '../selection-preview'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

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
    '按地址把一张网图取进来，存成这个人媒体库里的一张图并交回它的图片 id。那个 id 和别的图片 id 一样用：直接交给 editImage 当参考图或目标图，交给 viewImage 看内容。地址要是图片直链（取回来就是图片字节），网页地址取不到图；取回来会连同缩略图一起给你看一眼。商品页整套图用 fetchListingImages，别一张张取。',
  guidance:
    '用户给了图片地址、或者要照着真实存在的东西做（具体商品、地标、包装）时用取网图工具：地址可以是用户给的，也可以是搜索或抓网页找到的，取回来的图片 id 当参考图交给 editImage；只为配图不要取。网图多半有版权，只当参考，不作交付物。',
  parameters,
  // 地址写错、对方 404、取回来不是图片，模型换一个地址就能继续，不该把整轮停下。
  onError: 'continue',
  // 要写这个人的媒体库，所以跟着存素材那两个工具走：登录且开了云同步才在场。
  available: (_mode, audience) => agentSaveToolsAvailable(audience),
  // 取图不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ url }) => ({ title: `获取图片：${hostOf(url)}` }),
  execute: (context) => async (_toolCallId, params, signal) => {
    const { userId, conversationId } = context
    // 清单已经按登录状态筛过；真走到这里没有用户，就是没有可写的媒体库。
    if (!userId) throw new AgentToolError('authentication_required', '取网图要先登录。')
    const image = await fetchAndClaimImage({
      url: params.url,
      userId,
      conversationId,
      ...(params.name ? { name: params.name } : {}),
      ...(signal ? { signal } : {}),
    })
    const resolved = await context.images.resolve(image.imageId, 'preview')
    const evidence = resolved ? await referenceEvidence([resolved]) : { content: [], manifest: '' }
    return {
      content: [
        {
          type: 'text' as const,
          text: `已取到图片，图片 id ${image.imageId}（来源 ${image.sourceUrl}${fetchedImageSize(image)}）。可以直接交给 editImage 当参考图或目标图。网图多半有版权，只拿它当参考，别把它本身当成交付物。${evidence.manifest}`,
        },
        ...evidence.content,
      ],
      details: { fetchedImages: [image] },
    }
  },
})
