import type {
  AccountLifecyclePort,
  BillingPorts,
  EntitlementPort,
  MeteringPort,
} from './billing-hooks'
import { billingPortsFromTaskHooks } from './billing-hooks'
import { loadPrivateBffOverlay } from './private-overlay'

export {
  type AccountLifecyclePort,
  type BffTransaction,
  type BillingPorts,
  billingPortsFromTaskHooks,
  type ChatPricing,
  type EntitlementPort,
  type MeteringDecision,
  type MeteringDecisionInput,
  type MeteringPort,
  nonBillingPriceSnapshot,
  reservationFailureResponse,
  type TaskOutcome,
  type TaskReservationFailure,
  type TaskReservationResult,
  type TaskUsage,
} from './billing-hooks'

export async function loadBillingPorts(): Promise<BillingPorts> {
  const overlay = await loadPrivateBffOverlay()
  return billingPortsFromTaskHooks(overlay.taskHooks)
}

export async function loadMeteringPort(): Promise<MeteringPort> {
  return (await loadBillingPorts()).metering
}

export async function loadEntitlementPort(): Promise<EntitlementPort> {
  return (await loadBillingPorts()).entitlement
}

export async function loadAccountLifecyclePort(): Promise<AccountLifecyclePort> {
  return (await loadBillingPorts()).accountLifecycle
}
