import { describe, expect, it } from 'bun:test'
import { DrainState } from '../../lib/drain'

describe('deployment admission', () => {
  it('counts admission before asynchronous startup, keeps old work and rejects new work', () => {
    const drain = new DrainState()
    const done = drain.enter()!
    drain.begin()
    expect(drain.enter()).toBeNull()
    expect(drain.status()).toEqual({ draining: true, active: 1, safeToStop: false })
    done()
    done()
    expect(drain.status()).toEqual({ draining: true, active: 0, safeToStop: true })
  })

  it('retains a drained instance when durable finalization failed', () => {
    const drain = new DrainState()
    const done = drain.enter()!
    drain.begin()
    drain.failed()
    done()
    expect(drain.status().safeToStop).toBe(false)
  })
})
