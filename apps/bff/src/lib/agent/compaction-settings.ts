import type { Model } from '@earendil-works/pi-ai'
import type { QuotaValues } from '@image-playground/shared'
import { config } from '../../config'
import type { CompactionSettings } from './compaction'

export function compactionSettings(
  model: Pick<Model<'openai-completions'>, 'contextWindow' | 'maxTokens'>,
  quotas: QuotaValues = config.operator.quotas,
): CompactionSettings {
  return {
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    outputReserveTokens: quotas['agent:compaction-output-reserve-tokens'],
    bufferTokens: quotas['agent:compaction-buffer-tokens'],
    keepRecentTokens: quotas['agent:compaction-keep-tokens'],
    verbatimTokens: quotas['agent:compaction-verbatim-tokens'],
    failureThreshold: quotas['agent:compaction-failure-threshold'],
    breakerCooldownMs: quotas['agent:compaction-cooldown-minutes'] * 60 * 1000,
  }
}
