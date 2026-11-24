import type { AgentJobPlan } from '@image-playground/db'
import type {
  GptImage26Rejection,
  ImageTierEntry,
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  StageAuthorizationSubmission,
  SubmitRequest,
} from '@image-playground/shared'
import type { QuotaConsumeResult } from '../../lib/quota'
import type { ExecutionTransaction } from './task-lifecycle-bus'

export interface CreateQueueTaskInput {
  /**
   * 从哪个入口提交，决定图片档位怎么收口（见 `resolveImageTier`）。调用方显式给出。
   */
  readonly entry: ImageTierEntry
  readonly stageAuthorization?: StageAuthorizationSubmission
  readonly provider: QueueProvider
  readonly model: string
  /** 输入图仍是 data URL，落库前在这里归档进对象存储。 */
  readonly request: Omit<SubmitRequest, 'video'>
  readonly video?: PersistedVideoRequest
  /** Original prompt and capability decision used to build the persisted queue prompt. */
  readonly promptShaping?: {
    readonly originalPrompt: string
    readonly ratioViaPrompt?: boolean
  }
  readonly userId: string | null
  /** 智能体工具提交时带上会话与轮，任务由此可反查属于哪一轮。 */
  readonly agent?: {
    readonly conversationId: string
    readonly turnId: string
    /**
     * 这是一个后台任务：与任务行同一个事务登记进 `agent_jobs`，结束时据此判断要不要唤醒智能体。
     * 登记与任务同生同灭，worker 再快也不会在登记之前把它跑完。
     */
    readonly job?: {
      readonly toolCallId: string
      readonly wakeOnSuccess: boolean
      /** 提交这一刻的改图计划；唤醒轮接着它走。 */
      readonly plan?: AgentJobPlan
    }
  }
  /**
   * 云端项目里这个任务要接替的失败占位（项目元素 id）：单张重试时产物落回原来那个位置。
   * 它不在项目里、或不是失败占位时照常另找位置。
   */
  readonly projectSlot?: string
  /**
   * 创作页 HTTP 直出：同账号几秒内内容一样的提交当作连点挡掉。
   * 其他入口（批量套用、智能体等）一批里本就可能有内容相同的几条，不开。
   */
  readonly dedupeRepeats?: true
  /** CLI preserves the requested tier/quality and rejects unavailable membership tiers instead of downgrading.
   * 与 `entry: 'cli-strict'` 同进同出，不一致直接抛错。 */
  readonly strictImageRequest?: true
  /**
   * 调用方给的积分上限（CLI 的 `max_credits`）。只在积分计费开着时生效；先按事务内报价
   * 拒绝，再以实际预扣兜底，超限时任务与预扣一并回滚。预算不是请求内容，不进命令哈希。
   */
  readonly maxCredits?: number
  /** Server-only opt-in; legacy HTTP submissions retain their existing lifecycle. */
  readonly reconciliationRequired?: true
  /**
   * 调用方自己的事务。给出时任务行、预扣、后台任务登记与调用方随后的写入同一次提交，
   * 也不会在已经握着一条连接时再去连接池要第二条（确认生成走这条路，见 `confirmations.ts`）。
   * 缺席即自开事务，与从前一样。
   */
  readonly tx?: ExecutionTransaction
}

export type CreateQueueTaskOutcome =
  | { readonly kind: 'created'; readonly taskId: string; readonly submittedAt: number }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'idempotency_mismatch' }
  | { readonly kind: 'duplicate_submission'; readonly taskId: string }
  | { readonly kind: 'invalid_prompt' }
  | {
      readonly kind: 'invalid_image_request'
      readonly message: string
      readonly code: GptImage26Rejection
      readonly fields: readonly string[]
    }
  | { readonly kind: 'model_unavailable'; readonly message: string }
  | { readonly kind: 'authentication_required' }
  | { readonly kind: 'metering_denied'; readonly reason: string }
  | { readonly kind: 'private_billing_denied' }
  | { readonly kind: 'insufficient_credits'; readonly required: number; readonly available: number }
  | {
      readonly kind: 'max_credits_exceeded'
      readonly required: number
      readonly maxCredits: number
    }
  | { readonly kind: 'price_unavailable'; readonly model: string }
  | { readonly kind: 'quota_exceeded'; readonly quota: QuotaConsumeResult }
  | { readonly kind: 'invalid_input_image'; readonly message: string }
  | { readonly kind: 'object_storage_error'; readonly message: string }

export type PreparationRefusal = Extract<
  CreateQueueTaskOutcome,
  { kind: 'invalid_input_image' | 'object_storage_error' }
>

export type SubmitPreparedResult<T> =
  | { readonly kind: 'refused'; readonly index: number; readonly outcome: PreparationRefusal }
  | { readonly kind: 'committed'; readonly value: T }

export interface TaskPricingUnits {
  readonly quantity: number
  readonly unitMultiplier: number
  readonly quotaUnits: number
}

export interface SubmissionInputTransformResult {
  readonly request: Omit<SubmitRequest, 'video'>
  readonly facts?: Partial<PersistedSubmitRequest>
}

export interface TaskSubmissionContext {
  readonly input: CreateQueueTaskInput
  readonly taskId: string
  readonly submittedAt: number
  readonly requestPayload: PersistedSubmitRequest
  readonly pricing: TaskPricingUnits
  readonly reservedCredits: number
}

export interface TaskSubmissionPlugin {
  readonly id: string
  /** 事务外输入预处理（如局部重绘遮罩裁剪与保护标记）；返回修改后的请求与附加落库 facts。 */
  transformInput?(input: CreateQueueTaskInput): Promise<SubmissionInputTransformResult | undefined>
  /** 事务内准入与计费之前执行（用于固定锁获取顺序，如项目画布先拿 lockMediaOwner）。 */
  beforeAdmission?(tx: ExecutionTransaction, input: CreateQueueTaskInput): Promise<void>
  /** 任务行与计费/配额准入落库后、同事务内执行（阶段授权消费、项目产物预留、agent_jobs 登记）。 */
  afterTaskCreated?(tx: ExecutionTransaction, context: TaskSubmissionContext): Promise<void>
}

export class MissingTaskSubmissionPluginError extends Error {
  constructor(readonly pluginId: string) {
    super(`Missing required task submission plugin: ${pluginId}`)
    this.name = 'MissingTaskSubmissionPluginError'
  }
}

const pluginsById = new Map<string, TaskSubmissionPlugin>()
const plugins: TaskSubmissionPlugin[] = []

/**
 * 注册任务提交扩展插件：
 * - 同一对象引用重复注册幂等忽略；
 * - 同 ID 指向不同定义直接抛错，避免组合根静默覆盖。
 */
export function registerTaskSubmissionPlugin(plugin: TaskSubmissionPlugin): () => void {
  const existing = pluginsById.get(plugin.id)
  if (existing) {
    if (existing === plugin) return () => unregisterTaskSubmissionPlugin(plugin)
    throw new Error(`Conflicting task submission plugin registration for id: ${plugin.id}`)
  }
  pluginsById.set(plugin.id, plugin)
  plugins.push(plugin)
  return () => unregisterTaskSubmissionPlugin(plugin)
}

function unregisterTaskSubmissionPlugin(plugin: TaskSubmissionPlugin): void {
  if (pluginsById.get(plugin.id) !== plugin) return
  pluginsById.delete(plugin.id)
  const index = plugins.indexOf(plugin)
  if (index >= 0) plugins.splice(index, 1)
}

/** 关键安全/一致性能力缺失时 fail-closed 抛错，杜绝静默跳过授权或遮罩保护。 */
export function assertTaskSubmissionPluginRegistered(pluginId: string): void {
  if (!pluginsById.has(pluginId)) {
    throw new MissingTaskSubmissionPluginError(pluginId)
  }
}

export async function transformSubmissionInput(input: CreateQueueTaskInput): Promise<{
  readonly request: Omit<SubmitRequest, 'video'>
  readonly facts: Partial<PersistedSubmitRequest>
}> {
  let request = input.request
  let facts: Partial<PersistedSubmitRequest> = {}
  for (const plugin of [...plugins]) {
    if (!plugin.transformInput) continue
    const transformed = await plugin.transformInput({ ...input, request })
    if (!transformed) continue
    request = transformed.request
    if (transformed.facts) facts = { ...facts, ...transformed.facts }
  }
  return { request, facts }
}

export async function runSubmissionBeforeAdmission(
  tx: ExecutionTransaction,
  input: CreateQueueTaskInput,
): Promise<void> {
  for (const plugin of [...plugins]) {
    await plugin.beforeAdmission?.(tx, input)
  }
}

export async function runSubmissionAfterTaskCreated(
  tx: ExecutionTransaction,
  context: TaskSubmissionContext,
): Promise<void> {
  for (const plugin of [...plugins]) {
    await plugin.afterTaskCreated?.(tx, context)
  }
}

export function listTaskSubmissionPluginIds(): readonly string[] {
  return plugins.map((plugin) => plugin.id)
}

export function _resetTaskSubmissionPluginsForTesting(): void {
  pluginsById.clear()
  plugins.length = 0
}
