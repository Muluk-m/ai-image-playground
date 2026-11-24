import type { Agent, StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { agentModel, agentStreamFn } from '../../../lib/agent/model'
import { AgentRequestBudgetError } from '../../../lib/agent/outbound-budget'
import { agentThinking } from '../../../lib/agent/thinking'
import { createAgentUsageLedger } from '../../../lib/agent/usage-ledger'
import { log } from '../../../lib/logger'
import { agentTurnFailure } from '../contracts'
import type { TurnContextPipeline } from './context-pipeline'
import type { TurnGuards } from './turn-guards'
import type { PreparedAgentTurn, TurnExecutionState, TurnRuntimePorts } from './turn-types'

type SideCallAttempt = Parameters<ReturnType<typeof createAgentUsageLedger>['recordSideCall']>[1]

export function classifyTurnPromptError(
  thrown: unknown,
  modelId: string,
): {
  readonly error: 'agent_request_budget_exceeded' | 'agent_run_failed'
  readonly failure: ReturnType<typeof agentTurnFailure>
} {
  const error =
    thrown instanceof AgentRequestBudgetError
      ? ('agent_request_budget_exceeded' as const)
      : ('agent_run_failed' as const)
  return { error, failure: agentTurnFailure(error, thrown, modelId) }
}

export interface TurnStreamController {
  readonly model: Model<Api>
  readonly thinkingLevel: Agent['state']['thinkingLevel']
  readonly streamFn: StreamFn
  recordSideCall(kind: 'web_search' | 'compaction', attempt: SideCallAttempt): Promise<void>
  recordCompactionAttempt(attempt: SideCallAttempt): Promise<void>
  finishModelCall(message: AssistantMessage): Promise<void>
  waitDispatchAccounting(): Promise<void>
  settlement(): ReturnType<ReturnType<typeof createAgentUsageLedger>['settlement']>
}

/** 解析本轮模型与思考强度，优先沿用起轮准备锁定的运行配置。 */
export function resolveTurnModelAndThinking(prepared: PreparedAgentTurn): {
  readonly model: Model<Api>
  readonly thinkingLevel: Agent['state']['thinkingLevel']
} {
  const model = prepared.selectedRuntime?.model ?? agentModel(prepared.params?.thinkingDepth)
  const thinkingLevel =
    prepared.selectedRuntime?.effort ?? agentThinking(prepared.params?.thinkingDepth).effort
  return { model, thinkingLevel }
}

/**
 * 封装单轮上游流调用、用量账本、直出/已确认改图捷径与视觉证据派发记账。
 */
export function createTurnStreamController(input: {
  readonly prepared: PreparedAgentTurn
  readonly ports: TurnRuntimePorts
  readonly state: TurnExecutionState
  readonly model: Model<Api>
  readonly thinkingLevel: Agent['state']['thinkingLevel']
  readonly getGuards: () => TurnGuards
  readonly getContextPipeline: () => TurnContextPipeline
}): TurnStreamController {
  const { prepared, ports, state, model, thinkingLevel, getGuards, getContextPipeline } = input
  const { conversationId, turnId, execution } = prepared
  const ledger = createAgentUsageLedger({
    conversationId,
    turnId,
    userId: prepared.userId,
    deviceId: prepared.deviceId,
  })
  let modelCallId: string | null = null
  let dispatchAccounting = Promise.resolve()

  const streamFn: StreamFn = async (activeModel, context, options) => {
    await execution.assert()
    const guards = getGuards()
    const contextPipeline = getContextPipeline()
    // 确认范围后的那一轮：第一次调用按提议直接提交，不问模型（见 `confirmed-edit.ts`）。
    // 工具失败时下一次调用照常交给模型，它看得到这次调用和失败原因。
    if (!state.directEditTried) {
      state.directEditTried = true
      // 图片生成模式：原话直接进生图工具，不为「抄一遍原话」付一次对话模型（见 `direct-image.ts`）。
      const direct = ports.directEdit.directImageCall(prepared.input, Boolean(prepared.wake))
      if (direct) {
        log.info(
          { event: 'agent.direct_image', conversationId, turnId },
          'submitting the image-mode prompt without a model call',
        )
        return ports.directEdit.toolCallStream(activeModel, 'generateImage', direct)
      }
      const args = prepared.wake
        ? null
        : await ports.directEdit.confirmedMaskEditCall(
            prepared.input.history.messages,
            prepared.input.references,
            guards.images,
          )
      if (args) {
        log.info(
          { event: 'agent.confirmed_edit_direct', conversationId, turnId },
          'submitting the confirmed mask edit without a model call',
        )
        return ports.directEdit.toolCallStream(activeModel, 'editImage', args)
      }
    }
    contextPipeline.assertWithinBudget(context, (thrown) => {
      state.error ??= 'agent_context_overflow'
      state.failure ??= agentTurnFailure(state.error, thrown, activeModel.id)
    })
    let callId = await ledger.begin('conversation', activeModel.id, context)
    modelCallId = callId
    return agentStreamFn(
      prepared.params?.thinkingDepth,
      {
        onDispatchPending: (pending) => {
          // The fetch path reports rejection; this barrier only waits for its accounting.
          const settled = pending.then(
            () => {},
            () => {},
          )
          dispatchAccounting = dispatchAccounting.then(() => settled)
        },
        onRetry: async (message, nextModelId) => {
          await ledger.finish(callId, message)
          callId = await ledger.begin('conversation', nextModelId, context)
          modelCallId = callId
        },
        onCancelledBeforeDispatch: () => ledger.cancelledBeforeDispatch(callId),
        onDispatch: async (bytes) => {
          const evidence = contextPipeline.visualWorkset.dispatched(context.messages)
          if (evidence.length)
            log.info(
              {
                event: 'agent.visual_input',
                conversationId,
                turnId,
                blocks: evidence.length,
                evidence: evidence.map(
                  ({ source, representation, width, height, bytes, selection }) => ({
                    source,
                    representation,
                    width,
                    height,
                    bytes,
                    selection,
                  }),
                ),
              },
              'agent visual evidence dispatched',
            )
          await ledger.dispatched(callId, bytes)
        },
        onRejected: async (rejection) => {
          state.error = 'agent_request_budget_exceeded'
          state.failure = agentTurnFailure(state.error, rejection, activeModel.id)
          await ledger.rejected(callId, rejection)
        },
      },
      prepared.selectedRuntime,
    )(activeModel, context, options)
  }

  return {
    model,
    thinkingLevel,
    streamFn,
    recordSideCall: (kind, attempt) => ledger.recordSideCall(kind, attempt),
    async recordCompactionAttempt(attempt) {
      if (attempt.localRejection) {
        state.error = 'agent_request_budget_exceeded'
        state.failure = agentTurnFailure(state.error, attempt.localRejection, attempt.model)
      }
      await ledger.recordSideCall('compaction', attempt)
    },
    async finishModelCall(message) {
      if (!modelCallId) return
      const id = modelCallId
      modelCallId = null
      await ledger.finish(id, message)
    },
    waitDispatchAccounting: () => dispatchAccounting,
    settlement: () => ledger.settlement(),
  }
}
