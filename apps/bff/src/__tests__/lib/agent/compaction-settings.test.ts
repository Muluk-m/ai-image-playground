import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.DATABASE_URL = 'postgres://unused/compaction-settings'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.AGENT_CHAT_MODEL = 'gpt-6-luna'

const { loadOperatorConfig } = await import('../../../lib/operator-config')
const { compactionSettings } = await import('../../../lib/agent/compaction-settings')
const { agentModel } = await import('../../../lib/agent/model')

describe('compactionSettings', () => {
  it('uses the selected model window for each thinking depth', () => {
    const { quotas } = loadOperatorConfig(null)
    expect(compactionSettings(agentModel('fast'), quotas).contextWindow).toBe(1_050_000)
    expect(compactionSettings(agentModel('medium'), quotas).contextWindow).toBe(1_050_000)
    expect(compactionSettings(agentModel('deep'), quotas).contextWindow).toBe(1_000_000)
    expect(compactionSettings(agentModel(), quotas).contextWindow).toBe(1_050_000)
  })

  it('falls back to the shipped defaults', () => {
    const { quotas } = loadOperatorConfig(null)
    expect(compactionSettings({ contextWindow: 128_000, maxTokens: 8_000 }, quotas)).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      outputReserveTokens: 20_000,
      bufferTokens: 13_000,
      keepRecentTokens: 20_000,
      verbatimTokens: 20_000,
      failureThreshold: 3,
      breakerCooldownMs: 6 * 60 * 60 * 1000,
    })
  })

  it('takes every threshold from the operator config', () => {
    const { quotas } = loadOperatorConfig(
      resolve(import.meta.dir, '../../agent-compaction-operator-config.json'),
    )
    expect(compactionSettings({ contextWindow: 128_000, maxTokens: 8_000 }, quotas)).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      outputReserveTokens: 4_000,
      bufferTokens: 1_000,
      keepRecentTokens: 400,
      verbatimTokens: 300,
      failureThreshold: 1,
      breakerCooldownMs: 30 * 60 * 1000,
    })
  })
})
