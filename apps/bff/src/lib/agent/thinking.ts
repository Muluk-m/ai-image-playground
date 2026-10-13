import type { AgentThinkingDepth } from '@image-playground/shared'
import { config } from '../../config'
import { agentModelLimits } from './model-limits'
import profiles from './thinking.config.json'

for (const [depth, profile] of Object.entries(profiles)) {
  if (
    !['fast', 'medium', 'deep'].includes(depth) ||
    Object.keys(profile).some((key) => !['model', 'effort'].includes(key)) ||
    typeof profile.model !== 'string' ||
    !profile.model.trim() ||
    !['low', 'medium', 'high'].includes(profile.effort) ||
    !agentModelLimits(profile.model)
  ) {
    throw new Error('Invalid agent thinking profile configuration')
  }
}

export function agentThinking(depth?: AgentThinkingDepth): {
  model: string
  effort: 'off' | 'low' | 'medium' | 'high'
  contextWindow: number
  maxTokens: number
} {
  if (!depth) {
    const known = agentModelLimits(config.agent.model)
    return {
      model: config.agent.model,
      effort: 'off',
      contextWindow: known?.contextWindow ?? config.agent.contextWindow,
      maxTokens: known?.maxTokens ?? config.agent.maxTokens,
    }
  }
  const profile = profiles[depth]
  return {
    model: profile.model,
    effort: profile.effort as 'low' | 'medium' | 'high',
    ...agentModelLimits(profile.model)!,
  }
}
