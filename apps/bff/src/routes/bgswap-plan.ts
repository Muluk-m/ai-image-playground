import { type BackgroundPlanResult, PROMPT_LANGUAGES } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { buildBackgroundPrompt } from '../lib/bgswapPrompt'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { log } from '../lib/logger'
import { planBackground, VisionInvalidResponseError, VisionUpstreamError } from '../lib/vision'

const planBodySchema = t.Object({
  image: t.String({ pattern: '^data:image/', maxLength: 4_000_000 }),
  preference: t.Optional(t.String({ maxLength: 500 })),
  language: t.Optional(t.UnionEnum(PROMPT_LANGUAGES)),
})

export const bgswapPlanRoutes = new Elysia()
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
    '/api/bgswap/plan',
    async ({ body, status }) => {
      try {
        const plan = await planBackground(body)
        return {
          ...plan,
          prompt: buildBackgroundPrompt({
            plan: plan.plan,
            preference: body.preference,
            language: body.language,
          }),
        } satisfies BackgroundPlanResult
      } catch (error) {
        log.warn({ event: 'bgswap.vision_failed', err: error }, 'background planning failed')
        if (error instanceof VisionUpstreamError) {
          return status(502, { error: 'vision_upstream_error', upstream_status: error.status })
        }
        if (error instanceof VisionInvalidResponseError) {
          return status(502, { error: 'vision_invalid_response' })
        }
        throw error
      }
    },
    { body: planBodySchema },
  )
