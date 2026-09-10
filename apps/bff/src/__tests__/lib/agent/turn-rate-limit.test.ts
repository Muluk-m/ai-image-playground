import { describe, expect, it } from 'bun:test'
import type { QuotaValues } from '@image-playground/shared'

process.env.DATABASE_URL = 'postgres://unused/turn-rate-limit'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { loadOperatorConfig } = await import('../../../lib/operator-config')
const { createAgentTurnRateLimiter } = await import('../../../lib/agent/turn-rate-limit')

function quotas(overrides: Partial<QuotaValues>): QuotaValues {
  return { ...loadOperatorConfig(null).quotas, ...overrides }
}

describe('createAgentTurnRateLimiter', () => {
  it('stops a device once it runs out of turns for the minute', () => {
    const limited = createAgentTurnRateLimiter(
      quotas({ 'agent:turns-per-device-minute': 2, 'agent:turns-per-ip-hour': 0 }),
    )

    expect(limited('device-a', '10.0.0.1')).toBe(false)
    expect(limited('device-a', '10.0.0.1')).toBe(false)
    expect(limited('device-a', '10.0.0.1')).toBe(true)
    // 另一台设备有它自己的额度。
    expect(limited('device-b', '10.0.0.1')).toBe(false)
  })

  it('stops an address even when every turn claims a fresh device', () => {
    const limited = createAgentTurnRateLimiter(
      quotas({ 'agent:turns-per-device-minute': 0, 'agent:turns-per-ip-hour': 2 }),
    )

    expect(limited('device-1', '10.0.0.2')).toBe(false)
    expect(limited('device-2', '10.0.0.2')).toBe(false)
    expect(limited('device-3', '10.0.0.2')).toBe(true)
    expect(limited('device-4', '10.0.0.3')).toBe(false)
  })

  it('lets everything through when both thresholds are zero', () => {
    const limited = createAgentTurnRateLimiter(
      quotas({ 'agent:turns-per-device-minute': 0, 'agent:turns-per-ip-hour': 0 }),
    )

    for (let index = 0; index < 50; index++) {
      expect(limited('device-a', '10.0.0.1')).toBe(false)
    }
  })

  it('does not spend the address budget on a turn the device limit already stopped', () => {
    const limited = createAgentTurnRateLimiter(
      quotas({ 'agent:turns-per-device-minute': 1, 'agent:turns-per-ip-hour': 2 }),
    )

    expect(limited('device-a', '10.0.0.4')).toBe(false)
    expect(limited('device-a', '10.0.0.4')).toBe(true)
    expect(limited('device-b', '10.0.0.4')).toBe(false)
  })
})
