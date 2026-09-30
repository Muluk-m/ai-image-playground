import type { AgentTurnErrorCode, AgentTurnFailure } from '@image-playground/shared'
import { requestLogFields } from '../request-context'

/** Keep the upstream error useful without publishing credentials, signed URLs or image bytes. */
export function agentTurnFailure(
  code: AgentTurnErrorCode,
  error: unknown,
  model: string,
): AgentTurnFailure {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : code
  const message = raw
    .replace(/data:[^\s"']+/gi, '[REDACTED image]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|authorization|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/https?:\/\/[^\s"']+/gi, (url) => url.split('?')[0]!)
    .slice(0, 4_000)
  return { code, message, model, occurredAt: new Date().toISOString(), ...requestLogFields() }
}
