import type { QuotaValues } from '@image-playground/shared'
import { config } from '../../config'
import type { CompactionSettings } from './compaction'

export interface CompactionModelLimits {
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

export function compactionSettingsFrom(
  quotas: QuotaValues,
  model: CompactionModelLimits,
): CompactionSettings {
  return {
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    outputReserveTokens: quotas['agent:compaction-output-reserve-tokens'],
    bufferTokens: quotas['agent:compaction-buffer-tokens'],
    keepRecentMessages: quotas['agent:compaction-keep-messages'],
    maxIncrementalFolds: quotas['agent:compaction-max-folds'],
    failureThreshold: quotas['agent:compaction-failure-threshold'],
    breakerCooldownMs: quotas['agent:compaction-cooldown-minutes'] * 60 * 1000,
  }
}

export function compactionSettings(): CompactionSettings {
  return compactionSettingsFrom(config.operator.quotas, {
    contextWindow: config.agent.contextWindow,
    maxOutputTokens: config.agent.maxTokens,
  })
}
