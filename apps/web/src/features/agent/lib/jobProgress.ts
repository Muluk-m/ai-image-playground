import type { AgentBackgroundJobProgress, AgentToolName } from '@image-playground/shared'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

/**
 * 一次生成走到哪一步。结果卡与画布占位共用这一份：两处读同一张卡、同一个起点，
 * 所以说的阶段与已用时间永远一致。
 */
export const AGENT_JOB_PHASES = ['submitted', 'queued', 'generating', 'delivering'] as const
export type AgentJobPhase = (typeof AGENT_JOB_PHASES)[number]

/** 会走「提交、排队、生成、交付」这几步的工具。 */
const GENERATION_TOOLS: ReadonlySet<AgentToolName> = new Set([
  'generateImage',
  'editImage',
  'generateVideo',
])

export interface AgentToolProgress {
  readonly phase: AgentJobPhase
  /** 已用时间的起点（epoch 毫秒）。后台任务取服务端受理时刻；缺席即不知道何时开始。 */
  readonly since?: number
}

/**
 * 这张卡此刻的进度；已经结束（或根本不是生成）就是 null。
 *
 * - 轮里还在跑：工具刚起跑是「已提交」，任务进了队列是「排队」，上游在出图是「生成」。
 * - 后台任务：按服务端的任务表说排队还是生成；还没问到就停在「已提交」。
 * - 结果已到、正在落画布：「交付」。
 *
 * `job` 是服务端报的进度，`startedAt` 是本机看到工具起跑的时刻；有服务端的就用服务端的，
 * 刷新、换设备后起点不变。
 */
export function agentToolProgress(
  message: AgentToolMessage,
  job?: AgentBackgroundJobProgress,
  startedAt?: number,
): AgentToolProgress | null {
  const since = job?.submittedAt ?? startedAt
  const at = (phase: AgentJobPhase): AgentToolProgress =>
    since === undefined ? { phase } : { phase, since }
  if (message.status === 'running') {
    // 查素材库这类不出图的调用没有这几个阶段。
    if (!message.toolName || !GENERATION_TOOLS.has(message.toolName)) return null
    if (message.stage === 'running') return at('generating')
    return at(message.stage === 'submitted' ? 'queued' : 'submitted')
  }
  if (message.status === 'submitted') {
    if (!job) return at('submitted')
    return at(job.stage === 'running' ? 'generating' : 'queued')
  }
  if (message.status === 'succeeded' && message.delivery === 'pending') return at('delivering')
  return null
}

/** 已用时间，m:ss；过了一小时是 h:mm:ss。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${seconds}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

/** 画布占位认得的那两把钥匙：本机占的位记着结果卡的 messageId，云端预留的位记着任务 id。 */
export interface AgentPlaceholderRef {
  readonly messageId?: string
  readonly taskId?: string
}

/** 这个占位框属于哪张结果卡。 */
export function toolMessageForPlaceholder(
  messages: readonly AgentPanelMessage[],
  ref: AgentPlaceholderRef,
): AgentToolMessage | null {
  for (const message of messages) {
    if (message.kind !== 'tool') continue
    if (ref.messageId && message.id === ref.messageId) return message
    if (ref.taskId && message.job?.taskId === ref.taskId) return message
  }
  return null
}

export interface AgentJobInbox {
  /** 还没结束的后台任务，按提交先后。 */
  readonly running: readonly AgentToolMessage[]
  /** 已经结束的：成功、失败与取消的都在。 */
  readonly finished: readonly AgentToolMessage[]
  /** 结束里成功的那几个；收件箱顶上说「几个已完成」数的是它。 */
  readonly completed: number
}

/** 这个会话提交过的后台任务，按在跑与已结束分开。 */
export function agentJobInbox(messages: readonly AgentPanelMessage[]): AgentJobInbox {
  const jobs = messages.filter(
    (message): message is AgentToolMessage => message.kind === 'tool' && message.job !== undefined,
  )
  const finished = jobs.filter((message) => message.status !== 'submitted')
  return {
    running: jobs.filter((message) => message.status === 'submitted'),
    finished,
    completed: finished.filter((message) => message.status === 'succeeded').length,
  }
}
