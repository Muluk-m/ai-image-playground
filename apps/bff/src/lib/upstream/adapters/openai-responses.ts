import { buildImageResponsesBody } from '../../openaiImageResponses'
import { mergeOpenAIImageResults, withoutImageCount } from '../openai'
import type { UpstreamCallResult } from '../shared'
import { catalogCapabilities } from './catalog'
import { parsePayload, workingRequest } from './platform'
import type { ImageAdapter } from './types'

/**
 * 通用网关的 Responses 图片桥。图片工具不接受 n，张数在这里拆开。
 * 只在调度层已经决定走这条协议时使用。
 */
export const openaiResponsesAdapter: ImageAdapter = {
  protocol: 'openai-responses',
  capabilities: (model) =>
    catalogCapabilities(model, {
      honorsSize: false,
      promptGuard: 'prefix',
      nativeCount: { generate: false, edit: false },
      background: true,
      moderation: true,
    }),
  plan: (req, model, ctx) => {
    const mainModel = ctx.imageResponsesModel
    if (!mainModel) throw new Error('image responses model is not configured')
    const request = workingRequest(req, model, ctx)
    const count = Math.max(1, request.n ?? req.count ?? 1)
    // 与现有桥接一致：整单请求交给 builder，它不把 n 写进工具。
    const unit = count === 1 ? request : withoutImageCount(request)
    const body = buildImageResponsesBody(mainModel, model, unit)
    const call = {
      method: 'POST' as const,
      path: '/responses',
      body,
      images: 1,
    }
    return {
      calls: Array.from({ length: count }, () => call),
      applied: {
        ...(request.quality ? { quality: request.quality } : {}),
        ...(request.output_format ? { output_format: request.output_format } : {}),
        n: count,
      },
      // 工具参数里仍带着 size，和现在的桥接一致；回执标明网关不会兑现它。
      dropped: request.size
        ? [{ param: 'size', reason: 'Responses 桥接走 sub2api，上游不兑现 size' }]
        : [],
      freshBody: () => body,
    }
  },
  parse: (results: UpstreamCallResult[]) => {
    const payload =
      results.length <= 1 ? results[0]?.payload : mergeOpenAIImageResults(results).payload
    return parsePayload('openai-compat', payload)
  },
}
