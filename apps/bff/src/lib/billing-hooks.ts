import type { AgentBatchPriceSnapshot, TaskErrorType } from '@image-playground/shared'
import { status } from 'elysia'
import type { db as bffDb } from '../db/client'

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

/** 对话按 token 计费的两个参数，权威在单价表。 */
export interface ChatPricing {
  /** Cached input rate relative to ordinary input; absent preserves legacy free cache reads. */
  readonly cachedInputPriceRatio?: number
  readonly outputPriceRatio: number
  /** 一轮预扣多少输出 token；实际用量超过它就按预留封顶。 */
  readonly outputReserveTokens: number
  /** 账本用起轮时的单价快照计算原价；缺席时不展示减免数。 */
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
  | {
      readonly kind: 'metered'
      readonly metering: 'credits'
      readonly pricing?: AgentBatchPriceSnapshot
    }
  | {
      readonly kind: 'unmetered'
      readonly metering: 'none'
      readonly pricing?: AgentBatchPriceSnapshot
    }
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
  /** 会员档（4K）提交授权：有效订阅或免计费权益放行，未开启计费时一律拒绝。 */
  canSubmitTask?(input: {
    tx: BffTransaction
    userId: string
    model?: string
    request: { image_size?: string; size?: string }
  }): Promise<boolean>
  /** Immutable token quote under the caller's price lock. */
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
  }): Promise<{ credits: number; isMember: boolean; unmetered?: boolean } | null>
  /** Decide direct image/video/analysis metering before any wallet quote or hold. */
  meteringDecision?(input: MeteringDecisionInput): Promise<MeteringDecision>
  /** Atomically consume the unmetered account quota after the decision is known. */
  consumeUnmeteredQuota?(input: MeteringDecisionInput): Promise<
    | { readonly kind: 'consumed' }
    | {
        readonly kind: 'quota_exceeded'
        readonly quota: number
        readonly used: number
        readonly resetAt: string
      }
  >
  reserveTask(input: {
    tx: BffTransaction
    taskId: string
    userId: string
    model: string
    /** 计价单位数：图片任务是张数，视频任务是秒数。 */
    quantity: number
    /** 单位倍率：视频取清晰度倍率；图片取 imageRateMultiplier（GPT 2.5 按档位、2.6 按自己的积分表，Gemini 按请求档，其余为 1）。 */
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
  chatPricing(model: string, tx?: BffTransaction): Promise<ChatPricing | null>
  /** Whether the account currently has an active subscription. */
  isActiveMember?(input: { userId: string; now: number }): Promise<boolean>
  /**
   * 已结算任务实扣的积分，按任务 id；查不到的任务不出现在结果里。
   * 积分只有计费账本算得出，调用方一律问它，绝不自己按单价折算。
   */
  taskCredits(input: { taskIds: readonly string[] }): Promise<Readonly<Record<string, number>>>
  /** Active generation slots for one account. */
  accountConcurrencyLimit?(input: {
    tx: BffTransaction
    userId: string
    now: number
  }): Promise<number>
  /**
   * 套餐的保证并发与空闲时可用并发（弹性名额）。保证并发永远放行；空闲并发只在服务器有余量、
   * 没有别人排队时才放行，见 workers/idle-concurrency.ts。无订阅账号两者相等。
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
  canUnlinkOAuthIdentity?(input: {
    tx: BffTransaction
    userId: string
    provider: string
    subject: string
  }): Promise<{ allowed: boolean; reason?: string }>
  /** 用户注销、公开库还没删 users 行时调用。账本如果外键指着这个用户，要在这里删掉。 */
  onUserDeleted?(input: { tx: BffTransaction; userId: string }): Promise<void>
  runMaintenance(now: number): Promise<void>
  /** Worker-only integrations. */
  runWorkerMaintenance?(now: number): Promise<void>
}

/** 计费计量窄端口：只覆盖报价、计费判定、免计费配额、任务预扣、终态结算与已扣积分查询。 */
export type MeteringPort = Pick<
  PrivateTaskHooks,
  | 'meteringDecision'
  | 'consumeUnmeteredQuota'
  | 'quoteTask'
  | 'quoteTokenTask'
  | 'chatPricing'
  | 'reserveTask'
  | 'finalizeTask'
  | 'taskCredits'
>

/** 权益与并发窄端口：只覆盖会员/4K 准入、订阅状态、账户摘要与并发配额查询。 */
export type EntitlementPort = Pick<
  PrivateTaskHooks,
  | 'canSubmitTask'
  | 'isActiveMember'
  | 'accountSummary'
  | 'accountConcurrencyLimit'
  | 'accountConcurrencyEntitlement'
>

/** 账号生命周期与计费后台维护窄端口：只覆盖注册/解绑/注销挂钩与定时对账/通知维护。 */
export type AccountLifecyclePort = Pick<
  PrivateTaskHooks,
  | 'onUserCreated'
  | 'canUnlinkOAuthIdentity'
  | 'onUserDeleted'
  | 'runMaintenance'
  | 'runWorkerMaintenance'
>

export interface BillingPorts {
  readonly metering: MeteringPort
  readonly entitlement: EntitlementPort
  readonly accountLifecycle: AccountLifecyclePort
}

const portsByTaskHooks = new WeakMap<PrivateTaskHooks, BillingPorts>()

/**
 * 将既有 `PrivateTaskHooks`（含测试替身）无损投影为 3 个窄端口并按 `hooks` 引用缓存：
 * - 严格保留可选方法的存在性（undefined 不被包装成 truthy 函数），保持既有门禁与兼容分支语义完全不变；
 * - 按 `hooks` 对象身份缓存，测试用 `{ ...overlay, taskHooks: { ...overlay.taskHooks, ... } }` 覆盖任一方法时自动投影到新对象，绝不读到陈旧端口。
 */
export function billingPortsFromTaskHooks(hooks: PrivateTaskHooks): BillingPorts {
  const cached = portsByTaskHooks.get(hooks)
  if (cached) return cached
  const projected: BillingPorts = Object.freeze({
    metering: Object.freeze({
      ...(hooks.meteringDecision ? { meteringDecision: hooks.meteringDecision } : {}),
      ...(hooks.consumeUnmeteredQuota
        ? { consumeUnmeteredQuota: hooks.consumeUnmeteredQuota }
        : {}),
      ...(hooks.quoteTask ? { quoteTask: hooks.quoteTask } : {}),
      ...(hooks.quoteTokenTask ? { quoteTokenTask: hooks.quoteTokenTask } : {}),
      chatPricing: hooks.chatPricing,
      reserveTask: hooks.reserveTask,
      finalizeTask: hooks.finalizeTask,
      taskCredits: hooks.taskCredits,
    }),
    entitlement: Object.freeze({
      ...(hooks.canSubmitTask ? { canSubmitTask: hooks.canSubmitTask } : {}),
      ...(hooks.isActiveMember ? { isActiveMember: hooks.isActiveMember } : {}),
      ...(hooks.accountSummary ? { accountSummary: hooks.accountSummary } : {}),
      ...(hooks.accountConcurrencyLimit
        ? { accountConcurrencyLimit: hooks.accountConcurrencyLimit }
        : {}),
      ...(hooks.accountConcurrencyEntitlement
        ? { accountConcurrencyEntitlement: hooks.accountConcurrencyEntitlement }
        : {}),
    }),
    accountLifecycle: Object.freeze({
      onUserCreated: hooks.onUserCreated,
      ...(hooks.canUnlinkOAuthIdentity
        ? { canUnlinkOAuthIdentity: hooks.canUnlinkOAuthIdentity }
        : {}),
      ...(hooks.onUserDeleted ? { onUserDeleted: hooks.onUserDeleted } : {}),
      runMaintenance: hooks.runMaintenance,
      ...(hooks.runWorkerMaintenance ? { runWorkerMaintenance: hooks.runWorkerMaintenance } : {}),
    }),
  })
  portsByTaskHooks.set(hooks, projected)
  return projected
}
