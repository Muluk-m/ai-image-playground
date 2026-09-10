import type { QuotaValues } from '@image-playground/shared'
import { config } from '../../config'
import type { CompactionSettings } from './compaction'

export function compactionSettings(
  quotas: QuotaValues = config.operator.quotas,
  contextWindow: number = config.agent.contextWindow,
  maxOutputTokens: number = config.agent.maxTokens,
): CompactionSettings {
  return {
    contextWindow,
    maxOutputTokens,
    outputReserveTokens: quotas['agent:compaction-output-reserve-tokens'],
    bufferTokens: quotas['agent:compaction-buffer-tokens'],
    keepRecentMessages: quotas['agent:compaction-keep-messages'],
    verbatimTokens: quotas['agent:compaction-verbatim-tokens'],
    maxIncrementalFolds: quotas['agent:compaction-max-folds'],
    failureThreshold: quotas['agent:compaction-failure-threshold'],
    breakerCooldownMs: quotas['agent:compaction-cooldown-minutes'] * 60 * 1000,
  }
}
