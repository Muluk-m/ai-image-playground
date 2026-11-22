import type { AgentTurnEvent } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  failPatch,
  reduceTurnEvent,
  TURN_FAILED,
  type TurnEventState,
} from '../../../../features/agent/lib/turnEvents'
import { FAILED_TURN_FIELDS, IDLE_TURN_FIELDS } from '../../../../features/agent/lib/turnSession'
import type { AgentPanelMessage } from '../../../../features/agent/types'

const TURN = 'turn-1'
const context = { turnId: TURN, pendingUserText: null, conversationId: 'conv-1', now: () => 42 }

const running: TurnEventState = {
  messages: [],
  turns: {},
  turn: 'running',
  stopping: false,
  reconnecting: false,
  activeTurn: null,
  toolStartedAt: {},
  error: null,
  errorDiagnostic: null,
}

const toolStart = (startedAt?: number): AgentTurnEvent => ({
  type: 'toolStart',
  messageId: 'tool-1',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  title: '海报',
  ...(startedAt === undefined ? {} : { startedAt }),
})

const turnEnd = (
  patch: Partial<Extract<AgentTurnEvent, { type: 'turnEnd' }>> = {},
): AgentTurnEvent => ({
  type: 'turnEnd',
  turnId: TURN,
  durationMs: 1200,
  stopReason: 'completed',
  usage: null,
  ...patch,
})

describe('reduceTurnEvent', () => {
  it('marks the turn active on turnStart', () => {
    const next = reduceTurnEvent(
      running,
      { type: 'turnStart', turnId: TURN, userMessageId: 'u-1' },
      context,
    )
    expect(next.activeTurn).toEqual({ turnId: TURN })
  })

  it('keeps the server start time of a tool, and the first local time for old records', () => {
    expect(reduceTurnEvent(running, toolStart(7), context).toolStartedAt).toEqual({ 'tool-1': 7 })
    expect(reduceTurnEvent(running, toolStart(), context).toolStartedAt).toEqual({ 'tool-1': 42 })
    // 续播重放同一条没有时刻的 toolStart：不重新计时。
    const replayed = reduceTurnEvent(
      { ...running, toolStartedAt: { 'tool-1': 5 } },
      toolStart(),
      context,
    )
    expect(replayed.toolStartedAt ?? { 'tool-1': 5 }).toEqual({ 'tool-1': 5 })
  })

  it('returns to idle when the turn completes', () => {
    const next = reduceTurnEvent({ ...running, activeTurn: { turnId: TURN } }, turnEnd(), context)
    expect(next).toMatchObject({ ...IDLE_TURN_FIELDS, activeTurn: null })
    expect(next.error).toBeUndefined()
  })

  it('fails the turn with a diagnostic and drops half-streamed messages', () => {
    const streaming: AgentPanelMessage = {
      kind: 'text',
      id: 'assistant-1',
      turnId: TURN,
      role: 'assistant',
      text: '我先',
      streaming: true,
    }
    const next = reduceTurnEvent(
      { ...running, messages: [streaming], activeTurn: { turnId: TURN } },
      turnEnd({ stopReason: 'failed', error: 'agent_upstream_error' }),
      context,
    )
    expect(next).toMatchObject({ ...FAILED_TURN_FIELDS, activeTurn: null, messages: [] })
    expect(next.error).toEqual(expect.any(String))
    expect(next.error).not.toBe(TURN_FAILED())
    expect(next.errorDiagnostic).toEqual({
      code: 'agent_upstream_error',
      conversationId: 'conv-1',
      turnId: TURN,
      durationMs: 1200,
    })
    expect(next.turns?.[TURN]).toBeDefined()
  })

  it('does not treat an interrupted turn as a failure', () => {
    const next = reduceTurnEvent(
      running,
      turnEnd({ stopReason: 'failed', error: 'agent_turn_interrupted' }),
      context,
    )
    expect(next).toMatchObject({ ...IDLE_TURN_FIELDS, activeTurn: null })
    expect(next.error).toBeUndefined()
  })
})

describe('failPatch', () => {
  it('defaults to the generic message without a diagnostic', () => {
    expect(failPatch({ messages: [] })).toEqual({
      ...FAILED_TURN_FIELDS,
      activeTurn: null,
      error: TURN_FAILED(),
      errorDiagnostic: null,
      messages: [],
    })
  })
})
