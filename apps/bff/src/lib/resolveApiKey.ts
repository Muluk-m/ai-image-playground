import type { QueueProvider } from '@image-playground/shared'
import { config } from '../config'

/** Pick the upstream API key for a given provider kind, falling back to the generic key. */
export function resolveApiKey(kind: QueueProvider): string {
  const { apiKey, openaiApiKey, geminiApiKey } = config.upstream
  if (kind === 'openai-compat') return openaiApiKey || apiKey
  if (kind === 'gemini') return geminiApiKey || apiKey
  return apiKey
}

/** Chat, summary and search calls prefer the Claude credential when configured. */
export function resolveChatApiKey(model: string): string {
  if (!model.toLowerCase().startsWith('claude-')) return resolveApiKey('openai-compat')
  return config.upstream.claudeApiKey || resolveApiKey('openai-compat')
}
