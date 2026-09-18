import type {
  AgentBackgroundJobProgress,
  AgentBackgroundJobView,
  AgentContentBlock,
  AgentMessageView,
  AgentToolResultBlock,
} from '@image-playground/shared'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { cancelTasks } from '../../db/task-transitions'
import { taskProgressPhase } from '../task-progress'
import { type QueueTaskTerminalRow, queueTaskOutcome } from '../taskSubmission'
import { taskFailureCode } from './tools/errors'
import { queueArtifacts } from './tools/queueTask'

/**
 * 后台任务的结局只有一个来源：任务表。结果块在提交时写成 `submitted`，读回会话时对照任务行
 * 就地改写成终局并落库——刷新、换设备、服务重启之后读到的都是同一份，下一轮的模型也照它看到结果。
 * 任务行过了保留期会被清掉，所以终局必须写回消息，不能每次现算。
 */

type PendingJobBlock = AgentToolResultBlock & {
  readonly job: NonNullable<AgentToolResultBlock['job']>
}

function pendingJob(block: AgentContentBlock): block is PendingJobBlock {
  return block.type === 'toolResult' && block.status === 'submitted' && block.job !== undefined
}

/** 对照任务行算出的终局；任务还在跑就是 null。任务行不在即执行记录丢了，结局查不到。 */
export function settledJobBlock(
  block: PendingJobBlock,
  task: QueueTaskTerminalRow | undefined,
): AgentToolResultBlock | null {
  const outcome = task
    ? queueTaskOutcome(task)
    : {
        kind: 'failed' as const,
        reason: '任务丢失了',
        errorType: 'upstream_result_unknown' as const,
      }
  if (!outcome) return null
  const { job } = block
  if (outcome.kind === 'completed') {
    const artifacts = queueArtifacts(job.taskId, job.media, outcome.result).map((artifact) =>
      job.video && artifact.media === 'video' ? { ...artifact, video: job.video } : artifact,
    )
    return { ...block, status: 'succeeded', artifacts }
  }
  return {
    ...block,
    status: 'failed',
    message: outcome.reason,
    errorCode: 'cancelled' in outcome ? 'cancelled' : taskFailureCode(outcome.errorType),
  }
}

/**
 * 把这些消息里已经结束的后台任务结算成终局，落库后返回改写过的消息。调用方负责确权：
 * 消息必须来自已经按归属查出来的会话，任务也只认挂在这个会话下的。
 */
export async function settleAgentJobs(
  conversationId: string,
  messages: readonly AgentMessageView[],
): Promise<AgentMessageView[]> {
  const taskIds = messages.flatMap((message) =>
    message.content.filter(pendingJob).map((block) => block.job.taskId),
  )
  if (taskIds.length === 0) return [...messages]
  const tasks = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: schema.tasks.result_payload,
      error_message: schema.tasks.error_message,
      error_type: schema.tasks.error_type,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.id, [...new Set(taskIds)]),
        eq(schema.tasks.agent_conversation_id, conversationId),
      ),
    )
  const byId = new Map(tasks.map((task) => [task.id, task]))

  const settled: AgentMessageView[] = []
  for (const message of messages) {
    let changed = false
    const content = message.content.map((block) => {
      if (!pendingJob(block)) return block
      const next = settledJobBlock(block, byId.get(block.job.taskId))
      if (!next) return block
      changed = true
      return next
    })
    if (!changed) {
      settled.push(message)
      continue
    }
    // 只在这条消息还是读到时的样子才写：两个读者同时结算，算出来的是同一份，谁先写都一样。
    await db
      .update(schema.agent_messages)
      .set({ content })
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversationId),
          eq(schema.agent_messages.id, message.id),
          // 参数先定成 text 再转：直接写 `::jsonb`，驱动会把这串 JSON 再编码成一个 jsonb 字符串。
          sql`${schema.agent_messages.content} = ${JSON.stringify(message.content)}::text::jsonb`,
        ),
      )
    settled.push({ ...message, content })
  }
  return settled
}

/** 删除会话时一并取消它的后台任务；对话任务不在此列，它跟着轮走。取消按原桶退回。 */
export async function cancelAgentConversationJobs(conversationId: string): Promise<number> {
  const cancelled = await cancelTasks(
    and(eq(schema.tasks.agent_conversation_id, conversationId), ne(schema.tasks.kind, 'chat'))!,
  )
  return cancelled.length
}

/**
 * 这些消息里提交过后台任务的调用，结果块是此刻的样子。还没结束的带上任务表里的进度：
 * 排着队、在生成、在重连还是在确认，什么时候受理的。消息应当已经结算过（{@link settleAgentJobs}）。
 * 重试记录不论有没有提交过都在列：别的设备据此看到排队态，轮到时看到它换成在跑；没提交就结束的
 * （撤回、轮到时被拒）也在列，客户端只从这里得知它的终局。
 */
export async function agentJobViews(
  conversationId: string,
  messages: readonly AgentMessageView[],
): Promise<AgentBackgroundJobView[]> {
  const jobs = messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' && (block.job || block.retryOf)
        ? [{ messageId: message.id, turnId: message.turnId, result: block }]
        : [],
    ),
  )
  const pending = jobs.flatMap((job) =>
    job.result.status === 'submitted' && job.result.job ? [job.result.job.taskId] : [],
  )
  if (pending.length === 0) return jobs
  const tasks = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      submitted_at: schema.tasks.submitted_at,
      archive_payload: schema.tasks.archive_payload,
      upstream_task_ids: schema.tasks.upstream_task_ids,
      lease_expires_at: schema.tasks.lease_expires_at,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.id, [...new Set(pending)]),
        eq(schema.tasks.agent_conversation_id, conversationId),
      ),
    )
  // 阶段按任务表的持久字段算（ADR 0009），不压扁成只看 status：重启或滚动发布后重新排队、
  // 但已有上游任务号的是在重连，执行器租约过期的也是，不能说成「排队」或「生成中」。
  const progress = new Map(
    tasks.flatMap((task): [string, AgentBackgroundJobProgress][] =>
      task.status === 'queued' || task.status === 'in_progress'
        ? [
            [
              task.id,
              {
                stage: task.status === 'in_progress' ? 'running' : 'submitted',
                submittedAt: task.submitted_at,
                phase: taskProgressPhase(task),
              },
            ],
          ]
        : [],
    ),
  )
  return jobs.map((job) => {
    const current =
      job.result.status === 'submitted' && job.result.job
        ? progress.get(job.result.job.taskId)
        : undefined
    return current ? { ...job, progress: current } : job
  })
}

/**
 * 用户单独取消这个会话里的一个后台任务，按原桶退回。只认挂在这个会话下、由工具提交的任务；
 * 已经结束的任务不动。返回是否真的取消了一个任务。
 */
export async function cancelAgentJob(conversationId: string, taskId: string): Promise<boolean> {
  const cancelled = await cancelTasks(
    and(
      eq(schema.tasks.id, taskId),
      eq(schema.tasks.agent_conversation_id, conversationId),
      ne(schema.tasks.kind, 'chat'),
    )!,
  )
  return cancelled.length > 0
}
