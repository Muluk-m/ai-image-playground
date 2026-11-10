import { describe, expect, it } from 'vitest'
import { agentTurnSession } from '../../../../features/agent/lib/turnSession'

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
