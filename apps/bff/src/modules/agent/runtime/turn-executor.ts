import { Agent } from '@earendil-works/pi-agent-core'
import { log } from '../../../lib/logger'
import {
  createTurnContextPipeline,
  createVisualWorkset,
  type TurnContextPipeline,
} from './context-pipeline'
import { openTurnEventLog, type RunningTurn, registerRunningTurn } from './stream-broker'
import { attachTurnEventHandler } from './turn-events'
import { createTurnGuards, type TurnGuards } from './turn-guards'
import { createTurnInterjectionController } from './turn-interjection'
import { finalizeAgentTurn, handleFinalizationFailure } from './turn-settlement'
import { createTurnMessageStore } from './turn-store'
import {
  classifyTurnPromptError,
  createTurnStreamController,
  resolveTurnModelAndThinking,
} from './turn-stream'
import type { PreparedAgentTurn, TurnExecutionState, TurnRuntimePorts } from './turn-types'

/** 起一轮并立刻返回把手；`read()` 可以被断开再重开。 */
export async function executeAgentTurn(
  prepared: PreparedAgentTurn,
  ports: TurnRuntimePorts,
): Promise<RunningTurn> {
  const { conversationId, turnId, userMessageId, execution, input } = prepared
  const startedAt = Date.now()
  const events = await openTurnEventLog(conversationId, turnId)
  const store = createTurnMessageStore(prepared, events)
  const visualWorkset = createVisualWorkset()

  const state: TurnExecutionState = {
    clarified: false,
    confirmationGuarded: false,
    directEditTried: false,
    directEditSubmitted: false,
    combinationClarified: false,
    drafted: false,
    failure: undefined,
    error: undefined,
    aborted: false,
    userStopped: false,
    lengthContinuations: 0,
    ignoringTruncatedTools: false,
    savedPlanItems: 0,
    ended: false,
    acceptingInterjections: true,
    maskProposalRetried: false,
  }

  const { model, thinkingLevel } = resolveTurnModelAndThinking(prepared)
  let guards!: TurnGuards
  let contextPipeline!: TurnContextPipeline

  const stream = createTurnStreamController({
    prepared,
    ports,
    state,
    model,
    thinkingLevel,
    getGuards: () => guards,
    getContextPipeline: () => contextPipeline,
  })

  guards = createTurnGuards({
    prepared,
    ports,
    visualWorkset,
    recordWebSearch: (attempt) => stream.recordSideCall('web_search', attempt),
  })

  contextPipeline = createTurnContextPipeline({
    prepared,
    ports,
    model,
    turnTools: guards.turnTools,
    visualWorkset,
    onSummaryAttempt: (attempt) => stream.recordCompactionAttempt(attempt),
  })

  const agent = new Agent({
    initialState: {
      ...contextPipeline.initialState,
      model: stream.model,
      thinkingLevel: stream.thinkingLevel,
      tools: guards.turnTools,
    },
    streamFn: stream.streamFn,
    // 一次工具边界把已排队的插话按顺序交给模型，避免每句再触发一次模型请求。
    steeringMode: 'all',
    // 逐个跑：每次调用都是一条计费任务，并发起来事件次序也对不上产出落画布的顺序。
    toolExecution: 'sequential',
    // 确认门在这里认出要拦的生成调用；拦下的那次在花钱那一步停住，卡片停在待确认（`drafted`）。
    beforeToolCall: (context) => guards.gate.beforeToolCall(context),
    // 澄清、拟稿（包括确认门拦下）、按确认范围直接提交或用户中止后，不再回上游追加一次模型调用。
    shouldStopAfterTurn: () =>
      state.clarified ||
      state.drafted ||
      state.directEditSubmitted ||
      state.aborted ||
      !!state.error,
    transformContext: (messages) => contextPipeline.transformContext(messages),
  })

  const interjections = createTurnInterjectionController({
    prepared,
    ports,
    state,
    images: guards.images,
    store,
    events,
    agent,
  })

  attachTurnEventHandler({
    prepared,
    ports,
    state,
    agent,
    events,
    store,
    guards,
    stream,
    interjections,
  })

  events.emit({
    type: 'turnStart',
    turnId,
    userMessageId,
    reservedCredits: prepared.reservedCredits,
    ...(prepared.wake ? { wake: true as const } : {}),
  })
  if (prepared.queueId)
    events.emit({ type: 'queuedMessageConsumed', queueId: prepared.queueId, turnId })

  let resolveCompleted!: () => void
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const turn: RunningTurn = {
    completed,
    conversationId,
    turnId,
    mode: input.mode,
    read: (afterSeq) => events.read(afterSeq),
    interject: (text, references, options) => interjections.interject(text, references, options),
    abort(reason?: 'user_stop') {
      state.aborted = true
      if (reason === 'user_stop') state.userStopped = true
      agent.abort()
    },
  }
  const unregister = registerRunningTurn(turn)

  // 未完成澄清链仍是同一请求；实发与预扣共享附图范围及张数限制。
  void Promise.resolve()
    .then(async () => {
      if (state.aborted) return
      if (prepared.confirmationGuard) {
        state.confirmationGuarded = true
        const messageId = crypto.randomUUID()
        const text = prepared.confirmationGuard.reply
        log.info(
          {
            event: 'agent.short_confirmation_guarded',
            conversationId,
            turnId,
            reason: prepared.confirmationGuard.reason,
          },
          'short confirmation intercepted without calling the model',
        )
        events.emit({ type: 'assistantStart', messageId })
        events.emit({ type: 'textDelta', messageId, delta: text })
        await store.storeBlock({ type: 'text', text }, messageId)
        return
      }
      const sent = await contextPipeline.prepareInitialPrompt(guards.images)
      if (state.aborted) return
      await execution.assert()
      // 中止可能落在上面这次确认租约的等待里：那时 pi 还没开跑，`agent.abort()` 无处可去。
      // 不在开跑前同步再看一眼，这一轮会照常请求上游并跑完。
      if (state.aborted) return
      // 确认门续跑：历史末尾已经接上那几次调用与回执（见 `turn-input.ts`），不加任何新话，
      // 从工具结果接着往下走——对智能体来说这就是同一轮。
      if (input.continuation) return agent.continue()
      return agent.prompt(sent.text, sent.content)
    })
    .catch((thrown) => {
      if (state.aborted || state.error) return
      log.warn({ event: 'agent.turn_failed', err: thrown }, 'agent turn failed')
      const classified = classifyTurnPromptError(thrown, stream.model.id)
      state.error = classified.error
      state.failure = classified.failure
    })
    .then(() =>
      finalizeAgentTurn({
        prepared,
        state,
        startedAt,
        modelId: stream.model.id,
        events,
        store,
        waitDispatchAccounting: () => stream.waitDispatchAccounting(),
        settlement: () => stream.settlement(),
        saveHistoryAfterTurn: (saveInput) => contextPipeline.saveHistoryAfterTurn(saveInput),
        steered: interjections.hasUnconsumedSteering(),
        getAgentMessages: () => agent.state.messages,
      }),
    )
    .catch((err) =>
      handleFinalizationFailure({
        err,
        turnId,
        startedAt,
        modelId: stream.model.id,
        state,
        events,
      }),
    )
    .finally(() => {
      unregister()
      events.close()
      resolveCompleted()
    })

  return turn
}
