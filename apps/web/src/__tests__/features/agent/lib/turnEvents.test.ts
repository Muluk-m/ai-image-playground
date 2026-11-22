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
import { i18next } from '../../../../i18n'

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
    const started = { 'tool-1': 5 }
    const replayed = reduceTurnEvent({ ...running, toolStartedAt: started }, toolStart(), context)
    // 原样带回同一个对象，不换引用（换引用会触发无意义的重渲染）。
    expect(replayed.toolStartedAt).toBe(started)
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
    expect(next.error).toBe(i18next.t('error.upstream', { ns: 'agent' }))
    expect(next.error).not.toBe(TURN_FAILED())
    expect(next.errorDiagnostic).toEqual({
      code: 'agent_upstream_error',
      conversationId: 'conv-1',
      turnId: TURN,
      durationMs: 1200,
    })
    expect(next.turns?.[TURN]).toBeDefined()
  })

  it('lets explicit diagnostic fields win over the server failure, and defaults the code', () => {
    const next = reduceTurnEvent(
      running,
      turnEnd({
        stopReason: 'failed',
        failure: { code: 'upstream_raw', turnId: 'other', detail: 'quota' } as never,
      }),
      context,
    )
    expect(next.error).toBe(TURN_FAILED())
    expect(next.errorDiagnostic).toEqual({
      detail: 'quota',
      code: 'agent_run_failed',
      conversationId: 'conv-1',
      turnId: TURN,
      durationMs: 1200,
    })
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
