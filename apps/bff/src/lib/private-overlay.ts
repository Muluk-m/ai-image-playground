import { ensureBillingMigrations } from '@image-playground/db'
import { type AnyElysia, Elysia } from 'elysia'
import type { PrivateTaskHooks } from './billing-hooks'
import type { OAuthProviderDefinition } from './oauth/provider'
import { getOAuthProviderDefinition, registerOAuthProviders } from './oauth/registry'

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
  type PrivateTaskHooks,
  reservationFailureResponse,
  type TaskOutcome,
  type TaskReservationFailure,
  type TaskReservationResult,
  type TaskUsage,
} from './billing-hooks'

export interface PrivateBffOverlay {
  readonly present: boolean
  readonly routes: AnyElysia
  readonly taskHooks: PrivateTaskHooks
}

export interface BuiltInBffOverlayLoadResult {
  readonly routes: AnyElysia
  readonly taskHooks: PrivateTaskHooks
  readonly oauthProviders?: readonly OAuthProviderDefinition[]
}

export type BuiltInBffOverlayLoader = () => Promise<BuiltInBffOverlayLoadResult>

const EMPTY_TASK_HOOKS: PrivateTaskHooks = Object.freeze({
  async canSubmitTask() {
    return false
  },
  async reserveTask() {
    return { kind: 'reserved' as const, credits: 0 }
  },
  async finalizeTask() {},
  async chatPricing() {
    return null
  },
  async taskCredits() {
    return {}
  },
  async onUserCreated() {},
  async runMaintenance() {},
})

export const EMPTY_PRIVATE_BFF_OVERLAY: PrivateBffOverlay = Object.freeze({
  present: false,
  routes: new Elysia({ name: 'private-bff-empty' }),
  taskHooks: EMPTY_TASK_HOOKS,
})

let builtInLoader: BuiltInBffOverlayLoader | null = null
let overlayPromise: Promise<PrivateBffOverlay> | null = null

export function registerBuiltInBffOverlayLoader(loader: BuiltInBffOverlayLoader): void {
  builtInLoader = loader
}

function registerProvidersIdempotent(providers: readonly OAuthProviderDefinition[]): void {
  const missing: OAuthProviderDefinition[] = []
  for (const provider of providers) {
    const existing = getOAuthProviderDefinition(provider.id)
    if (existing) {
      if (existing !== provider) throw new Error(`conflicting OAuth provider: ${provider.id}`)
      continue
    }
    missing.push(provider)
  }
  if (missing.length > 0) registerOAuthProviders(missing)
}

async function loadBuiltInOverlay(): Promise<PrivateBffOverlay> {
  if (!builtInLoader) return EMPTY_PRIVATE_BFF_OVERLAY
  const loaded = await builtInLoader()
  if (loaded.oauthProviders) registerProvidersIdempotent(loaded.oauthProviders)
  return Object.freeze({
    present: true,
    routes: loaded.routes,
    taskHooks: loaded.taskHooks,
  })
}

export function loadPrivateBffOverlay(): Promise<PrivateBffOverlay> {
  if (!overlayPromise) {
    overlayPromise = loadBuiltInOverlay().catch((error) => {
      overlayPromise = null
      throw error
    })
  }
  return overlayPromise
}

export function _setPrivateBffOverlayForTesting(overlay?: PrivateBffOverlay): void {
  overlayPromise = overlay ? Promise.resolve(overlay) : null
}

export function assertPrivateBffOverlayPresent(
  overlay: PrivateBffOverlay,
  requiredCapability: string,
): void {
  if (!overlay.present) {
    throw new Error(`${requiredCapability} requires the billing BFF module`)
  }
}

export async function runPrivateMigrations(databaseUrl: string): Promise<void> {
  await ensureBillingMigrations(databaseUrl)
}
