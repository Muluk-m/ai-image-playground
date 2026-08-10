import { describe, expect, it } from 'bun:test'
import { type ContainerHealthState, runContainerHealthCheck } from '../../lib/container-health'

function createHarness() {
  let healthy = false
  let now = 100_000
  let state: ContainerHealthState | null = null
  let restarts = 0

  return {
    setHealthy(value: boolean) {
      healthy = value
    },
    advance(ms: number) {
      now += ms
    },
    get state() {
      return state
    },
    get restarts() {
      return restarts
    },
    run() {
      return runContainerHealthCheck({
        failureLimit: 2,
        maxRestarts: 2,
        restartCooldownMs: 60_000,
        now: () => now,
        check: async () => healthy,
        loadState: async () => state,
        saveState: async (next) => {
          state = next
        },
        clearState: async () => {
          state = null
        },
        restart: async () => {
          restarts += 1
        },
      })
    },
  }
}

describe('runContainerHealthCheck', () => {
  it('restarts only after consecutive failures, with cooldown and a hard limit', async () => {
    const harness = createHarness()

    expect(await harness.run()).toBe('failed')
    expect(harness.restarts).toBe(0)
    expect(await harness.run()).toBe('restarted')
    expect(harness.restarts).toBe(1)

    expect(await harness.run()).toBe('failed')
    expect(await harness.run()).toBe('cooldown')
    expect(harness.restarts).toBe(1)

    harness.advance(60_000)
    expect(await harness.run()).toBe('restarted')
    expect(harness.restarts).toBe(2)

    harness.advance(60_000)
    expect(await harness.run()).toBe('failed')
    expect(await harness.run()).toBe('restart_limit_reached')
    expect(harness.restarts).toBe(2)
  })

  it('clears the consecutive failure and restart budget after recovery', async () => {
    const harness = createHarness()
    await harness.run()
    await harness.run()
    expect(harness.state).not.toBeNull()

    harness.setHealthy(true)
    expect(await harness.run()).toBe('healthy')
    expect(harness.state).toBeNull()
  })
})
