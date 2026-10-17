import { Elysia, t } from 'elysia'
import { AgentSettingsError } from '../lib/agent/provider-settings'
import { AgentContextOverflow } from '../lib/agent/request-budget'
import { agentTurnRateLimited } from '../lib/agent/turn-rate-limit'
import { CanvasTextError, canvasTextModels, generateCanvasText } from '../lib/canvas-text'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { clientAddress, deviceIdSchema } from '../lib/http'
import { log } from '../lib/logger'
import { reservationFailureResponse } from '../lib/private-overlay'
import { requireUser } from '../lib/user-auth'

export const textGenerationRoutes = new Elysia({ prefix: '/api/canvas' })
  .use(requireUser)
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('agent:chat')) return capabilityUnavailable('agent:chat')
  })
  .get('/text/models', async ({ status }) => {
    try {
      return await canvasTextModels()
    } catch {
      return status(503, { error: 'text_model_unavailable' })
    }
  })
  .post(
    '/text',
    async ({ body, status, authUser, request, server }) => {
      if (
        agentTurnRateLimited(
          body.deviceId,
          clientAddress(request, server?.requestIP(request)?.address ?? null),
        )
      )
        return status(429, { error: 'rate_limited' })
      if (!body.instruction.trim()) return status(400, { error: 'text_instruction_empty' })
      try {
        const result = await generateCanvasText(body, authUser?.id ?? null, request.signal)
        if ('failure' in result) return reservationFailureResponse(result.failure)
        return result
      } catch (error) {
        if (error instanceof CanvasTextError) return status(error.status, { error: error.code })
        if (error instanceof AgentSettingsError)
          return status(503, { error: 'text_model_unavailable' })
        if (error instanceof AgentContextOverflow)
          return status(400, { error: 'text_context_too_large' })
        log.error(
          { event: 'canvas.text_generation_failed', err: error },
          'canvas text generation failed',
        )
        return status(502, { error: 'text_generation_failed' })
      }
    },
    {
      body: t.Object({
        model: t.String({ minLength: 1, maxLength: 512 }),
        instruction: t.String({ minLength: 1, maxLength: 12_000 }),
        deviceId: deviceIdSchema(),
        currentText: t.String({ maxLength: 50_000 }),
        references: t.Optional(
          t.Array(
            t.Object({
              id: t.String({ minLength: 1, maxLength: 200 }),
              kind: t.Union([t.Literal('text'), t.Literal('image'), t.Literal('video')]),
              label: t.Optional(t.String({ maxLength: 500 })),
              text: t.Optional(t.String({ maxLength: 50_000 })),
            }),
            { maxItems: 32 },
          ),
        ),
      }),
    },
  )
