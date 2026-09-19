import type { AgentInboxResumePayload } from '@image-playground/db'
import type { AgentToolEndEvent } from '@image-playground/shared'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { appendAgentMessage, listAgentToolCalls } from './conversations'
import {
  type AgentReplayedSubmission,
  agentSubmissionKey,
  agentToolDraftedBlock,
  agentToolStartFromSnapshot,
  agentToolSubmittedBlock,
  isAgentToolName,
} from './tools'

/**
 * 中断续跑：服务重启或执行者被接管打断了一轮（它没有终帧、也没有页脚），补写终帧的一方在这里
 * 收拾它留下的东西，再决定要不要续一次。
 *
 * - 没说完的那段回复本来就没落库，终帧按失败补上之后面板也会把它撤掉：续跑是重新生成，不接着
 *   那条流。
 * - 已经提交的后台任务不受影响：任务与登记同一个事务写下，结果卡却要等工具收尾才写。进程死在
 *   两者之间时，照起跑时落库的参数快照把结果卡补上——产物才落得到画布上，续跑的那一轮也才看得见
 *   它已经提交过、不会再提交一次。
 * - 同一轮只续一次：续跑记录按被打断的轮去重（见 `enqueueAgentResume`），续跑那一轮自己再被打断
 *   也不再续，反复崩溃时不会无限循环。
 */

const inbox = schema.agent_inbox

export interface InterruptedTurnRecovery {
  /** 补写的结果卡，排在终帧之前发给续播的客户端。 */
  readonly events: readonly AgentToolEndEvent[]
  /** 要续跑时的载荷；不续（续跑那一轮自己被打断、在等澄清答复、不是收件箱起的轮）为 null。 */
  readonly resume: AgentInboxResumePayload | null
}

/** 收拾被打断的一轮：补写已提交任务的结果卡，并算出续跑的载荷。调用方持有会话租约。 */
export async function recoverInterruptedTurn(
  conversationId: string,
  turnId: string,
): Promise<InterruptedTurnRecovery> {
  const events = await restoreSubmittedJobCards(conversationId, turnId)
  return { events, resume: await resumePayload(conversationId, turnId) }
}
/**
 * 结果卡没写下的那几次调用，照它们留下的东西补一张：提交过任务的补「已提交」，只拟了稿的
 * 按草稿补「等待确认」——草稿已经落库，卡没落就点不开，那份材料会永远卡在库里。
 */
async function restoreSubmittedJobCards(
  conversationId: string,
  turnId: string,
): Promise<AgentToolEndEvent[]> {
  const calls = await listAgentToolCalls(conversationId, turnId)
  if (calls.length === 0) return []
  const stored = new Set(
    (
      await db
        .select({ id: schema.agent_messages.id })
        .from(schema.agent_messages)
        .where(
          and(
            eq(schema.agent_messages.conversation_id, conversationId),
            inArray(
              schema.agent_messages.id,
              calls.map((call) => call.messageId),
            ),
          ),
        )
    ).map((row) => row.id),
  )
  const jobs = await db
    .select({
      taskId: schema.agent_jobs.task_id,
      toolCallId: schema.agent_jobs.tool_call_id,
      review: schema.agent_jobs.wake_on_success,
    })
    .from(schema.agent_jobs)
    .where(
      and(
        eq(schema.agent_jobs.conversation_id, conversationId),
        eq(schema.agent_jobs.turn_id, turnId),
      ),
    )
    .orderBy(asc(schema.agent_jobs.submitted_at))
  const pending = await db
    .select({
      toolCallId: schema.agent_generation_drafts.tool_call_id,
      prompt: schema.agent_generation_drafts.prompt,
      submission: schema.agent_generation_drafts.submission,
    })
    .from(schema.agent_generation_drafts)
    .where(
      and(
        eq(schema.agent_generation_drafts.conversation_id, conversationId),
        eq(schema.agent_generation_drafts.turn_id, turnId),
        isNull(schema.agent_generation_drafts.task_id),
      ),
    )
  const restored: AgentToolEndEvent[] = []
  for (const call of calls) {
    if (stored.has(call.messageId) || !isAgentToolName(call.toolName)) continue
    const start = agentToolStartFromSnapshot(call.toolName, call.toolCallId, call.snapshot)
    const job = jobs.find((one) => one.toolCallId === call.toolCallId)
    const draft = pending.find((one) => one.toolCallId === call.toolCallId)
    // 没提交出任务、也没拟出稿的调用没有东西可交代：它连同那段没说完的回复一起丢掉。
    if (!job && !draft) continue
    const block = job
      ? agentToolSubmittedBlock(start, {
          taskId: job.taskId,
          media: call.toolName === 'generateVideo' ? 'video' : 'image',
          ...(job.review ? { review: true as const } : {}),
        })
      : agentToolDraftedBlock(start, draft!.prompt, draft!.submission.anchorObjectId)
    await appendAgentMessage(db, {
      id: call.messageId,
      conversationId,
      turnId,
      role: 'assistant',
      content: [block],
    })
    const { type: _stored, ...fields } = block
    restored.push({ type: 'toolEnd', messageId: call.messageId, ...fields })
  }
  return restored
}

/** 续跑沿用被打断那一轮的输入：开轮时取走的那条收件箱记录，以及工具起跑时的参数快照。 */
async function resumePayload(
  conversationId: string,
  turnId: string,
): Promise<AgentInboxResumePayload | null> {
  const consumed = await db
    .select({ kind: inbox.kind, payload: inbox.payload })
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.consumed_turn_id, turnId),
        eq(inbox.status, 'consumed'),
      ),
    )
    .orderBy(asc(inbox.seq))
  // 不是从收件箱起的轮认不出它当时的输入；续跑那一轮自己被打断就不再续。
  if (consumed.length === 0 || consumed.some((row) => row.kind === 'system_event')) return null
  // 用户消息那一轮可能顺带并进了排着的唤醒：它是用户的轮，按用户那一句续。
  const started = consumed.find((row) => row.kind !== 'task_result') ?? consumed[0]!
  const [conversation] = await db
    .select({
      deletedAt: schema.agent_conversations.deleted_at,
      deviceId: schema.agent_conversations.device_id,
    })
    .from(schema.agent_conversations)
    .where(eq(schema.agent_conversations.id, conversationId))
  if (!conversation || conversation.deletedAt) return null
  const said = await db
    .select({ content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.turn_id, turnId),
        eq(schema.agent_messages.role, 'assistant'),
      ),
    )
  // 它已经问出了澄清，或者已经拟好一张等确认的稿：都是在等用户，不是没做完。
  if (
    said.some((message) =>
      message.content.some(
        (block) =>
          block.type === 'clarification' ||
          (block.type === 'toolResult' && block.status === 'awaiting_confirmation'),
      ),
    )
  )
    return null
  const payload = started.payload
  // 被打断的是一轮唤醒：续跑接着处理它那一批结果，输入全部沿用那一批（见 `executeResumeTurn`）。
  if ('taskIds' in payload)
    return {
      interruptedTurnId: turnId,
      deviceId: payload.deviceId || conversation.deviceId || '',
      wake: { turnId: payload.turnId, taskIds: [...payload.taskIds] },
    }
  const snapshot = (await listAgentToolCalls(conversationId, turnId))[0]?.snapshot
  const mode = 'text' in payload ? payload.mode : snapshot?.mode
  const params = 'text' in payload ? payload.params : snapshot?.params
  return {
    interruptedTurnId: turnId,
    deviceId: ('deviceId' in payload && payload.deviceId) || conversation.deviceId || '',
    ...(mode ? { mode } : {}),
    ...(params ? { params } : {}),
  }
}

/**
 * 被打断那一轮已经提交成后台任务的调用，按调用内容认：续跑那一轮再发起一模一样的调用时，
 * 工具不再提交，直接交回这个任务（见 `agentTurnTools`）。这是服务端的去重，不靠提示词。
 */
export async function interruptedSubmissions(
  conversationId: string,
  turnId: string,
): Promise<AgentReplayedSubmission[]> {
  const [calls, jobs] = await Promise.all([
    listAgentToolCalls(conversationId, turnId),
    db
      .select({
        taskId: schema.agent_jobs.task_id,
        toolCallId: schema.agent_jobs.tool_call_id,
        review: schema.agent_jobs.wake_on_success,
      })
      .from(schema.agent_jobs)
      .where(
        and(
          eq(schema.agent_jobs.conversation_id, conversationId),
          eq(schema.agent_jobs.turn_id, turnId),
        ),
      )
      .orderBy(asc(schema.agent_jobs.submitted_at)),
  ])
  return jobs.flatMap((job) => {
    const call = calls.find((one) => one.toolCallId === job.toolCallId)
    if (!call || !isAgentToolName(call.toolName)) return []
    return [
      {
        key: agentSubmissionKey(
          call.toolName,
          call.snapshot.mode,
          call.snapshot.args,
          call.snapshot.imageIds,
        ),
        job: {
          taskId: job.taskId,
          media: call.toolName === 'generateVideo' ? ('video' as const) : ('image' as const),
          ...(job.review ? { review: true as const } : {}),
        },
      },
    ]
  })
}

/**
 * 续跑那一轮给模型的系统说明：不落库、不出用户气泡。对话记录里已经有被打断那一轮说完的话与
 * 结果卡，这里只说清「发生了什么、该怎么接」。被打断的是唤醒轮时带上那一轮本来的说明
 * （`wakeNotice`）：接着处理那一批结果，而不是把用户更早的请求再做一遍。
 */
export function resumeTurnPrompt(wakeNotice?: string): string {
  const head =
    '（系统通知，不是用户说的话）上一轮回复被服务重启打断了，没说完的那部分已经丢弃，用户看不到。'
  const tail =
    '对话记录里标着已提交的后台任务仍在进行，不要重复提交；结果出来之前不要说已经生成好。'
  if (wakeNotice)
    return [
      head,
      '被打断的那一轮是在处理后台任务的结果：接着把它们处理完，已经说过的话不要重复；用户更早的请求已经提交过，不要重新做一遍。',
      tail,
      '那一轮本来收到的说明如下：',
      wakeNotice,
    ].join('\n')
  return [
    head,
    '请接着把用户上一轮的请求做完：已经说过的话不要重复，已经完成的步骤不要重做。',
    tail,
  ].join('\n')
}
