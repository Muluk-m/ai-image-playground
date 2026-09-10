import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.DATABASE_URL = 'postgres://unused/compaction-settings'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { loadOperatorConfig } = await import('../../../lib/operator-config')
const { compactionSettingsFrom } = await import('../../../lib/agent/compaction-settings')

const MODEL = { contextWindow: 128_000, maxOutputTokens: 8_000 }

describe('compactionSettingsFrom', () => {
  it('falls back to the shipped defaults', () => {
    const { quotas } = loadOperatorConfig(null)
    expect(compactionSettingsFrom(quotas, MODEL)).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      outputReserveTokens: 20_000,
      bufferTokens: 13_000,
      keepRecentMessages: 10,
      maxIncrementalFolds: 5,
      failureThreshold: 3,
      breakerCooldownMs: 6 * 60 * 60 * 1000,
    })
  })

  it('takes every threshold from the operator config', () => {
    const { quotas } = loadOperatorConfig(
      resolve(import.meta.dir, '../../agent-compaction-operator-config.json'),
    )
    expect(compactionSettingsFrom(quotas, MODEL)).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      outputReserveTokens: 4_000,
      bufferTokens: 1_000,
      keepRecentMessages: 4,
      maxIncrementalFolds: 2,
      failureThreshold: 1,
      breakerCooldownMs: 30 * 60 * 1000,
    })
  })
})
