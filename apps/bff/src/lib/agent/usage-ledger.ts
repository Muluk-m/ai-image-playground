import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import type { AgentTurnUsage } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { ChatAttempt } from '../chatCompletion'
import { log } from '../logger'
import { requestInputTokens } from './request-budget'

interface TurnIdentity {
  readonly conversationId: string
  readonly turnId: string
  readonly userId: string | null
  readonly deviceId: string
}

type CallPurpose = typeof schema.agent_model_calls.$inferInsert.purpose

/** 调用事实不保存消息对象：上下文可以被替换，结算只读取这一轮的独立记录。 */
export function createAgentUsageLedger(identity: TurnIdentity) {
  let upstreamInvocationCount = 0
  let knownConversationCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  /**
   * 派发那一刻按我们的口径估的输入，按调用 id 记着。上游报回真实用量时两相对照落一条日志：
   * 预算闸门是启发式的（`request-budget.ts`），不记偏差就永远不知道它偏了多少、偏向哪边。
   */
  const estimates = new Map<string, number>()
  const calls = schema.agent_model_calls
  const scope = and(
    eq(calls.conversation_id, identity.conversationId),
    eq(calls.turn_id, identity.turnId),
  )

  return {
    async begin(purpose: CallPurpose, model: string, context?: Context): Promise<string> {
      const id = crypto.randomUUID()
      const imageCount =
        context?.messages.reduce(
          (count, message) =>
            count +
            (Array.isArray(message.content)
              ? message.content.filter((part) => part.type === 'image').length
              : 0),
          0,
        ) ?? 0
      if (context) estimates.set(id, requestInputTokens(context))
      await db.insert(calls).values({
        id,
        conversation_id: identity.conversationId,
        turn_id: identity.turnId,
        user_id: identity.userId,
        device_id: identity.deviceId,
        purpose,
        model,
        input_image_count: imageCount,
        status: 'in_progress',
        started_at: Date.now(),
      })
      if (purpose === 'conversation') upstreamInvocationCount += 1
      return id
    },

    async finish(id: string, message: AssistantMessage): Promise<void> {
      const reported = message.usage
      // pi 在上游缺 usage 时填零；不能将占位零宣称为已知的免费调用。
      const usage =
        reported.totalTokens ||
        reported.input ||
        reported.output ||
        reported.cacheRead ||
        reported.cacheWrite
          ? {
              inputTokens: reported.input + reported.cacheRead + reported.cacheWrite,
              outputTokens: reported.output,
              ...(reported.cacheRead > 0 ? { cachedInputTokens: reported.cacheRead } : {}),
            }
          : null
      const [completed] = await db
        .update(calls)
        .set({
          status:
            message.stopReason === 'error'
              ? 'failed'
              : message.stopReason === 'aborted'
                ? 'cancelled'
                : 'completed',
          usage,
          cache_read_tokens: usage ? reported.cacheRead : null,
          cache_write_tokens: usage ? reported.cacheWrite : null,
          tool_calls: message.content.flatMap((part) =>
            part.type === 'toolCall' ? [{ id: part.id, name: part.name }] : [],
          ),
          finished_at: Date.now(),
        })
        .where(and(scope, eq(calls.id, id), eq(calls.status, 'in_progress')))
        .returning({ purpose: calls.purpose })
      const estimated = estimates.get(id)
      estimates.delete(id)
      // 估的与上游报的摆在一起，运营才能判断这条启发式偏了多少、要不要调。
      // 上游没报用量时无从对照，那种调用不落这条。
      if (estimated !== undefined && usage) {
        log.info(
          {
            event: 'agent.input_estimate_deviation',
            conversationId: identity.conversationId,
            turnId: identity.turnId,
            model: message.model,
            estimatedInputTokens: estimated,
            reportedInputTokens: usage.inputTokens,
          },
          'agent input estimate compared with the reported usage',
        )
      }
      if (completed?.purpose === 'conversation' && usage) {
        knownConversationCalls += 1
        inputTokens += usage.inputTokens
        outputTokens += usage.outputTokens
        cachedInputTokens += usage.cachedInputTokens ?? 0
      }
    },

    async recordSummary(attempt: ChatAttempt): Promise<void> {
      await db
        .insert(calls)
        .values({
          id: attempt.id,
          conversation_id: identity.conversationId,
          turn_id: identity.turnId,
          user_id: identity.userId,
          device_id: identity.deviceId,
          purpose: 'compaction',
          model: attempt.model,
          status: attempt.status,
          usage: attempt.usage,
          started_at: attempt.startedAt,
          finished_at: attempt.finishedAt,
        })
        .onConflictDoNothing()
    },

    settlement(): { usage: AgentTurnUsage | null; upstreamInvocationCount: number } {
      return {
        upstreamInvocationCount,
        usage:
          knownConversationCalls === upstreamInvocationCount && (inputTokens || outputTokens)
            ? { inputTokens, outputTokens, ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}) }
            : null,
      }
    },
  }
}
