import type { AgentActiveTurnView, AgentTurnEvent } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import {
  type AgentPanelEventContext,
  type AgentPanelState,
  dropUnsettledMessages,
  reduceAgentPanelEvent,
} from './panelMessages'
import { type AgentTurnFields, applyTurnSessionEvent, FAILED_TURN_FIELDS } from './turnSession'

export const TURN_FAILED = () => i18next.t('error.turnFailed', { ns: 'agent' })

export function turnFailureText(code?: string): string {
  switch (code) {
    case 'agent_upstream_error':
      return i18next.t('error.upstream', { ns: 'agent' })
    case 'agent_request_budget_exceeded':
      return i18next.t('error.requestBudgetExceeded', { ns: 'agent' })
    case 'agent_context_overflow':
      return i18next.t('error.contextOverflow', { ns: 'agent' })
    case 'agent_tool_failed':
      return i18next.t('error.toolFailed', { ns: 'agent' })
    default:
      return TURN_FAILED()
  }
}

/** 一轮判失败：回到 failed、出横幅，正在流的半截消息收掉。 */
export function failPatch(
  state: Pick<AgentPanelState, 'messages'>,
  message = TURN_FAILED(),
  diagnostic: Record<string, unknown> | null = null,
) {
  return {
    ...FAILED_TURN_FIELDS,
    activeTurn: null,
    error: message,
    errorDiagnostic: diagnostic,
    messages: dropUnsettledMessages(state.messages),
  }
}

/** 轮事件读写的那部分 store 状态。 */
export interface TurnEventState extends AgentPanelState, AgentTurnFields {
  readonly activeTurn: AgentActiveTurnView | null
  readonly toolStartedAt: Readonly<Record<string, number>>
  readonly error: string | null
  readonly errorDiagnostic: Record<string, unknown> | null
}

export interface TurnEventContext extends AgentPanelEventContext {
  readonly conversationId: string
  /** 服务端没给 `startedAt` 的旧记录才用本机时刻；测试注入固定值。 */
  readonly now?: () => number
}

/**
 * 一条轮事件落到面板与轮状态上的变化，纯函数。队列归约（`reduceMessageQueue`）与交付副作用
 * 仍在 store 的 `apply` 里各自进行。
 */
export function reduceTurnEvent(
  state: TurnEventState,
  event: AgentTurnEvent,
  context: TurnEventContext,
): Partial<TurnEventState> {
  const panel = reduceAgentPanelEvent(state, event, context)
  // 已用时间的起点取服务端盖在 toolStart 上的时刻：刷新、换设备重放出来的是同一个数。
  // 旧记录没有它才退回本机看到的时刻，续播重放同一条时不重新计时。
  if (
    event.type === 'toolStart' &&
    (event.startedAt !== undefined || state.toolStartedAt[event.messageId] === undefined)
  )
    return {
      ...panel,
      toolStartedAt: {
        ...state.toolStartedAt,
        [event.messageId]: event.startedAt ?? (context.now ?? Date.now)(),
      },
    }
  if (event.type === 'turnStart') return { ...panel, activeTurn: { turnId: event.turnId } }
  if (event.type !== 'turnEnd') return panel
  // 被打断、已经排上中断续跑的轮不是失败：不出失败横幅，续上的那一轮随后开始（ADR 0006）。
  if (event.stopReason === 'failed' && event.error !== 'agent_turn_interrupted')
    return {
      ...failPatch(state, turnFailureText(event.error), {
        ...event.failure,
        code: event.error ?? 'agent_run_failed',
        conversationId: context.conversationId,
        turnId: event.turnId,
        durationMs: event.durationMs,
      }),
      turns: panel.turns,
    }
  return { ...panel, ...applyTurnSessionEvent(state, 'finish'), activeTurn: null }
}
