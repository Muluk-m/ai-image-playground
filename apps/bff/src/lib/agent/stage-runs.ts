import type { AgentInboxTaskResultPayload } from '@image-playground/db'
import {
  type AgentTurnParams,
  type AgentWakeSkipReason,
  type StageAuthorization,
  type StageRunNodeRecord,
  type StageRunNodeReport,
  type StageRunReason,
  type StageRunRecord,
  type StageRunReportInput,
  type StageRunReportResult,
  type StageRunWakeReceipt,
} from '@image-playground/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import type { BffTransaction } from '../private-overlay'
import type { AgentOwner } from './conversations'
import { enqueueAgentWake, stageRunWakeId } from './inbox'
import {
  lockOwnedStageAuthorization,
  StageAuthorizationError,
  stageExecutionTokenMatches,
} from './stage-authorizations'
import { AGENT_WAKE_CHANNEL } from './wake'

/**
 * 运行回报与唤醒（#1367）。浏览器跑完一批阶段授权内的画布节点，或开跑前就被拦下，把每个节点的
 * 结局报上来；这里核对、记进授权、结束授权，并按唤醒规则写一条唤醒进收件箱：
 *
 * - 一条授权只收一次回报，收件箱里那条唤醒的 id 由授权 id 定死，重复上报不会再唤醒；
 * - 被拦下同样唤醒；积分不足、连续唤醒到了上限时由起轮那一步跳过（见 `start-turn.ts`），
 *   跳过的原因记回授权与运行卡，面板据此说明智能体没有查看。
 */

const table = schema.agent_stage_authorizations
const FAILED_TASK = new Set(['failed', 'cancelled'])

type StageRow = typeof table.$inferSelect

/** 提案键是 `${turnId}:${callId}`：唤醒点名提出这批运行的那一轮。 */
function proposalTurnId(row: StageRow): string {
  const cut = row.proposal_key.lastIndexOf(':')
  return cut > 0 ? row.proposal_key.slice(0, cut) : row.proposal_key
}

function sameNodeSet(reported: readonly StageRunNodeReport[], scope: readonly string[]): boolean {
  const ids = new Set(reported.map((node) => node.nodeId))
  return (
    ids.size === reported.length &&
    reported.length === scope.length &&
    scope.every((id) => ids.has(id))
  )
}

/** 授权上记下的、这批节点真正建出的任务现在是什么状态。 */
async function submittedTaskStatuses(
  tx: BffTransaction,
  state: StageAuthorization,
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(state.attempts.flatMap((attempt) => attempt.taskIds))]
  if (!ids.length) return new Map()
  const rows = await tx
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, ids))
  return new Map(rows.map((row) => [row.id, row.status]))
}

/**
 * 回报来自浏览器，只当作「浏览器看到了什么」，凡是服务端自己记着的都以服务端为准：
 * - 节点集合必须与授权范围完全一致；
 * - 报「已完成」的节点必须有一个任务在服务端确实已完成；没提交过任务的不能报已完成；
 * - 提交过任务的不能报「被拦下」或「没轮到」；
 * - 报「失败」却一个任务都没建出来（预检被拒、提交没被接受）的，按被拦下记，不说成「已提交」；
 * - 报「失败」而最近一次提交的任务在服务端其实还在跑或已完成的（浏览器因画布改动等没等到结果），
 *   照记失败但标上任务的真实状态，智能体不把它说成生成失败；不拒收，免得整批回报和唤醒一起丢掉；
 * - 「自动重试过」按授权上这个节点建出任务的尝试次数算，不信浏览器给的值。
 */
async function verifiedReport(
  tx: BffTransaction,
  state: StageAuthorization,
  confirmed: boolean,
  input: StageRunReportInput,
): Promise<StageRunNodeRecord[]> {
  if (!sameNodeSet(input.nodes, state.nodeIds))
    throw new StageAuthorizationError('stage_run_report_scope', 422)
  const statuses = await submittedTaskStatuses(tx, state)
  return input.nodes.map((node) => {
    const submitted = state.attempts.filter(
      (attempt) => attempt.nodeId === node.nodeId && attempt.taskIds.length > 0,
    )
    const succeeded = submitted.some((attempt) =>
      attempt.taskIds.some((taskId) => statuses.get(taskId) === 'completed'),
    )
    if (
      (!confirmed && (node.outcome === 'completed' || node.outcome === 'failed')) ||
      (node.outcome === 'completed' && !succeeded) ||
      ((node.outcome === 'blocked' || node.outcome === 'skipped') && submitted.length > 0)
    )
      throw new StageAuthorizationError('stage_run_report_mismatch', 422)
    const outcome = node.outcome === 'failed' && submitted.length === 0 ? 'blocked' : node.outcome
    const latest = (submitted.at(-1)?.taskIds ?? []).flatMap((taskId) => {
      const status = statuses.get(taskId)
      return status ? [status] : []
    })
    const task =
      outcome !== 'failed'
        ? undefined
        : latest.includes('completed')
          ? ('completed' as const)
          : latest.some((status) => !FAILED_TASK.has(status))
            ? ('running' as const)
            : undefined
    return {
      nodeId: node.nodeId,
      outcome,
      ...(outcome !== 'completed' && node.reason ? { reason: node.reason } : {}),
      ...(submitted.length > 1 ? { retried: true } : {}),
      ...(task ? { task } : {}),
    }
  })
}

/**
 * 收下一批运行的回报。会话行先锁：唤醒的序号与并发的入队排成一列，锁的先后也与 `wake.ts` 一致。
 * 同一条授权的第二次回报原样交回、不再唤醒。
 */
export async function reportStageRun(
  userId: string,
  id: string,
  input: StageRunReportInput & { readonly deviceId?: string },
): Promise<{ readonly authorization: StageAuthorization } & StageRunReportResult> {
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select({ conversationId: table.conversation_id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.user_id, userId)))
    if (!head) throw new StageAuthorizationError('stage_authorization_not_found', 404)
    await tx
      .select({ id: schema.agent_conversations.id })
      .from(schema.agent_conversations)
      .where(eq(schema.agent_conversations.id, head.conversationId))
      .for('update')
    const row = await lockOwnedStageAuthorization(tx, userId, id)
    if (row.state.run) return { authorization: row.state, wake: 'duplicate' as const }
    // 授权已被用户结束或已过期：不再收回报、不再唤醒（结束就是用户不要智能体接着看这批了）。
    if (row.state.status === 'ended' || row.state.status === 'expired')
      throw new StageAuthorizationError('stage_authorization_inactive')
    const confirmed = row.execution_token_hash !== null
    if (
      confirmed
        ? !input.executionToken || !stageExecutionTokenMatches(row, input.executionToken)
        : input.executionToken !== undefined
    )
      throw new StageAuthorizationError('stage_authorization_inactive')
    const now = Date.now()
    const run: StageRunRecord = {
      reportedAt: now,
      nodes: await verifiedReport(tx, row.state, confirmed, input),
    }
    const authorization: StageAuthorization = {
      ...row.state,
      status: row.state.status === 'exhausted' ? 'exhausted' : 'ended',
      run,
      audit: [
        ...row.state.audit,
        { kind: 'reported', at: now },
        ...(row.state.status === 'exhausted' ? [] : [{ kind: 'ended' as const, at: now }]),
      ],
    }
    await tx.update(table).set({ state: authorization, updated_at: now }).where(eq(table.id, id))
    const payload: AgentInboxTaskResultPayload = {
      turnId: proposalTurnId(row),
      taskIds: [],
      deviceId: input.deviceId ?? '',
      stageRun: { authorizationId: id, eventVersion: 1 },
    }
    await enqueueAgentWake(tx, row.conversation_id, payload, now)
    await tx.execute(sql`SELECT pg_notify(${AGENT_WAKE_CHANNEL}, ${row.conversation_id})`)
    log.info(
      {
        event: 'agent.stage.reported',
        authorizationId: id,
        conversationId: row.conversation_id,
        outcomes: run.nodes.map((node) => node.outcome),
      },
      'Stage run reported; agent wake queued',
    )
    return { authorization, wake: 'queued' as const }
  })
}

/** 回报唤醒到了哪一步。还没回报时返回 null。 */
export async function readStageRunWakeReceipt(
  userId: string,
  id: string,
): Promise<StageRunWakeReceipt | null> {
  const inbox = schema.agent_inbox
  const [row] = await db
    .select({
      state: table.state,
      status: inbox.status,
      turnId: inbox.consumed_turn_id,
    })
    .from(table)
    .innerJoin(schema.agent_conversations, eq(schema.agent_conversations.id, table.conversation_id))
    .leftJoin(
      inbox,
      and(
        eq(inbox.conversation_id, table.conversation_id),
        eq(inbox.id, stageRunWakeId(id)),
        eq(inbox.kind, 'task_result'),
      ),
    )
    .where(
      and(
        eq(table.id, id),
        eq(table.user_id, userId),
        eq(schema.agent_conversations.user_id, userId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
  if (!row?.state.run) return null
  const skipped = row.state.run.wakeSkipped
  if (skipped || !row.status || row.status === 'cancelled' || row.status === 'failed')
    return { status: 'skipped', ...(skipped ? { reason: skipped } : {}) }
  if (row.status === 'consumed' && row.turnId) return { status: 'consumed', turnId: row.turnId }
  return { status: 'pending' }
}

/** 运行卡（runNodes 的结果块）里记着这条授权的那几条消息。 */
async function runCards(tx: BffTransaction, conversationId: string, authorizationId: string) {
  return tx
    .select({ id: schema.agent_messages.id, content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        sql`${schema.agent_messages.content} @> ${JSON.stringify([
          { type: 'toolResult', canvasRun: { authorizationId } },
        ])}::jsonb`,
      ),
    )
}

/**
 * 唤醒没有起轮（积分不足、连续唤醒到了上限）：原因记回授权的回报与运行卡，面板说明智能体没有查看。
 * 在跳过唤醒的同一个事务里调用。
 */
export async function markStageRunWakeSkipped(
  tx: BffTransaction,
  conversationId: string,
  authorizationId: string,
  reason: AgentWakeSkipReason,
): Promise<void> {
  const [row] = await tx
    .select({ state: table.state })
    .from(table)
    .where(and(eq(table.id, authorizationId), eq(table.conversation_id, conversationId)))
    .for('update')
  if (row?.state.run && !row.state.run.wakeSkipped)
    await tx
      .update(table)
      .set({ state: { ...row.state, run: { ...row.state.run, wakeSkipped: reason } } })
      .where(eq(table.id, authorizationId))
  for (const card of await runCards(tx, conversationId, authorizationId)) {
    const content = card.content.map((block) =>
      block.type === 'toolResult' && block.canvasRun?.authorizationId === authorizationId
        ? { ...block, wakeSkipped: reason }
        : block,
    )
    await tx
      .update(schema.agent_messages)
      .set({ content })
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversationId),
          eq(schema.agent_messages.id, card.id),
        ),
      )
  }
}

const REASON_TEXT: Record<StageRunReason, string> = {
  missing_frame: '首帧或尾帧帧位为空，没有可用的帧图',
  missing_media: '引用的素材没有可用的图',
  missing_prompt: '没有提示词',
  model_unavailable: '模型或参数不可用',
  input_limit: '参考图超过模型上限',
  local_upload: '用了只在浏览器里的临时上传图，服务端看不到',
  busy: '节点正在生成或上传，不能同时再跑',
  insufficient_balance: '积分不足',
  dependency_cycle: '节点之间的连线成环',
  spec_changed: '画布上的模型、数量或参数在授权之后改了，和授权时不一致',
  authorization: '授权已失效或不在范围内',
  upstream_failed: '它依赖的上游节点没有出结果',
  generation_failed: '生成失败',
  budget_exceeded: '自动重试会超出这次授权的预算上限',
  retry_limit: '已经自动重试过一次',
  canvas_changed: '运行途中画布被改动，结果没能对上',
  stopped: '这一批停下了，没轮到它',
}

function nodeLine(name: string, node: StageRunNodeRecord): string {
  const reason = node.reason ? REASON_TEXT[node.reason] : undefined
  if (node.outcome === 'failed' && node.task === 'running')
    return `- 「${name}」：已提交，任务还在生成，这一批没等到它的结果${reason ? `（${reason}）` : ''}；不要说它失败或已完成，结果出来会出现在节点上。`
  if (node.outcome === 'failed' && node.task === 'completed')
    return `- 「${name}」：已提交，任务出了结果，但没能成为节点主结果${reason ? `（${reason}）` : ''}；请用户在节点上查看并选用。`
  switch (node.outcome) {
    case 'completed':
      return `- 「${name}」：已完成，结果已成为节点主结果${node.retried ? '（自动重试一次后成功）' : ''}。`
    case 'failed':
      return `- 「${name}」：已提交但没有结果${node.retried ? '，授权内已自动重试一次，仍然失败' : ''}${reason ? `（${reason}）` : ''}。`
    case 'blocked':
      return `- 「${name}」：开跑前被拦下，没有提交${reason ? `：${reason}` : ''}。`
    case 'skipped':
      return `- 「${name}」：没有运行${reason ? `：${reason}` : ''}。`
  }
}

export interface StageRunWakeContent {
  readonly text: string
  readonly mode: 'image' | 'video'
  readonly params: AgentTurnParams
}

/**
 * 唤醒轮看到的那一段：哪个阶段、每个节点（用节点名）的结局与原因，以及该怎么说、不该做什么。
 * 这一轮里再发起的 runNodes 或 runStoryboardFrames 一律等用户在卡上确认：自动重试已经用过，新的花费要用户点头。
 */
export async function stageRunWakeContent(
  conversationId: string,
  owner: AgentOwner,
  notice: NonNullable<AgentInboxTaskResultPayload['stageRun']>,
): Promise<StageRunWakeContent | null> {
  if (owner.kind !== 'user' || notice.eventVersion !== 1) return null
  const [row] = await db
    .select({ state: table.state })
    .from(table)
    .innerJoin(schema.agent_conversations, eq(schema.agent_conversations.id, table.conversation_id))
    .where(
      and(
        eq(table.id, notice.authorizationId),
        eq(table.user_id, owner.userId),
        eq(table.conversation_id, conversationId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
  const state = row?.state
  const run = state?.run
  if (!state || !run) return null
  const nameOf = new Map(state.nodeIds.map((id, index) => [id, state.nodeNames[index] || id]))
  const count = (outcome: StageRunNodeReport['outcome']) =>
    run.nodes.filter((node) => node.outcome === outcome).length
  const completed = count('completed')
  // 报失败但任务其实还在跑或已出结果的，不算进失败，单独说。
  const unsettled = run.nodes.filter((node) => node.outcome === 'failed' && node.task).length
  const failed = count('failed') - unsettled
  const blocked = count('blocked')
  const skipped = count('skipped')
  const overBudget = run.nodes.some(
    (node) => node.outcome === 'failed' && !node.task && node.reason === 'budget_exceeded',
  )
  // 首帧阶段的节点 runNodes 不收，要重出得走 runStoryboardFrames。
  const rerun = state.storyboard ? 'runStoryboardFrames（单镜重出传 shotIds）' : 'runNodes'
  const guidance = [
    '汇报规则：用节点名称指代节点，不要说内部 id；只有标为「已完成」的节点才能说已完成或已生成，提交了但没有结果的只能说「已提交」或「失败」。',
  ]
  if (blocked > 0)
    guidance.push(
      '被拦下的节点：逐个说清原因，以及用户要补什么或改什么（例如先给首帧节点出图、补素材、换可用的模型）。',
    )
  if (failed > 0)
    guidance.push(
      overBudget
        ? `失败节点的自动重试超出了这次授权的预算：说明还差什么，请用户同意后再用 ${rerun} 为这些节点发起新的阶段授权。`
        : '失败节点已在授权内自动重试过至多一次，不要再自行重试或重新提交：说明失败的是哪几个，提议下一步，等用户决定。',
    )
  if (unsettled > 0)
    guidance.push(
      '没等到结果的节点：任务已提交，不是生成失败；还在生成的等结果出现在节点上，已出结果的请用户在节点上查看并选用，不要重新提交。',
    )
  if (skipped > 0)
    guidance.push(
      `没有运行的节点：说明它们为什么没轮到；要继续时请用户同意后再用 ${rerun} 发起新的阶段授权。`,
    )
  guidance.push('这一轮不要自行发起新的付费运行；需要再跑时先向用户说明并等他同意。')
  return {
    text: [
      '（系统通知，不是用户说的话）你发起的画布节点运行这一批已经结束，授权随之结束。',
      `阶段「${state.stage}」，授权 ${state.id}，预算上限 ${state.budgetCap} 积分，已用 ${state.spentCredits} 积分。共 ${run.nodes.length} 个节点：已完成 ${completed}，失败 ${failed}，${unsettled > 0 ? `没等到结果 ${unsettled}，` : ''}被拦下 ${blocked}，未运行 ${skipped}。`,
      ...run.nodes.map((node) => nodeLine(nameOf.get(node.nodeId) ?? node.nodeId, node)),
      ...guidance,
    ].join('\n'),
    mode:
      state.bindings?.length && state.bindings.every((binding) => binding.kind === 'video')
        ? 'video'
        : 'image',
    params: { autoSubmit: false },
  }
}
