import type {
  AgentCanvasRunProposal,
  StageAuthorization,
  StageRunNodeReport,
  StageRunReason,
  StageRunRecord,
} from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import { refreshChannels } from '../../../lib/channels/bootstrapChannels'
import {
  billedNodeQuantity,
  type NodeBatchError,
  type NodeBatchJob,
  type NodeBatchPlan,
} from '../../canvas/lib/nodeBatch'
import { agentNodeRunBridge, subscribeAgentNodeRun } from './nodeRunBridge'
import { stageAuthorizationClient } from './stageAuthorizationClient'

export const AGENT_NODE_RUN_UNDO_SECONDS = 5
/** 这一批交给智能体的回报：逐节点结局，以及唤醒走到了哪一步。 */
export interface AgentNodeRunReport {
  readonly nodes: readonly StageRunNodeReport[]
  /** `reporting` 正在交；`queued` 已排上唤醒；`failed` 没交上（网络或授权已失效）。 */
  readonly wake: 'reporting' | 'queued' | 'duplicate' | 'none' | 'failed'
  /** 唤醒没有起轮的原因，面板据此说明智能体没有查看。 */
  readonly wakeSkipped?: StageRunRecord['wakeSkipped']
}
interface RunBase {
  readonly jobs: readonly NodeBatchJob[]
  readonly credits?: number
  readonly authorization?: StageAuthorization
  readonly report?: AgentNodeRunReport
}
export type AgentNodeRun = RunBase &
  (
    | { readonly status: 'confirming' }
    | { readonly status: 'countdown'; readonly remaining: number }
    | { readonly status: 'running'; readonly completed: number; readonly active: string }
    | { readonly status: 'done' }
    | { readonly status: 'undone' }
    | { readonly status: 'failed'; readonly error: NodeBatchError; readonly completed: number }
  )
/** 发起这次运行的那张卡：回报交上之后，由它去接智能体的唤醒轮。 */
export interface AgentNodeRunOrigin {
  readonly onReported?: (authorizationId: string) => void
}
// Execution rights live only in this document. Reloads, snapshots and other tabs cannot acquire them.
const origins = new Map<string, AgentNodeRunOrigin>()
const runs = new Map<string, AgentNodeRun>()
const controls = new Map<string, { control: AbortController; authorizationId: string }>()
const listeners = new Set<() => void>()
let revision = 0
/**
 * 本标签页拿到运行权。直接出图的提案在这里就开跑，不等运行卡渲染出来：
 * 聊天面板收起（从首页「画布创作」进项目的默认状态）时运行卡根本没挂载，
 * 把开跑挂在卡片上，授权就一直停在 pending，而智能体已经说了「会立即开跑」。
 */
export function registerAgentNodeRunOrigin(
  key: string,
  origin: AgentNodeRunOrigin = {},
  proposal?: AgentCanvasRunProposal,
) {
  origins.set(key, origin)
  for (const listener of listeners) listener()
  if (proposal?.direct) armDirectAgentNodeRun(key, proposal)
}
// 等画布接上再开跑的直接出图：拿着运行权、还没开跑的那几张。
const directWaits = new Map<string, () => void>()
function disarmDirectAgentNodeRun(key: string) {
  directWaits.get(key)?.()
}
/**
 * 画布（运行桥）已经挂着就立刻开跑，否则等它挂上。开跑前先把模型清单刷新一下（30 秒节流）：
 * 模型刚被停用时不按旧清单提交。`busy` 之类会自己消失的拦截不开跑，画布重新挂上时再试。
 */
function armDirectAgentNodeRun(key: string, proposal: AgentCanvasRunProposal) {
  disarmDirectAgentNodeRun(key)
  let stopped = false
  let refreshing = false
  const attempt = () => {
    if (stopped || refreshing) return
    if (!origins.has(key) || runs.has(key)) return stop()
    if (agentNodeRunBridge()?.projectId !== proposal.projectId) return
    refreshing = true
    // refreshChannels 不会 reject：拉取失败时保留现有清单（与卡片报价同一降级策略），
    // 已下线的模型提交时服务端会按 model_unavailable 拒掉。
    void refreshChannels().then(() => {
      refreshing = false
      if (stopped) return
      if (startAgentNodeRun(key, proposal, 0) || runs.has(key) || !origins.has(key)) stop()
    })
  }
  const unsubscribe = subscribeAgentNodeRun(attempt)
  const stop = () => {
    stopped = true
    unsubscribe()
    if (directWaits.get(key) === stop) directWaits.delete(key)
  }
  directWaits.set(key, stop)
  attempt()
}
/**
 * 换会话或清掉消息之后调用。还没确认的提案不在 runs 里，随消息一起丢掉。
 * 已经开跑的运行卡留下。不要在注册时按数量裁剪：未确认的卡片还没有 run，裁掉就会失去确认入口。
 */
export function releaseIdleAgentNodeRunOrigins() {
  let changed = false
  for (const key of origins.keys()) {
    if (runs.has(key)) continue
    origins.delete(key)
    disarmDirectAgentNodeRun(key)
    changed = true
  }
  if (!changed) return
  revision += 1
  for (const listener of listeners) listener()
}
export const isAgentNodeRunOrigin = (key: string) => origins.has(key)
/** 运行表换代的次数。输入栏用它知道哪张运行卡已经开跑，不必再当成待确认。 */
export function agentNodeRunRevision(): number {
  return revision
}
export const agentNodeRun = (key: string) => runs.get(key)
export function subscribeAgentNodeRuns(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function publish(key: string, run: AgentNodeRun) {
  revision += 1
  runs.set(key, run)
  for (const listener of listeners) listener()
}
// 正挂着的运行卡。卡在就由卡在终局交完后收走运行（它要先把结局留在卡面上）。
const watchedCards = new Map<string, number>()
/** 运行卡挂载时调用，返回卸载时的释放函数。 */
export function watchAgentNodeRun(key: string): () => void {
  watchedCards.set(key, (watchedCards.get(key) ?? 0) + 1)
  return () => {
    const left = (watchedCards.get(key) ?? 1) - 1
    if (left > 0) watchedCards.set(key, left)
    else watchedCards.delete(key)
  }
}
/**
 * 没有卡在看的运行，终局交完就收走。聊天面板收起时直接出图的运行卡从不挂载，
 * 不在这里收，跑完的运行连同运行权、回调会在这个标签页里一直留着。之后再打开面板，
 * 卡片按服务端记录显示，和刷新后看到的一样。
 */
function releaseUnwatchedRun(key: string) {
  if (watchedCards.has(key)) return
  const run = runs.get(key)
  if (!run || (run.status !== 'done' && run.status !== 'undone' && run.status !== 'failed')) return
  if (run.report?.wake === 'reporting') return
  forgetAgentNodeRun(key, controls.get(key)?.control)
}
export function forgetAgentNodeRun(key: string, control?: AbortController) {
  const dropControl = control !== undefined && controls.get(key)?.control === control
  if (!runs.has(key) && !origins.has(key) && !dropControl) return
  runs.delete(key)
  origins.delete(key)
  disarmDirectAgentNodeRun(key)
  if (dropControl) controls.delete(key)
  revision += 1
  for (const listener of listeners) listener()
}
export function agentNodeRunControl(key: string): AbortController | undefined {
  return controls.get(key)?.control
}
/**
 * 开跑前就拦下、且不会自己消失的错误：报给智能体让它说明缺什么。`busy`（正在生成或上传）与
 * `balance`（余额不足或还没读到）会自己变化，不报：前者等它跑完再开，后者按「积分不足不唤醒」处理。
 */
const PERSISTENT_BLOCKS = new Set<NodeBatchError>([
  'empty',
  'cycle',
  'prompt',
  'media',
  'model',
  'limit',
  'local',
  'stale',
])
const BLOCK_REASONS: Partial<Record<NodeBatchError, StageRunReason>> = {
  cycle: 'dependency_cycle',
  stale: 'spec_changed',
  changed: 'canvas_changed',
  authorization: 'authorization',
  balance: 'insufficient_balance',
}
/** 开跑前被拦下：每个授权节点各记一笔，有自己原因的记被拦下，其余记没轮到。 */
function blockedReport(
  proposal: AgentCanvasRunProposal,
  plan: Pick<NodeBatchPlan, 'jobs'> | null | undefined,
  error: NodeBatchError,
): StageRunNodeReport[] {
  const fallback = BLOCK_REASONS[error]
  return proposal.nodeIds.map((nodeId) => {
    const job = plan?.jobs.find((one) => one.id === nodeId)
    const reason: StageRunReason | undefined = !job
      ? 'missing_prompt'
      : (job.blocked ??
        (Object.keys(job.temporary).length > 0 && error === 'local' ? 'local_upload' : fallback))
    return reason
      ? { nodeId, outcome: 'blocked' as const, reason }
      : { nodeId, outcome: 'skipped' as const, reason: 'stopped' as const }
  })
}
const MID_RUN_REASONS: Partial<Record<NodeBatchError, StageRunReason>> = {
  changed: 'canvas_changed',
  media: 'missing_media',
  authorization: 'authorization',
}
/** 跑到一半停下：已有结局的照记，正在跑的那个记失败，其余记没轮到。 */
function interruptedReport(
  proposal: AgentCanvasRunProposal,
  outcomes: ReadonlyMap<string, StageRunNodeReport>,
  active: string | undefined,
  error: NodeBatchError | undefined,
): StageRunNodeReport[] {
  return proposal.nodeIds.map(
    (nodeId) =>
      outcomes.get(nodeId) ??
      (nodeId === active
        ? {
            nodeId,
            outcome: 'failed' as const,
            reason: (error && MID_RUN_REASONS[error]) || ('generation_failed' as const),
          }
        : { nodeId, outcome: 'skipped' as const, reason: 'stopped' as const }),
  )
}
function batchError(error: unknown): NodeBatchError {
  if (error && typeof error === 'object' && 'code' in error) {
    switch (error.code) {
      case 'empty':
      case 'cycle':
      case 'busy':
      case 'prompt':
      case 'media':
      case 'model':
      case 'changed':
      case 'failed':
      case 'cancelled':
      case 'limit':
      case 'balance':
      case 'authorization':
      case 'stale':
      case 'local':
        return error.code
    }
  }
  return 'failed'
}
/**
 * 把这一批的结局交给 BFF：它结束授权、唤醒智能体一次。服务端收下了（这一次排上、或早已收过）就让
 * 发起的那张卡去接唤醒轮。请求出错时回报可能已在服务端落库、只是响应丢了，先按唤醒回执确认一次：
 * 收下了照常接唤醒轮；确认没收下才在卡上说明没交上，不重放。
 * 终局先带着「正在交」发出去，卡在交完之前不会把这次运行收走。返回服务端是否已收下这份回报。
 */
async function reportRun(
  key: string,
  terminal: AgentNodeRun,
  authorizationId: string,
  nodes: readonly StageRunNodeReport[],
  executionToken: string | undefined,
  sameAccount: () => boolean,
): Promise<boolean> {
  const origin = origins.get(key)
  let published = false
  const update = (report: AgentNodeRunReport, authorization?: StageAuthorization) => {
    if (!sameAccount()) return
    // 第一次发的是终局本身；之后在卡上那份之上补回执（卡在交完之前不会收走它）。
    const run = published ? (runs.get(key) ?? terminal) : terminal
    published = true
    publish(key, { ...run, report, ...(authorization ? { authorization } : {}) })
  }
  const follow = () => {
    if (sameAccount()) origin?.onReported?.(authorizationId)
  }
  update({ nodes, wake: 'reporting' })
  try {
    const result = await stageAuthorizationClient.report(authorizationId, {
      nodes,
      ...(executionToken ? { executionToken } : {}),
    })
    update({ nodes, wake: result.wake }, result.authorization)
    // 重复上报说明早已有人交上（响应丢了重交、或另一处先交了）：那条唤醒照样要接。
    if (result.wake === 'queued' || result.wake === 'duplicate') follow()
    return true
  } catch {
    const receipt = await stageAuthorizationClient.wake(authorizationId).catch(() => null)
    if (receipt) {
      const authorization = await stageAuthorizationClient
        .read(authorizationId)
        .catch(() => undefined)
      update({ nodes, wake: 'duplicate' }, authorization)
      follow()
      return true
    }
    update({ nodes, wake: 'failed' })
    return false
  }
}
const skippedWakes = new Map<string, NonNullable<StageRunRecord['wakeSkipped']>>()
/** 唤醒被跳过（积分不足、连续唤醒到了上限）：卡上说明智能体没有查看。运行收走之后也记得。 */
export function noteAgentNodeRunWakeSkipped(
  authorizationId: string,
  reason: NonNullable<StageRunRecord['wakeSkipped']>,
) {
  if (skippedWakes.get(authorizationId) === reason) return
  skippedWakes.set(authorizationId, reason)
  revision += 1
  for (const listener of listeners) listener()
}
export const agentNodeRunWakeSkipped = (authorizationId: string | undefined) =>
  authorizationId ? skippedWakes.get(authorizationId) : undefined
/** Explicit confirmation is the only entry. The BFF grants a token once, before the undo window. */
const notedBlocks = new Set<string>()
/**
 * 需要确认的卡开跑前就被拦下（按钮置灰）：把逐节点原因报给服务端记日志，好在 admin 日志里查得到。
 * 同一条授权的同一组原因只报一次；不结束授权，用户改好画布后还能确认。
 */
export function noteAgentNodeRunBlocked(
  proposal: AgentCanvasRunProposal,
  plan: Pick<NodeBatchPlan, 'jobs' | 'error'> | null | undefined,
): void {
  const authorizationId = proposal.authorizationId
  const error = plan?.error
  if (proposal.direct || !authorizationId || !error || !PERSISTENT_BLOCKS.has(error)) return
  const nodes = blockedReport(proposal, plan, error).filter((node) => node.outcome === 'blocked')
  if (!nodes.length) return
  const key = `${authorizationId}:${nodes.map((node) => `${node.nodeId}=${node.reason}`).join(',')}`
  if (notedBlocks.has(key)) return
  notedBlocks.add(key)
  // 没报上去（网络抖动、BFF 暂时不可用）就把键放回去，下次渲染再报。
  void stageAuthorizationClient.blocked(authorizationId, nodes).catch(() => {
    notedBlocks.delete(key)
  })
}

export function startAgentNodeRun(
  key: string,
  proposal: AgentCanvasRunProposal,
  undoSeconds = AGENT_NODE_RUN_UNDO_SECONDS,
): boolean {
  const authorizationId = proposal.authorizationId
  if (!authorizationId || !origins.has(key) || runs.has(key)) return false
  const plan = agentNodeRunBridge()?.quote(proposal)
  const sameAccount = accountScope()
  // 直接出图开跑前就被拦下（缺首帧、缺素材、参数不可用……）：不提交，把原因交给智能体，授权随之结束。
  // 需要确认的卡在这种情况下按钮是灰的，用户看得到原因，不自动回报。
  if (proposal.direct && plan?.error && PERSISTENT_BLOCKS.has(plan.error)) {
    const error = plan.error
    void reportRun(
      key,
      { jobs: plan.jobs, credits: plan.credits, status: 'failed', error, completed: 0 },
      authorizationId,
      blockedReport(proposal, plan, error),
      undefined,
      sameAccount,
    ).then((reported) => {
      if (!reported) void stageAuthorizationClient.end(authorizationId).catch(() => {})
      releaseUnwatchedRun(key)
    })
    return true
  }
  if (!plan || plan.error || plan.blocked) return false
  const base: RunBase = { jobs: plan.jobs, credits: plan.credits }
  const control = new AbortController()
  controls.set(key, { control, authorizationId })
  publish(key, { ...base, status: 'confirming' })
  void (async () => {
    let authorization: StageAuthorization | undefined
    let executionToken: string | undefined
    // 已经交到浏览器里的逐节点结局；`active` 是正在提交或等结果的那个，`started` 说明已经过了开跑前的检查。
    const outcomes = new Map<string, StageRunNodeReport>()
    let active: string | undefined
    let started = false
    let terminal: AgentNodeRun | undefined
    let nodes: StageRunNodeReport[] | undefined
    try {
      const confirmed = await stageAuthorizationClient.confirm(
        authorizationId,
        plan.jobs.map((job) => ({
          nodeId: job.id,
          model: job.model,
          quantity: billedNodeQuantity(job),
          unitMultiplier: job.unitMultiplier ?? 1,
        })),
      )
      authorization = confirmed.authorization
      executionToken = confirmed.executionToken
      if (control.signal.aborted || !sameAccount()) return
      if (undoSeconds > 0)
        await new Promise<void>((resolve) => {
          let remaining = undoSeconds
          publish(key, { ...base, authorization, status: 'countdown', remaining })
          const timer = setInterval(() => {
            remaining -= 1
            if (remaining > 0)
              publish(key, { ...base, authorization, status: 'countdown', remaining })
            else {
              clearInterval(timer)
              resolve()
            }
          }, 1000)
          control.signal.addEventListener(
            'abort',
            () => {
              clearInterval(timer)
              resolve()
            },
            { once: true },
          )
        })
      if (control.signal.aborted || !sameAccount()) return
      const bridge = agentNodeRunBridge()
      if (bridge?.projectId !== proposal.projectId)
        throw Object.assign(new Error('changed'), { code: 'changed' })
      publish(key, {
        ...base,
        authorization,
        status: 'running',
        completed: 0,
        active: plan.jobs[0]?.id ?? '',
      })
      await bridge.run(
        proposal,
        plan.signature,
        control.signal,
        (completed, id) => {
          if (id) {
            started = true
            active = id
          }
          if (!control.signal.aborted)
            publish(key, { ...base, authorization, status: 'running', completed, active: id })
        },
        confirmed.executionToken,
        (report) => {
          outcomes.set(report.nodeId, report)
        },
      )
      nodes = interruptedReport(proposal, outcomes, undefined, undefined)
      terminal = { ...base, authorization, status: 'done' }
    } catch (error) {
      const run = runs.get(key)
      const code = batchError(error)
      // 用户自己撤销或停下、换了账号：不唤醒，那是用户自己的决定。
      const reportable = !control.signal.aborted && sameAccount() && run?.status !== 'undone'
      if (reportable)
        nodes = started
          ? interruptedReport(proposal, outcomes, active, code)
          : // 确认时规格就对不上，或开跑前的预检、复核没过：一个都没提交，算被拦下。
            authorization || code === 'stale'
            ? blockedReport(proposal, agentNodeRunBridge()?.quote(proposal) ?? plan, code)
            : undefined
      if (run?.status !== 'undone')
        terminal = {
          ...base,
          authorization,
          status: 'failed',
          error: code,
          completed: run?.status === 'running' ? run.completed : 0,
        }
    } finally {
      if (controls.get(key)?.control === control) controls.delete(key)
      if (terminal && nodes && sameAccount()) {
        const reported = await reportRun(
          key,
          terminal,
          authorizationId,
          nodes,
          executionToken,
          sameAccount,
        )
        if (reported) authorization = undefined
      } else if (terminal) publish(key, terminal)
      if (authorization) {
        try {
          const ended = await stageAuthorizationClient.end(authorizationId)
          // 换了账号就不把回执写回原运行，但下面照样回收，不能提前 return 跳过。
          const run = sameAccount() ? runs.get(key) : undefined
          if (run) publish(key, { ...run, authorization: ended })
        } catch {
          // 换账号后这枚会话已经不属于原用户，登出会在服务端收回。丢失回执也不能靠本地状态重放。
        }
      }
      // 换了账号：确认中或倒计时里提前退出的运行停在非终局，终局才收的规则收不走它。
      // 它属于原账号，新账号下不该再显示或保留，这里直接收走。
      if (!sameAccount()) forgetAgentNodeRun(key, control)
      else releaseUnwatchedRun(key)
    }
  })()
  return true
}
/** Stop prevents all later submissions; already accepted queue tasks continue normally. */
export function stopAgentNodeRun(key: string) {
  const run = runs.get(key),
    execution = controls.get(key)
  if (!run || !execution) return
  execution.control.abort()
  if (run.status === 'countdown' || run.status === 'confirming')
    publish(key, {
      jobs: run.jobs,
      credits: run.credits,
      authorization: run.authorization,
      status: 'undone',
    })
  void stageAuthorizationClient
    .end(execution.authorizationId)
    .then((authorization) => {
      const current = runs.get(key)
      if (current) publish(key, { ...current, authorization })
    })
    .catch(() => {})
}
