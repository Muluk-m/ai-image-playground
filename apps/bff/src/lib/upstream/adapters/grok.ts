import type { HydratedSubmitRequest } from '../../imageArchive'
import { buildGrokEditBody, buildGrokImagine2Body, isGrokImagine2 } from '../grok'
import { buildOpenAIBody, mergeOpenAIImageResults, withoutImageCount } from '../openai'
import type { UpstreamCallResult } from '../shared'
import { catalogCapabilities } from './catalog'
import { parsePayload, workingRequest } from './platform'
import type { ImageAdapter, UpstreamCall } from './types'

function sentGrok(body: Record<string, unknown>): Record<string, unknown> {
  const applied: Record<string, unknown> = {}
  for (const key of ['aspect_ratio', 'resolution', 'quality', 'size', 'output_format'] as const) {
    if (typeof body[key] === 'string') applied[key] = body[key]
  }
  return applied
}

/** Grok 上游不认原生 n，多张在这里拆开。2.0 把 size 收成 aspect_ratio / resolution。 */
export const grokAdapter: ImageAdapter = {
  protocol: 'grok-imagine',
  capabilities: (model) =>
    catalogCapabilities(model, {
      honorsSize: !isGrokImagine2(model),
      promptGuard: 'none',
      nativeCount: { generate: false, edit: false },
      moderation: false,
    }),
  plan: (req, model, ctx) => {
    const request = workingRequest(req, model, ctx)
    const editing = Boolean(request.input_images?.length || request.mask)
    const count = Math.max(1, request.n ?? req.count ?? 1)
    const unit = count === 1 ? request : withoutImageCount(request)
    const build = (one: HydratedSubmitRequest): Record<string, unknown> => {
      if (editing) return buildGrokEditBody(model, one)
      if (isGrokImagine2(model)) return buildGrokImagine2Body(model, one)
      return buildOpenAIBody(model, one)
    }
    const body = build(unit)
    const path = editing ? '/images/edits' : '/images/generations'
    const call: UpstreamCall = { method: 'POST', path, body, images: 1 }
    return {
      calls: Array.from({ length: count }, () => call),
      applied: { ...sentGrok(body), n: count },
      dropped: [],
      freshBody: () => build(unit),
    }
  },
  parse: (results: UpstreamCallResult[]) => {
    const payload =
      results.length <= 1 ? results[0]?.payload : mergeOpenAIImageResults(results).payload
    return parsePayload('openai-compat', payload)
  },
}
