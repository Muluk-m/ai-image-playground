import {
  type BackgroundPlanResult,
  PROMPT_LANGUAGES,
  type SceneScan,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { buildBackgroundPrompt } from '../lib/bgswapPrompt'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { log } from '../lib/logger'
import {
  planBackground,
  scanScene,
  VisionInvalidResponseError,
  VisionUpstreamError,
} from '../lib/vision'

const imageSchema = t.String({ pattern: '^data:image/', maxLength: 4_000_000 })

const planBodySchema = t.Object({
  image: imageSchema,
  preference: t.Optional(t.String({ maxLength: 500 })),
  language: t.Optional(t.UnionEnum(PROMPT_LANGUAGES)),
})

/** 两个视觉端点的失败口径一致：上游挂了与答非所问都是 502。返回 null 表示不是视觉失败。 */
function visionFailure(error: unknown): Record<string, unknown> | null {
  if (error instanceof VisionUpstreamError) {
    return { error: 'vision_upstream_error', upstream_status: error.status }
  }
  if (error instanceof VisionInvalidResponseError) return { error: 'vision_invalid_response' }
  return null
}

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
            sceneType: plan.sceneType,
            preference: body.preference,
            language: body.language,
          }),
        } satisfies BackgroundPlanResult
      } catch (error) {
        log.warn({ event: 'bgswap.vision_failed', err: error }, 'background planning failed')
        const failure = visionFailure(error)
        if (failure) return status(502, failure)
        throw error
      }
    },
    { body: planBodySchema },
  )
  .post(
    '/api/bgswap/scan',
    async ({ body, status }) => {
      try {
        return (await scanScene(body.image)) satisfies SceneScan
      } catch (error) {
        log.warn({ event: 'bgswap.scan_failed', err: error }, 'scene scan failed')
        const failure = visionFailure(error)
        if (failure) return status(502, failure)
        throw error
      }
    },
    { body: t.Object({ image: imageSchema }) },
  )
