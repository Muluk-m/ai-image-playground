import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { log } from '../lib/logger'
import {
  analyzeCompetitorImages,
  VisionInvalidResponseError,
  VisionUpstreamError,
} from '../lib/vision'

const analyzeBodySchema = t.Object({
  images: t.Array(t.String({ pattern: '^data:image/', maxLength: 4_000_000 }), {
    minItems: 1,
    maxItems: 20,
  }),
  product: t.Object({
    name: t.String({ minLength: 1, maxLength: 200 }),
    description: t.String({ maxLength: 2000 }),
  }),
})

export const remixAnalyzeRoutes = new Elysia()
  // Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('remix:analyze')) return capabilityUnavailable('remix:analyze')
  })
  .post(
    '/api/remix/analyze',
    async ({ body, status }) => {
      try {
        return { briefs: await analyzeCompetitorImages(body.images, body.product) }
      } catch (error) {
        log.warn({ event: 'remix.vision_failed', err: error }, 'vision analysis failed')
        if (error instanceof VisionUpstreamError) {
          return status(502, { error: 'vision_upstream_error', upstream_status: error.status })
        }
        if (error instanceof VisionInvalidResponseError) {
          return status(502, { error: 'vision_invalid_response' })
        }
        throw error
      }
    },
    { body: analyzeBodySchema },
  )
