import type {
  AgentCanvasRunProposal,
  StageAuthorization,
  StageAuthorizationSubmission,
  StageRunNodeReport,
  StageRunReason,
  StageRunRecord,
} from '@image-playground/shared'
import { stageExecutionSpecsMatch } from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import { refreshChannels } from '../../../lib/channels/bootstrapChannels'
import {
  billedNodeQuantity,
  type NodeBatchError,
  NodeBatchFailure,
  type NodeBatchJob,
  type NodeBatchPlan,
} from '../../canvas/lib/nodeBatch'
import { type AgentNodeRunBridge, agentNodeRunBridge, subscribeAgentNodeRun } from './nodeRunBridge'
import { stageAuthorizationClient } from './stageAuthorizationClient'

/**
 * 提交被阶段授权拦下时，把 BFF 的错误码翻成报给智能体的原因；不是授权拒绝就返回 undefined，
 * 照常按上游失败处理（可以重试一次）。
 */
function stageRejectionReason(code: string | undefined): StageRunReason | undefined {
  // 只认已知的拒绝码；没列出的（含以后新增的）按普通失败走原来的重试流程，不猜原因。
  switch (code) {
    case 'stage_authorization_scope':
    case 'stage_authorization_attempt_conflict': // 模型、倍率或数量和授权时不一致
      return 'spec_changed'
    case 'stage_authorization_budget':
      return 'budget_exceeded'
    case 'stage_authorization_retry_limit':
      return 'retry_limit'
    case 'stage_authorization_inactive':
    case 'stage_authorization_not_found':
    case 'stage_authorization_stale':
      return 'authorization'
    default:
      return undefined
  }
}

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
// 每次开跑的身份。换账号后旧运行收尾时凭它认领：同一 key 已被收走又开了新的一次，就不动新的。
const owners = new Map<string, symbol>()
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
  // 运行权是登记时那个账号的：等画布、刷新清单期间换了账号，旧提案不能在新账号下开跑。
  const sameAccount = accountScope()
  let stopped = false
  let refreshing = false
  const attempt = () => {
    if (stopped || refreshing) return
    if (!sameAccount() || !origins.has(key) || runs.has(key)) return stop()
    if (agentNodeRunBridge()?.projectId !== proposal.projectId) return
    refreshing = true
    // refreshChannels 不会 reject：拉取失败时保留现有清单（与卡片报价同一降级策略），
    // 已下线的模型提交时服务端会按 model_unavailable 拒掉。
    void refreshChannels().then(() => {
      refreshing = false
      if (stopped) return
      if (!sameAccount()) return stop()
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
function watchAgentNodeRun(key: string): () => void {
  watchedCards.set(key, (watchedCards.get(key) ?? 0) + 1)
  return () => {
    const left = (watchedCards.get(key) ?? 1) - 1
    if (left > 0) watchedCards.set(key, left)
    else {
      watchedCards.delete(key)
      releaseUnwatchedRun(key)
    }
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
  owners.delete(key)
  disarmDirectAgentNodeRun(key)
  if (dropControl) controls.delete(key)
  revision += 1
  for (const listener of listeners) listener()
}
/**
 * 换了账号后收走这次运行留下的运行卡和运行权。它们属于原账号，新账号下不该再显示或保留；
 * 但只收自己的：key 已经换了一次运行（被收走后又开跑），或运行权已重新登记，都原样留着。
 */
function forgetSwitchedRun(
  key: string,
  owner: symbol,
  origin: AgentNodeRunOrigin | undefined,
  control?: AbortController,
) {
  if (owners.get(key) !== owner) return
  owners.delete(key)
  runs.delete(key)
  if (origins.get(key) === origin) {
    origins.delete(key)
    disarmDirectAgentNodeRun(key)
  }
  if (control && controls.get(key)?.control === control) controls.delete(key)
  revision += 1
  for (const listener of listeners) listener()
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
  owner: symbol,
  syncResults?: () => Promise<void>,
): Promise<boolean> {
  const origin = origins.get(key)
  let published = false
  // 回报跨 await：账号换过、或这个 key 已经归了更新的一次运行，就不再往卡上写，也不去接唤醒轮。
  const live = () => sameAccount() && owners.get(key) === owner
  const update = (report: AgentNodeRunReport, authorization?: StageAuthorization) => {
    if (!live()) return
    // 第一次发的是终局本身；之后在卡上那份之上补回执（卡在交完之前不会收走它）。
    const run = published ? (runs.get(key) ?? terminal) : terminal
    published = true
    publish(key, { ...run, report, ...(authorization ? { authorization } : {}) })
  }
  const follow = () => {
    if (live()) origin?.onReported?.(authorizationId)
  }
  update({ nodes, wake: 'reporting' })
  // 回报会立即唤醒读服务端画布；本机生成完成还不代表媒体与节点已在服务端可读。
  if (syncResults && nodes.some((node) => node.outcome === 'completed')) {
    try {
      await syncResults()
    } catch {
      update({ nodes, wake: 'failed' })
      return false
    }
  }
  if (!live()) return false
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

function quoteAgentNodeRun(proposal: AgentCanvasRunProposal, bridge = agentNodeRunBridge()) {
  const plan = bridge?.quote(proposal)
  if (!plan) return plan
  // 临时上传不在服务端快照里。确认前就停住并提示，不能拖到提交才因张数对不上失败。
  if (plan.jobs.some((job) => Object.keys(job.temporary).length > 0))
    return { ...plan, error: 'local' as const }
  if (!proposal.specs?.length || plan.error) return plan
  const live = plan.jobs.map((job) => ({
    nodeId: job.id,
    model: job.model,
    quantity: billedNodeQuantity(job),
    unitMultiplier: job.unitMultiplier ?? 1,
  }))
  return stageExecutionSpecsMatch(live, proposal.specs)
    ? plan
    : { ...plan, error: 'stale' as const }
}

async function runAuthorizedNodeBatch(
  bridge: AgentNodeRunBridge,
  proposal: AgentCanvasRunProposal,
  signature: string,
  signal: AbortSignal,
  progress: (completed: number, id: string) => void,
  executionToken: string,
  record: (report: StageRunNodeReport) => void,
  live: () => boolean,
) {
  const assertCurrent = () => {
    if (signal.aborted || !live()) throw new NodeBatchFailure('cancelled')
  }
  const plan = quoteAgentNodeRun(proposal, bridge)
  if (!plan || plan.signature !== signature || plan.error || plan.blocked)
    throw new NodeBatchFailure(plan?.error ?? 'changed')
  if (!proposal.authorizationId) throw new NodeBatchFailure('authorization')
  const authorizationId = proposal.authorizationId
  const authorizations: Record<string, StageAuthorizationSubmission> = {}
  const preflightJob = async (job: NodeBatchJob) => {
    assertCurrent()
    const attemptId = crypto.randomUUID()
    await stageAuthorizationClient.preflight(authorizationId, {
      executionToken,
      attemptId,
      nodeId: job.id,
      model: job.model,
      quantity: billedNodeQuantity(job),
      unitMultiplier: job.unitMultiplier ?? 1,
    })
    assertCurrent()
    authorizations[job.id] = {
      authorizationId,
      nodeId: job.id,
      attemptId,
      executionToken,
    }
  }
  for (const job of plan.jobs) await preflightJob(job)
  assertCurrent()
  const retried = new Set<string>()
  await bridge.run(proposal, plan, {
    signal,
    progress,
    authorizations,
    hooks: {
      // 授权内同一节点至多自动重试一次；重试另开一次预检，花费计入授权已用额度。
      recover: async (job, error) => {
        if (!(error instanceof NodeBatchFailure) || error.code !== 'failed') throw error
        const failed = (reason: StageRunReason) => {
          record({
            nodeId: job.id,
            outcome: 'failed',
            reason,
            ...(retried.has(job.id) ? { retried: true } : {}),
          })
          return 'skip' as const
        }
        // BFF 按授权拒绝了这次提交：原样再提一遍还是同样被拒，不白占一次重试，直接报原因。
        const rejected = stageRejectionReason(error.submitError)
        if (rejected) return failed(rejected)
        if (retried.has(job.id)) return failed('generation_failed')
        try {
          await preflightJob(job)
        } catch (rejected) {
          assertCurrent()
          // 重试预检与提交被授权拒绝时使用同一组回报原因。
          const code = rejected instanceof Error ? rejected.message : undefined
          return failed(stageRejectionReason(code) ?? 'generation_failed')
        }
        retried.add(job.id)
        return 'retry'
      },
      completed: (job) =>
        record({
          nodeId: job.id,
          outcome: 'completed',
          ...(retried.has(job.id) ? { retried: true } : {}),
        }),
      skipped: (job) => record({ nodeId: job.id, outcome: 'skipped', reason: 'upstream_failed' }),
    },
  })
  assertCurrent()
}

export function startAgentNodeRun(
  key: string,
  proposal: AgentCanvasRunProposal,
  undoSeconds = AGENT_NODE_RUN_UNDO_SECONDS,
): boolean {
  const authorizationId = proposal.authorizationId
  if (!authorizationId || !origins.has(key) || runs.has(key)) return false
  const plan = quoteAgentNodeRun(proposal)
  const sameAccount = accountScope()
  const owner = Symbol(key)
  // 跨 await 的每一步都要同时核对账号和运行权：换走又换回同一账号时 scope 一样，
  // 但这个 key 可能已经归了更新的一次运行，旧运行不能再接着跑或往卡上写。
  const live = () => sameAccount() && owners.get(key) === owner
  const origin = origins.get(key)
  // 直接出图开跑前就被拦下（缺首帧、缺素材、参数不可用……）：不提交，把原因交给智能体，授权随之结束。
  // 需要确认的卡在这种情况下按钮是灰的，用户看得到原因，不自动回报。
  if (proposal.direct && plan?.error && PERSISTENT_BLOCKS.has(plan.error)) {
    const error = plan.error
    owners.set(key, owner)
    void reportRun(
      key,
      { jobs: plan.jobs, credits: plan.credits, status: 'failed', error, completed: 0 },
      authorizationId,
      blockedReport(proposal, plan, error),
      undefined,
      sameAccount,
      owner,
    ).then((reported) => {
      if (!reported) void stageAuthorizationClient.end(authorizationId).catch(() => {})
      // 交的途中换了账号：卡上停在「正在交」，终局才收的规则收不走它，按换账号收走。
      if (!sameAccount()) forgetSwitchedRun(key, owner, origin)
      else if (live()) releaseUnwatchedRun(key)
    })
    return true
  }
  if (!plan || plan.error || plan.blocked) return false
  const base: RunBase = { jobs: plan.jobs, credits: plan.credits }
  const control = new AbortController()
  controls.set(key, { control, authorizationId })
  owners.set(key, owner)
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
    let syncResults: (() => Promise<void>) | undefined
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
      if (control.signal.aborted || !live()) return
      if (undoSeconds > 0)
        await new Promise<void>((resolve) => {
          let remaining = undoSeconds
          publish(key, { ...base, authorization, status: 'countdown', remaining })
          const timer = setInterval(() => {
            remaining -= 1
            if (!live()) {
              // 倒计时中换了账号或这个 key 已归新的一次运行：不再往卡上写，交给下面的核对收尾。
              clearInterval(timer)
              resolve()
            } else if (remaining > 0)
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
      if (control.signal.aborted || !live()) return
      const bridge = agentNodeRunBridge()
      if (bridge?.projectId !== proposal.projectId)
        throw Object.assign(new Error('changed'), { code: 'changed' })
      // 保留开跑时的会话，切换项目后仍同步这一批所属的画布。
      syncResults = bridge.syncResults
      publish(key, {
        ...base,
        authorization,
        status: 'running',
        completed: 0,
        active: plan.jobs[0]?.id ?? '',
      })
      await runAuthorizedNodeBatch(
        bridge,
        proposal,
        plan.signature,
        control.signal,
        (completed, id) => {
          if (id) {
            started = true
            active = id
          }
          if (!control.signal.aborted && live())
            publish(key, { ...base, authorization, status: 'running', completed, active: id })
        },
        confirmed.executionToken,
        (report) => {
          outcomes.set(report.nodeId, report)
        },
        live,
      )
      nodes = interruptedReport(proposal, outcomes, undefined, undefined)
      terminal = { ...base, authorization, status: 'done' }
    } catch (error) {
      const run = runs.get(key)
      const code = batchError(error)
      // 用户自己撤销或停下、换了账号：不唤醒，那是用户自己的决定。
      const reportable = !control.signal.aborted && live() && run?.status !== 'undone'
      if (reportable)
        nodes = started
          ? interruptedReport(proposal, outcomes, active, code)
          : // 确认时规格就对不上，或开跑前的预检、复核没过：一个都没提交，算被拦下。
            authorization || code === 'stale'
            ? blockedReport(proposal, quoteAgentNodeRun(proposal) ?? plan, code)
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
      if (terminal && nodes && live()) {
        const reported = await reportRun(
          key,
          terminal,
          authorizationId,
          nodes,
          executionToken,
          sameAccount,
          owner,
          syncResults,
        )
        if (reported) authorization = undefined
      } else if (terminal && live()) publish(key, terminal)
      if (authorization) {
        try {
          const ended = await stageAuthorizationClient.end(authorizationId)
          // 换了账号就不把回执写回原运行，但下面照样回收，不能提前 return 跳过。
          const run = live() ? runs.get(key) : undefined
          if (run) publish(key, { ...run, authorization: ended })
        } catch {
          // 换账号后这枚会话已经不属于原用户，登出会在服务端收回。丢失回执也不能靠本地状态重放。
        }
      }
      // 换了账号：确认中或倒计时里提前退出的运行停在非终局，终局才收的规则收不走它。
      // 它属于原账号，新账号下不该再显示或保留，这里直接收走。
      if (!sameAccount()) forgetSwitchedRun(key, owner, origin, control)
      else if (live()) releaseUnwatchedRun(key)
    }
  })()
  return true
}
/** Stop prevents all later submissions; already accepted queue tasks continue normally. */
export function stopAgentNodeRun(key: string) {
  const run = runs.get(key),
    execution = controls.get(key)
  if (!run || !execution) return
  const sameAccount = accountScope()
  const owner = owners.get(key)
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
      if (!sameAccount() || owners.get(key) !== owner) return
      const current = runs.get(key)
      if (current) publish(key, { ...current, authorization })
    })
    .catch(() => {})
}

export interface AgentNodeRunSnapshot {
  readonly run?: AgentNodeRun
  readonly plan?: NodeBatchPlan | null
  readonly authorization?: StageAuthorization
  readonly origin: boolean
  readonly canConfirm: boolean
  readonly readFailed: boolean
  readonly readReady: boolean
  readonly wakeSkipped?: NonNullable<StageRunRecord['wakeSkipped']>
}

/** A view observes a run; releasing it never stops execution or grants execution rights. */
export function createAgentNodeRunView(key: string, initialProposal: AgentCanvasRunProposal) {
  let proposal = initialProposal
  const sameAccount = accountScope()
  const observers = new Set<() => void>()
  let settled: AgentNodeRun | undefined
  let stored: StageAuthorization | undefined
  let readFailed = false
  let readGeneration = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disconnect: (() => void) | undefined
  const readSnapshot = (): AgentNodeRunSnapshot => {
    if (!sameAccount())
      return { origin: false, canConfirm: false, readFailed: false, readReady: false }
    const live = runs.get(key)
    if (live && isTerminalRun(live)) settled = live
    const run = live ?? settled
    const authorization =
      run?.authorization &&
      (run.status !== 'running' || run.authorization.audit.length > (stored?.audit.length ?? 0))
        ? run.authorization
        : stored
    return {
      run,
      plan: run ? undefined : quoteAgentNodeRun(proposal),
      authorization,
      canConfirm:
        !proposal.direct &&
        !run &&
        (authorization?.status ?? proposal.status) === 'pending' &&
        origins.has(key),
      origin: origins.has(key),
      readFailed,
      readReady: stored !== undefined,
      wakeSkipped: agentNodeRunWakeSkipped(proposal.authorizationId),
    }
  }
  let snapshot = readSnapshot()
  const update = () => {
    snapshot = readSnapshot()
    if (snapshot.canConfirm && !snapshot.readFailed && snapshot.plan?.error)
      noteAgentNodeRunBlocked(proposal, snapshot.plan)
    for (const observer of observers) observer()
    const live = runs.get(key)
    if (live && isTerminalRun(live) && live.report?.wake !== 'reporting') {
      // Finish publishing the receipt and following the wake before retiring this run.
      queueMicrotask(() => {
        if (runs.get(key) === live) forgetAgentNodeRun(key, controls.get(key)?.control)
      })
    }
  }
  const stopReading = () => {
    readGeneration += 1
    clearTimeout(timer)
  }
  const read = () => {
    stopReading()
    const id = proposal.authorizationId
    if (!id || proposal.direct || !observers.size || !sameAccount()) return
    const generation = readGeneration
    const current = () => observers.size > 0 && generation === readGeneration && sameAccount()
    let failures = 0
    const refresh = async () => {
      try {
        const state = await stageAuthorizationClient.read(id)
        if (!current()) return
        failures = 0
        readFailed = false
        stored = state
        update()
        if (state.status === 'pending' || state.status === 'active')
          timer = setTimeout(refresh, 3000)
      } catch {
        if (!current()) return
        failures += 1
        if (failures >= 5) {
          readFailed = true
          update()
        } else timer = setTimeout(refresh, Math.min(30_000, 3000 * 2 ** (failures - 1)))
      }
    }
    void refresh()
  }
  return {
    getSnapshot: () => snapshot,
    updateProposal: (next: AgentCanvasRunProposal) => {
      if (proposal === next) return
      const restartRead =
        proposal.authorizationId !== next.authorizationId || proposal.direct !== next.direct
      proposal = next
      if (restartRead) {
        stopReading()
        stored = undefined
        readFailed = false
      }
      update()
      if (restartRead) read()
    },
    subscribe: (observer: () => void) => {
      observers.add(observer)
      if (observers.size === 1) {
        const unwatch = watchAgentNodeRun(key)
        const unsubscribeRuns = subscribeAgentNodeRuns(update)
        const unsubscribeCanvas = subscribeAgentNodeRun(update)
        disconnect = () => {
          stopReading()
          unsubscribeRuns()
          unsubscribeCanvas()
          unwatch()
        }
        update()
        void refreshChannels()
        read()
      }
      return () => {
        observers.delete(observer)
        if (!observers.size) {
          disconnect?.()
          disconnect = undefined
        }
      }
    },
    start: () => sameAccount() && startAgentNodeRun(key, proposal),
    stop: () => {
      if (sameAccount()) stopAgentNodeRun(key)
    },
    retryRead: read,
  }
}

function isTerminalRun(run: AgentNodeRun) {
  return run.status === 'done' || run.status === 'undone' || run.status === 'failed'
}
