import {
  type BackgroundPlanResult,
  BG_SWAP_MODES,
  buildBackgroundPrompt,
  PROMPT_LANGUAGES,
  type SceneScan,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'

import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { chatFailure } from '../lib/chatCompletion'
import { badRequestOnValidation, imageDataUrlSchema } from '../lib/http'
import { log } from '../lib/logger'
import { planBackground, scanScene } from '../lib/vision'

const imageSchema = imageDataUrlSchema()

const planBodySchema = t.Object({
  image: imageSchema,
  preference: t.Optional(t.String({ maxLength: 500 })),
  language: t.Optional(t.UnionEnum(PROMPT_LANGUAGES)),
  mode: t.Optional(t.UnionEnum(BG_SWAP_MODES)),
})

export const bgswapPlanRoutes = new Elysia()
  .use(badRequestOnValidation())
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
            inventory: plan.inventory,
            preference: body.preference,
            language: body.language,
            mode: body.mode,
          }),
        } satisfies BackgroundPlanResult
      } catch (error) {
        log.warn({ event: 'bgswap.vision_failed', err: error }, 'background planning failed')
        const failure = chatFailure(error, 'vision')
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
        const failure = chatFailure(error, 'vision')
        if (failure) return status(502, failure)
        throw error
      }
    },
    { body: t.Object({ image: imageSchema }) },
  )
