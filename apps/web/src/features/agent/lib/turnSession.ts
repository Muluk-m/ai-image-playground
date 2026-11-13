import { defineMachine } from '@image-playground/shared'
import type { AgentTurnStatus } from '../types'

/**
 * 面板上「这一轮在不在跑」的显式视图。
 * store 仍对外暴露 `turn`、`stopping`、`reconnecting`；写入一律经
 * `applyTurnSessionEvent`，idle / failed 上不会再留下重连或停止标志。
 */
export type AgentTurnSession =
  | { readonly phase: 'idle' }
  | { readonly phase: 'failed' }
  | {
      readonly phase: 'running'
      readonly stream: 'live' | 'reconnecting'
      readonly stop: 'idle' | 'requested'
    }

export type AgentTurnFields = {
  readonly turn: AgentTurnStatus
  readonly stopping: boolean
  readonly reconnecting: boolean
}

export const AGENT_TURN_SESSION_STATES = [
  'idle',
  'failed',
  'live',
  'live_stopping',
  'reconnecting',
  'reconnecting_stopping',
] as const

export type AgentTurnSessionState = (typeof AGENT_TURN_SESSION_STATES)[number]

export const AGENT_TURN_SESSION_EVENTS = [
  'start',
  'ensureRunning',
  'finish',
  'fail',
  'requestStop',
  'clearStop',
  'reportReconnect',
  'clearReconnect',
] as const

export type AgentTurnSessionEvent = (typeof AGENT_TURN_SESSION_EVENTS)[number]

function runningTransitions(
  self: 'live' | 'live_stopping' | 'reconnecting' | 'reconnecting_stopping',
) {
  const reconnecting = self === 'reconnecting' || self === 'reconnecting_stopping'
  const stopping = self === 'live_stopping' || self === 'reconnecting_stopping'
  return {
    start: 'live',
    ensureRunning: self,
    finish: 'idle',
    fail: 'failed',
    requestStop: reconnecting ? 'reconnecting_stopping' : 'live_stopping',
    clearStop: reconnecting ? 'reconnecting' : 'live',
    reportReconnect: stopping ? 'reconnecting_stopping' : 'reconnecting',
    clearReconnect: stopping ? 'live_stopping' : 'live',
  } as const
}

export const agentTurnSessionMachine = defineMachine({
  id: 'agent-turn-session',
  states: AGENT_TURN_SESSION_STATES,
  events: AGENT_TURN_SESSION_EVENTS,
  transitions: {
    idle: {
      start: 'live',
      ensureRunning: 'live',
      finish: 'idle',
      fail: 'failed',
      requestStop: 'idle',
      clearStop: 'idle',
      reportReconnect: 'idle',
      clearReconnect: 'idle',
    },
    failed: {
      start: 'live',
      ensureRunning: 'live',
      finish: 'idle',
      fail: 'failed',
      requestStop: 'failed',
      clearStop: 'failed',
      reportReconnect: 'failed',
      clearReconnect: 'failed',
    },
    live: runningTransitions('live'),
    live_stopping: runningTransitions('live_stopping'),
    reconnecting: runningTransitions('reconnecting'),
    reconnecting_stopping: runningTransitions('reconnecting_stopping'),
  },
})

export function agentTurnSession(input: AgentTurnFields): AgentTurnSession {
  if (input.turn === 'idle') return { phase: 'idle' }
  if (input.turn === 'failed') return { phase: 'failed' }
  return {
    phase: 'running',
    stream: input.reconnecting ? 'reconnecting' : 'live',
    stop: input.stopping ? 'requested' : 'idle',
  }
}

export function sessionStateOf(session: AgentTurnSession): AgentTurnSessionState {
  if (session.phase === 'idle') return 'idle'
  if (session.phase === 'failed') return 'failed'
  if (session.stream === 'reconnecting')
    return session.stop === 'requested' ? 'reconnecting_stopping' : 'reconnecting'
  return session.stop === 'requested' ? 'live_stopping' : 'live'
}

export function sessionFromState(state: AgentTurnSessionState): AgentTurnSession {
  if (state === 'idle') return { phase: 'idle' }
  if (state === 'failed') return { phase: 'failed' }
  return {
    phase: 'running',
    stream: state === 'reconnecting' || state === 'reconnecting_stopping' ? 'reconnecting' : 'live',
    stop: state === 'live_stopping' || state === 'reconnecting_stopping' ? 'requested' : 'idle',
  }
}

export const IDLE_TURN_FIELDS: AgentTurnFields = {
  turn: 'idle',
  stopping: false,
  reconnecting: false,
}

export const FAILED_TURN_FIELDS: AgentTurnFields = {
  turn: 'failed',
  stopping: false,
  reconnecting: false,
}

export function encodeTurnSession(session: AgentTurnSession): AgentTurnFields {
  if (session.phase === 'idle') return IDLE_TURN_FIELDS
  if (session.phase === 'failed') return FAILED_TURN_FIELDS
  return {
    turn: 'running',
    stopping: session.stop === 'requested',
    reconnecting: session.stream === 'reconnecting',
  }
}

/** 按事件推进对话轮三元组；idle / failed 写入时清掉残留的停止和重连标志。 */
export function applyTurnSessionEvent(
  fields: AgentTurnFields,
  event: AgentTurnSessionEvent,
): AgentTurnFields {
  const next = agentTurnSessionMachine.step(sessionStateOf(agentTurnSession(fields)), event)
  return encodeTurnSession(sessionFromState(next))
}
