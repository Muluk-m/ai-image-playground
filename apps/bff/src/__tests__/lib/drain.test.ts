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

  it('keeps a failed durable finalization from authorizing retirement', () => {
    const drain = new DrainState()
    const done = drain.enter()!
    drain.begin()
    drain.failed()
    done()
    expect(drain.status()).toEqual({ draining: true, active: 0, safeToStop: false, failed: true })
  })
})
