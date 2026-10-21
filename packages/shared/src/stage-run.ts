import type { AgentWakeSkipReason } from './agent'

/**
 * 一批阶段授权运行的回报（见 `CONTEXT.md`「唤醒」）。浏览器跑完一批画布节点、或开跑前就被拦下，
 * 把每个节点的结局交给 BFF；BFF 记进授权并唤醒智能体一次。
 */

/** 授权内同一节点至多自动重试这么多次，重试计入授权已用额度。 */
export const STAGE_RUN_MAX_RETRIES = 1

/**
 * 节点没跑成的原因。前几项是开跑前被拦下（缺首帧、缺素材、参数不可用……），
 * 后几项是跑到一半停下的原因。智能体按它向用户说明，界面不展示这些码。
 */
export const STAGE_RUN_REASONS = [
  'missing_frame',
  'missing_media',
  'missing_prompt',
  'model_unavailable',
  'input_limit',
  'local_upload',
  'busy',
  'insufficient_balance',
  'dependency_cycle',
  'spec_changed',
  'authorization',
  'upstream_failed',
  'generation_failed',
  'budget_exceeded',
  'retry_limit',
  'canvas_changed',
  'stopped',
] as const
export type StageRunReason = (typeof STAGE_RUN_REASONS)[number]

/**
 * - `completed`：有真实结果，成为节点主结果。
 * - `failed`：提交过但没有结果（含自动重试之后仍失败）。
 * - `blocked`：开跑前被拦下，没有提交。
 * - `skipped`：这一批停下了，节点没轮到。
 */
export const STAGE_RUN_OUTCOMES = ['completed', 'failed', 'blocked', 'skipped'] as const
export type StageRunOutcome = (typeof STAGE_RUN_OUTCOMES)[number]

export interface StageRunNodeReport {
  readonly nodeId: string
  readonly outcome: StageRunOutcome
  readonly reason?: StageRunReason
  /**
   * 这个节点在授权内自动重试过。浏览器给的只作参考，服务端按授权上建出任务的尝试次数重算后才记下；
   * 重试上限同样由服务端的预检把守，不看这个值。
   */
  readonly retried?: boolean
}

/** 浏览器交给 BFF 的那一份。确认前就被拦下时没有执行凭证。 */
export interface StageRunReportInput {
  readonly executionToken?: string
  readonly nodes: readonly StageRunNodeReport[]
}

/** 记在授权上的回报。同一条授权只收一次，重复上报原样交回、不再唤醒。 */
export interface StageRunRecord {
  readonly reportedAt: number
  readonly nodes: readonly StageRunNodeReport[]
  /** 唤醒没有起轮的原因：积分不足、连续唤醒到了上限，或会话已删除。 */
  readonly wakeSkipped?: AgentWakeSkipReason | 'conversation_deleted'
}

/** 上报的回执：这一次是否排上了唤醒。 */
export interface StageRunReportResult {
  readonly wake: 'queued' | 'duplicate' | 'none'
}

/** 回报的唤醒走到了哪一步；面板据此接上唤醒轮，或说明智能体没有查看。 */
export type StageRunWakeReceipt =
  | { readonly status: 'pending' }
  | { readonly status: 'consumed'; readonly turnId: string }
  | { readonly status: 'skipped'; readonly reason?: StageRunRecord['wakeSkipped'] }
