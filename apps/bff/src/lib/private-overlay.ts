import { type AnyElysia, Elysia } from 'elysia'
import type { db as bffDb } from '../db/client'

export type BffTransaction = Parameters<Parameters<typeof bffDb.transaction>[0]>[0]

export type TaskReservationResult =
  | { readonly kind: 'reserved' }
  | {
      readonly kind: 'insufficient_credits'
      readonly required: number
      readonly available: number
    }
  | { readonly kind: 'price_unavailable'; readonly model: string }

export interface PrivateTaskHooks {
  reserveTask(input: {
    tx: BffTransaction
    taskId: string
    userId: string
    model: string
    quantity: number
  }): Promise<TaskReservationResult>
  finalizeTask(input: {
    tx: BffTransaction
    taskId: string
    upstreamInvocationCount: number
  }): Promise<void>
  onUserCreated(input: { tx: BffTransaction; userId: string }): Promise<void>
  runMaintenance(now: number): Promise<void>
}

type PrivateBffModule = {
  readonly privateBffRoutes: AnyElysia
  readonly privateTaskHooks: PrivateTaskHooks
}
type PrivateMigrationModule = {
  runPrivateMigrations(databaseUrl: string): Promise<void>
}

export interface PrivateBffOverlay {
  readonly present: boolean
  readonly routes: AnyElysia
  readonly taskHooks: PrivateTaskHooks
}

const EMPTY_TASK_HOOKS: PrivateTaskHooks = Object.freeze({
  async reserveTask() {
    return { kind: 'reserved' as const }
  },
  async finalizeTask() {},
  async onUserCreated() {},
  async runMaintenance() {},
})

export const EMPTY_PRIVATE_BFF_OVERLAY: PrivateBffOverlay = Object.freeze({
  present: false,
  routes: new Elysia({ name: 'private-bff-empty' }),
  taskHooks: EMPTY_TASK_HOOKS,
})

const privateEntryUrl = new URL('../../../../private/apps/bff/index.ts', import.meta.url)
const privateMigrationEntryUrl = new URL('../../../../private/apps/bff/migrate.ts', import.meta.url)
let overlayPromise: Promise<PrivateBffOverlay> | null = null

async function loadOverlay(entryUrl: URL): Promise<PrivateBffOverlay> {
  if (!(await Bun.file(entryUrl).exists())) return EMPTY_PRIVATE_BFF_OVERLAY
  const privateModule: PrivateBffModule = await import(entryUrl.href)

  if (!(privateModule.privateBffRoutes instanceof Elysia)) {
    throw new Error('private/apps/bff/index.ts must export privateBffRoutes as an Elysia plugin')
  }
  if (
    !privateModule.privateTaskHooks ||
    typeof privateModule.privateTaskHooks.reserveTask !== 'function' ||
    typeof privateModule.privateTaskHooks.finalizeTask !== 'function' ||
    typeof privateModule.privateTaskHooks.runMaintenance !== 'function' ||
    typeof privateModule.privateTaskHooks.onUserCreated !== 'function'
  ) {
    throw new Error('private/apps/bff/index.ts must export the complete privateTaskHooks contract')
  }
  return Object.freeze({
    present: true,
    routes: privateModule.privateBffRoutes,
    taskHooks: privateModule.privateTaskHooks,
  })
}

export function loadPrivateBffOverlay(entryUrl?: URL): Promise<PrivateBffOverlay> {
  if (entryUrl) return loadOverlay(entryUrl)
  overlayPromise ??= loadOverlay(privateEntryUrl)
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
    throw new Error(`${requiredCapability} requires the private BFF overlay`)
  }
}

export async function runPrivateMigrations(
  databaseUrl: string,
  entryUrl: URL = privateMigrationEntryUrl,
): Promise<void> {
  if (!(await Bun.file(entryUrl).exists())) return
  const privateModule: Partial<PrivateMigrationModule> = await import(entryUrl.href)
  if (typeof privateModule.runPrivateMigrations !== 'function') {
    throw new Error('private/apps/bff/migrate.ts must export runPrivateMigrations')
  }
  await privateModule.runPrivateMigrations(databaseUrl)
}
