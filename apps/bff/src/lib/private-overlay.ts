import { ensureBillingMigrations } from '@image-playground/db'
import { type AnyElysia, Elysia } from 'elysia'
import type { PrivateTaskHooks } from './billing-hooks'
import type { OAuthProviderDefinition } from './oauth/provider'
import { getOAuthProviderDefinition, registerOAuthProviders } from './oauth/registry'

export {
  type BffTransaction,
  type ChatPricing,
  type MeteringDecision,
  type MeteringDecisionInput,
  nonBillingPriceSnapshot,
  type PrivateTaskHooks,
  reservationFailureResponse,
  type TaskOutcome,
  type TaskReservationFailure,
  type TaskReservationResult,
  type TaskUsage,
} from './billing-hooks'

type PrivateBffModule = {
  readonly privateBffRoutes: AnyElysia
  readonly privateTaskHooks: PrivateTaskHooks
  readonly privateOAuthProviders?: readonly OAuthProviderDefinition[]
}
type PrivateMigrationModule = {
  runPrivateMigrations(databaseUrl: string): Promise<void>
}

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
  const missing = providers.filter((provider) => !getOAuthProviderDefinition(provider.id))
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

async function loadExternalOverlay(entryUrl: URL): Promise<PrivateBffOverlay> {
  if (!(await Bun.file(entryUrl).exists())) return EMPTY_PRIVATE_BFF_OVERLAY
  const privateModule: PrivateBffModule = await import(entryUrl.href)
  if (privateModule.privateOAuthProviders)
    registerProvidersIdempotent(privateModule.privateOAuthProviders)

  if (!(privateModule.privateBffRoutes instanceof Elysia)) {
    throw new Error('external BFF module must export privateBffRoutes as an Elysia plugin')
  }
  if (
    !privateModule.privateTaskHooks ||
    typeof privateModule.privateTaskHooks.reserveTask !== 'function' ||
    typeof privateModule.privateTaskHooks.finalizeTask !== 'function' ||
    typeof privateModule.privateTaskHooks.chatPricing !== 'function' ||
    typeof privateModule.privateTaskHooks.taskCredits !== 'function' ||
    typeof privateModule.privateTaskHooks.runMaintenance !== 'function' ||
    typeof privateModule.privateTaskHooks.onUserCreated !== 'function'
  ) {
    throw new Error('external BFF module must export the complete privateTaskHooks contract')
  }
  return Object.freeze({
    present: true,
    routes: privateModule.privateBffRoutes,
    taskHooks: privateModule.privateTaskHooks,
  })
}

export function loadPrivateBffOverlay(entryUrl?: URL): Promise<PrivateBffOverlay> {
  if (entryUrl) return loadExternalOverlay(entryUrl)
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

export async function runPrivateMigrations(databaseUrl: string, entryUrl?: URL): Promise<void> {
  if (!entryUrl) {
    await ensureBillingMigrations(databaseUrl)
    return
  }
  if (!(await Bun.file(entryUrl).exists())) return
  const privateModule: Partial<PrivateMigrationModule> = await import(entryUrl.href)
  if (typeof privateModule.runPrivateMigrations !== 'function') {
    throw new Error('migration module must export runPrivateMigrations')
  }
  await privateModule.runPrivateMigrations(databaseUrl)
}
