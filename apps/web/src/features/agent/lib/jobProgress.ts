import type { AgentBackgroundJobProgress, AgentToolName } from '@image-playground/shared'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

/**
 * 一次生成走到哪一步。结果卡与画布占位共用这一份：两处读同一张卡、同一个起点，
 * 所以说的阶段与已用时间永远一致。
 */
export const AGENT_JOB_STEPS = ['submitted', 'queued', 'generating', 'delivering'] as const
export type AgentJobStep = (typeof AGENT_JOB_STEPS)[number]

/**
 * 阶段比刻度多两个服务端持久阶段（ADR 0009），各有自己的说法，不压扁成排队或生成：
 * `reconnecting` 是重启或滚动发布后执行器重新接上上游，`confirming` 是结果已归档、正在确认。
 * 两者在刻度上都落在「生成」那一格。
 */
export type AgentJobPhase = AgentJobStep | 'reconnecting' | 'confirming'

/** 这个阶段在四格刻度上落在哪一格。 */
export function agentJobStep(phase: AgentJobPhase): AgentJobStep {
  return phase === 'reconnecting' || phase === 'confirming' ? 'generating' : phase
}

/**
 * 这张卡的后台任务还没走到终局：任务还在跑，或者它是一条还在重试队列里排着、服务端还没提交的
 * 重试。两者都要接着问服务端，界面上也都还在等结果——「还在跑」只有这一条判定。
 */
export function agentJobUnsettled(message: AgentPanelMessage): boolean {
  return message.kind === 'tool' && (message.status === 'submitted' || message.status === 'queued')
}

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
 * - 后台任务：按服务端任务表的持久阶段说排队、生成、重连还是确认；还没问到就停在「已提交」。
 * - 结果已到、正在落画布：「交付」。
 *
 * `job` 是服务端报的进度，`startedAt` 是工具起跑的时刻（服务端盖在 `toolStart` 上的那个，
 * 旧记录才退回本机看到的时刻）；两者都是服务端的数，刷新、换设备后起点不变。
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
    if (job.phase) return at(job.phase)
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
  /** 还没结束的：后台任务在跑的，和重试队列里排着、还没提交的。按提交先后。 */
  readonly running: readonly AgentToolMessage[]
  /** 已经结束的：成功、失败与取消的都在。 */
  readonly finished: readonly AgentToolMessage[]
  /** 结束里成功的那几个；进度条里走满的一段是它。 */
  readonly completed: number
  /** 结束里没成的那几个：失败与取消。 */
  readonly failed: number
}

/**
 * 这个会话的后台任务，按在跑与已结束分开。
 *
 * 「在跑」按 `agentJobUnsettled` 数，不是只数 `submitted`：重试队列里排着的那张卡（`queued`）
 * 还没提交、手上没有任务 id，可它确实在等着跑。只认 `submitted` 会把它算进已结束，顶上于是说
 * 「0 个进行中」，而用户刚放进去的几个还在排队。
 */
export function agentJobInbox(messages: readonly AgentPanelMessage[]): AgentJobInbox {
  const running: AgentToolMessage[] = []
  const finished: AgentToolMessage[] = []
  let completed = 0
  for (const message of messages) {
    if (message.kind !== 'tool') continue
    // 提交过后台任务的，加上重试队列里排着、还没拿到任务 id 的那张。
    if (message.job === undefined && message.status !== 'queued') continue
    if (agentJobUnsettled(message)) running.push(message)
    else if (message.status === 'succeeded') {
      finished.push(message)
      completed += 1
    } else finished.push(message)
  }
  return { running, finished, completed, failed: finished.length - completed }
}
