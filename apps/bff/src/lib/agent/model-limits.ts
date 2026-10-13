import models from './models.config.json'

interface ModelLimits {
  contextWindow: number
  maxTokens: number
}

for (const [model, limits] of Object.entries(models)) {
  if (
    !model.trim() ||
    Object.keys(limits).some((key) => !['contextWindow', 'maxTokens'].includes(key)) ||
    !Number.isSafeInteger(limits.contextWindow) ||
    !Number.isSafeInteger(limits.maxTokens) ||
    limits.maxTokens <= 0 ||
    limits.contextWindow <= limits.maxTokens
  ) {
    throw new Error('Invalid agent model limits configuration')
  }
}

export function agentModelLimits(model: string): ModelLimits | undefined {
  return Object.entries(models).find(([id]) => id === model)?.[1]
}
