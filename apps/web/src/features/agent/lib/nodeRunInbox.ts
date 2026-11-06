import type { StageRunOutcome, StageRunReason } from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import type { NodeBatchError } from '../../canvas/lib/nodeBatch'
import type { AgentPanelMessage, AgentToolMessage } from '../types'
import {
  type AgentNodeRunSnapshot,
  type AgentNodeRunView,
  createAgentNodeRunView,
} from './nodeRuns'

export interface AgentNodeInboxEntry {
  readonly kind: 'node-run'
  readonly id: string
  readonly message: AgentToolMessage
  readonly nodeId: string
  readonly title: string
  readonly status: StageRunOutcome | 'pending' | 'running' | 'ended' | 'expired' | 'exhausted'
  readonly reason?: StageRunReason
  readonly error?: NodeBatchError
  readonly readFailed?: boolean
  readonly pendingLabel:
    | 'nodeRun.status.pending'
    | 'nodeRun.status.active'
    | 'nodeRun.confirming'
    | 'nodeRun.startingIn'
    | 'retry.queued'
  readonly seconds?: number
  readonly submitted: boolean
}

export interface AgentNodeInboxScope {
  readonly conversationId: string | null
  readonly projectId: string | null
}

/** 只认当前会话中的授权卡；提案工具成功不代表其中任何一个节点已生成。 */
export function nodeRunInboxEntries(
  message: AgentToolMessage,
  snapshot: AgentNodeRunSnapshot,
  scope: AgentNodeInboxScope,
): AgentNodeInboxEntry[] {
  const proposal = message.canvasRun
  if (!proposal?.authorizationId || proposal.projectId !== scope.projectId) return []
  const { run, plan, authorization } = snapshot
  if (
    !authorization ||
    authorization.id !== proposal.authorizationId ||
    authorization.projectId !== scope.projectId ||
    authorization.conversationId !== scope.conversationId
  )
    return []
  const reports = authorization?.run?.nodes ?? run?.report?.nodes ?? run?.outcomes ?? []
  const outcomes = new Map(reports.map((node) => [node.nodeId, node]))
  const jobs = new Map((run?.jobs ?? plan?.jobs ?? []).map((job) => [job.id, job]))
  const stageStatus = authorization?.status ?? proposal.status
  const pendingLabel =
    run?.status === 'confirming'
      ? 'nodeRun.confirming'
      : run?.status === 'countdown'
        ? 'nodeRun.startingIn'
        : run?.status === 'running'
          ? 'retry.queued'
          : stageStatus === 'active'
            ? 'nodeRun.status.active'
            : 'nodeRun.status.pending'
  return [...new Set(proposal.nodeIds)].map<AgentNodeInboxEntry>((nodeId) => {
    const report = outcomes.get(nodeId)
    const job = jobs.get(nodeId)
    const index = proposal.nodeIds.indexOf(nodeId)
    let status: AgentNodeInboxEntry['status'] = 'pending'
    let reason = report?.reason
    let error: NodeBatchError | undefined
    if (report) {
      status = 'task' in report && report.task === 'running' ? 'running' : report.outcome
      if (status === 'running') reason = undefined
    } else if (run?.status === 'running') {
      status = run.active === nodeId ? 'running' : 'pending'
    } else if (run?.status === 'failed') {
      status = 'failed'
      error = run.error
    } else if (run?.status === 'undone') {
      status = 'skipped'
      reason = 'stopped'
    } else if (run?.status === 'done') {
      // 没有逐节点回执时只知道授权结束，不能把整批结束当成每个节点成功。
      status = 'ended'
    } else if (run) {
      status = 'pending'
    } else if (
      stageStatus === 'ended' ||
      stageStatus === 'expired' ||
      stageStatus === 'exhausted'
    ) {
      status = stageStatus
    } else if (
      authorization?.attempts.some(
        (attempt) => attempt.nodeId === nodeId && attempt.taskIds.length > 0,
      )
    ) {
      status = 'running'
    } else if (plan?.error || plan?.blocked) {
      status = 'blocked'
      reason = job?.blocked
      error = plan.error
    }
    return {
      kind: 'node-run',
      id: `${proposal.authorizationId}:${nodeId}`,
      message,
      nodeId,
      title:
        job?.label ||
        authorization?.nodeNames[authorization.nodeIds.indexOf(nodeId)] ||
        proposal.nodeNames?.[index] ||
        message.title,
      status,
      reason,
      error,
      readFailed: snapshot.readFailed,
      pendingLabel,
      seconds: run?.status === 'countdown' ? run.remaining : undefined,
      submitted: status === 'running' && run?.status !== 'running',
    }
  })
}

/** 复用运行卡的观察与读取生命周期；面板自己不轮询，也不取得执行权。 */
export function createAgentNodeInbox(
  messages: readonly AgentPanelMessage[],
  scope: AgentNodeInboxScope,
) {
  const sameAccount = accountScope()
  const entries: { message: AgentToolMessage; view: AgentNodeRunView }[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.kind !== 'tool') continue
    const proposal = message.canvasRun
    if (
      !proposal?.authorizationId ||
      proposal.projectId !== scope.projectId ||
      seen.has(proposal.authorizationId)
    )
      continue
    seen.add(proposal.authorizationId)
    entries.push({ message, view: createAgentNodeRunView(message.id, proposal) })
  }
  const collect = (): AgentNodeInboxEntry[] =>
    sameAccount()
      ? entries.flatMap(({ message, view }) =>
          nodeRunInboxEntries(message, view.getSnapshot(), scope),
        )
      : []
  let snapshot = collect()
  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      const update = () => {
        snapshot = collect()
        notify()
      }
      const disconnect = entries.map(({ message, view }) => {
        if (message.canvasRun) view.updateProposal(message.canvasRun)
        return view.subscribe(update)
      })
      update()
      return () => {
        for (const dispose of disconnect) dispose()
      }
    },
  }
}

/** 只翻译已有的安全原因码，不展示上游错误原文。 */
export const NODE_RUN_REASON_LABELS = {
  missing_frame: 'canvas:nodeBatch.media',
  missing_media: 'canvas:nodeBatch.media',
  missing_prompt: 'canvas:nodeBatch.prompt',
  model_unavailable: 'canvas:nodeBatch.model',
  input_limit: 'canvas:nodeBatch.limit',
  local_upload: 'canvas:nodeBatch.local',
  busy: 'canvas:nodeBatch.busy',
  insufficient_balance: 'canvas:nodeBatch.balance',
  dependency_cycle: 'canvas:nodeBatch.cycle',
  spec_changed: 'nodeRun.rejected.specChanged',
  authorization: 'nodeRun.rejected.authorization',
  upstream_failed: 'canvas:nodeBatch.media',
  generation_failed: 'canvas:nodeBatch.failed',
  budget_exceeded: 'nodeRun.rejected.budget',
  retry_limit: 'nodeRun.rejected.retryLimit',
  canvas_changed: 'canvas:nodeBatch.changed',
  stopped: 'canvas:nodeBatch.cancelled',
} as const satisfies Record<StageRunReason, string>
