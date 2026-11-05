import { buildAgnesGenerationsBody, mergeOpenAIDataResults, withoutImageCount } from '../openai'
import { clientError, type UpstreamCallResult } from '../shared'
import { catalogCapabilities } from './catalog'
import { parsePayload, workingRequest } from './platform'
import type { ImageAdapter } from './types'

const MASK_UNSUPPORTED = '该模型不支持遮罩编辑（上游无 mask 能力），请换 GPT 模型或去掉遮罩'

/** Agnes 文生图和图生图共用 generations JSON，不认 n，多张在这里拆开。 */
export const agnesAdapter: ImageAdapter = {
  protocol: 'agnes',
  capabilities: (model) =>
    catalogCapabilities(model, {
      honorsSize: true,
      promptGuard: 'none',
      nativeCount: { generate: false, edit: false },
      moderation: false,
      background: false,
    }),
  plan: (req, model, ctx) => {
    const request = workingRequest(req, model, ctx)
    if (request.mask) throw clientError(MASK_UNSUPPORTED)
    const count = Math.max(1, request.n ?? req.count ?? 1)
    const unit = count === 1 ? request : withoutImageCount(request)
    const body = buildAgnesGenerationsBody(model, unit)
    const call = {
      method: 'POST' as const,
      path: '/images/generations',
      body,
      images: 1,
    }
    return {
      calls: Array.from({ length: count }, () => call),
      applied: {
        ...(request.size ? { size: request.size } : {}),
        n: count,
      },
      dropped: [],
      freshBody: () => buildAgnesGenerationsBody(model, unit),
    }
  },
  parse: (results: UpstreamCallResult[]) => {
    const payload =
      results.length <= 1 ? results[0]?.payload : mergeOpenAIDataResults(results).payload
    return parsePayload('openai-compat', payload)
  },
}
