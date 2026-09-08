import {
  STORYBOARD_IDEA_MAX_CHARS,
  STORYBOARD_SHOT_COUNTS,
  STORYBOARD_STYLE_MAX_CHARS,
  STORYBOARD_TOTAL_SECONDS,
  VIDEO_ASPECT_RATIOS,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'

import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { chatFailure } from '../lib/chatCompletion'
import { badRequestOnValidation, imageDataUrlSchema } from '../lib/http'
import { log } from '../lib/logger'
import { planStoryboard } from '../lib/storyboard'
import { requireUserOrService } from '../lib/user-auth'

const planBodySchema = t.Object({
  idea: t.String({ minLength: 1, maxLength: STORYBOARD_IDEA_MAX_CHARS }),
  shots: t.UnionEnum(STORYBOARD_SHOT_COUNTS),
  totalSeconds: t.UnionEnum(STORYBOARD_TOTAL_SECONDS),
  aspectRatio: t.UnionEnum(VIDEO_ASPECT_RATIOS),
  style: t.Optional(t.String({ maxLength: STORYBOARD_STYLE_MAX_CHARS })),
  referenceImage: t.Optional(imageDataUrlSchema()),
})

// 每次调用都烧上游视觉模型额度，所以匿名请求不能进来。
export const storyboardPlanRoutes = new Elysia()
  .use(badRequestOnValidation())
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('generation:storyboard')) {
      return capabilityUnavailable('generation:storyboard')
    }
  })
  .use(requireUserOrService)
  .post(
    '/api/storyboard/plan',
    async ({ body, status }) => {
      const startedAt = Date.now()
      try {
        const plan = await planStoryboard(body)
        log.info(
          { event: 'storyboard.planned', shots: plan.shots.length, ms: Date.now() - startedAt },
          'storyboard planned',
        )
        return { plan }
      } catch (error) {
        log.warn({ event: 'storyboard.plan_failed', err: error }, 'storyboard planning failed')
        const failure = chatFailure(error, 'storyboard')
        if (failure) return status(502, failure)
        throw error
      }
    },
    { body: planBodySchema },
  )
