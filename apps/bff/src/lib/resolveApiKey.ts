import type { QueueProvider } from '@image-playground/shared'
import { config } from '../config'

/** Pick the upstream API key for a given provider kind, falling back to the generic key. */
export function resolveApiKey(kind: QueueProvider): string {
  const { apiKey, openaiApiKey, geminiApiKey } = config.upstream
  if (kind === 'openai-compat') return openaiApiKey || apiKey
  if (kind === 'gemini') return geminiApiKey || apiKey
  return apiKey
}

/** Chat, summary and search calls route Claude models through their own gateway credential. */
export function resolveChatApiKey(model: string): string {
  if (!model.toLowerCase().startsWith('claude-')) return resolveApiKey('openai-compat')
  if (!config.upstream.claudeApiKey) {
    throw new Error('UPSTREAM_CLAUDE_API_KEY is required for Claude chat models')
  }
  return config.upstream.claudeApiKey
}
