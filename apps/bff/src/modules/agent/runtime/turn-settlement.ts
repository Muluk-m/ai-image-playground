import type { AgentTurnCost, AgentTurnUsage } from '@image-playground/shared'
import { scheduleAgentFollowUps } from '../../../lib/agent/follow-ups'
import {
  GATE_CONTINUATION_EMPTY_REPLY,
  shouldFillEmptyGateContinuation,
} from '../../../lib/agent/gate-continuation-empty'
import { bffDrain } from '../../../lib/drain'
import { log } from '../../../lib/logger'
import { agentTurnFailure, type TurnEventLog } from '../contracts'
import {
  ConversationExecutionLost,
  cancelStoppedTurnJobs,
  touchAgentConversation,
} from '../conversation'
import type { TurnMessageStore } from './turn-store'
import { recordAgentTurnSummary } from './turn-summary'
import type {
  AgentTurnSettlement,
  PreparedAgentTurn,
  TurnExecutionState,
  TurnModelHistorySaveInput,
} from './turn-types'

const settlementDelay = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000)

/** 持久结算重试循环：失去会话租约立即退出，其他暂时故障按指数退避重试直至成功。 */
export async function settleDurably(
  settle: NonNullable<PreparedAgentTurn['settle']>,
  settlement: AgentTurnSettlement,
  assertExecution: () => Promise<void>,
): Promise<AgentTurnCost> {
  for (let attempt = 0; ; attempt++) {
    try {
      await assertExecution()
      return await settle(settlement)
    } catch (thrown) {
      if (thrown instanceof ConversationExecutionLost) throw thrown
      log.error(
        { event: 'agent.turn_settle_retry', attempt: attempt + 1, err: thrown },
        'agent turn settlement will retry',
      )
      await new Promise((resolve) => setTimeout(resolve, settlementDelay(attempt)))
    }
  }
}

/** 单轮主循环结束后的收尾：补齐空续跑兜底、清理中止任务、持久结算、写页脚、发终帧、存模型历史。 */
export async function finalizeAgentTurn(input: {
  readonly prepared: PreparedAgentTurn
  readonly state: TurnExecutionState
  readonly startedAt: number
  readonly modelId: string
  readonly events: TurnEventLog
  readonly store: TurnMessageStore
  readonly waitDispatchAccounting: () => Promise<void>
  readonly settlement: () => {
    readonly usage: AgentTurnUsage | null
    readonly upstreamInvocationCount: number
  }
  readonly saveHistoryAfterTurn: (input: {
    readonly outcome: TurnModelHistorySaveInput['outcome']
    readonly steered: boolean
    readonly storedMessages: TurnModelHistorySaveInput['expectedHistory']
    readonly messages: TurnModelHistorySaveInput['messages']
  }) => Promise<void>
  readonly hasUnconsumedSteering: () => boolean
  readonly getAgentMessages: () => TurnModelHistorySaveInput['messages']
}): Promise<void> {
  const { prepared, state, startedAt, modelId, events, store } = input
  const { conversationId, turnId, settle, execution } = prepared

  state.acceptingInterjections = false
  // SDK abort can finish the stream while dispatch cancellation is still writing.
  await input.waitDispatchAccounting()
  // 已经排队的落库先等定，「这一轮写出过东西没有」才算得准。
  await store.waitWrites()
  // 没收尾的半截回复也算产出，空轮兜底连它一起看：失败与否必须在决定落不落它之前定死，
  // 否则就成了「因为没落所以判失败、因为失败所以不落」。
  const emptyVisible = !state.error && !state.aborted && !store.storedAny() && !store.hasOpenText()
  if (
    shouldFillEmptyGateContinuation({
      continuation: Boolean(prepared.input.continuation),
      error: Boolean(state.error),
      aborted: state.aborted,
      storedAny: store.storedAny(),
      openText: store.hasOpenText(),
    })
  ) {
    const messageId = crypto.randomUUID()
    events.emit({ type: 'assistantStart', messageId })
    events.emit({ type: 'textDelta', messageId, delta: GATE_CONTINUATION_EMPTY_REPLY })
    await store.storeBlock({ type: 'text', text: GATE_CONTINUATION_EMPTY_REPLY }, messageId)
    await store.waitWrites()
  } else if (emptyVisible) {
    state.error = 'agent_run_failed'
  }
  // 失败的轮不留这段没收尾的回复：面板在 turnEnd failed 时把它撤掉，历史要跟着撤，
  // 不然刷新回来它又冒出来。中止不在此列——那段话用户还看得见，照旧落库。
  if (state.error) await store.discardOpen()
  // 中止时 pi 可能走不到 message_end，已经流给用户的半截回复要自己落库。
  await store.closeOpen(!state.aborted)
  store.flushQueued()
  await store.waitWrites()
  // 用户中止：停止接口已经取消过这一轮的出图任务，这里在工具全部落定之后再扫一遍，接住中止那一刻
  // 还在提交路上、之后才落库的任务（BUG-32）。重复取消是空操作。
  if (state.userStopped)
    await cancelStoppedTurnJobs(conversationId, turnId).catch((err) => {
      log.error(
        { event: 'agent.stop_cancel_failed', conversationId, turnId, err },
        'stopped turn could not cancel its late jobs',
      )
    })

  const { usage, upstreamInvocationCount } = input.settlement()
  if (emptyVisible && prepared.input.continuation && !state.error) {
    log.warn(
      {
        event: 'agent.gate_continuation_empty',
        turnId,
        outputTokens: usage?.outputTokens ?? 0,
      },
      'gate continuation produced no visible reply; stored a fallback',
    )
  }
  const outcome: TurnModelHistorySaveInput['outcome'] = state.error
    ? 'failed'
    : state.aborted
      ? 'cancelled'
      : 'completed'
  let cost: AgentTurnCost | undefined
  if (settle) {
    cost = await settleDurably(
      settle,
      { outcome, usage, upstreamInvocationCount },
      execution.assert,
    )
  }
  log.info(
    { event: 'agent.turn_settled', turnId, usage, error: state.error ?? null },
    'agent turn settled',
  )
  const durationMs = Date.now() - startedAt
  const stopReason = outcome === 'cancelled' ? 'aborted' : outcome
  let summaryStored = false
  try {
    // 先落持久事实再发终帧：终帧要过保留窗口就没了，页脚不能只靠它。
    await recordAgentTurnSummary({
      conversationId,
      turnId,
      durationMs,
      stopReason,
      ...(cost ? { cost } : {}),
      ...(state.error
        ? { failure: state.failure ?? agentTurnFailure(state.error, state.error, modelId) }
        : {}),
    })
    summaryStored = true
  } catch (thrown) {
    // 页脚丢一轮不该把已经流给用户的这一轮拖成报错。
    log.error(
      { event: 'agent.turn_summary_failed', turnId, err: thrown },
      'agent turn summary not stored',
    )
  }
  // 下一句是终帧之后的旁路：不进这一轮的账单，也不让用户多等终帧。
  // 失败、中止、澄清、待确认都不问——那些轮下一句该由用户自己接。
  if (
    summaryStored &&
    stopReason === 'completed' &&
    !state.error &&
    !state.aborted &&
    !state.clarified &&
    !state.drafted &&
    !state.confirmationGuarded
  ) {
    scheduleAgentFollowUps({
      conversationId,
      turnId,
      messages: store.storedMessageValues(),
    })
  }
  events.emit({
    type: 'turnEnd',
    turnId,
    durationMs,
    stopReason,
    ...(state.error
      ? {
          error: state.error,
          failure: state.failure ?? agentTurnFailure(state.error, state.error, modelId),
        }
      : {}),
    usage,
    cost,
  })
  state.ended = true
  await touchAgentConversation(conversationId)
  await events.flush()
  if (!state.confirmationGuarded) {
    await input.saveHistoryAfterTurn({
      outcome,
      steered: input.hasUnconsumedSteering(),
      storedMessages: store.storedMessageValues(),
      messages: input.getAgentMessages(),
    })
  }
}

/** 收尾链路异常时的兜底：失去租约交由接手方补写，其他异常补发失败终帧以释放订阅端。 */
export async function handleFinalizationFailure(input: {
  readonly err: unknown
  readonly turnId: string
  readonly startedAt: number
  readonly modelId: string
  readonly state: TurnExecutionState
  readonly events: TurnEventLog
}): Promise<void> {
  const { err, turnId, startedAt, modelId, state, events } = input
  // 租约已经归了别人：这里不能再写，终帧由接手的一方补（见 `sealAbandonedTurns`）。
  if (err instanceof ConversationExecutionLost) return
  bffDrain.failed()
  log.error(
    { event: 'agent.finalization_failed', turnId, err },
    'turn could not be durably finalized; the recovery scan seals it once the lease expires',
  )
  if (state.ended) return
  events.emit({
    type: 'turnEnd',
    turnId,
    durationMs: Date.now() - startedAt,
    stopReason: 'failed',
    error: 'agent_run_failed',
    failure: agentTurnFailure('agent_run_failed', err, modelId),
    usage: null,
  })
  // 落不了库也无妨：连着的消费者已经收到终帧，之后的读取由补写兜底。
  await events.flush().catch(() => {})
}
