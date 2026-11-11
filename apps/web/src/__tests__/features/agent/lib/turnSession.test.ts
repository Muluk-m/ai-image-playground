import { describe, expect, it } from 'vitest'
import {
  AGENT_TURN_SESSION_EVENTS,
  AGENT_TURN_SESSION_STATES,
  type AgentTurnFields,
  type AgentTurnSessionEvent,
  type AgentTurnSessionState,
  agentTurnSession,
  agentTurnSessionMachine,
  applyTurnSessionEvent,
  encodeTurnSession,
  FAILED_TURN_FIELDS,
  IDLE_TURN_FIELDS,
  sessionFromState,
  sessionStateOf,
} from '../../../../features/agent/lib/turnSession'

const RAW: Record<AgentTurnSessionState, AgentTurnFields> = {
  idle: { turn: 'idle', stopping: false, reconnecting: false },
  failed: { turn: 'failed', stopping: false, reconnecting: false },
  live: { turn: 'running', stopping: false, reconnecting: false },
  live_stopping: { turn: 'running', stopping: true, reconnecting: false },
  reconnecting: { turn: 'running', stopping: false, reconnecting: true },
  reconnecting_stopping: { turn: 'running', stopping: true, reconnecting: true },
}

/** 每一格都是旧写入的语义：开始清空标志，结束/失败归一到合法形状，停与重连只在 running 上叠。 */
const NEXT: Record<AgentTurnSessionState, Record<AgentTurnSessionEvent, AgentTurnSessionState>> = {
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
  live: {
    start: 'live',
    ensureRunning: 'live',
    finish: 'idle',
    fail: 'failed',
    requestStop: 'live_stopping',
    clearStop: 'live',
    reportReconnect: 'reconnecting',
    clearReconnect: 'live',
  },
  live_stopping: {
    start: 'live',
    ensureRunning: 'live_stopping',
    finish: 'idle',
    fail: 'failed',
    requestStop: 'live_stopping',
    clearStop: 'live',
    reportReconnect: 'reconnecting_stopping',
    clearReconnect: 'live_stopping',
  },
  reconnecting: {
    start: 'live',
    ensureRunning: 'reconnecting',
    finish: 'idle',
    fail: 'failed',
    requestStop: 'reconnecting_stopping',
    clearStop: 'reconnecting',
    reportReconnect: 'reconnecting',
    clearReconnect: 'live',
  },
  reconnecting_stopping: {
    start: 'live',
    ensureRunning: 'reconnecting_stopping',
    finish: 'idle',
    fail: 'failed',
    requestStop: 'reconnecting_stopping',
    clearStop: 'reconnecting',
    reportReconnect: 'reconnecting_stopping',
    clearReconnect: 'live_stopping',
  },
}

describe('agentTurnSession', () => {
  it('drops a stale reconnect flag once the turn is idle or failed', () => {
    expect(agentTurnSession({ turn: 'idle', stopping: false, reconnecting: true })).toEqual({
      phase: 'idle',
    })
    expect(agentTurnSession({ turn: 'failed', stopping: true, reconnecting: true })).toEqual({
      phase: 'failed',
    })
  })

  it('keeps reconnect and stop as orthogonal fields while the turn is running', () => {
    expect(agentTurnSession({ turn: 'running', stopping: true, reconnecting: true })).toEqual({
      phase: 'running',
      stream: 'reconnecting',
      stop: 'requested',
    })
    expect(agentTurnSession({ turn: 'running', stopping: false, reconnecting: false })).toEqual({
      phase: 'running',
      stream: 'live',
      stop: 'idle',
    })
  })
})

describe('agentTurnSession encode/decode', () => {
  it('round-trips every legal machine state through the store triple', () => {
    for (const state of AGENT_TURN_SESSION_STATES) {
      const session = sessionFromState(state)
      expect(sessionStateOf(session)).toBe(state)
      expect(encodeTurnSession(session)).toEqual(RAW[state])
      expect(sessionStateOf(agentTurnSession(RAW[state]))).toBe(state)
    }
  })

  it('writes idle and failed without leftover stop or reconnect flags', () => {
    expect(IDLE_TURN_FIELDS).toEqual({ turn: 'idle', stopping: false, reconnecting: false })
    expect(FAILED_TURN_FIELDS).toEqual({ turn: 'failed', stopping: false, reconnecting: false })
    expect(
      applyTurnSessionEvent({ turn: 'idle', stopping: true, reconnecting: true }, 'finish'),
    ).toEqual(IDLE_TURN_FIELDS)
    expect(
      applyTurnSessionEvent({ turn: 'failed', stopping: true, reconnecting: true }, 'fail'),
    ).toEqual(FAILED_TURN_FIELDS)
  })
})

describe('agentTurnSession events', () => {
  it('covers every state × event pair', () => {
    for (const state of AGENT_TURN_SESSION_STATES) {
      for (const event of AGENT_TURN_SESSION_EVENTS) {
        expect(agentTurnSessionMachine.step(state, event), `${state} + ${event}`).toBe(
          NEXT[state][event],
        )
        expect(applyTurnSessionEvent(RAW[state], event), `${state} + ${event} fields`).toEqual(
          RAW[NEXT[state][event]],
        )
      }
    }
  })

  it('start always opens a live running turn, ensureRunning keeps current running flags', () => {
    expect(applyTurnSessionEvent(RAW.reconnecting_stopping, 'start')).toEqual(RAW.live)
    expect(applyTurnSessionEvent(RAW.reconnecting_stopping, 'ensureRunning')).toEqual(
      RAW.reconnecting_stopping,
    )
    expect(applyTurnSessionEvent(RAW.idle, 'ensureRunning')).toEqual(RAW.live)
    expect(applyTurnSessionEvent(RAW.failed, 'start')).toEqual(RAW.live)
  })

  it('does not invent a running session when stop or reconnect fires while idle or failed', () => {
    expect(applyTurnSessionEvent(RAW.idle, 'requestStop')).toEqual(IDLE_TURN_FIELDS)
    expect(applyTurnSessionEvent(RAW.idle, 'reportReconnect')).toEqual(IDLE_TURN_FIELDS)
    expect(applyTurnSessionEvent(RAW.failed, 'requestStop')).toEqual(FAILED_TURN_FIELDS)
    expect(applyTurnSessionEvent(RAW.failed, 'reportReconnect')).toEqual(FAILED_TURN_FIELDS)
  })
})
