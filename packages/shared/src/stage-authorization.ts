import type { AgentTurnParams } from './agent'
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
/**
 * 首帧阶段授权绑定的分镜表。确认授权时服务端把这张表写成定稿；
 * 提案之后镜头表被改过（指纹不同）就拒绝确认，需要重新提案。
 */
export interface StageStoryboardFinalization {
  readonly storyboardId: string
  readonly fingerprint: string
}
/**
 * 提出这批运行的那一轮里，跟画布出图有关的参数。运行回报唤醒智能体时，唤醒轮没有用户请求，
 * 就沿用这一份：直接出图开着时唤醒轮里的 runNodes 照样直接开跑，关着时照样等确认卡；
 * 报价也按同一个工作台模型、张数和视频参数算，不会和原标签页实际提交的规格对不上。
 */
export interface StageAuthorizationTurn {
  /** 那一轮画布 runNodes 是否直接开跑（缺席按开算之后的结果）。 */
  readonly autoSubmit: boolean
  readonly model?: string
  readonly canvasImageModel?: string
  readonly canvasImageCount?: number
  readonly video?: AgentTurnParams['video']
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
  /** 首帧阶段才有：确认即定稿的分镜表。 */
  readonly storyboard?: StageStoryboardFinalization
  /** 提案那一轮的直接出图偏好与出图参数，唤醒轮沿用。这个字段出现之前登记的授权没有它。 */
  readonly turn?: StageAuthorizationTurn
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
