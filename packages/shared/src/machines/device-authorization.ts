import { defineMachine } from '../state-machine'

/** RFC 8628 设备码。过期不另设状态，仍看 `expires_at`。 */
export const deviceAuthorization = defineMachine({
  id: 'device-authorization',
  states: ['pending', 'approved', 'denied', 'consumed'] as const,
  events: ['approve', 'deny', 'consume'] as const,
  transitions: {
    pending: { approve: 'approved', deny: 'denied' },
    approved: { consume: 'consumed' },
    denied: {},
    consumed: {},
  },
})

export type DeviceAuthorizationState = (typeof deviceAuthorization.states)[number]

export function deviceDecisionEvent(decision: 'approved' | 'denied'): 'approve' | 'deny' {
  return decision === 'approved' ? 'approve' : 'deny'
}
