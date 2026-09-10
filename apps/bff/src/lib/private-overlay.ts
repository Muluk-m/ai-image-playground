import type { TaskErrorType } from '@image-playground/shared'
import { type AnyElysia, Elysia, status } from 'elysia'
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

export type TaskReservationFailure = Exclude<TaskReservationResult, { kind: 'reserved' }>

/** 预扣被拒的线上契约。图片、视频与对话共用，别在各自路由里再写一遍状态码。 */
export function reservationFailureResponse(failure: TaskReservationFailure) {
  if (failure.kind === 'insufficient_credits') {
    const { required, available } = failure
    return status(402, { error: 'insufficient_credits', required, available })
  }
  return status(422, { error: 'model_price_unavailable', model: failure.model })
}

/** 任务终态。结算判据只看它，不看上游被调用了几次。 */
export type TaskOutcome = 'completed' | 'failed' | 'cancelled'

/** 计价用量，口径同 reserveTask 的 quantity 与 unitMultiplier。 */
export interface TaskUsage {
  quantity: number
  unitMultiplier: number
  /** 对话任务才有：上游报的 token 数，后台的消耗汇总只认它。 */
  tokens?: { input: number; output: number }
}

/** 对话按 token 计费的两个参数，权威在私有单价表，运营改价即时生效。 */
export interface ChatPricing {
  /** 输出单价相对输入单价的倍数。 */
  readonly outputPriceRatio: number
  /** 一轮预扣多少输出 token。 */
  readonly outputReserveTokens: number
}

export interface PrivateTaskHooks {
  reserveTask(input: {
    tx: BffTransaction
    taskId: string
    userId: string
    model: string
    /** 计价单位数：图片任务是张数，视频任务是秒数。 */
    quantity: number
    /** 单位倍率；图片恒为 1，视频取清晰度倍率。 */
    unitMultiplier: number
  }): Promise<TaskReservationResult>
  finalizeTask(input: {
    tx: BffTransaction
    taskId: string
    outcome: TaskOutcome
    upstreamInvocationCount: number
    errorType?: TaskErrorType
    upstreamStatus?: number | null
    /** 上游返回的实际用量；缺席即按预留额全额结算。 */
    actualUsage?: TaskUsage
  }): Promise<void>
  /** 单价表里没登记这个对话模型时返回 null；起轮会在预扣那一步被拒。 */
  chatPricing(model: string): Promise<ChatPricing | null>
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
  async chatPricing() {
    return null
  },
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
    typeof privateModule.privateTaskHooks.chatPricing !== 'function' ||
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
