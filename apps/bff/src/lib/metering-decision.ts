import type { MeteringDecision } from './private-overlay'

const DECISION_KINDS: Record<string, true> = { metered: true, unmetered: true, denied: true }

/** Validate only the runtime authorization shape returned by an untrusted overlay. */
export function meteringDecisionOrDenied(value: unknown): MeteringDecision | undefined {
  try {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { kind: 'denied', reason: 'invalid_metering_decision' }
    const decision = value as Record<string, unknown>
    if (DECISION_KINDS[decision.kind as string] !== true)
      return { kind: 'denied', reason: 'invalid_metering_decision' }
    if (decision.kind === 'denied') {
      return typeof decision.reason === 'string' && decision.reason.trim().length > 0
        ? { kind: 'denied', reason: decision.reason }
        : { kind: 'denied', reason: 'invalid_metering_decision' }
    }
    const expectedMetering = decision.kind === 'unmetered' ? 'none' : 'credits'
    if (decision.metering !== expectedMetering)
      return { kind: 'denied', reason: 'invalid_metering_decision' }
    return decision as MeteringDecision
  } catch {
    return { kind: 'denied', reason: 'invalid_metering_decision' }
  }
}
