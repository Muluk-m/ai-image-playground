import type { AgentThinkingDepth } from '@image-playground/shared'
import { config } from '../../config'
import profiles from './thinking.config.json'

for (const [depth, profile] of Object.entries(profiles)) {
  if (
    !['fast', 'medium', 'deep'].includes(depth) ||
    Object.keys(profile).some((key) => key !== 'model' && key !== 'effort') ||
    typeof profile.model !== 'string' ||
    !profile.model.trim() ||
    !['low', 'medium', 'high'].includes(profile.effort)
  ) {
    throw new Error('Invalid agent thinking profile configuration')
  }
}

export function agentThinking(depth?: AgentThinkingDepth): {
  model: string
  effort: 'off' | 'low' | 'medium' | 'high'
} {
  if (!depth) return { model: config.agent.model, effort: 'off' }
  const profile = profiles[depth]
  return { model: profile.model, effort: profile.effort as 'low' | 'medium' | 'high' }
}
