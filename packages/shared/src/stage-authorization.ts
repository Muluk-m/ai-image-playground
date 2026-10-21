import type { StageExecutionBinding } from './stage-execution'
import type { StageRunRecord } from './stage-run'

export type StageAuthorizationStatus = 'pending' | 'active' | 'exhausted' | 'ended' | 'expired'

export interface StageAuthorizationCharge {
  readonly nodeId: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
  readonly credits: number
}
export interface StageAuthorizationAttempt {
  readonly id: string
  readonly nodeId: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
  readonly reservedCredits: number
  readonly spentCredits: number
  readonly submittedQuantity: number
  readonly taskIds: readonly string[]
}
export interface StageAuthorizationAudit {
  readonly at: number
  readonly kind:
    | 'proposed'
    | 'confirmed'
    | 'preflight'
    | 'retry'
    | 'submitted'
    | 'reported'
    | 'exhausted'
    | 'ended'
    | 'expired'
  readonly nodeId?: string
  readonly taskId?: string
  readonly credits?: number
}
export interface StageAuthorization {
  readonly id: string
  readonly conversationId: string
  readonly projectId: string
  readonly stage: string
  readonly nodeIds: readonly string[]
  readonly nodeNames: readonly string[]
  readonly estimatedCredits: number
  readonly budgetCap: number
  /** 提案或确认时服务端按节点模型、数量和倍率算出的报价。模型自填的预估不在这里。 */
  readonly charges?: readonly StageAuthorizationCharge[]
  /**
   * 提案时从画布冻结的提示词、输入张数和媒体类型。
   * 消费执行凭证时必须与真实提交一致；缺了就拒绝，不能只凭令牌跑任意内容。
   */
  readonly bindings?: readonly StageExecutionBinding[]
  readonly spentCredits: number
  readonly status: StageAuthorizationStatus
  readonly attempts: readonly StageAuthorizationAttempt[]
  readonly audit: readonly StageAuthorizationAudit[]
  /** 这一批运行的回报；收到后授权结束，智能体被唤醒一次。 */
  readonly run?: StageRunRecord
}
/** Ephemeral execution credential; never store it in a canvas, message, or browser storage. */
export interface StageAuthorizationSubmission {
  readonly authorizationId: string
  readonly nodeId: string
  readonly attemptId: string
  readonly executionToken: string
}
export interface StageAuthorizationPreflight {
  readonly nodeId: string
  readonly attemptId: string
  readonly executionToken: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
}
