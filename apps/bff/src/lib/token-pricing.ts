import type { TaskUsage } from './private-overlay'

/** Immutable token conversion rates shared by conversation and independent analysis tasks. */
export interface TokenPricing {
  readonly cachedInputPriceRatio?: number
  readonly outputPriceRatio: number
  readonly outputReserveTokens: number
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
}

function usageUnits(usage: TokenUsage, pricing: TokenPricing): TaskUsage {
  const cached = usage.cachedInputTokens ?? 0
  return {
    quantity: 1,
    unitMultiplier:
      (usage.inputTokens -
        cached +
        cached * (pricing.cachedInputPriceRatio ?? 0) +
        usage.outputTokens * pricing.outputPriceRatio) /
      1_000,
  }
}

/** Reserve ordinary input and the snapshotted output allowance; cache hits are not guaranteed. */
export function reservedTokenUsage(estimatedInputTokens: number, pricing: TokenPricing): TaskUsage {
  return usageUnits(
    { inputTokens: estimatedInputTokens, outputTokens: pricing.outputReserveTokens },
    pricing,
  )
}

export function settledTokenUsage(usage: TokenUsage, pricing: TokenPricing): TaskUsage
export function settledTokenUsage(
  usage: TokenUsage | null,
  pricing: TokenPricing,
): TaskUsage | undefined
/** Unknown usage is absent; an explicitly reported zero remains an independent zero-use fact. */
export function settledTokenUsage(
  usage: TokenUsage | null,
  pricing: TokenPricing,
): TaskUsage | undefined {
  if (usage === null) return undefined
  return {
    ...usageUnits(usage, pricing),
    tokens: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      ...(usage.cachedInputTokens ? { cachedInput: usage.cachedInputTokens } : {}),
    },
  }
}
