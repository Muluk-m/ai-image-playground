import type { Agent } from '@earendil-works/pi-agent-core'
import { AGENT_CLARIFICATION_TOOL, clarificationFromResult } from '../../../lib/agent/clarification'
import {
  AGENT_LENGTH_CONTINUE_NOTE,
  agentLengthFailureText,
} from '../../../lib/agent/length-continuation'
import { log } from '../../../lib/logger'
import { agentToolStage, agentTurnFailure, type TurnEventLog, toolErrorText } from '../contracts'
import type { TurnGuards } from './turn-guards'
import type { TurnInterjectionController } from './turn-interjection'
import type { TurnMessageStore } from './turn-store'
import type { TurnStreamController } from './turn-stream'
import type {
  OpenToolCall,
  PreparedAgentTurn,
  TurnExecutionState,
  TurnRuntimePorts,
} from './turn-types'

/**
 * 订阅 Pi `Agent` 事件流并驱动消息气泡、工具卡、长度续写、澄清与遮罩提案处理。
 */
export function attachTurnEventHandler(input: {
  readonly prepared: PreparedAgentTurn
  readonly ports: TurnRuntimePorts
  readonly state: TurnExecutionState
  readonly agent: Agent
  readonly events: TurnEventLog
  readonly store: TurnMessageStore
  readonly guards: TurnGuards
  readonly stream: TurnStreamController
  readonly interjections: TurnInterjectionController
}): void {
  const { prepared, ports, state, agent, events, store, guards, stream, interjections } = input
  const { conversationId, turnId } = prepared
  const { mode } = prepared.input

  /** 一次工具调用独占一条助手消息，两次调用的结果卡因此不会互相覆盖。 */
  const openTools = new Map<string, OpenToolCall>()

  // 范围确认失败：记一条日志，给用户一句话并收尾。暂不可用、分割出错这类失败，模型再试
  // 一次也只会拿到同样的结果，或者改去整图编辑、叫用户手画，都不是用户要的。
  // 参数写错（外接框越界、实例没标 selected）例外：交回模型改参数重试一次，再错才收尾。
  const maskProposalFailed = async (reason: string) => {
    log.warn(
      {
        event: 'agent.tool_failed',
        conversationId,
        turnId,
        tool: ports.maskProposal.AGENT_MASK_PROPOSAL_TOOL,
        reason,
      },
      'mask proposal tool failed',
    )
    const messageId = crypto.randomUUID()
    const text = ports.maskProposal.maskProposalFailedText(reason)
    events.emit({ type: 'assistantStart', messageId })
    events.emit({ type: 'textDelta', messageId, delta: text })
    await store.storeBlock({ type: 'text', text }, messageId)
    state.clarified = true
  }

  agent.subscribe(async (event) => {
    if (event.type === 'message_start' && event.message.role === 'user') {
      const content = event.message.content
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('')
      const steering = interjections.consumeSteeringReference(text)
      if (steering) {
        guards.maskedEditPlan.interjected()
        guards.images.attach(steering.references)
        guards.imageCombinations.interjected(steering.references)
        state.combinationClarified = false
        if (guards.images.masked) guards.maskedEditPlan.protect()
        guards.authorization.amend(steering.text, steering.active, steering.references.length > 0)
      }
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      state.ignoringTruncatedTools = false
      store.openAssistant()
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (
        (update.type === 'text_delta' ||
          update.type === 'thinking_delta' ||
          update.type === 'toolcall_delta') &&
        update.delta.length > 0
      ) {
        stream.markFirstToken()
      }
      if (update.type === 'text_delta') {
        store.pushTextDelta(update.delta)
      }
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      // 在读取任何生成结果之前冻结整批方案；未提交过任务时允许修正参数错误。
      guards.maskedEditPlan.capture(
        event.message.content.flatMap((block) => (block.type === 'toolCall' ? [block] : [])),
      )
      await stream.finishModelCall(event.message)
      // pi 不为上游失败抛异常，它把失败写进助手消息的停因。工具失败时的中止也走这里，
      // 那时 error 已经写好，别让它把更准的那个原因盖掉。
      // 长度截断先续写一次：没有工具调用时自己补一条续写说明；有工具调用时 pi 会带着
      // 「参数可能被截断」的工具结果再问一次。第二次仍截断才判失败，已写出的文字留下。
      const truncated = event.message.stopReason === 'length'
      if (truncated && !state.aborted && state.lengthContinuations < 1 && !state.error) {
        state.lengthContinuations += 1
        state.ignoringTruncatedTools = true
        await store.closeOpen(!state.aborted)
        if (!event.message.content.some((block) => block.type === 'toolCall')) {
          agent.followUp({
            role: 'user',
            content: [{ type: 'text', text: AGENT_LENGTH_CONTINUE_NOTE }],
            timestamp: Date.now(),
          })
        }
      } else if ((event.message.stopReason === 'error' || truncated) && !state.aborted) {
        if (truncated) state.ignoringTruncatedTools = true
        state.error ??= 'agent_upstream_error'
        state.failure ??= agentTurnFailure(
          state.error,
          truncated ? agentLengthFailureText(state.savedPlanItems) : event.message.errorMessage,
          stream.model.id,
        )
        const local =
          state.error === 'agent_request_budget_exceeded' ||
          state.error === 'agent_context_overflow'
        log.warn(
          {
            event: local ? 'agent.request_rejected' : 'agent.upstream_failed',
            conversationId,
            turnId,
            failure: state.failure,
          },
          local ? 'agent request was rejected locally' : 'agent upstream call failed',
        )
        if (truncated) await store.closeOpen(!state.aborted)
        else await store.discardOpen()
      } else await store.closeOpen(!state.aborted)
      store.clearOpenRef()
      store.flushQueued()
    }
    // Pi 为截断后跳过的工具也发 start/end；失败响应不能据此生成已执行的工具卡。
    if (
      event.type === 'tool_execution_start' &&
      !state.error &&
      !state.ignoringTruncatedTools &&
      ports.tools.isAgentToolName(event.toolName)
    ) {
      const messageId = crypto.randomUUID()
      const start = ports.tools.agentToolStart(
        mode,
        event.toolName,
        event.toolCallId,
        event.args,
        guards.images,
        prepared.params,
      )
      openTools.set(event.toolCallId, { messageId, start })
      events.emit({ type: 'toolStart', messageId, ...start, startedAt: Date.now() })
      // 起跑就落库：结果卡要等工具跑完，轮在半截丢了也还找得回当时的参数。
      const { snapshot } = start
      if (snapshot)
        await store.recordToolCall(messageId, event.toolCallId, event.toolName, snapshot)
    }
    if (event.type === 'tool_execution_update') {
      const pending = openTools.get(event.toolCallId)
      const stage = agentToolStage(event.partialResult)
      if (pending && stage) {
        events.emit({
          type: 'toolProgress',
          messageId: pending.messageId,
          toolCallId: event.toolCallId,
          stage,
        })
      }
    }
    // 澄清不出工具卡，所以它不在工具注册表里，`openTools` 也没有它的登记。
    if (
      event.type === 'tool_execution_end' &&
      (event.toolName === AGENT_CLARIFICATION_TOOL ||
        event.toolName === ports.maskProposal.AGENT_MASK_PROPOSAL_TOOL)
    ) {
      const block = event.isError
        ? null
        : event.toolName === ports.maskProposal.AGENT_MASK_PROPOSAL_TOOL
          ? ports.maskProposal.maskProposalFromResult(event.result)
          : clarificationFromResult(event.result)
      if (!block) {
        // 提醒类的退回（整图要求、已有选区）照常交回模型，让它改调 editImage；其余才收尾。
        if (
          event.isError &&
          event.toolName === ports.maskProposal.AGENT_MASK_PROPOSAL_TOOL &&
          !state.aborted
        ) {
          const reason = toolErrorText(event.result)
          if (ports.maskProposal.maskProposalGuidance(reason)) return
          if (!state.maskProposalRetried && ports.maskProposal.maskProposalRetryable(reason)) {
            state.maskProposalRetried = true
            log.info(
              {
                event: 'agent.tool_retry',
                conversationId,
                turnId,
                tool: ports.maskProposal.AGENT_MASK_PROPOSAL_TOOL,
                reason,
              },
              'mask proposal params rejected, model may retry once',
            )
            return
          }
          await maskProposalFailed(reason)
        }
        return
      }
      const messageId = crypto.randomUUID()
      events.emit({ ...block, messageId })
      await store.storeBlock(block, messageId)
      state.clarified = true
      return
    }
    if (event.type === 'tool_execution_end') {
      const pending = openTools.get(event.toolCallId)
      if (!pending) return
      if (event.toolName === 'planImageBatch' && !event.isError) {
        const items = pending.start.snapshot?.args.items
        if (Array.isArray(items)) state.savedPlanItems += items.length
      }
      openTools.delete(event.toolCallId)
      const toolFailure = event.isError
        ? guards.toolFailures.take(event.toolCallId, state.aborted)
        : null
      const { block, abortsTurn } = ports.tools.agentToolEnd(
        pending.start,
        event.result,
        toolFailure,
      )
      const { type: _stored, ...fields } = block
      events.emit({ type: 'toolEnd', messageId: pending.messageId, ...fields })
      await store.storeBlock(block, pending.messageId)
      if (block.status === 'awaiting_confirmation') state.drafted = true
      if (
        !event.isError &&
        event.toolCallId.startsWith(ports.directEdit.CONFIRMED_EDIT_CALL_PREFIX)
      )
        state.directEditSubmitted = true
      const combinationQuestion = event.isError ? null : clarificationFromResult(event.result)
      if (combinationQuestion && !state.combinationClarified) {
        const messageId = crypto.randomUUID()
        events.emit({ ...combinationQuestion, messageId })
        await store.storeBlock(combinationQuestion, messageId)
        state.clarified = true
        state.combinationClarified = true
      }
      if (!state.aborted && abortsTurn) {
        state.error = 'agent_tool_failed'
        state.failure = agentTurnFailure(state.error, block.message, stream.model.id)
        agent.abort()
      }
    }
  })
}
