import type { AgentBatchPriceSnapshot, TaskErrorType } from '@image-playground/shared'
import { type AnyElysia, Elysia, status } from 'elysia'
import type { db as bffDb } from '../db/client'
import { registerOAuthProviders } from './oauth/registry'
import type { OAuthProviderDefinition } from './oauth/provider'

export type BffTransaction = Parameters<Parameters<typeof bffDb.transaction>[0]>[0]

export type TaskReservationResult =
  | { readonly kind: 'reserved'; readonly credits: number }
  | {
      readonly kind: 'insufficient_credits'
      readonly required: number
      readonly available: number
    }
  | {
      readonly kind: 'quota_exceeded'
      readonly quota: number
      readonly used: number
      readonly resetAt: string
    }
  | { readonly kind: 'price_unavailable'; readonly model: string }
  | { readonly kind: 'access_denied'; readonly reason: string }
export type TaskReservationFailure = Exclude<TaskReservationResult, { kind: 'reserved' }>

/** 预扣被拒的线上契约。图片、视频与对话共用，别在各自路由里再写一遍状态码。 */
export function reservationFailureResponse(failure: TaskReservationFailure) {
  if (failure.kind === 'insufficient_credits') {
    const { required, available } = failure
    return status(402, { error: 'insufficient_credits', required, available })
  }
  if (failure.kind === 'access_denied')
    return status(403, { error: 'access_denied', reason: failure.reason })
  if (failure.kind === 'quota_exceeded')
    return status(429, {
      error: 'daily_quota_exceeded',
      quota: failure.quota,
      used: failure.used,
      reset_at: failure.resetAt,
    })
  return status(422, { error: 'model_price_unavailable', model: failure.model })
}

/** 任务终态。结算判据只看它，不看上游被调用了几次。 */
export type TaskOutcome = 'completed' | 'failed' | 'cancelled'

/** 计价用量，口径同 reserveTask 的 quantity 与 unitMultiplier。 */
export interface TaskUsage {
  quantity: number
  unitMultiplier: number
  /** 对话任务才有：上游报的 token 数，后台的消耗汇总只认它。 */
  tokens?: { input: number; output: number; cachedInput?: number }
}

/** 对话按 token 计费的两个参数，权威在私有单价表。 */
export interface ChatPricing {
  /** Cached input rate relative to ordinary input; absent preserves legacy free cache reads. */
  readonly cachedInputPriceRatio?: number
  readonly outputPriceRatio: number
  /** 一轮预扣多少输出 token；实际用量超过它就按预留封顶。 */
  readonly outputReserveTokens: number
  /** 私有账本用起轮时的单价快照计算原价；旧 overlay 缺席时不展示减免数。 */
  readonly quoteCredits?: (reserved: TaskUsage, actual?: TaskUsage) => number
}
export interface MeteringDecisionInput {
  tx: BffTransaction
  userId: string
  model: string
  kind: 'image' | 'video' | 'analysis' | 'chat'
  quantity: number
  unitMultiplier: number
  inputEstimateTokens?: number
}

export type MeteringDecision =
  | { readonly kind: 'metered'; readonly metering: 'credits'; readonly pricing?: AgentBatchPriceSnapshot }
  | { readonly kind: 'unmetered'; readonly metering: 'none'; readonly pricing?: AgentBatchPriceSnapshot }
  | { readonly kind: 'denied'; readonly reason: string }

export function nonBillingPriceSnapshot(input: {
  model: string
  kind: 'image' | 'video' | 'analysis' | 'chat'
  quantity: number
  unitMultiplier: number
  inputEstimateTokens?: number
  outputReserveTokens?: number
  itemKey?: string
}): AgentBatchPriceSnapshot {
  return {
    ...(input.itemKey ? { itemKey: input.itemKey } : {}),
    model: input.model,
    unit:
      input.kind === 'analysis' || input.kind === 'chat'
        ? 'kilo_token'
        : input.kind === 'video'
          ? 'second'
          : 'image',
    quantity: input.quantity,
    unitMultiplier: input.unitMultiplier,
    pricingVersion: `non-billing:${input.kind}:${input.model}:${input.quantity}:${input.unitMultiplier}`,
    quotedAt: Date.now(),
    validUntil: null,
    baseUnitCredits: 0,
    outputPriceRatio: 1,
    cachedInputPriceRatio: 0,
    inputEstimateTokens: input.inputEstimateTokens ?? 0,
    outputReserveTokens: input.outputReserveTokens ?? 0,
    exemption: 'non-billing',
  }
}
export interface PrivateTaskHooks {
  /** Immutable token quote under the caller's price lock; absent in older overlays. */
  quoteTokenTask?(input: {
    tx: BffTransaction
    userId: string
    model: string
    estimatedInputTokens: number
  }): Promise<{ estimatedCredits: number; pricing: AgentBatchPriceSnapshot } | null>

  /** Read-only quote. Missing hooks/prices are unavailable, never a zero-cost authorization. */
  quoteTask?(input: {
    tx: BffTransaction
    userId: string
    model: string
    quantity: number
    unitMultiplier: number
  }): Promise<{ estimatedCredits: number; pricing: AgentBatchPriceSnapshot } | null>
  accountSummary?(input: {
    userId: string
    now: number
  }): Promise<{ credits: number; isMember: boolean; unmetered?: boolean }>
  canSubmitTask?(input: {
    tx: BffTransaction
    userId: string
    request: { image_size?: string }
  }): Promise<boolean>

  /** Decide direct image/video/analysis metering before any wallet quote or hold. */
  meteringDecision?(input: MeteringDecisionInput): Promise<MeteringDecision>
  /** Atomically consume the unmetered account quota after the decision is known. */
  consumeUnmeteredQuota?(input: MeteringDecisionInput): Promise<
    | { readonly kind: 'consumed' }
    | { readonly kind: 'quota_exceeded'; readonly quota: number; readonly used: number; readonly resetAt: string }
  >
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
  /**
   * 已结算任务实扣的积分，按任务 id；查不到的任务不出现在结果里。
   * 积分只有私有账本算得出，公开树一律问它，绝不自己按单价折算。
   */
  taskCredits(input: { taskIds: readonly string[] }): Promise<Readonly<Record<string, number>>>
  /** Active generation slots for one account. Optional until the pinned overlay supplies plan entitlements. */
  accountConcurrencyLimit?(input: {
    tx: BffTransaction
    userId: string
    now: number
  }): Promise<number>
  /**
   * 套餐的保证并发与空闲时可用并发（弹性名额）。保证并发永远放行；空闲并发只在服务器有余量、
   * 没有别人排队时才放行，见 workers/idle-concurrency.ts。无订阅账号两者相等。
   * 可选（先扩后缩）：缺席时退回 `accountConcurrencyLimit`，空闲并发等于保证并发。
   */
  accountConcurrencyEntitlement?(input: {
    tx: BffTransaction
    userId: string
    now: number
  }): Promise<{ guaranteed: number; idle: number }>
  onUserCreated(input: {
    tx: BffTransaction
    userId: string
    source: 'operator' | 'self-registration'
    referralCode?: string
    oauthProvider?: string
  }): Promise<void>
  /**
   * 用户注销、公开库还没删 users 行时调用。私有账本如果外键指着这个用户，要在这里删掉。
   * 可选（先扩后缩）：钉住的 overlay 还没有这一项时，公开库照常注销。
   */
  onUserDeleted?(input: { tx: BffTransaction; userId: string }): Promise<void>
  runMaintenance(now: number): Promise<void>
  /** Worker-only integrations; absent in older overlays. */
  runWorkerMaintenance?(now: number): Promise<void>
  /**
   * 旧版收费模块记在自己单价表里的停用模型。上下架已归公开库的 `model_availability`，这一项只在迁移完成前
   * 补进同一份清单；可选成员，缺席即没有遗留停用。
   */
  inactiveModels?(): Promise<ReadonlySet<string>>
}

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

const EMPTY_TASK_HOOKS: PrivateTaskHooks = Object.freeze({
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

const privateEntryUrl = new URL('../../../../private/apps/bff/index.ts', import.meta.url)
const privateMigrationEntryUrl = new URL('../../../../private/apps/bff/migrate.ts', import.meta.url)
let overlayPromise: Promise<PrivateBffOverlay> | null = null

async function loadOverlay(entryUrl: URL): Promise<PrivateBffOverlay> {
  if (!(await Bun.file(entryUrl).exists())) return EMPTY_PRIVATE_BFF_OVERLAY
  const privateModule: PrivateBffModule = await import(entryUrl.href)
  if (privateModule.privateOAuthProviders) registerOAuthProviders(privateModule.privateOAuthProviders)

  if (!(privateModule.privateBffRoutes instanceof Elysia)) {
    throw new Error('private/apps/bff/index.ts must export privateBffRoutes as an Elysia plugin')
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
