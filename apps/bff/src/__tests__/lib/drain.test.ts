import { describe, expect, it } from 'bun:test'
import { DrainState } from '../../lib/drain'

describe('deployment admission', () => {
  it('counts admission before asynchronous startup, keeps old work and rejects new work', () => {
    const drain = new DrainState()
    const done = drain.enter()!
    drain.begin()
    expect(drain.enter()).toBeNull()
    expect(drain.status()).toEqual({ draining: true, active: 1, safeToStop: false, failed: false })
    done()
    done()
    expect(drain.status()).toEqual({ draining: true, active: 0, safeToStop: true, failed: false })
  })

  // A rollout stops a draining instance at its deadline anyway (ADR 0009, 2026-09-18): a failed
  // settlement is reported, and the recovery scan seals the turn once its lease expires.
  it('reports a failed durable finalization without holding the drained instance', () => {
    const drain = new DrainState()
    const done = drain.enter()!
    drain.begin()
    drain.failed()
    done()
    expect(drain.status()).toEqual({ draining: true, active: 0, safeToStop: true, failed: true })
  })
})
