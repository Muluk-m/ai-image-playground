import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { chatFailure } from '../lib/chatCompletion'
import { badRequestOnValidation, imageDataUrlSchema } from '../lib/http'
import { log } from '../lib/logger'
import { analyzeCompetitorImages } from '../lib/vision'

const analyzeBodySchema = t.Object({
  images: t.Array(imageDataUrlSchema(), { minItems: 1, maxItems: 20 }),
  product: t.Object({
    name: t.String({ minLength: 1, maxLength: 200 }),
    description: t.String({ maxLength: 2000 }),
  }),
})

export const remixAnalyzeRoutes = new Elysia()
  .use(badRequestOnValidation())
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
        const failure = chatFailure(error, 'vision')
        if (failure) return status(502, failure)
        throw error
      }
    },
    { body: analyzeBodySchema },
  )
